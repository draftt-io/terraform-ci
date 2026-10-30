# Draftt Terraform CI

`draftt-io/terraform-ci` reads an existing Terraform or OpenTofu plan JSON, scrubs it on the runner, and uploads it to Draftt CI. Draftt CI scans the plan against your Draftt policies and, on pull requests, the Draftt CI GitHub App publishes the result. The Action never writes to GitHub itself and needs no GitHub token.

The raw plan never leaves the runner. Policy violations never fail the workflow; scan errors fail it only with `fail-on-scan-error: "true"`.

## Requirements

- The Draftt CI GitHub App is installed on the repository and bound to your Draftt organization.
- `api-url` points at the Draftt CI scans endpoint (`/ci/scans`); the default is `https://api.draftt.io/ci/scans`.
- A Draftt API key, stored as a secret.

## Usage

Create `plan.json` from the same pull-request revision the Action inspects. Do not print, cache, commit, or upload that file: Terraform plan JSON can contain plaintext secrets.

```yaml
name: Terraform policy scan

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

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
```

Use `tofu plan` and `tofu show -json` when the repository uses OpenTofu.

## What the App publishes

On a pull request event the Draftt CI App completes one check run, `Draftt Terraform Policy Scan` (or `Draftt Terraform Policy Scan (<scanKey>)` for a root other than `.`), with annotations on the changed lines, and posts or updates one PR comment per scan key. The check never fails: it concludes `success` without policy violations and `neutral` with some, so do not make it a required status check.

On other events (`push`, `merge_group`, `workflow_dispatch`) Draftt CI scans the plan and publishes nothing; the counts appear in the outputs and the job summary.

## Inputs

| Input | Default | Description |
|---|---|---|
| `plan-json` | required | Path to the Terraform or OpenTofu plan JSON |
| `api-url` | `https://api.draftt.io/ci/scans` | The Draftt CI scans endpoint. Must use HTTPS and end in `/ci/scans`; anything else is an input error |
| `api-key` | | Draftt API key |
| `terraform-root` | `.` | Root module directory, relative to the workspace (an absolute path inside `GITHUB_WORKSPACE` is accepted) |
| `policy-ids` | | JSON array of Draftt policy ids; omit it to use the organization's default policies |
| `fail-on-scan-error` | `false` | Fail the job when the scan cannot complete |

## Outputs

| Output | Description |
|---|---|
| `scan-status` | `completed`, `skipped` (pull request from an external fork), or `error` |
| `violation-count` | Resources with policy violations |
| `warning-count` | Incomplete evaluation or coverage warnings |
| `annotation-count` | Annotations the App published on the check |
| `check-run-url` | URL of the check the App published, empty when none was published |

Outputs contain counts and the check URL only, never plan data, policy details, credentials, or backend error bodies.

## Scan keys and limits

- The scan key is `terraform-root` as a workspace-relative POSIX path, `.` for the repository root: letters, digits, `.`, `_`, `/` and `-`, at most 200 characters, no `..` segments. Use one `terraform-root` per root module to get one check and one comment per module.
- A commit takes at most 50 scan keys. Uploads are deduplicated on `runId:runAttempt:scanKey`, so two scans in one workflow run attempt (matrix jobs included) must use different roots.
- The App annotates changed lines only when the Action can send a map from resource address to file and line. It sends none when the pull request head is not checked out, Terraform files differ from the commit, `GITHUB_WORKSPACE` is not the repository root, Git cannot be inspected, or the map would push the request over 50 MiB; the findings then stay in the check summary and the PR comment. The map is capped at 100,000 resources.
- Pull requests from external forks are skipped without reading the plan or uploading anything.
- On `pull_request_target` the planned code runs with access to the Draftt key; prefer `pull_request`.

## Requests and errors

Requests over 1 MiB are gzip-compressed, and a scrubbed plan over 49 MiB fails the scan before anything is sent. `502`, `503` and `504` answers and network failures are retried up to 3 attempts, waiting 0.5 s then 1 s; other statuses, `500` included, are final. On a `4xx` or a `502` the scan error is `Draftt answered <status>: <message>` with the service's message (for example `owner_mismatch` or `github_unavailable`); a `500` or other `5xx` is reported by status, and its body is never read.

## Plan security

The Action keeps only the plan sections Draftt needs, removes Terraform-marked and recognized credential fields from both sides of an update, and rejects recognized credential formats that remain. If Terraform marks an unexpected field as sensitive, the Action sends nothing and reports a scan error. An IAM trust policy (`assume_role_policy`) is stripped from values and configuration rather than rejected.

The raw plan file is limited to 50 MiB, the scrubbed plan to 49 MiB, and the whole request to 50 MiB; the source map is dropped first when the request would exceed it. The API key is masked before the plan is read.

The API key belongs to the Draftt organization: a workflow in any repository that holds it can upload a scan for any pull request of the bound GitHub organization. Limit the secret to the repositories that run the scan, rotate it like a release credential, and protect `.github/workflows/` with CODEOWNERS.

## Logs

The job log shows the `api-url` host (never its path or query) and the scan key, each retry wait (for example `Draftt answered 502, retrying in 0.5 s (attempt 2 of 3)`), any publish error the App reported, and on completion the violation, warning and annotation counts and the check URL. The API key, plan values and Draftt response bodies are never logged, except the service's message on a `4xx` or a `502`.

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
