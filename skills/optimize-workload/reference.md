# Optimize Workload — reference

Deep detail for [`SKILL.md`](SKILL.md). Read this when actually running an
optimization. See also [`../../docs/optimize-workload-contract.md`](../../docs/optimize-workload-contract.md)
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
  `capture-evidence`.
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
- `rubric` / `llm-judge` — graded scoring against a confirmed criteria list.
  Debias position with the swapped two-pass score
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

These steps are now skill-led until TypeScript commands are restored. See
[`../../docs/current-functionality.md`](../../docs/current-functionality.md).

**Evaluate (measure before changing).** Prefer an existing eval suite / traces /
app route over a toy fixture; replay locally when it can estimate quality or
regression risk. State, for the workload: current route, token shape / volume,
latency target vs observed, cost/request, quality gate + acceptable regression
band, and the candidate route. A small live comparison only when replay can't
answer the economic question (and only under the approval gate). Inference for
evaluation follows the same Understudy-first default as optimization.

**Optimize (highest-leverage intervention first).** Consider prompt
prefill/repair, parser/schema repair, context trimming, route/candidate swap, and
GEPA according to the observed failure class. Confirm metric, incumbent route,
split boundaries, sample size, and failure taxonomy first; use a dry-run to
validate mechanics before any paid step, not to substitute for the full plan.

## Optimization-Target Menu

The ladder above is *how* you change. This menu is *what* you change. Before
spending budget, pick the **target most likely to resolve the observed failure
mode**. When multiple targets have comparable likelihood, prefer the cheaper and
more reversible one; otherwise choose the stronger intervention and disclose the
cost. Changing a tool description may be better than swapping the model when the
failure is actually in tool guidance.
State the chosen target and the failure mode it addresses in the run artifact:

- **System prompt** — instructions, role, constraints applied to every call.
  Cheap; first stop for instruction-following or formatting misses.
- **User prompt template** — the per-row scaffold around inputs. For misses
  driven by phrasing, missing fields, or weak few-shot framing.
- **Tool descriptions** — names, arg docs, and when-to-use text. For wrong-tool,
  bad-argument, or redundant-call failures in an agentic workload.
- **Routing policy** — which model/route a request takes. For failures
  concentrated on a request class a different route handles better.
- **Model choice** — the student model itself. Use early when capacity or
  capability evidence makes weaker prompt-only iterations unlikely to close the
  gap.
- **Context-window strategy** — what gets packed and trimmed. For truncation,
  lost-in-the-middle, or cost-from-bloat failures.
- **Retrieval parameters** — top-k, chunking, reranking, query construction. For
  missing-evidence or irrelevant-context failures in a RAG workload.
- **Retry strategy** — retry count, backoff, and reformulation on failure. For
  intermittent parse or transient-error failures, not systematic quality misses.

**Decide (turn evidence into one call).** Classify the evidence level, then pick
**exactly one**: promote, hold, rerun, optimize, train, or publish. Below
holdout/live validation, mark promotion as **blocked** — emit an optimization
lead, not a win. The decision packet records: decision + evidence level,
baseline vs candidate, artifact paths, caveats / missing evidence, and the
approval-gated next step. This is the same gate `claim.json` enforces.

Two principles hold across every target and lane:

- **Keep a candidate history.** Record each candidate you try — target chosen,
  variant, score, and why it was kept or rejected — so the trail is auditable
  and a regression can be rolled back to a known-good prior. Do not overwrite
  prior candidates; append.
- **Never claim an improvement without measured before/after evidence.** A delta
  is only real when baseline and candidate were scored on the same metric and
  split, and the numbers are tied to the hash-bound `claim.json` contract (see
  SKILL.md → Claim Rules). No before/after, no claim — only a lead.

## Inference Boundary

Optimization may need inference. Never inspect or print secret values. A named
activated workflow may run its declared provider calls without repeated
confirmation. Use
`understudy login --email <developer-email>` plus
`understudy run -- <local command>` for the Understudy inference path, or
record BYO provider-key readiness only as redacted presence/source metadata.
Keep the selected provider, model, budget, and data class in the run artifact.

## Optimization Lanes

Three ways to optimize, picked by commitment and workload shape:

1. **Eval-input adapter lane.** The CLI can run
   `optimize-workload adapter run --adapter eval-input-gepa --manifest ...`
   through a local `uv` runtime. It reads a local manifest, excludes holdout
   rows, invokes upstream `gepa.optimize`, and writes
   `eval-input-candidate.json` plus `proof-packet.json`. This is the pattern for
   future Python-native adapter ports: TypeScript handles CLI/auth/artifacts;
   Python stays inside the ignored uv runtime.
2. **In-place prompt optimization.** A future adapter should run the developer's
   real workload via an injected `infer` function and evolve the prompt or route
   component they already ship. Truest to production, lowest commitment.
3. **Program lane (opt-in).** The agent can scaffold a reusable DSPy program
   from local samples using the program-scaffold pattern, verify parity, then
   run the approval-gated `adapter run --adapter dspy-gepa --execute` path
   against the Understudy gateway with exact `dspy==3.3.0` and
   `gepa[dspy]==0.1.1`, separate student/reflection deployments, an explicit
   dollar cap, and a conservative input/output token-price basis. A
   `--program-bridge` may provide a multi-component student, trainset, valset,
   `ScoreWithFeedback` metric, and deployable export callback. Before either LM
   is used, its offline hook binds provider-free validation
   of the loaded executable bundle to the workload-adapter source,
   tool-schema, package receipt, typed request/expected fields, and any required
   tool-write/world-state probe; an admission-only command then performs one
   live canary and emits the exact receipt required by the later compile. The
   optimizer records package/config/program
   state and a canonical bundle SHA-256. Full GEPA optimization over that program is
   gated by parity: the scaffolded program must reproduce the incumbent
   baseline before optimization, or you optimize a reconstruction that diverges
   from production.

## Rubric Reward (the OSS half of the verifier rung)

The agent can turn a human-confirmed `rubric.json` plus an injected or approved
judge verdict into `(score, feedback)` using a local script when the workload
needs a graded metric richer than pass/fail.
Pointwise scoring surfaces failing-criterion rationales as feedback. Pairwise
scoring and human-agreement calibration remain future hardening before trusting
a rubric judge for claims. The rubric + judgment is OSS-native and valuable on
its own; **RL training over the reward stays hosted** (the verifier boundary
above).
