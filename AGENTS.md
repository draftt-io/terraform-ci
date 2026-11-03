# Working in this repository

This repository is public. Everything in it is visible to anyone: code, comments, tests, commit messages, branch names, pull request titles and bodies, review comments, issues and release notes. Write every one of them for a reader outside Draftt.

## Keep internal context out

Do not put any of the following anywhere in this repository:

- Names of Draftt's internal services, repositories, environments, clusters or accounts. Say "Draftt" or "the Draftt server".
- Ticket identifiers or links to an issue tracker, design documents, review notes, chat threads or internal wikis.
- Names of employees, customers, customer organizations or their identifiers.
- Links to private repositories, workflow runs or checks in them. Evidence in a pull request uses public links or a description of the result.
- API keys, tokens, account identifiers, hostnames other than the public Draftt endpoints, or plan files from real infrastructure.

If a change needs internal context to be understood, keep that context in Draftt's internal documentation and describe the change here in terms a customer would understand.

## Commits, branches and pull requests

- Commit messages say what changed and why, in plain language. No attribution trailers, no session links, no generated-by footers.
- Branch names describe the change, for example `source-map-cap` or `release-workflow`.
- A pull request body has a short summary, the evidence that the change works, and the merge risk. One commit per logical change; squash before merge when the history is noisy.

## Code

- The Action runs on Node 24. `npm run typecheck`, `npm test` and `npm run bundle` must pass, and the rebuilt `dist/index.js` is committed with every change to `src/`.
- One runtime dependency, `@actions/core`. Do not add another.
- Comments explain behaviour a customer or contributor needs; they never reference internal decisions, reviews or tickets.
- Documentation for customers lives on docs.draftt.io. The README covers installation, inputs, outputs, what is sent to Draftt, versioning and support.
