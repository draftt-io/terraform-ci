# Draftt Terraform CI

`draftt-io/terraform-ci` scans an existing Terraform or OpenTofu plan JSON with Draftt and reports policy violations as a GitHub Check.

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
          github-token: ${{ github.token }}
```

Use `tofu plan` and `tofu show -json` instead when the repository uses OpenTofu.

## Enforcement

Both options default to `false` during rollout:

```yaml
with:
  fail-on-violations: "true"
  fail-on-scan-error: "true"
```

- `fail-on-violations` fails only when Draftt reports clear policy violations.
- `fail-on-scan-error` fails when the plan cannot be read or scrubbed, Draftt cannot complete the scan, or the GitHub Check cannot be published.
- Incomplete policy evaluation and coverage gaps always warn and pass.
- Pull requests from external forks are skipped without reading the plan or Draftt key.

## Outputs

- `scan-status`: `completed`, `skipped`, or `error`
- `violation-count`
- `warning-count`
- `annotation-count`

Outputs contain counts only. They never contain plan data, policy details, credentials, or backend error bodies.

## Plan security

The Action keeps only the plan sections Fetcher needs, removes Terraform-marked and recognized credential fields from both sides of an update, and rejects recognized credential formats that remain. If Terraform marks an unexpected field as sensitive, the Action sends nothing and reports a scan error rather than risk an incorrect policy result.

The raw plan and final request are each limited to 50 MiB. The API key is masked before the plan is read.

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
