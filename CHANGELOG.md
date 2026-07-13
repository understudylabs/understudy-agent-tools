# Changelog

Notable, user-facing changes to the Understudy skills + CLI. Versions track the
plugin: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`,
`.opencode/adapter.json`, and `.hermes/adapter.json` are bumped together on any
release that changes the skill catalog, CLI surface, or agent-platform adapter
surface, because an installed plugin has no other
staleness signal. After upgrading, reload or enable the plugin in your coding
agent.

The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses semantic-ish versioning (minor = new skill or new capability, patch = fixes).

## [Unreleased]

### Added

- **Truthful native Rust migration baseline.** `understudy runtime conformance
  --backend native` now uses the owner-only authenticated Desktop API to force
  the one-release Rust fallback against a named warm slot. It passes only the
  exact prompt-only case the legacy headless boundary actually supports and
  records richer frozen scenarios as explicit gaps, preventing synthetic
  wrapper events from overstating image, tool, cancellation, compaction,
  restart, or supervision parity.
- **Understudy Desktop agent control plane.** The public CLI now discovers the
  owner-only Desktop capability file and exposes a versioned OpenAPI 3.1
  contract for capabilities, models, downloads, residency, canonical turns,
  exact cancellation/replay, and supervisor feedback. Agent turns can pair a
  small local slot with a distinct local supervisor slot while preserving
  student, supervisor, and teacher events and usage. A frozen synthetic
  grocery-marketplace proof compares small, main, and supervised routes without
  uploads, provider calls, or an LLM judge.
- **Supervisor-decision labeling.** Runtime 0.3.1 gives every supervisor verdict
  a stable marker, including accepted `continue` and `stop` decisions, so human
  feedback can measure missed errors as well as bad nudges and takeovers.

### Fixed

- **Dropped Workload Card review no longer asks a local model to open an
  inaccessible filesystem path.** Desktop now passes only the bounded,
  metadata-only summary into chat, treats its fields as untrusted data, and
  frames a frozen behavior benchmark instead of a file-count check. Structured
  eval rows plus a prompt produce a 10-example incumbent-versus-candidate plan
  while source payloads remain unread until the user explicitly continues.
- **Runtime conformance can no longer pass with ambiguous token attribution.**
  Runtime 0.3.5 requires every usage event to name its exact model, records the
  supervisor model on every verdict, and makes the frozen takeover gate prove
  separate student, supervisor, and teacher usage whose model identities match
  the emitted deltas and teacher continuation. Reference traces must also carry
  the exact frozen user message and image identity instead of merely containing
  similarly named event types. The suite id and fixture hashes changed so older
  evidence fails closed instead of satisfying the release deletion gate.

- **Desktop restart no longer strands tool calls on a stale sidecar token.**
  Idempotent runtime start now compares an injected Desktop tool credential
  with the owner-only stored credential using a timing-safe comparison. If the
  Desktop token rotated while the sidecar stayed healthy, the CLI replaces the
  sidecar before the next turn instead of allowing post-restart tool execution
  to fail with 401.
- **The curl installer can no longer finish looking successful with zero
  coding-agent adapters installed.** `install.sh` now logs the raw agent-menu
  answer and the resolved `--agents` selection to the install log ("Agent
  adapter selection: …"), records installed / skipped / failed per adapter,
  and prints an adapter summary after step 2. The final "Where this goes next"
  section only shows per-agent next steps (e.g. `/reload-plugins` +
  `/understudy:onboard`) for adapters that actually installed. When adapters
  were requested (anything other than `--agents none`) but none installed, or
  an explicitly requested adapter failed on a missing CLI/manifest, the
  installer prints a loud warning with per-platform manual install commands
  and exits with the new status code 3 instead of a clean 0. Adapters the
  user disabled themselves (e.g. `--agents claude-code --no-claude`) count as
  intentional CLI-only installs, not failures, and still exit 0. An
  incomplete adapter step is no longer marked resumable-complete, so
  `--resume` retries adapter installation instead of skipping past it.
- **`understudy setup` crash.** The legacy Claude-compatible skill-copy path
  crashed with `ENOENT ... skills/onboard/frontmatter.md` on every run:
  `frontmatter.md` was folded into `skills/onboard/SKILL.md` in the
  plugin-first onboarding change (0.2.0) without updating `setup.ts`, so every
  release 0.2.0–0.6.0 shipped the command broken. `setup` now installs
  `SKILL.md` directly, rewriting the frontmatter `name` to match the installed
  `understudy-onboard` directory and the `description` to carry both trigger
  surfaces the loose copy serves (first-run onboarding *and* the historical
  "convert to Understudy" / "add GEPA" conversion phrases), appending a short
  routing section that points conversion requests at `setup-code.md`, and
  copying the per-stack recipes and reference docs alongside it, mirroring
  `skills/onboard/` so relative links keep working. README now presents the
  Claude Code plugin install as the primary path with `understudy setup` as
  the legacy loose-copy fallback.

## [0.6.0] — 2026-06-22

### Added

- **Hermes Agent adapter support.** Added a `.hermes/adapter.json` sentinel,
  registry entry, installer autodetection, and `--agents hermes`. The installer
  registers the shared `skills/` tree in `skills.external_dirs`
  (`~/.hermes/config.yaml`) through a durable `~/.understudy/skills` symlink, so
  Hermes discovers the same `SKILL.md` files natively — no copies, no Python
  plugin. Config edits are idempotent and back up `config.yaml`; activation is
  `/reload-skills` (no restart needed).
- **OpenCode adapter support.** Added native OpenCode skill discovery through
  `.opencode/skills`, a `/understudy-onboard` command, installer autodetection,
  and `--agents opencode`.

### Changed

- **Unified agent-adapter setup.** Added `install-agent-adapter` as the canonical
  install/update/verify/uninstall skill for Claude Code, Cursor, Codex, OpenCode,
  and Hermes Agent. The older platform-specific install skills now route to it as
  compatibility shims.
- `understudy doctor` now includes OpenCode and Hermes adapter version drift
  checks, the installer can launch OpenCode when it is the selected launchable
  adapter, and Cursor adapter install now preserves unexpected existing plugin
  paths.
- Clarified that OpenCode support is a native skills/commands adapter, not a
  JS/TS OpenCode plugin, and documented the symlink/restart behavior.
- OpenCode installs now end with a manual TUI handoff instead of auto-launching
  `opencode` from the curl-piped installer, avoiding Bun/OpenCode TTY failures.

## [0.5.0] — 2026-06-19

### Added

- **`ladder` remote model picker.** The ladder now builds remote lanes from the
  Understudy gateway catalog when org context is available, falls back to the
  public remote model list, and supports explicit existing model ids via
  `UNDERSTUDY_LADDER_REMOTE_MODELS` (for example `glm-5.2`). The viewer consumes
  `/models` as the source of truth instead of hard-coding only `glm-5.1`.

### Changed

- `understudy run` now injects the non-secret `UNDERSTUDY_ORG_ID` when known so
  local tools can discover org-scoped hosted metadata without reading
  credentials from disk.

## [0.4.0] — 2026-06-19

### Added

- **Multi-agent plugin adapters.** Added a shared adapter registry and
  `understudy platforms` so Claude Code, Cursor, and Codex can expose the same
  `skills/` tree without platform-specific forks.
- **Cursor plugin support.** Added `.cursor-plugin/plugin.json`, an
  `install-cursor-plugin` skill, installer autodetect/linking into
  `~/.cursor/plugins/local/understudy`, and README/docs activation guidance.
- **Codex plugin support.** Added `.codex-plugin/plugin.json`, a local Codex
  marketplace at `.agents/plugins/marketplace.json`, an `install-codex-plugin`
  skill, installer marketplace registration, and `/plugins` activation
  guidance.

### Changed

- `install.sh` now supports `--agents auto|all|claude-code|cursor|codex|none`
  and `UNDERSTUDY_AGENT_PLATFORMS` so the curl installer can autodetect or
  explicitly target multiple coding-agent harnesses.
- `understudy doctor` now checks version consistency across Claude Code,
  Cursor, and Codex plugin metadata.

### Fixed

- **`ladder` scoring integrity.** Wired the `no_extra_writes` anti-shotgun check
  into all three hard tasks (it existed but was used by none), so a model that
  does the right work but also shotguns — extra emails, or touching the
  `sla_route` P2 decoy ticket `T-556` — now loses `strict`. The numeric
  `body_contains` match is digit-bounded (`3808` is no longer satisfied by
  `38080`), and a task with only negative assertions is rejected at load. Verified:
  the gold trajectory and the frontier (`glm-5.1`) still score `strict=1.0`; a
  shotgun trajectory now fails.

## [0.3.0] — 2026-06-16

### Added

- **`ladder` skill** — a local web UI for an immediate local-vs-frontier model
  comparison (the onboarding "climb"): a local mlx model and a frontier gateway
  model run the same task with live thinking + tool-call traces, scored against a
  synthetic world. Skill catalog goes from 21 to 22. (Existing installs need this
  release to pick it up — see the note at the top.)
- **`ingest-traces`** gained a LOTUS semantic-triage reference and orchestrator
  routing for developers who already have production traces.

### Changed

- **`recursive-language-model`** now measures the decomposition *process*, not
  just the outcome.
- Folded June-2026 local-model + gateway benchmark learnings into the
  `run-local-model-lab`, `manage-local-models`, and gateway-touching skills.
- **Gateway inference always streams** across the skills, recipes, and CLI (the
  edge cuts long non-streaming calls), so frontier and routed runs are reliable.
- Installer glow-up with an agent-native two-phase login for a demoable,
  agent-first sign-up; `install.sh` bash 3.2 fix.
- CLI workload admin commands (`list`/`create`/`update`) moved to `/admin/v1`;
  hosted-contract docs linked from the README and gateway-touching skills.

## [0.2.0] — 2026-06-11

### Added

- **Plugin staleness signal** so updates actually reach existing installs:
  `install-plugin` compares the installed version against the repo's
  `plugin.json`, `understudy doctor` fails if the three version files drift, and
  the release checklist requires the joint bump.
- Telemetry disclosure in the CLI (`status` shows a telemetry line; login prints
  the opt-out once) and a global `--json` flag surfaced in every subcommand.

### Changed

- Consolidated the skill catalog from 32 to 21 focused skills.
