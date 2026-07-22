# Merge train: running many agent PRs into main safely

Distilled from the 2026-07 merge night: 27 agent-built PRs merged into main in
24 hours with ad-hoc bash. This document codifies what worked, what almost
broke, and the tooling that now replaces the ad-hoc parts.

## Tooling

- **`scripts/merge-train.sh <pr> [<pr>...]`** — merges a sequence of PRs in
  order with strict gating and an on-GitHub audit trail. Supports `--dry-run`.
- **`scripts/wave-ownership.mjs`** — checks a branch's changed files against a
  `wave.json` ownership manifest; exits nonzero on violations.

## The rules, and why

### 1. Gate on check *conclusions*, never on mergeability alone

`mergeable: MERGEABLE` only means "no textual conflicts". The one red-main
incident during the merge night came from merging a PR that was MERGEABLE but
whose checks had not passed. The train therefore:

- waits out GitHub's asynchronous `UNKNOWN` mergeability recompute (it happens
  after every base-branch update, i.e. after every previous merge in the train),
- runs `gh pr checks --watch` until checks settle,
- then requires every completed check to conclude SUCCESS / NEUTRAL / SKIPPED.
  Any FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, or STARTUP_FAILURE stops
  the train with the failing check named.

### 2. Admin-merge audit-comment convention

Merges use `gh pr merge --merge --admin`, which bypasses branch protection.
That is acceptable only if the verification evidence lives somewhere durable:
**before** merging, the train posts a comment on the PR containing a checks
table and the merge rationale. Anyone auditing main later can see, on the PR
itself, exactly what was green at merge time and why the admin merge was taken.

### 3. Worktree isolation + explicit file ownership per wave

Agents in a wave each work in their own git worktree on their own branch, and
each wave declares which files each agent owns. During the merge night this
contract was only verbal, and there were two near-misses: multiple agents
extending `src/benchmark-artifacts.ts`, and three agents touching
`run-executor.ts` in one wave.

The contract is now a manifest:

```json
{
  "agents": [
    { "branch": "anthro/foo", "owns": ["src/foo/**", "tests/foo*"], "forbidden": ["src/run-executor.ts"] },
    { "branch": "anthro/bar", "owns": ["src/bar/**"] }
  ]
}
```

Check any branch before (or while) it opens a PR:

```sh
node scripts/wave-ownership.mjs --wave wave.json --branch anthro/foo --pr 123
node scripts/wave-ownership.mjs --wave wave.json --branch anthro/foo --base origin/main
```

A file is a violation if it matches the agent's `forbidden` globs, or matches
another agent's `owns` globs without also matching this agent's own `owns`.
Shared files should either be forbidden to everyone (route changes through a
dedicated agent) or explicitly co-owned with a reconcile plan.

### 4. Reconcile agents do semantic unions

When a PR turns CONFLICTING mid-train (the train stops and says so), do not
resolve conflicts by picking a side. The pattern that worked: dispatch a
reconcile agent whose only job is to merge the base into the branch and produce
a **semantic union** — both features' behavior preserved, tests from both sides
green — then push and resume the train from that PR. Blind "ours"/"theirs"
resolution is how one wave's work silently deletes another's.

### 5. Order the train, keep it serial

Merge PRs one at a time, in dependency order. Every merge changes the base for
everything behind it, so the train re-waits mergeability and re-gates checks
per PR rather than trusting a snapshot taken at the start.

## Follow-up

- **Evaluate GitHub's native merge queue** for this repo. It automates the
  serialize-rebase-recheck-merge loop that `merge-train.sh` does by hand; the
  script would remain useful for the audit comment and the ownership/reconcile
  workflow, but the queue may replace the core loop.
