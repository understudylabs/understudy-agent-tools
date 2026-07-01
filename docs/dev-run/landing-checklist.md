# Landing checklist — how PRs merge in this repo

The dev-run discipline that caught real bugs in every PR so far (precedence
inversion, write races, wedged downloads, stale docs). Any agent landing a PR
follows this; it is cheap insurance, not ceremony.

## Per PR

1. **Merge-test first.** In a scratch worktree:
   `git worktree add /tmp/prN-tree origin/<pr-branch> && cd /tmp/prN-tree &&
   git merge origin/main` — must be conflict-free or resolved deliberately.
   Then `cargo check --all-targets && cargo test` (if Rust changed) and
   `npm ci && npm test`. The merge RESULT is what ships, not the branch.
2. **Adversarial review, scaled to risk.** For concurrency, persistence,
   auth, or money-adjacent changes: review with distinct lenses (correctness
   of the new logic; semantic composition with what merged since the branch
   point) and try to REFUTE each finding by reading the code before believing
   it. For docs/config-only PRs a single careful read suffices.
3. **Fix findings on the PR branch** (small follow-up commits, honest
   messages), re-run both test suites, push.
4. **Gates + merge.** Wait for the `gates` check; repo admins land with
   `gh pr merge N --merge --admin` (auto-merge is disabled; review
   requirement is satisfied by the review above — record findings in a PR
   comment if the reviewer isn't the merger).
5. **After merge:** delete scratch worktrees, verify `origin/main` builds if
   anything non-trivial was resolved during merge.

## Known cross-PR hotspots (check when merging concurrent work)

- `apps/homescreen/src-tauri/src/lib.rs` — every workstream registers
  commands/modules here; textual merges usually succeed, so check the
  registration list compiles and nothing was dropped.
- `commands.rs` and `chat.rs` — multiple workstreams touch different regions;
  semantic composition matters more than textual (e.g. a new loop bound
  composing with an error path added by another PR).
- `skills/onboard/reference.md` and `skills/manage-local-models/reference.md`
  — doc PRs keep colliding here; after any model-registry change, grep the
  whole tree for ids that are no longer published:
  every id in docs must exist in `https://models.understudylabs.com/catalog`.

## In-flight PRs this checklist was written for

- `anthro/wave3-eval-result-v1` — schema + adoption. Review lenses:
  schema completeness vs the three producers; db migration correctness on
  the #118 migrations-once path; export packet backward compatibility;
  ladder JSONL persistence doesn't break `tests/ladder.test.mjs`.
- `anthro/wave5a-daemon-parity` — new agent surface. Review lenses: auth on
  every new endpoint; blocking work off the axum workers; run-registry 409 +
  cancellation correctness (token checked between rows, DB rows marked);
  MCP inputSchemas actually match handler expectations; CLI discovery
  pid-check (dead pid ⇒ not running).
