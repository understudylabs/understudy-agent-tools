# Stage 1 — Author the RL environment (step-API MDP)

The first executable stage of [`prepare-verifier-handoff`](../SKILL.md), entered
only after the decision gate has confirmed that the workload genuinely needs
learned multi-step policy training.

[`design-simulated-environment`](../../design-simulated-environment/SKILL.md)
produces a **batch episode runner**: `run(task, model) -> transcript +
final-state score`, where the model lives *inside* the loop and the env drives
it. An RL trainer needs the inverse: the trainer owns the policy and calls the
env one action at a time.

```text
reset(task_id, seed) -> obs                        # build sim state, return messages + tools
step(action)         -> (obs', reward, done, info) # apply ONE tool call, mutate state, return result
```

This stage **inverts control** on the existing sim env so an external trainer
(Prime Intellect Verifiers) can drive it. You do **not** rebuild the simulated
backend — it is the same object; you re-expose it behind a step boundary. You do
**not** run RL here; you produce the env that gets packaged in
[stage 2](stage-2-package-env.md).

## Safety gates (authoring-specific)

- **Local-first, no upload.** The env, fixtures, and recorded trajectories stay
  local. Do not upload source, traces, prompts, or datasets, and never print or
  commit provider keys. RL training itself happens at the partner, not here.
- **Synthetic state only.** Carry forward the sim env's invented entities; never
  seed reset() from real customer records.
- **No live side effects.** `step()` mutates in-memory sim state only — never a
  real app, never the live MLX router beyond local inference.
- **Preserve the holdout boundary.** The RL train pool MUST EXCLUDE the frozen
  dev/holdout rows. Contaminating the RL pool with eval rows invalidates every
  later claim — gate on this explicitly (Flow step 7).

## Entry conditions

- No batch-scored sim env yet (no `run(task, model)` with a final-state score)?
  Build it first in
  [`design-simulated-environment`](../../design-simulated-environment/SKILL.md).
  Do not author a step API over tools that aren't simulated.
- Model choice, prompt, or route still has headroom? Stay in evaluation —
  [`optimize-agentic-workload`](../../optimize-agentic-workload/SKILL.md). An
  MDP wrapper is only worth it once the workload genuinely needs *learned
  multi-step behavior*.
- Cheaper weight-update rung not yet tried? A local distillation / pedagogical
  pass via
  [`local-distillation-lab`](../../local-distillation-lab/SKILL.md) may close
  the gap without a hosted trainer — rule it out first.
- Haven't yet decided *whether* RL is the right arm — off-policy SFT vs
  on-policy repair vs RL, or measuring learnability/concentration? That
  arm-selection decision lives in
  [`recursive-language-model` → pedagogical training](../../recursive-language-model/references/pedagogical-training.md).
  This stage is **only** the mechanical `reset`/`step` inversion you build
  *after* RL is the confirmed arm — it does not decide the arm.
- **Continue here only** when a working sim env exists and the confirmed need is
  a step-API MDP for an RL trainer to drive.

## Key leverage

Recorded trajectories pay for most of this stage. The sim env's per-task JSON
already has `messages` (each with `role` + `tool_calls`), `steps`, `end_state`,
`finish_reasons`, and a fractional `score`. That recording IS the obs/action
contract:

- **obs** = the `messages` list (plus the tool catalog).
- **action** = one assistant message carrying `tool_calls`.
- **tool result** = a message appended after applying the action.
- **terminal reward** = the existing fractional `score`.

So the serializable contract is *recovered*, not invented, and a recorded
trajectory doubles as a **conformance fixture**: replay it through `step()` and
assert you reproduce the same `end_state` + `score`. If it round-trips, the
wrapper is faithful to the batch runner.

## Flow

Cover all five inversion properties, the replay-conformance test, and the
holdout gate. Each is a gate, not a suggestion.

1. **Factor the agent loop OUT (inversion of control).** Find the driver loop in
   the sim env that calls the model, executes the tool, and appends the result.
   Split it: the *env* keeps "apply tool call → mutate state → return result";
   the *trainer* keeps "choose next action." The env must never import or call a
   model. Verify by grep — no model/provider call inside the env module.

2. **Isolate per-rollout state (parallel-rollout-safety audit).** Many episodes
   run concurrently; each needs its own sim-state instance. Audit for
   module-level / global mutable state, shared dicts, class attributes, or a
   singleton backend — these cross-contaminate parallel rollouts and are the
   primary failure mode. Move all mutable state into an instance created in
   `reset()`. Confirm two interleaved episodes don't see each other's writes.

3. **Make reset(task, seed) deterministic.** Expose `reset` as a pure function of
   `(task_id, seed)`: same seed ⇒ byte-identical initial state and obs. Route
   every nondeterministic source (RNG, clock, id generation, dict ordering)
   through the seed. Same seed twice must produce equal `obs`. **Watch
   constructor-default timestamps and generated ids** — the easiest nondeterminism
   to miss. (Verified on AutomationBench: `WorldState()` stamps a wall-clock
   `gmail.internal_date` at build time, so two resets differ on a field no task
   touches; it breaks full-state conformance while leaving the reward identical.)
   Pin these to the seed/initial_state.

4. **Pin the serializable obs/action contract.** obs and action cross a process
   boundary, so both must JSON-serialize. Recover the contract from the recorded
   trajectory JSON (above): obs = messages + tools; action = an assistant message
   with `tool_calls`; the step appends a tool-result message. Write the schema
   down; reject non-serializable payloads at the boundary.

