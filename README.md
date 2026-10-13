# Draftt Terraform CI

`draftt-io/terraform-ci` scans an existing Terraform or OpenTofu plan JSON with Draftt and reports policy violations as a GitHub Check. On pull requests it can hand publishing to the Draftt CI GitHub App, which then owns the check and a PR comment.

The Action scrubs the plan on the runner before sending it. It never sends the raw plan. By default, violations and scan errors are reported without failing the workflow; on pull requests published by the Draftt CI App, a Draftt Admin can switch to blocking mode in the Draftt console (see [Enforcement](#enforcement)).

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
- A commit takes at most 50 scan keys (one per `terraform-root`). A further key is refused with `This commit already has 50 Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).`, a scan error that is not retried; a re-upload of an existing key is always accepted.
- The service deduplicates uploads on `runId:runAttempt:scanKey`. Two scans in one workflow run attempt, including matrix jobs (which share the run attempt), must use different directories: `infra`, `./infra/` and `${{ github.workspace }}/infra` are the same key. A second upload with the same key is never published: the Action then reports `publisher: server` with the first scan's `check-run-url`, while its counts and job summary are the second scan's. Scanning one root module more than once per run attempt (for example once per environment) is not supported in server mode. Re-running the workflow is a new attempt and scans again.
- Annotations appear in **Files changed** on the exact changed lines only when the Action sends the source map. It sends none when, for example, the pull request head is not checked out, Terraform files differ from the commit, `GITHUB_WORKSPACE` is not the repository root (nested workspaces), Git cannot be inspected, the Terraform sources cannot be mapped, or the map was dropped to keep the request under 50 MiB; findings then stay in the check summary and the PR comment.
- The source map is capped at 100,000 resources, with a warning; findings for the rest stay in the summary.
- The Action posts a completed `Draftt Terraform Policy Scan (Action)` check only when the server did not publish (for example, the App is not installed on the repository) or the scan could not complete (invalid inputs, an unreadable or rejected plan, a failed request). Failures to post that check are warnings.
- Current limitation: when a pull request is opened, reopened or pushed, the App's webhook queues a check and a waiting comment for the root key `.` only. If no upload arrives for that key, the check concludes neutral after the timeout a Draftt Admin sets in the Draftt console (10 minutes by default). A workflow whose `terraform-root` is not the repository root therefore also sees an extra `Draftt Terraform Policy Scan` check that ends neutral with "Root module plan not received", plus its comment.
- On `pull_request_target` the planned code runs with access to the Draftt key; prefer `pull_request`.

Every other case — `publish-mode: action`, the default ui-backend `api-url`, and `push`, `merge_group` or `workflow_dispatch` events — runs the v0.1.1 flow under the unchanged check name `Draftt Terraform Policy Scan`, with the check started before inputs are validated. Only its report layout (below), the new outputs, the `github-token` default (`${{ github.token }}`) and the nested-workspace annotation check change: when `GITHUB_WORKSPACE` is not the repository root, annotations are skipped with a warning.

Requests to `/v1/scans` over 1 MiB are gzip-compressed. A `429` response waits for `Retry-After` (at most 60 s) before retrying. A `408 upload_timeout` (the upload did not finish within the service's 240 s) and a `422 too_many_scan_keys` are not retried; the Action reports their message as the scan error.

## Report layout

The check summary, and the PR comment the App posts, lead with counts by status and the earliest due date, then a table of resource, status, policy and change needed (`from → to by <date>`) with one row per policy hit. Collapsed sections follow for resources past the first 25 and for checks that could not run, then a footer with coverage counts.

Annotations on the changed lines are plain text and at most 500, most urgent first. In `server` mode each table row links to the file and line at the scanned commit; the Action's own check shows `path:line` without a link.

## Upgrading from v0.1.x

With the default `api-url` only the report layout, the new outputs, the `github-token` default (`${{ github.token }}`, so a workflow that omitted it now gets a check) and the nested-workspace annotation check (annotations are skipped with a warning when `GITHUB_WORKSPACE` is not the repository root) change. Once `api-url` points at `/v1/scans`, a required check pinned to the GitHub Actions source must be re-pinned to the Draftt CI App check, under the name given in Publish mode. Any pull request that gets no server-mode upload while the App is installed (`action` mode, the default `api-url`, pull requests the workflow skips by path or draft) shows the App's queued check concluding neutral after the timeout (10 minutes by default).

`fail-on-violations` no longer decides the check. A Draftt Admin sets advisory or blocking mode in the Draftt console (Integrations › Draftt CI › Scan settings). If your workflow set `fail-on-violations: true`, ask a Draftt Admin to switch to blocking mode before you upgrade, or pull requests with violations will pass.

In blocking mode the scan step fails when the check fails. Steps after it run only with `if: always()`.

## Enforcement

On pull requests in server mode (the three conditions in [Publish mode](#publish-mode)), the Draftt CI mode decides whether the check fails. A Draftt Admin sets it for the organization in the Draftt console (Integrations › Draftt CI › Scan settings):

- **Advisory** (the default): the check reports violations and does not fail; neither does the job.
- **Blocking**: a plan with policy violations fails the check, and the scan step fails with `Draftt CI is in blocking mode and found policy violations in <n> Terraform resource(s). See the check: <url>`. To block merging, require the check in a ruleset: see [Require the Draftt check](#require-the-draftt-check).

The job fails when the check the service published concludes `failure`; the service is the authority. When the service could not publish its check, the Action applies the mode itself: the job fails in blocking mode when there are violations, and the `Draftt Terraform Policy Scan (Action)` fallback check concludes `failure` then, `neutral` with violations in advisory mode, and `success` without violations. The local report and the fallback annotations use level `failure` in blocking mode and `warning` otherwise. In blocking mode, when the check for the root scan key `.` could not be published, the Action warns that the required Draftt check will pass when it times out. A service that reports no mode is treated as advisory, and the log says `Draftt CI did not report a mode; update the Draftt CI service.` The completion line in the log names the mode.

`fail-on-violations` is deprecated. It still decides where the Action publishes its own check (the v0.1.1 flow: `publish-mode: action`, events other than pull requests, or an `api-url` not ending in `/v1/scans`): there it fails the job only when Draftt reports clear policy violations and the input is `true`. In server mode on pull requests it is ignored, with a warning when it is set (`true` or `false`); the value is still sent to the service, which ignores it. It has no default; unset means `false`.

```yaml
with:
  fail-on-scan-error: "true"
```

- `fail-on-scan-error` (default `false`) fails when the plan cannot be read or scrubbed, Draftt cannot complete the scan, or (in the v0.1.1 flow) the GitHub Check cannot be published.
- Incomplete policy evaluation and coverage gaps always warn and pass.
- Pull requests from external forks are skipped without reading the plan or Draftt key.

## Require the Draftt check

Blocking mode fails the Draftt check; a branch ruleset that requires the check is what blocks merging.

1. **The rule.** Create a branch ruleset for the protected branches with "Require status checks to pass", add "Draftt Terraform Policy Scan" and choose the Draftt CI app as its source. Require only this check, the one Draftt CI queues on every pull request. Do not require a "Draftt Terraform Policy Scan (&lt;scan key&gt;)" variant: Draftt CI creates it only when your workflow uploads a plan for that root, so a pull request that does not upload it can never merge without a bypass.

   Choosing the Draftt CI app as the source matters: without it, any workflow that creates a check named "Draftt Terraform Policy Scan" satisfies the rule. The check appears in GitHub's picker after it has run once in the repository; you can also type the name. Rulesets on private repositories need a GitHub Team or Enterprise plan; classic branch protection works the same way: Require status checks, add the check, choose the Draftt CI app.
2. **Root scan only.** Blocking mode applies to the scan of the repository root (`terraform-root: .`, the default). Checks for other roots show their result but cannot block merging through the Draftt check. In blocking mode the workflow job still fails on their violations.
3. **What the merge box shows.**

   | Draftt check | Merge |
   |---|---|
   | queued or in progress | blocked |
   | `success` | allowed |
   | `neutral` | allowed |
   | `failure` | blocked |

   A check that times out concludes neutral and passes. Right after a check completes, GitHub can show the merge state as unknown for up to 90 seconds.
4. **Pull requests without a plan.** Draftt CI adds a pending check to every pull request in the repositories it covers. A pull request whose workflow does not upload a plan (no Terraform change, a draft, a workflow skipped by `paths:`) cannot merge until the check times out and passes, the configured timeout after each push; with "Require branches to be up to date", every Update branch starts the wait again. Target the ruleset only at repositories that run the Draftt workflow and that the Draftt CI installation covers: a repository outside the installation never gets the check, so a ruleset over all repositories blocks it permanently. Set the timeout just above your workflow's usual time from push to upload, including runner queue time.
5. **Late plans and re-runs.** If the timeout passes before the plan is uploaded, the check passes. A plan uploaded later replaces the result. The Re-run button on the Draftt check does not scan again. Re-run the Terraform workflow job instead; the new run is judged with the current mode.
6. **Stuck check.** If the Draftt check stays pending, push a new commit or re-run the workflow; reopening the pull request does not queue a new check. A repository that was archived or removed from the Draftt CI installation keeps the pending checks it already had: remove the requirement or merge through a bypass.
7. **Not supported.** Merge queue is not supported yet: do not require the Draftt check on a branch that uses a merge queue. Blocking mode needs `publish-mode: server` (the default). With `publish-mode: action` the Draftt check passes when it times out.
8. **Failing closed.** To also fail the workflow job when Draftt cannot scan, set `fail-on-scan-error: true` and require the job.
9. **Bypass.** Fork pull requests get no Draftt check, and that includes forks inside your own organization: Draftt CI does not check any pull request whose branch lives in another repository. Such pull requests need a bypass. Required checks also apply to direct pushes: bots that push to the branch need the bypass list. A bypass actor can merge any pull request past the rule, not only fork pull requests.
10. **What blocking mode protects against.** Blocking mode stops accidental policy violations. It does not stop a repository writer who wants to pass the check: in a `pull_request` workflow the PR's own workflow file runs with the Draftt key, so the author can change what is uploaded. Protect the workflow: add CODEOWNERS for `.github/workflows/` (and the Terraform workflow's scripts) and require code-owner review in the same ruleset. The API key belongs to the Draftt organization: a workflow in any repository that holds it can publish a check for any pull request of the bound GitHub organization. Store it as a repository or organization secret limited to the repositories that run the scan, and rotate it like a release credential. With `pull_request_target` the planned code runs with the key, so prefer `pull_request`.
11. **Switching modes.** Switching the organization to blocking or advisory in the Draftt console changes nothing on open pull requests until the workflow runs again. After switching to advisory, failing checks stay failing until that re-run. Before you disconnect Draftt CI or uninstall the app, remove the ruleset requirement, or pull requests in those repositories cannot merge.

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

Size limits: the raw plan file is limited to 50 MiB. The scrubbed plan as sent (what the service measures) is limited to 49 MiB, the service's cap; a larger one is refused before upload with `The Terraform plan is larger than 49 MiB, the most Draftt CI accepts. Scan a smaller root module with terraform-root, or split the plan.` The whole request is limited to 50 MiB; the Action drops the source map first when the request would exceed it. The API key is masked before the plan is read.

The Action gzips requests to `/v1/scans` over 1 MiB. Direct callers of `/v1/scans` should send gzip too (`Content-Encoding: gzip`): the service gives an upload 240 s and answers `408 upload_timeout` when the body has not arrived by then.

## Logs

The job log shows the scan's progress: the publish mode, the `api-url` host (never its path or query) and, in server mode, the scan key when the scan starts; each retry wait (for example `Draftt answered 429, retrying in 30 s (attempt 2 of 3)`); the fallback or error check the Action posts; and on completion the publisher, the violation, warning and annotation counts, the check URL and, in server mode, the Draftt CI mode. The API key, the GitHub token, plan values and Draftt response bodies are never logged; the one exception is the service's message on a `408` or `422` answer, reported as the scan error.

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
