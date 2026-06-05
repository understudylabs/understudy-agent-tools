# PR Review Checklist

Use this before opening or merging public repo PRs. The goal is not style
polish; it is keeping the OSS surface small, local-first, and easy to review.

## Structural Bar

- No source file should cross 1,000 lines without a clear reason in the PR
  description. Prefer extracting a focused command module, runtime template,
  adapter registry, or pure helper first.
- Avoid adding feature-specific branches inside unrelated flows. Put new
  behavior behind the module that owns the concept.
- Prefer deleting or isolating complexity over moving the same complexity into a
  different helper.
- Keep TypeScript as the CLI/orchestration layer. Python may exist only as
  generated or ignored local `uv` runtime state for Python-native packages.

## Public Boundary

- No uploads, provider calls, hosted jobs, package installs, or model downloads
  happen without an explicit user action. Authenticated product telemetry must
  stay within `docs/telemetry.md` and honor `UNDERSTUDY_TELEMETRY=0`.
- Secret values never appear in docs, logs, tests, fixtures, generated packets,
  or PR descriptions.
- Examples and tests use synthetic data or small public fixtures.
- Docs should name one canonical contract. Remove stale or duplicate docs rather
  than rewriting them in place and creating a second source of truth.

## CLI And Skills

- Every changed CLI surface has a test that covers success and the relevant
  refusal/blocking path.
- Every changed skill still routes through `skills/understudy/SKILL.md` or a
  documented specialist skill.
- Skills stay short and use progressive disclosure; long command notes belong in
  `reference.md` or docs.

## Required Checks

Run before opening or updating a PR:

```sh
npm run check
git diff --check
```

For broad PRs, also inspect the shape explicitly:

```sh
git diff --stat
wc -l src/**/*.ts tests/*.mjs
```
