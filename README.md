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

`github-token` defaults to `${{ github.token }}`; pass it only to use a different token. Keep `checks: write`: the v0.1.1 flow uses it for its check, and server mode uses it for the fallback and error checks.

## Publish mode

`publish-mode` defaults to `server`. The Draftt CI App publishes only when all three hold:

1. `publish-mode` is `server`;
2. `api-url` ends with `/v1/scans` (a trailing slash is fine). Until the default changes, set it to `https://draftt-ci.draftt.io/v1/scans`;
3. the event is `pull_request` or `pull_request_target`.

Then the check `Draftt Terraform Policy Scan` and the PR comment are owned by the Draftt CI App, and the Action creates no check of its own while the scan runs:

- The Action sends the scrubbed plan, the pull request context and, when it can map resources to source, a map from resource address to file and line. The App completes its check and posts or updates one PR comment per scan key, marked `<!-- draftt-ci:scan:<scanKey> -->`.
- The scan key is `terraform-root` as a workspace-relative POSIX path, with `.` for the repository root. An absolute `terraform-root` inside the workspace (for example `${{ github.workspace }}/infra`) is converted to its relative key; an absolute path outside the workspace is an error. Use one `terraform-root` per root module to get one check and one comment per module.
- The service deduplicates uploads on `runId:runAttempt:scanKey`, so two scans in the same workflow run attempt need different `terraform-root` values. Re-running the workflow is a new attempt and scans again.
- Annotations appear in **Files changed** on the exact changed lines only when the Action sends the source map. It sends none when the pull request head is not checked out, Terraform files differ from the commit, or `GITHUB_WORKSPACE` is not the repository root (nested workspaces); findings then stay in the check summary and the PR comment.
- The source map is capped at 100,000 resources, with a warning; findings for the rest stay in the summary.
- The Action posts a completed `Draftt Terraform Policy Scan (Action)` check only when the server did not publish (for example, the App is not installed on the repository) or the request failed. Failures to post that check are warnings.
- When the App has started a queued check for a pull request and no upload arrives, the App concludes that check as neutral after 10 minutes.
- On `pull_request_target` the planned code runs with access to the Draftt key; prefer `pull_request`.

Every other case — `publish-mode: action`, the default ui-backend `api-url`, and `push`, `merge_group` or `workflow_dispatch` events — runs the v0.1.1 flow unchanged, under the unchanged check name `Draftt Terraform Policy Scan`, with the check started before inputs are validated.

Requests to `/v1/scans` over 1 MiB are gzip-compressed. A `429` response waits for `Retry-After` (at most 60 s) before retrying.

## Report layout

The check summary, and the PR comment the App posts, lead with counts by status and the earliest due date, then a table of resource, status, policy and change needed (`from → to by <date>`) with one row per policy hit. Collapsed sections follow for resources past the first 25 and for checks that could not run, then a footer with coverage counts.

Annotations on the changed lines are plain text and at most 500, most urgent first. In `server` mode each table row links to the file and line at the scanned commit; the Action's own check shows `path:line` without a link.

## Upgrading from v0.1.x

With the default `api-url` nothing changes. Once `api-url` points at `/v1/scans`, a required check pinned to the GitHub Actions source must be re-pinned to the Draftt CI App. `action` mode with the App installed leaves the App's queued check to time out as neutral after 10 minutes.

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

The raw plan and final request are each limited to 50 MiB; the Action drops the source map first when the request would exceed it. The service caps the plan alone at 49 MiB, so a scrubbed plan between 49 and 50 MiB passes the Action and comes back as a scan error (`payload_too_large`, "Terraform plan exceeds the 49 MiB limit"). Keep plans under 49 MiB. The API key is masked before the plan is read.

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
