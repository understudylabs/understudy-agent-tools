---
name: understudy-agent-tools
purpose: Public OSS conventions for Understudy agent tools.
updated: 2026-06-03
status: draft
---

# AGENTS.md

This repository is public and MIT licensed. Treat every file as future-facing
OSS from the first commit.

## Boundary

- Local-first by default.
- No uploads, provider calls, telemetry, or hosted jobs without an explicit user
  action.
- No customer data, private traces, secrets, private repo names, or internal
  incident notes.
- Examples must use synthetic data or small public fixtures.

## Architecture

Keep one layer per spine:

- CLI: `src/understudy_agent_tools/`
- scripts: `scripts/`
- skills: `skills/`
- vendor shims: `vendor/`
- docs: `docs/`

The CLI is a router. Scripts and skills should remain independently readable.

## Skills

The public entrypoint is `skills/understudy/SKILL.md`.

Use progressive disclosure: start with the fat skill, then route to the
specialist playbook for the current intent. Keep specialist skills short and
move deeper command notes into `reference.md`.

## Extraction Discipline

When importing code from private Understudy repos:

1. Remove private data and internal-only assumptions.
2. Replace customer examples with synthetic fixtures.
3. Add or preserve license metadata for vendored code.
4. Add a smoke test or dry-run command.
5. Keep the commit scoped to one spine.
