# Validate And Optimize — reference

Deep detail for [`SKILL.md`](SKILL.md). Read this when actually running an
optimization. See also [`../../docs/validate-and-optimize-contract.md`](../../docs/validate-and-optimize-contract.md)
(adapter + claim packet) and [`../../docs/optimize-references.md`](../../docs/optimize-references.md)
(papers).

## Headroom And Stopping Rules

GEPA only has signal when there is room to improve. Before spending budget,
confirm headroom from `baseline.json`'s per-row results:

- If the incumbent **never fails** the chosen metric, there is nothing to
  optimize — stop and report, do not run GEPA.
- If even a strong model **never succeeds** on the failing rows, the task is
  beyond the current frontier — stop; this is a data/validator problem, not a
  prompt problem.
- GEPA's headroom is the set of rows currently failing **and** that look
  promptable (a stronger reflection model can see the fix). Run GEPA against
  those.

Stopping rule during/after a run:

- If the local scorer **saturates to 1.0 quickly**, the scoring surface is too
  easy or the metric is a weak proxy. Do not claim a win — strengthen the metric
  or harden the holdout first.
- If prompt repair (GEPA) stalls with real headroom remaining, do **not** keep
  spending. Name the next rung — supervised fine-tuning / distillation — as the
  recommendation; this OSS skill does not implement training.

## Model Selection

GEPA uses two models. Keep them distinct:

- **Student** — the cheap candidate being optimized. Default to a small,
  inexpensive model per provider (e.g. Fireworks `qwen3-8b`, Anthropic
  `claude-haiku`, OpenAI `gpt-4.1-mini`, Gemini `flash`, Lilac `gemma-4-31b`).
  It must clear the model preflight (capabilities + context window) recorded by
  `understand-workload`.
- **`reflection_lm`** — the strong model that reads failures and proposes better
  prompts. Use a **frontier-tier** model (e.g. Gemini Pro, Claude Opus, GPT-5).
  It is optional: `None` falls back to weaker heuristic reflection — acceptable
  for exploration, but a weak reflection model is a silent quality cap.

Both run on the developer's own provider keys (local-first); neither requires an
Understudy account. Pick the student before optimizing and freeze it in the
candidate artifact.

## Feedback Function

GEPA's edge over scalar optimizers is **natural-language feedback**. The metric
must return, per failing row, a diagnosis of *why* it failed and what to change
— e.g. "first tool mismatch: expected `create_record`, got `update_record`;
expected ordered sequence … preserve stable argument keys" — not a bare score.
Build the feedback from the validator's real failure (assertion, schema error,
rubric criterion, judge rationale). Bland or pass/fail-only feedback wastes the
optimizer.

## Validator Kinds

`metric.json`'s `validator.kind` selects how a candidate is scored. Each must
produce `(score, feedback)`:

- `unit-test` / `golden` / `custom-command` — deterministic check; feedback is
  the failing assertion or diff.
- `schema` (Zod / JSON-schema `safeParse`) — separate `schema_pass` from
  `quality_pass`; a valid-shape, valid-enum output must not be failed merely for
  not matching a teacher trace verbatim (the proxy-strict-match trap).
- `rubric` — confirmed criteria list (id, description, review type); auto-drafted
  rubrics need human approval.
- `llm-judge` — must debias position with a swapped two-pass score
  `(r_ab − r_ba + 2) / 4`; never single-pass. Report judge-vs-human agreement
  separately from candidate preference.
- `human-review` — blind, order-randomized packet.

`kind: proxy` is rejected by the gate. If only a proxy is available, run
diagnostic mode and do not emit `claim.json`.

## Verifier Boundary

This skill optimizes against the confirmed **validator** (offline, deterministic
`(score, feedback)`). Full RL **verifiers / environments** (stateful trajectory
reward — PrimeIntellect `verifiers`, Tinker RL) are a later rung and are **out of
scope** here: they need hosted training and are never executed by this OSS tool.
`metric.json` may carry an optional `verifier_environment_id` that *points at*
such an environment for later use, but this skill never runs it and never imports
untrusted task code.
