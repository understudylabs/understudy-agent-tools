# Changelog

Notable, user-facing changes to the Understudy skills + CLI. Versions track the
plugin: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`,
`.opencode/adapter.json`, `.hermes/adapter.json`, and `.devin/adapter.json` are
bumped together on any release that changes the skill catalog, CLI surface, or
agent-platform adapter surface, because an installed plugin has no other
staleness signal. After upgrading, reload or enable the plugin in your coding
agent.

The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses semantic-ish versioning (minor = new skill or new capability, patch = fixes).

## [Unreleased]

### Added

- **Train on your own data, end to end.** Desktop/runtime 0.3.36 and CLI
  0.6.33 let you drop a spreadsheet (`.xlsx` workbooks now work, alongside CSV
  and other tables) onto Understudy Desktop and go all the way to a trained
  model: the app reads your file, proposes a training plan in plain language,
  and — only after you approve — runs the training in the cloud. Before
  anything is uploaded or any money is spent, a consent receipts card shows
  exactly what will leave your machine and what it will cost, and you choose
  between training locally or in the cloud. Messy data is handled gracefully:
  empty or ambiguous rows are set aside with a note instead of failing the
  whole import.
- **Dataset focus mode.** While you prepare and launch a training run, the
  training card becomes the whole window — no sidebars or clutter — and the
  window sizes itself to the content.
- **Watch your training run, step by step.** A live timeline shows each
  readiness gate as it is checked (with honest results, not spinners), and once
  training starts you get granular status: a loss curve sparkline, a header
  that names the current phase, and a running plain-language narration of what
  is happening. When the run finishes, a training outcome summary connects the
  results back to your evals.
- **`understudy training doctor`.** One CLI command walks the whole
  remote-training chain and reports the first broken link, so "why isn't my
  training working" has a one-step answer.
- **Sturdier app plumbing.** The Desktop's local API server is now supervised:
  it reports why it stopped, restarts itself with capped backoff, and
  health-checks itself, so background features recover without an app restart.
- **Truthful model cards in Chat.** One quiet info action beside the selected
  model now shows its QAT source, MLX conversion, decode contract, scoped
  certification, footprint, routing hints, and current slot state without
  leaving the conversation. The four `-understudy` cards explicitly distinguish
  compression and runtime certification from SFT or RL, and unknown provider or
  local routes stay neutral instead of receiving invented provenance.
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

- **Desktop window controls are simpler and updates are easier to verify.**
  Desktop/runtime 0.3.18 and CLI 0.6.15 remove the persisted always-on-top
  titlebar pin and its native capability. The macOS application menu and
  menu-bar tray now both expose **Check for Updates…**, with current,
  available, and failed checks reported through the shared operation notice.
  Automatic availability checks still run at launch and every 15 minutes.

- **Desktop chat is direct by default and releases can update in place.**
  Desktop/runtime 0.3.17 and CLI 0.6.14 stop attaching the experimental
  supervisor to ordinary model-picker turns. Explicit evaluation and agent API
  supervision remain available. This release also bootstraps Tauri's signed
  updater: future Desktop releases can download, verify, install, and restart
  through the shared in-app operation notice, with a manual signed-download
  fallback if an update cannot be applied.

- **Desktop installation no longer depends on npm or a machine-local Node.**
  Desktop/runtime 0.3.16 and CLI 0.6.13 ship one version-coupled cohort: a
  pinned Node 22.23.0 runtime, bundled CLI, Pi conversation sidecar, public
  package resources, and the two external runtime modules needed for HTTP and
  image handling. In-app repair verifies that signed local cohort instead of
  downloading an installer, and release checks verify its versions, hashes,
  dependencies, and Node license before publication.

- **Completed supervisor nudges replace the student answer cleanly.**
  Desktop/runtime 0.3.15 and CLI 0.6.12 preserve the original nudge verdict,
  interruption reason, and teacher continuation while replacing a completed
  structured answer instead of appending a second payload. Streaming nudges
  can still resume the student in place.

- **Desktop API conversations now count toward the exact-release migration
  cohort.** Desktop/runtime 0.3.14 and CLI 0.6.11 record versioned API turns in
  the same local route ledger as GUI turns, including caller-owned run and
  session identity, provider usage, tool rounds, supervision, compaction,
  latency, memory, and terminal status. Canonical traces can no longer succeed
  while the release monitor incorrectly remains at zero observed turns.

- **Every canonical-runtime build has an unambiguous CLI distribution
  identity.** Desktop/runtime 0.3.13 requires CLI 0.6.10. Reusing 0.6.9 after
  its runtime advanced from 0.3.12 to 0.3.13 would have let an installed older
  sidecar look current, so the release gate now audits the entire first-parent
  runtime transition rather than only the last public Desktop tag. A newly
  installed app cannot repair itself back to the older 0.6.8 command surface
  that lacks proof-scoped correction handoff, the GEPA spend fuse, and the
  portable fail-closed grocery proof.

- **CLI installs expose one honest staleness signal for the current command
  surface.** CLI and adapter manifests advance to 0.6.9 after the
  proof-scoped correction handoff, GEPA spend fuse, and portable fail-closed
  grocery proof landed. Desktop's required CLI floor advances with them, so an
  older 0.6.8 checkout can no longer look current while missing those commands.

- **macOS memory headroom stays conservative without collapsing to zero under
  compression.** Desktop 0.3.12 updates the pinned system-memory reader to the
  current Apple XNU available-memory calculation. Model warming still keeps
  the runtime multiplier, 16 GB dynamic reserve, heavy-model exclusivity, and
  GPU teardown delay, but active compressed-memory workloads no longer turn a
  nonzero safe margin into a misleading `0.0 GB`. CLI and adapter manifests
  advance to 0.6.8 with runtime/Desktop 0.3.12.

- **Healthy runtimes reconnect instead of asking for repair.** Desktop 0.3.11
  quietly rebinds the CLI-owned conversation runtime to the current
  authenticated Desktop tool session at launch. A healthy process with a
  stale tool credential is described as reconnecting, the UI clears the
  transient state after readiness, and genuine repair failures remain
  actionable. CLI and adapter manifests advance to 0.6.7 with runtime/Desktop
  0.3.11.

- **Desktop and its canonical sidecar now release as one compatibility unit.**
  CLI and adapter manifests advance to 0.6.6 with runtime/Desktop 0.3.10, and
  Desktop requires that CLI release. The release gate now rejects a runtime
  version bump unless the distributed CLI also advances and the Desktop CLI
  floor matches it, preventing a signed app from repairing back to an older
  sidecar.

- **Desktop repair now installs the ConversationRuntime version the app
  requires.** CLI and adapter manifests advance to 0.6.5 with runtime 0.3.8,
  and Desktop 0.3.8 requires that CLI release. The health check can no longer
  accept a stale 0.6.4 checkout and repeatedly repair back to runtime 0.3.7.

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
