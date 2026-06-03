# Understudy Skill Library

This library uses progressive disclosure: start with the entrypoint, then load
one specialist skill only when the developer's intent requires it.

## Entry Point

- [`understudy`](understudy/SKILL.md) routes demo, evaluation, optimization,
  training handoff, lab notes, local proxying, provider keys, model lookup, and
  local-model readiness.

## Specialist Skills

- [`understudy-demo`](understudy-demo/SKILL.md) scans a local repo for AI
  workload candidates, drafts a Workload Card, and falls back to synthetic
  fixtures when no local workload is available.
- [`understudy-evaluate`](understudy-evaluate/SKILL.md) compares prompts,
  traces, eval rows, datasets, or candidate models with explicit split
  boundaries.
- [`understudy-optimize`](understudy-optimize/SKILL.md) improves a measured
  workload while protecting holdout evidence.
- [`understudy-train`](understudy-train/SKILL.md) prepares SFT, preference, RL,
  adapter, or hosted-training handoffs.
- [`understudy-lab`](understudy-lab/SKILL.md) records longer experiment loops,
  budgets, artifacts, decisions, and next actions.
- [`understudy-local-proxy`](understudy-local-proxy/SKILL.md) handles local
  OpenAI-compatible proxying, trace capture, and replay.
- [`understudy-provider-keys`](understudy-provider-keys/SKILL.md) handles local
  credential setup and status checks.
- [`understudy-model-lookup`](understudy-model-lookup/SKILL.md) inspects model
  availability, runner compatibility, and local-vs-remote options.
- [`understudy-local-models`](understudy-local-models/SKILL.md) checks MLX,
  Apple Silicon, Ollama, and local runner readiness before local inference or
  route comparisons.

## Public Safety

Default to local-only, no-upload, no-spend work. Public examples should use
synthetic fixtures, local `.understudy/` artifacts, public provider docs, or
public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
