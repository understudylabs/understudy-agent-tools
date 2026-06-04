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
- [`understudy-workload-discovery`](understudy-workload-discovery/SKILL.md)
  finds and ranks AI workload candidates in a local repo before evaluation,
  provider changes, or optimization.
- [`understudy-capture-import`](understudy-capture-import/SKILL.md) finds local
  traces, eval fixtures, prompt files, logs, datasets, and benchmark artifacts
  before payload extraction or evaluation.
- [`understudy-evaluate`](understudy-evaluate/SKILL.md) compares prompts,
  traces, eval rows, datasets, or candidate models with explicit split
  boundaries.
- [`understudy-latency-triage`](understudy-latency-triage/SKILL.md) separates
  inference, context, routing, retry, streaming, and app latency.
- [`understudy-output-control`](understudy-output-control/SKILL.md) separates
  parser, JSON/schema, tool-call, and output-contract failures from model
  reasoning failures.
- [`understudy-blind-review`](understudy-blind-review/SKILL.md) prepares
  anonymized pairwise review packets for qualitative outputs.
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
- [`understudy-provider-integrations`](understudy-provider-integrations/SKILL.md)
  maps workloads to provider cookbooks, route decisions, and partner
  methodologies without approving spend.
- [`understudy-model-lookup`](understudy-model-lookup/SKILL.md) inspects model
  availability, runner compatibility, and local-vs-remote options.
- [`understudy-local-models`](understudy-local-models/SKILL.md) checks MLX,
  Apple Silicon, Ollama, and local runner readiness before local inference or
  route comparisons.
- [`understudy-value-reporting`](understudy-value-reporting/SKILL.md) turns
  measured evidence into conservative value reports.
- [`understudy-decision-packet`](understudy-decision-packet/SKILL.md) turns
  measured evidence into promote, hold, rerun, train, or publish decisions.
- [`understudy-publish-results`](understudy-publish-results/SKILL.md) prepares
  public-safe result summaries.
- [`understudy-tufte`](understudy-tufte/SKILL.md) improves report structure,
  analytical hierarchy, and concise evidence presentation.
- [`understudy-deslop`](understudy-deslop/SKILL.md) removes generic AI prose
  and overclaims from public-facing text.
- [`understudy-bootstrap`](understudy-bootstrap/SKILL.md) handles public setup
  checks when the CLI cannot be found.

## Public Safety

Default to local-only, no-upload, no-spend work. Public examples should use
synthetic fixtures, local `.understudy/` artifacts, public provider docs, or
public open-source projects.

Do not include customer names, domains, raw prompts, raw completions, traces,
secrets, private notes, internal runbooks, or hosted-control details in public
skills.
