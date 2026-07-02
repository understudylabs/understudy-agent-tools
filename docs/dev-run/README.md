# Dev run: "one spine, two surfaces" — handoff plans

Self-contained work plans for coding agents (Claude Code, Devin, Codex, Cursor,
or a fresh session). Each plan carries all the context needed to execute
without access to the session that authored it. Read this index first, then
the plan you are assigned.

## Thesis (why this run exists)

Understudy is a flywheel: real usage → captures → evals with provenance →
Fusion routing (certified local `-understudy` models ↔ paid gateway) →
verified savings → training data → better local models. The **CLI** is the
control plane and evidence state machine; the **desktop app**
(`apps/homescreen`) is the local runtime/daemon and cockpit; the **skills**
are the methodology. The recurring disease this run cures: contracts that
exist in prose get copied instead of shared, then drift (the 2026-07-01
onboarding failure was exactly this).

## State as of 2026-07-01 (main @ 44343ca)

Done and merged:
- `#115` hygiene (chat tool cap restored, real timestamps), `#116` download
  hardening, `#117` benchmark scoring/run-id fixes (introduced "unscored"),
  `#118` SQLite hardening (shared conn, WAL, migrations-once) + sidekick
  transcript fixes, `#120` route policy extracted to
  `apps/homescreen/src-tauri/src/route_policy.rs`, `#121` compaction guard.
- Wave 1 — catalog spine: `GET https://models.understudylabs.com/catalog`
  is live (`understudy.model_catalog.v1`, 10 pullable models, ETag/304);
  CLI + app fetch it with bundled fallbacks synced (`#123`); downloads
  self-heal against fresh SHA256SUMS on both surfaces.
- Wave 2 — identity: one credential resolution (env > top-level key >
  sole-org entry, matching `resolveAuth`), `$HOME` never a project root, and
  the app owns `~/.understudy/agent-card.json`
  (`apps/homescreen/src-tauri/src/agent_card.rs`) (`#122`).

In flight (check `gh pr list` — land via [landing-checklist.md](landing-checklist.md)):
- Wave 3 — `understudy.eval_result.v1` schema adopted by app/ladder/skills/CLI
  (branch `anthro/wave3-eval-result-v1`).
- Wave 5a — daemon agent parity: HTTP+MCP warm/download/benchmark/chat,
  typed MCP schemas, CLI daemon discovery (branch `anthro/wave5a-daemon-parity`).

Queued (this directory):
1. [wave-4-evidence-bridge.md](wave-4-evidence-bridge.md) — start after wave 3 lands.
2. [wave-5b-eval-gallery.md](wave-5b-eval-gallery.md) — start after wave 3 lands
   (coordinates with 5a if unlanded).
3. [backlog-server-hardening.md](backlog-server-hardening.md) — independent.
4. [backlog-desktop-hygiene-ci.md](backlog-desktop-hygiene-ci.md) — independent;
   the CI item is the highest-leverage single change in this directory.

## Settled decisions (do not relitigate)

- **The app is the daemon.** CLI and agents defer to the app for
  models/serving when present (discovery via agent-card + health probe),
  standalone fallback otherwise.
- **`understudy.eval_result.v1`** is the one eval-row schema; app tables and
  skills claim packets both adopt it. No converters between parallel formats.
- **Eval gallery gets real data; the Capture pane backend stays deferred.**
- **Official model ladder = certified `-understudy` QAT snapshots** (e2b
  default, 26b-a4b), vanilla rungs are diagnostics/interims; the snapshot
  service's `/catalog` is the single source of truth — never embed a model
  list without marking it a fallback.

## Conventions (all plans)

- Branch from fresh `origin/main`; never commit to main directly (branch
  policy: `gates` CI + review required; repo admins land with
  `gh pr merge N --merge --admin` after gates pass and review).
- Work in a git worktree; never touch the user's main working tree
  (it usually carries uncommitted work).
- Verify before opening the PR: `npm ci && npm test` at root AND
  `cargo check --all-targets && cargo test` in `apps/homescreen/src-tauri`
  when Rust changed. CI does NOT run cargo (see the hygiene plan) — you are
  the Rust gate.
- Commit messages end with the agent's Co-Authored-By line. PR bodies state
  test evidence and caveats honestly.
- The platform pieces (Cloudflare Worker `understudy-model-downloads`, R2
  bucket `understudy-model-snapshots`) deploy via the CF API with wrangler
  OAuth; procedure and registry layout are documented in the session memory
  `model-downloads-worker.md` (Claude) — other agents: ask the user before
  any worker/R2 change.
