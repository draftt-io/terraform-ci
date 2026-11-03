# Contributing

Node.js 24 or later is required.

```text
npm ci
npm run typecheck
npm test
npm run bundle
```

`dist/index.js` is committed because GitHub runs the bundle directly. Rebuild it with `npm run bundle` after every change under `src/` and commit the result; CI rebuilds it and fails when the committed bundle differs from the source. CI also runs the Action from the checkout against an unreachable endpoint to prove the bundle loads and reports a scan error.

The Action has one runtime dependency, `@actions/core`. Do not add another.

## Releasing

The Release workflow runs by hand from `main` with a semantic version tag that matches the version in `package.json`, for example `v1.2.0` or `v1.2.0-rc.1`. It reruns the verification, publishes an immutable GitHub release on that tag, and for a final version moves the major tag (`v1`) to the released commit. A prerelease never moves the major tag.

See `AGENTS.md` for what must stay out of this public repository.
