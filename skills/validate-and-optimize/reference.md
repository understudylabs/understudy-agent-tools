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

`metric.json`'s `validator.kind` dispatches the runner; each kind must produce
`(score, feedback)`. Invocation fields (`command`, `callable`, `schema_path`,
`rubric_path`) say *how* to run it:

- `command` / `callable` — run a deterministic check (a unit test, golden-output
  diff, or any script/function); feedback is the failing assertion or diff.
- `schema` (Zod / JSON-schema `safeParse`) — separate `schema_pass` from
  `quality_pass`; a valid-shape, valid-enum output must not be failed merely for
  not matching a teacher trace verbatim (the proxy-strict-match trap).
- `rubric` / `llm-judge` — graded scoring via `scripts/rubric_reward.py` against a
  confirmed criteria list. Debias position with the swapped two-pass score
  (`(r_ab − r_ba + 1)/2` for [0,1] judge scores; the internal judge uses `÷4` on a
  [-1,1] scale); never single-pass. Auto-drafted rubrics need human approval; gate
  on `judge_human_agreement` before trusting the judge.
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

## Folded steps: evaluate · optimize · decide

These three were folded in from former standalone skills; full originals in
[`appendix/understudy-evaluate`](../../appendix/understudy-evaluate/SKILL.md),
[`appendix/understudy-optimize`](../../appendix/understudy-optimize/SKILL.md),
[`appendix/understudy-decision-packet`](../../appendix/understudy-decision-packet/SKILL.md).

**Evaluate (measure before changing).** Prefer an existing eval suite / traces /
app route over a toy fixture; replay locally when it can estimate quality or
regression risk. State, for the workload: current route, token shape / volume,
latency target vs observed, cost/request, quality gate + acceptable regression
band, and the candidate route. A small live comparison only when replay can't
answer the economic question (and only under the approval gate). Inference for
evaluation follows the same Understudy-first default as optimization.

**Optimize (cheapest intervention first).** Climb the evidence ladder: prompt
prefill/repair → parser/schema repair → context trimming → route/candidate
swap → GEPA. Confirm metric, incumbent route, split boundaries, sample size, and
failure taxonomy first; run the smallest dry-run before any paid step; match the
intervention to the *observed* failure class, not a guess.

**Decide (turn evidence into one call).** Classify the evidence level, then pick
**exactly one**: promote, hold, rerun, optimize, train, or publish. Below
holdout/live validation, mark promotion as **blocked** — emit an optimization
lead, not a win. The decision packet records: decision + evidence level,
baseline vs candidate, artifact paths, caveats / missing evidence, and the
approval-gated next step. This is the same gate `claim.json` enforces.

## Inference (Understudy-first, BYO fallback)

Optimization always needs inference, so the **default is Understudy inference**.
`understudy_agent_tools.inference.resolve_backend()` checks for an Understudy
credential (`UNDERSTUDY_API_KEY` env, then the `Understudy-credentials` keychain
blob — same resolution as the agent CLI) and, if present, routes model calls
through the Understudy gateway (one credential, all providers, credit-metered).

When not logged in, the lane **recommends `understudy login`** and falls back to
the developer's own provider keys — so login is the expected default, not a hard
gate; BYO stays supported for the register-averse. `build_dspy_lm(model)` /
`dspy_program.resolve_lm(model)` apply this default for the DSPy lane; the
in-place adapter's `infer` uses the same backend. The credential is never logged
(`login_status()` returns only a boolean + source).

## Optimization Lanes

Two ways to optimize, picked by commitment and workload shape:

1. **In-place prompt optimization (default).** `scripts/_adapter.py`'s
   `UnderstudyGepaAdapter` runs the developer's *real* workload via an injected
   `infer` (single call or multi-turn agent loop) and evolves the prompt(s) they
   already ship. Truest to production, lowest commitment, no DSPy. For MCP /
   tool-use agents, prefer gepa's built-in `mcp_adapter` / `terminal_bench_adapter`
   over hand-rolling.
2. **DSPy-program lane (opt-in).** `scripts/dspy_program.py` scaffolds a DSPy
   program from the Workload Card + samples, then `dspy.GEPA` optimizes it
   natively — instructions across predictors + bootstrapped few-shot demos, and
   `dspy.ReAct` for multi-turn. Richer, but the user must adopt the program as
   runtime, and it is **gated by `parity_check`**: the scaffolded program must
   reproduce the incumbent baseline on holdout before GEPA runs, or you optimize a
   reconstruction that diverges from production.

## Rubric Reward (the OSS half of the verifier rung)

`scripts/rubric_reward.py` turns a human-confirmed `rubric.json` + an injected
LLM judge into `(score, feedback)` — a graded `metric` (richer than pass/fail)
usable directly by either lane. `score_pointwise` weights per-criterion judgments
and surfaces failing-criterion rationales as feedback; `score_pairwise` debiases
position; `judge_human_agreement` is the calibration gate before trusting a
rubric judge. The rubric + judgment is OSS-native and valuable on its own; **RL
training over the reward stays hosted** (the verifier boundary above).
