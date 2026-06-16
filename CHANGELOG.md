# Changelog

Notable, user-facing changes to the Understudy skills + CLI. Versions track the
plugin: `package.json`, `.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` are bumped together on any release that changes
the skill catalog or CLI surface, because an installed plugin has no other
staleness signal. After upgrading, run `/reload-plugins`.

The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses semantic-ish versioning (minor = new skill or new capability, patch = fixes).

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
