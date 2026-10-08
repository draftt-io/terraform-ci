# Draftt Terraform CI

`draftt-io/terraform-ci` scans an existing Terraform or OpenTofu plan JSON with Draftt and reports policy violations as a GitHub Check. On pull requests it can hand publishing to the Draftt CI GitHub App, which then owns the check and a PR comment.

The Action scrubs the plan on the runner before sending it. It never sends the raw plan. By default, violations and scan errors are reported without failing the workflow.

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
          # api-url: https://draftt-ci.draftt.io/v1/scans
```

Use `tofu plan` and `tofu show -json` instead when the repository uses OpenTofu.

`github-token` defaults to `${{ github.token }}`; pass it only to use a different token. Keep `checks: write`: the v0.1.1 flow uses it for its check, server mode uses it for the fallback and error checks, and either mode uses it for the skipped check on pull requests from external forks.

## Publish mode

`publish-mode` defaults to `server`. The Draftt CI App publishes only when all three hold:

1. `publish-mode` is `server`;
2. `api-url` ends with `/v1/scans` (a trailing slash is fine). Until the default changes, set it to `https://draftt-ci.draftt.io/v1/scans`;
3. the event is a pull request event: `pull_request`, `pull_request_target`, or another event whose payload carries the pull request.

Then the Draftt CI App owns the check and the PR comment, and the Action creates no check of its own while the scan runs. The App's check is named `Draftt Terraform Policy Scan` for the scan key `.` and `Draftt Terraform Policy Scan (<scanKey>)` for any other key:

- The Action sends the scrubbed plan, the pull request context and, when it can map resources to source, a map from resource address to file and line. The App completes its check and posts or updates one PR comment per scan key, marked `<!-- draftt-ci:scan:<scanKey> -->`.
- The scan key is `terraform-root` as a workspace-relative POSIX path, with `.` for the repository root. An absolute `terraform-root` inside the workspace (for example `${{ github.workspace }}/infra`) is converted to its relative key; an absolute path outside the workspace is an error. The key may contain only letters, digits, `.`, `_`, `/` and `-`, at most 200 characters, without `..` segments; anything else is a scan error in server mode. Use one `terraform-root` per root module to get one check and one comment per module.
- The service deduplicates uploads on `runId:runAttempt:scanKey`. Two scans in one workflow run attempt, including matrix jobs (which share the run attempt), must use different directories: `infra`, `./infra/` and `${{ github.workspace }}/infra` are the same key. A second upload with the same key is never published: the Action then reports `publisher: server` with the first scan's `check-run-url`, while its counts and job summary are the second scan's. Scanning one root module more than once per run attempt (for example once per environment) is not supported in server mode. Re-running the workflow is a new attempt and scans again.
- Annotations appear in **Files changed** on the exact changed lines only when the Action sends the source map. It sends none when, for example, the pull request head is not checked out, Terraform files differ from the commit, `GITHUB_WORKSPACE` is not the repository root (nested workspaces), Git cannot be inspected, the Terraform sources cannot be mapped, or the map was dropped to keep the request under 50 MiB; findings then stay in the check summary and the PR comment.
- The source map is capped at 100,000 resources, with a warning; findings for the rest stay in the summary.
- The Action posts a completed `Draftt Terraform Policy Scan (Action)` check only when the server did not publish (for example, the App is not installed on the repository) or the scan could not complete (invalid inputs, an unreadable or rejected plan, a failed request). Failures to post that check are warnings.
- Current limitation: when a pull request is opened, reopened or pushed, the App's webhook queues a check and a waiting comment for the root key `.` only. If no upload arrives for that key, the check concludes neutral after 10 minutes. A workflow whose `terraform-root` is not the repository root therefore also sees an extra `Draftt Terraform Policy Scan` check that ends neutral with "Root module plan not received", plus its comment.
- On `pull_request_target` the planned code runs with access to the Draftt key; prefer `pull_request`.

Every other case — `publish-mode: action`, the default ui-backend `api-url`, and `push`, `merge_group` or `workflow_dispatch` events — runs the v0.1.1 flow under the unchanged check name `Draftt Terraform Policy Scan`, with the check started before inputs are validated. Only its report layout (below) and the new outputs change.

Requests to `/v1/scans` over 1 MiB are gzip-compressed. A `429` response waits for `Retry-After` (at most 60 s) before retrying.

## Report layout

The check summary, and the PR comment the App posts, lead with counts by status and the earliest due date, then a table of resource, status, policy and change needed (`from → to by <date>`) with one row per policy hit. Collapsed sections follow for resources past the first 25 and for checks that could not run, then a footer with coverage counts.

Annotations on the changed lines are plain text and at most 500, most urgent first. In `server` mode each table row links to the file and line at the scanned commit; the Action's own check shows `path:line` without a link.

## Upgrading from v0.1.x

With the default `api-url` only the report layout and the new outputs change. Once `api-url` points at `/v1/scans`, a required check pinned to the GitHub Actions source must be re-pinned to the Draftt CI App check, under the name given in Publish mode. Any pull request that gets no server-mode upload while the App is installed (`action` mode, the default `api-url`, pull requests the workflow skips by path or draft) shows the App's queued check concluding neutral after 10 minutes.

## Enforcement

Both options default to `false` during rollout:

```yaml
with:
  fail-on-violations: "true"
  fail-on-scan-error: "true"
```

- `fail-on-violations` fails only when Draftt reports clear policy violations.
- `fail-on-scan-error` fails when the plan cannot be read or scrubbed, Draftt cannot complete the scan, or (in the v0.1.1 flow) the GitHub Check cannot be published.
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

The raw plan and final request are each limited to 50 MiB; the Action drops the source map first when the request would exceed it. The service caps the plan alone at 49 MiB, so a scrubbed plan between 49 and 50 MiB passes the Action and comes back as a scan error ("Draftt rejected the scan request as too large"; the service caps the plan at 49 MiB). Keep plans under 49 MiB. The API key is masked before the plan is read.

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
