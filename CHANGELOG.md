# Changelog

Notable, user-facing changes to the Understudy skills + CLI. Versions track the
plugin: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`,
`.codex-plugin/plugin.json`, and `.agents/plugins/marketplace.json` are bumped
together on any release that changes the skill catalog, CLI surface, or
agent-platform adapter surface, because an installed plugin has no other
staleness signal. After upgrading, reload or enable the plugin in your coding
agent.

The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses semantic-ish versioning (minor = new skill or new capability, patch = fixes).

## [Unreleased]

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
