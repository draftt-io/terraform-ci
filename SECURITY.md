# Security

## Reporting a vulnerability

Report a vulnerability in this Action through GitHub's private vulnerability reporting (open the Security tab of this repository and choose "Report a vulnerability") or by email to [security@draftt.io](mailto:security@draftt.io). Do not open a public issue for it.

Draftt acknowledges reports within three business days and keeps the reporter informed until the fix is released.

## Supported versions

Fixes are released on the latest 1.x version. Workflows that reference `draftt-io/terraform-ci@v1` receive them without a change; workflows pinned to an exact version or commit need to update the reference.

## What the Action sends to Draftt

The Action reads the plan file the workflow produced, removes every value Terraform marks sensitive, reduces provider configuration to the region and the assumed role ARN, rejects the plan if a recognized credential format remains, and uploads the result over HTTPS to the configured Draftt endpoint with the organization's access key. It never writes to GitHub and needs no GitHub token. The README describes the upload in detail.
