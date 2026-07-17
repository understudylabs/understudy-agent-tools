# Contributing to Understudy Agent Tools

This guide outlines the technical expectations for contributing to this repository.

## Prerequisites

- **Node.js ≥ 22.19.0**: Required by the `engines` field in `package.json`.
- **npm**: We use standard `npm`, not `yarn` or `pnpm`.

## Local Development

Install dependencies from the exact lockfile:
```sh
npm ci
```

### No Linters or Formatters

**Do not look for an `eslint` or `prettier` config.** This repo uses TypeScript compiler checks and git diffs as the primary quality gates. Do not add formatting or linting dependencies to your PRs.

The quality gate is enforced by running:
```sh
npm run check
```
This single command runs:
1. `npm run build` (`tsc -p tsconfig.build.json`)
2. `npm run typecheck` (`tsc --noEmit`)
3. `npm test` (using Node.js's built-in test runner)
4. `npm run skills:validate` (validates skill `.md` files)
5. `npm run package:smoke` (sanity checks the CLI package)

Additionally, avoid trailing whitespace, which is checked in CI via `git diff --check`.

### Testing

This repository uses **Node's built-in test runner** (`node --test` with `node:assert/strict`).
- **Do not install Jest, Vitest, or Mocha.**
- Test files live in `tests/` and are named `*.test.mjs`.
- The test pattern is integration-focused: we spawn the CLI using `node:child_process` and assert on `stdout`, `stderr`, and exit codes.

### Skills

The core product surface consists of the `SKILL.md` agent playbooks in the `skills/` directory.
- Changes to skills are validated by `npm run skills:validate`.
- If you add or modify a skill, ensure its frontmatter matches the schema expected by the validator.

## Pull Requests

### Commit Message Style

We loosely follow Conventional Commits. Use an imperative subject and a scope in parentheses when applicable:
- `feat(desktop): add trained model library`
- `fix(cli): make first-run setup coherent`
- `docs: clarify install and update paths`

GitHub automatically appends the PR number (e.g., `(#269)`) when merging.

### PR Description Template

Mirror the format of recent merged PRs. Your PR description must include the following two sections:

```markdown
## Outcome / Summary
[Brief description of what changed, e.g., "Adds a quiet reader-position rail to Desktop chat..."]

## Verification
- `npm run check` passed (X tests passed, Y skills valid)
- `git diff --check` passed
[Any manual testing or specific integration tests you ran]
```

Run these verification commands locally and document the results in your PR before requesting a review.
