# Draftt Terraform CI

`draftt-io/terraform-ci` scans an existing Terraform or OpenTofu plan JSON with Draftt and reports policy violations as a GitHub Check. On pull requests it can hand publishing to the Draftt CI GitHub App, which then owns the check and a PR comment.

The Action scrubs the plan on the runner before sending it. It never sends the raw plan. Policy violations never fail the check or the workflow; scan errors fail them only with `fail-on-scan-error: true` (see [Check outcome](#check-outcome)).

## Usage

Your workflow must create `plan.json` from the same pull-request revision that the Action inspects. Do not print, cache, commit, or upload that file because Terraform plan JSON can contain plaintext secrets.

```yaml
name: Terraform policy scan

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths:
      - "**/*.tf"
      - "**/*.tf.json"
      - "**/*.tfvars"
      - "**/*.tfvars.json"
      - "**/*.tofu"
      - "**/*.tofu.json"
      - "**/.terraform.lock.hcl"

permissions:
  contents: read
  checks: write

concurrency:
  group: draftt-terraform-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  policy-scan:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      # Configure Terraform/OpenTofu and run init above the following commands.
      - run: terraform plan -out=tfplan
      - run: terraform show -json tfplan > plan.json
      - name: Scan Terraform policies with Draftt
        uses: draftt-io/terraform-ci@<pinned-release-commit-sha>
        with:
          plan-json: plan.json
          api-key: ${{ secrets.DRAFTT_API_KEY }}
          # Optional: publish through the Draftt CI GitHub App (see Publish mode).
          # api-url: https://api.draftt.io/ci/v1/scans
```

Use `tofu plan` and `tofu show -json` instead when the repository uses OpenTofu.

`github-token` defaults to `${{ github.token }}`; pass it only to use a different token. Keep `checks: write`: the v0.1.1 flow uses it for its check, server mode uses it for the fallback and error checks, and either mode uses it for the skipped check on pull requests from external forks.

## Publish mode

`publish-mode` defaults to `server`. The Draftt CI App publishes only when all three hold:

1. `publish-mode` is `server`;
2. `api-url` ends with `/v1/scans` (a trailing slash is fine). Until the default changes, set it to `https://api.draftt.io/ci/v1/scans`;
3. the event is a pull request event: `pull_request`, `pull_request_target`, or another event whose payload carries the pull request.

Then the Draftt CI App owns the check and the PR comment, and the Action creates no check of its own while the scan runs. The App's check is named `Draftt Terraform Policy Scan` for the scan key `.` and `Draftt Terraform Policy Scan (<scanKey>)` for any other key:

- The Action sends the scrubbed plan, the pull request context and, when it can map resources to source, a map from resource address to file and line. The App completes its check and posts or updates one PR comment per scan key, marked `<!-- draftt-ci:scan:<scanKey> -->`.
- The scan key is `terraform-root` as a workspace-relative POSIX path, with `.` for the repository root. An absolute `terraform-root` inside the workspace (for example `${{ github.workspace }}/infra`) is converted to its relative key; an absolute path outside the workspace is an error. The key may contain only letters, digits, `.`, `_`, `/` and `-`, at most 200 characters, without `..` segments; anything else is a scan error in server mode. Use one `terraform-root` per root module to get one check and one comment per module.
- A commit takes at most 50 scan keys (one per `terraform-root`). A further key is refused with `This commit already has 50 Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).`, a scan error that is not retried; a re-upload of an existing key is always accepted.
- Draftt CI deduplicates uploads on `runId:runAttempt:scanKey`. Two scans in one workflow run attempt, including matrix jobs (which share the run attempt), must use different directories: `infra`, `./infra/` and `${{ github.workspace }}/infra` are the same key. A second upload with the same key is never published: the Action then reports `publisher: server` with the first scan's `check-run-url`, while its counts and job summary are the second scan's. Scanning one root module more than once per run attempt (for example once per environment) is not supported in server mode. Re-running the workflow is a new attempt: it scans again and Draftt CI publishes a new check run.
- Annotations appear in **Files changed** on the exact changed lines only when the Action sends the source map. It sends none when, for example, the pull request head is not checked out, Terraform files differ from the commit, `GITHUB_WORKSPACE` is not the repository root (nested workspaces), Git cannot be inspected, the Terraform sources cannot be mapped, or the map was dropped to keep the request under 50 MiB; findings then stay in the check summary and the PR comment.
- The source map is capped at 100,000 resources, with a warning; findings for the rest stay in the summary.
- The Action posts a completed `Draftt Terraform Policy Scan (Action)` check only when the server did not publish (for example, the App is not installed on the repository) or the scan could not complete (invalid inputs, an unreadable or rejected plan, a failed request). It concludes like the App's check: `success` without violations, `neutral` with some. Failures to post that check are warnings.
- Current limitation: when a pull request is opened, reopened or pushed, the App's webhook queues a check and a waiting comment for the root key `.` only. If no upload arrives for that key, the check concludes neutral after the timeout a Draftt Admin sets in the Draftt console (10 minutes by default). A workflow whose `terraform-root` is not the repository root therefore also sees an extra `Draftt Terraform Policy Scan` check that ends neutral with "Root module plan not received", plus its comment.
- On `pull_request_target` the planned code runs with access to the Draftt key; prefer `pull_request`.

Every other case — `publish-mode: action`, the default `api-url` (`https://api.draftt.io/ci/scanTerraformPlan`), and `push`, `merge_group` or `workflow_dispatch` events — runs the v0.1.1 flow under the unchanged check name `Draftt Terraform Policy Scan`, with the check started before inputs are validated. Only its report layout (below), the new outputs, the `github-token` default (`${{ github.token }}`) and the nested-workspace annotation check change: when `GITHUB_WORKSPACE` is not the repository root, annotations are skipped with a warning. In both publish modes the report links each `path:line` to the changed file at the scanned commit.

Requests to `/v1/scans` over 1 MiB are gzip-compressed. A `429` response waits for `Retry-After` (at most 60 s) before retrying. A `408 upload_timeout` (the upload did not finish within the service's 240 s) and a `422 too_many_scan_keys` are not retried; the Action reports their message as the scan error.

## Report layout

The check summary, and the PR comment the App posts, lead with counts by status and the earliest due date, then a table of resource, status, policy and change needed (`from → to by <date>`) with one row per policy hit. Collapsed sections follow for resources past the first 25 and for checks that could not run, then a footer with coverage counts.

Annotations on the changed lines are plain text and at most 500, most urgent first. Each table row links to the file and line at the scanned commit, in the App's check and in the Action's own check.

## Upgrading from v0.1.x

With the default `api-url` only the report layout, the new outputs, the `github-token` default (`${{ github.token }}`, so a workflow that omitted it now gets a check) and the nested-workspace annotation check (annotations are skipped with a warning when `GITHUB_WORKSPACE` is not the repository root) change. Once `api-url` points at `/v1/scans`, the check on pull requests comes from the Draftt CI App, under the name given in Publish mode; if branch protection requires a `Draftt Terraform Policy Scan` check, remove that requirement (see [Check outcome](#check-outcome)). Any pull request that gets no server-mode upload while the App is installed (`action` mode, the default `api-url`, pull requests the workflow skips by path or draft) shows the App's queued check concluding neutral after the timeout (10 minutes by default).

`fail-on-violations` no longer fails the check or the job in any mode. When it is `true` the job log warns `fail-on-violations is ignored: Draftt CI checks never fail; violations are reported in the check and PR comment.`

## Check outcome

The Draftt CI check never fails: it completes as success when the plan has no policy violations, and as neutral when it has some or when no plan arrived.

Don't add the Draftt check as a required status check: while it waits for a plan it is pending, and a required pending check blocks merging until the timeout.

The `Draftt Terraform Policy Scan (Action)` fallback check and the check the Action publishes in the v0.1.1 flow follow the same rule, and their annotations use level `warning`. The scan step itself never fails on violations.

`fail-on-violations` is deprecated and ignored in every flow; when it is `true` the job log warns `fail-on-violations is ignored: Draftt CI checks never fail; violations are reported in the check and PR comment.` It has no default; the value is still sent to the service, which ignores it.

```yaml
with:
  fail-on-scan-error: "true"
```

- `fail-on-scan-error` (default `false`) fails the Action, and concludes its error check as `failure`, when the plan cannot be read or scrubbed, Draftt cannot complete the scan, or (in the v0.1.1 flow) the GitHub Check cannot be published.
- Incomplete policy evaluation and coverage gaps always warn and pass.
- Pull requests from external forks are skipped without reading the plan or Draftt key.

## Outputs

- `scan-status`: `completed`, `skipped`, or `error`
- `violation-count`
- `warning-count`
- `annotation-count`: annotations published by the Draftt CI App or by this Action
- `check-run-url`: URL of the published check run, empty when none was published
- `publisher`: `server` (the Draftt CI App), `action` (this Action), or `none`

Outputs contain counts, the check run URL and the publisher only. They never contain plan data, policy details, credentials, or backend error bodies.

## Plan security

The Action keeps only the plan sections Fetcher needs, removes Terraform-marked and recognized credential fields from both sides of an update, and rejects recognized credential formats that remain. If Terraform marks an unexpected field as sensitive, the Action sends nothing and reports a scan error rather than risk an incorrect policy result.

An IAM trust policy (`assume_role_policy`) is stripped the same way: it is not a credential, but Draftt does not evaluate it and the provider or a `sensitive()` wrapper may mark it, so it is removed from values and configuration rather than rejected.

The API key belongs to the Draftt organization: a workflow in any repository that holds it can publish a check for any pull request of the bound GitHub organization. Store it as a repository or organization secret limited to the repositories that run the scan, and rotate it like a release credential. In a `pull_request` workflow the pull request's own workflow file runs with the key, so protect `.github/workflows/` with CODEOWNERS.

Size limits: the raw plan file is limited to 50 MiB. The scrubbed plan as sent (what the service measures) is limited to 49 MiB, the service's cap; a larger one is refused before upload with `The Terraform plan is larger than 49 MiB, the most Draftt CI accepts. Scan a smaller root module with terraform-root, or split the plan.` The whole request is limited to 50 MiB; the Action drops the source map first when the request would exceed it. The API key is masked before the plan is read.

The Action gzips requests to `/v1/scans` over 1 MiB. Direct callers of `/v1/scans` should send gzip too (`Content-Encoding: gzip`): the service gives an upload 240 s and answers `408 upload_timeout` when the body has not arrived by then.

## Logs

The job log shows the scan's progress: the publish mode, the `api-url` host (never its path or query) and, in server mode, the scan key when the scan starts; each retry wait (for example `Draftt answered 429, retrying in 30 s (attempt 2 of 3)`); the fallback or error check the Action posts; the `fail-on-violations` warning when that input is `true`; and on completion the publisher, the violation, warning and annotation counts and the check URL. The API key, the GitHub token, plan values and Draftt response bodies are never logged; the one exception is the service's message on a `408` or `422` answer, reported as the scan error.

## Development

Node.js 24 is required.

```text
npm ci
npm run typecheck
npm test
npm run bundle
```

`dist/index.js` is committed because GitHub executes the bundle directly. CI rebuilds it and fails if it differs from the TypeScript source.

The manual Release workflow accepts a semantic version tag, reruns the full verification, and creates the GitHub release from `main`. New releases default to prerelease until explicitly promoted.
