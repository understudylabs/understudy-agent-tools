---
name: understudy-agent-tools
purpose: Public OSS conventions for Understudy agent tools.
updated: 2026-06-03
status: draft
---

# AGENTS.md

This file tells a coding agent how to operate in this repo. There are two
audiences — serve the right one.

## Are you helping a user, or editing the library?

- **Helping a user get value from Understudy** (improve an LLM app, cut
  cost/latency, run a local model, pick a route) → start with **Install the
  plugin** below, then run onboarding. This is the common case.
- **Contributing to this repo** (changing skills, CLI, docs) → skip to
  [Working on this repo](#working-on-this-repo).

When unsure, assume the user wants help with their workload, not to edit the
library.

## Install the plugin (do this first for users)

Understudy is delivered as a **Claude Code plugin**. Install it — do not try to
operate from the raw source tree. The plugin loads the skills, and **the skills
are the product**: they are what let you explain what Understudy is, why it
matters, and walk the user from a captured trace to a measured, shipped
improvement. Without them you are guessing; with them you have the playbooks, the
safety gates, and the local-first optimization loop.

Recommend installation to the user in plain terms, e.g.: *"Understudy works best
as a Claude Code plugin — it installs locally, makes no network calls, and gives
me the playbooks to actually improve your LLM workload. Want me to install it?"*
Then use the [`install-plugin`](skills/install-plugin/SKILL.md) skill:

```bash
claude plugin marketplace add "$(git rev-parse --show-toplevel)"
claude plugin install understudy@understudy-skills
```

The user then types `/reload-plugins` once — **no restart needed**. You cannot
run that step yourself; surface it and wait.

### It is reversible — say so

Installing is low-risk and fully reversible. Tell the user the uninstall path up
front so saying yes feels safe:

```bash
claude plugin uninstall understudy@understudy-skills   # remove the plugin
claude plugin marketplace remove understudy-skills      # forget the local source
```

Nothing outside Claude Code's own plugin registry is touched, and nothing
uploads or spends. Mention uninstall exists — then recommend they keep it
installed to get the most out of Understudy.

## Then onboard the user

Once installed (and `/reload-plugins` run), run the
[`onboard`](skills/onboard/SKILL.md) skill. It is the engaging first-run
experience: it backgrounds a small American open-model download while it profiles
the machine and interviews the user, then writes a durable
`~/.understudy/profile.json` so every later skill can meet the user where they
are. Onboarding hands off to the [`understudy`](skills/understudy/SKILL.md)
orchestrator.

## How to behave with users

Follow [`docs/engagement-and-pacing.md`](docs/engagement-and-pacing.md): plan up
front, announce time estimates *before* starting long work, background blocking
tasks and stay interactive while they run (start the long download first, then
interview during it), fill wall-clock with useful analysis (alternative-model
cost estimates, benchmark lookups), and keep telling the user where they are in
the loop.

---

## Working on this repo

This repository is public and MIT licensed. Treat every file as future-facing
OSS from the first commit.

## Boundary

- Local-first by default.
- No uploads, provider calls, telemetry, or hosted jobs without an explicit user
  action.
- No customer data, private traces, secrets, private repo names, or internal
  incident notes.
- Examples must use synthetic data or small public fixtures.

Read these before extraction, release, or public docs work:

- [`docs/privacy-and-data-boundaries.md`](docs/privacy-and-data-boundaries.md)
- [`docs/security.md`](docs/security.md)
- [`docs/telemetry.md`](docs/telemetry.md)
- [`docs/oss-release-boundary.md`](docs/oss-release-boundary.md)
- [`docs/release-checklist.md`](docs/release-checklist.md)

## Architecture

Keep one layer per spine:

- CLI: `src/` for thin durable shortcuts, auth, artifact checks, and runtime wrappers
- scripts: `scripts/` for repo hygiene only, not product CLI code
- skills: `skills/`
- vendor shims: `vendor/`
- docs: `docs/`

The CLI should stay thin. Skills explain the capability; the CLI only makes
durable product shortcuts reliable enough for an agent to monitor.

## TypeScript + uv Python Bridge

This repo is skills-first and TypeScript-backed. Port product behavior from
`understudy-agent` into TypeScript only when it affects auth, command routing,
durable execution, artifact checks, or public safety boundaries. Put workflow
judgment and implementation guidance in skills and docs.

Python is allowed only as isolated runtime glue for Python-native workload
logic such as GEPA, DSPy, eval harnesses, rubric helpers, dataset transforms,
or future training/export adapters. Use the bridge pattern:

1. TypeScript owns the command, flags, validation, approval gates, and artifact
   paths.
2. TypeScript invokes Python with `uv run --no-project` or an ignored local
   `.understudy/` runtime.
3. Python receives file paths or JSON, returns structured JSON on stdout, and
   never becomes an importable package in this repo.
4. Do not add `pyproject.toml`, `uv.lock`, `src/understudy_agent_tools/`, or
   checked-in `.py` product modules without a deliberate architecture change.

See [`docs/uv-python-bridge.md`](docs/uv-python-bridge.md).

## Skills

The public entrypoint is `skills/understudy/SKILL.md`.

Use progressive disclosure: start with the fat skill, then route to the
specialist playbook for the current intent. Keep specialist skills short and
move deeper command notes into `reference.md`.

### Catalog growth rule

New findings default to a `reference.md` inside the skill that owns the user
intent. A new top-level skill requires a user utterance no existing skill
claims, and the PR must name which existing skills it was checked against.
Frontmatter descriptions are user-intent triggers (≤60 words, quoted user
phrases, no unglossed internal jargon), not pipeline-position statements.

## Extraction Discipline

When importing code from private Understudy repos:

1. Remove private data and internal-only assumptions.
2. Replace customer examples with synthetic fixtures.
3. Add or preserve license metadata for vendored code.
4. Add a smoke test or dry-run command.
5. Keep the commit scoped to one spine.

Before opening a PR that changes skills, docs, scripts, package metadata, or
vendored files, run:

```sh
npm run check
git diff --check
```

Before broad CLI or adapter PRs, also check file size and diff shape:

```sh
git diff --stat
wc -l src/**/*.ts tests/*.mjs
```