5. **Add the per-step reward hook + shaping (with a reward-hacking guard).**
   Terminal reward = the existing fractional `score`, emitted when `done`.
   Optional shaping: small intermediate credit for verifiable progress (e.g.
   hitting the *correct app/endpoint* BEFORE the mutation). **Reward-hacking
   guard:** shaped credit must require real progress toward the gold final state,
   never reward mere activity (tool-call count, retries, length), and the shaped
   optimum must coincide with the terminal optimum. If shaping could be maxed
   without raising the final `score`, drop it. Keep shaping additive and off by
   default.

6. **Replay-conformance test (required).** Replay each recorded trajectory's
   actions through `reset()` + `step()` in order. **Hard-assert reproduced
   `score` (the reward) equals the recorded score** — that is the conformance
   signal, because it is exactly what the trainer optimizes. Treat full
   `end_state` equality as a *soft* check, **modulo the nondeterministic default
   fields from step 3** (project them out or pin them); raw full-dump equality
   will spuriously fail otherwise. (On AutomationBench this wrapper reproduced
   the score 200/200; full-dump equality was 0/200 purely from the timestamp
   default — reward fidelity, not state divergence.) A trajectory whose *score*
   fails to round-trip means the inversion changed semantics — fix the wrapper,
   not the fixture.

7. **EXCLUDE holdout/dev from the RL train pool.** Build the RL task pool from
   the frozen seed-7 **train** split only; the dev and holdout rows must never
   enter `reset()` during training. Assert the pool's task_ids are disjoint from
   dev/holdout — ideally consume a decontaminated selection from
   [`curate-trajectories`](../../curate-trajectories/SKILL.md) rather than
   hand-filtering. State the sample size and flag it as small.

8. **Continue to packaging.** Carry the env + the obs/action schema + the
   conformance result into [stage 2](stage-2-package-env.md), which packages it
   for Prime Intellect Verifiers and builds the return-eval. This repo does not
   run that training.

## Recovering the obs/action contract from recorded trajectories

The batch sim env's per-task export already encodes everything the step API
needs, so the contract is *recovered*, not invented (see Key leverage above).

Watch the on-disk encoding: real exports store each `tool_calls` entry as a
**JSON-encoded string**, and inside it `arguments` is itself a JSON string —
double-decode (`json.loads` twice) when reconstructing actions. The stable task
id lives in the `name` field; `id` is only a 1-based enumeration index.

## Worked wiring — AutomationBench `simple`/`api`

Verified integration map (reuse the sim's own primitives; do not rebuild):

- The episode loop is **not** in the workload repo — it lives in the vendored
  `verifiers` library (`MultiTurnEnv.rollout`). Factor *that* out; the trainer
  owns the policy.
- `WorldState(**info["initial_state"])` — the per-task sim state. It is
  instantiated per task with no module-level globals, so parallel rollouts are
  already isolation-safe. The `initial_state` IS the seed (there is no RNG seed).
- `api_fetch(world=..., method, url, params, body)` — the state mutator (one
  step). `api_search(query, top_k)` is read-only discovery.
- `partial_credit(state)` — the reward (fractional final-state score), with the
  anti-free-credit logic already built in.
- Task definition: dataset row keyed by `task`; its `info` is a JSON string with
  `initial_state` / `assertions`. Set `AUTOMATIONBENCH_STRICT_ASSERTIONS=0` so a
  buggy assertion yields reward 0 instead of crashing the rollout.

## Determinism caveat (verified, not hypothetical)

`WorldState()` stamps a wall-clock `gmail.internal_date` at construction time. Two
resets therefore differ on a field no task touches and no assertion reads. Across
all 200 recorded trajectories this wrapper reproduced the **score 200/200**, but
full `end_state` equality was **0/200** — entirely from that timestamp, i.e.
reward fidelity, not state divergence. Pin such constructor defaults to the
seed/initial_state, or project them out before comparing state.

## Running-example specifics

The grounding workload: AutomationBench `simple`/`api` endpoint-discovery, with
local **Gemma-4-E2B** served via the MLX router at `:8081`, and frozen **seed-7
splits (train 18 / dev 6 / holdout 6)**. The sim backend (endpoint catalog +
state + final-state validator) is re-exposed behind `reset`/`step`; reward = the
fractional final-state score, with optional **"correct app before mutation"
shaping** under the reward-hacking guard (Flow step 5).

## Replay-conformance recipe

1. `reset` a fresh sim from `initial_state`.
2. Recover the action sequence from `messages[].tool_calls` (double-decode).
3. Apply each action through `step()` (api_fetch mutates; api_search is inert).
4. **Hard-assert** reproduced `score` == recorded `score` — this is the
   conformance signal (it is exactly what the trainer optimizes).
5. **Soft-check** `end_state` equality *modulo* the volatile default fields from
   Flow step 3 ("Make reset(task, seed) deterministic"); raw full-dump equality
   will spuriously fail.

A score that fails to round-trip means the inversion changed semantics — fix the
wrapper, not the fixture.

## Stage output

Before moving to stage 2, record:

- whether the agent loop was factored out (env makes no model call);
- the parallel-rollout-safety audit result (per-instance state, no globals);
- determinism status (same seed ⇒ same obs);
- the serializable obs/action schema, recovered from recorded trajectories;
- the reward hook, any shaping, and the reward-hacking-guard verdict;
- the replay-conformance result (N trajectories round-tripped, end_state + score
  reproduced);
- confirmation the RL train pool excludes dev/holdout, with sample size flagged.

## External docs

- Prime Intellect Verifiers overview: `https://docs.primeintellect.ai/verifiers/overview`
- Prime Intellect Verifiers training: `https://docs.primeintellect.ai/verifiers/training`
