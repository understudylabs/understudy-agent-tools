---
name: author-rl-env
description: Use to invert a batch-scored simulated environment into a stateful step-API MDP (reset/step) that an external RL trainer can drive — "turn my sim env into a gym-style env", "expose reset and step for RL", "make a verifiers-trainable environment", "factor the agent loop out of my env", "give the trainer a step() API", or any handoff from design-simulated-environment toward prepare-verifier-handoff. Re-exposes the same simulated backend; never runs RL here.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Author an RL environment (step-API MDP)

`design-simulated-environment` produces a **batch episode runner**:
`run(task, model) -> transcript + final-state score`, where the model lives
*inside* the loop and the env drives it. An RL trainer needs the inverse: the
trainer owns the policy and calls the env one action at a time.

```text
reset(task_id, seed) -> obs                        # build sim state, return messages + tools
step(action)         -> (obs', reward, done, info) # apply ONE tool call, mutate state, return result
```

This skill **inverts control** on the existing sim env so an external trainer
(Prime Intellect Verifiers) can drive it. You do **not** rebuild the simulated
backend — it is the same object; you re-expose it behind a step boundary. You do
**not** run RL here; you produce the env that gets handed off.

## Safety Gates

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

## Decision Gate

- No batch-scored sim env yet (no `run(task, model)` with a final-state score)?
  Build it first in
  [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
  Do not author a step API over tools that aren't simulated.
- Model choice, prompt, or route still has headroom? Stay in evaluation —
  [`../optimize-api-workflow/SKILL.md`](../optimize-api-workflow/SKILL.md) or
  [`../optimize-agentic-search/SKILL.md`](../optimize-agentic-search/SKILL.md).
  An MDP wrapper is only worth it once the workload genuinely needs *learned
  multi-step behavior*.
- Cheaper weight-update rung not yet tried? A local distillation / pedagogical
  pass via
  [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) (or
  the `pedagogical-learning` skill) may close the gap without a hosted trainer —
  rule it out first.
- Haven't yet decided *whether* RL is the right arm — off-policy SFT vs on-policy
  repair vs RL, or measuring learnability/concentration? That arm-selection
  decision lives in the `rlm-pedagogical-training` skill. This skill is **only**
  the mechanical `reset`/`step` inversion you build *after* RL is the confirmed
  arm — it does not decide the arm.
- You have the trainer-ready env and just need the hosted handoff? Skip to
  [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
- **Continue here only** when a working sim env exists and the confirmed need is
  a step-API MDP for an RL trainer to drive.

## Key leverage

Recorded trajectories pay for most of this skill. The sim env's per-task JSON
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
   not the fixture. See `examples/replay_conformance.py`.

7. **EXCLUDE holdout/dev from the RL train pool.** Build the RL task pool from
   the frozen seed-7 **train** split only; the dev and holdout rows must never
   enter `reset()` during training. Assert the pool's task_ids are disjoint from
   dev/holdout — ideally consume a decontaminated selection from
   [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) rather
   than hand-filtering. State the sample size and flag it as small.

8. **Hand off.** Package the env + the obs/action schema + the conformance result
   and route to
   [`../package-verifier-env/SKILL.md`](../package-verifier-env/SKILL.md) (which
   packages it for Prime Intellect Verifiers and builds the return-eval) via
   [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
   This repo does not run that training.

## Running example

AutomationBench `simple`/`api` endpoint-discovery, local Gemma-4-E2B served via
the MLX router at `:8081`, frozen seed-7 splits (train 18 / dev 6 / holdout 6).
The sim backend (endpoint catalog + state + final-state validator) is re-exposed
behind `reset`/`step`; reward = the existing fractional final-state score, with
optional "correct app before mutation" shaping under the reward-hacking guard.

## Output Standard

End with:

- whether the agent loop was factored out (env makes no model call);
- the parallel-rollout-safety audit result (per-instance state, no globals);
- determinism status (same seed ⇒ same obs);
- the serializable obs/action schema, recovered from recorded trajectories;
- the reward hook, any shaping, and the reward-hacking-guard verdict;
- the replay-conformance result (N trajectories round-tripped, end_state + score
  reproduced);
- confirmation the RL train pool excludes dev/holdout, with sample size flagged;
- `result_type: rl-env-authored` or `blocked`;
- one recommended next step, usually `package-verifier-env` via
  `prepare-verifier-handoff`.

## References

- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md) — builds the batch-scored sim env this skill inverts.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) — supplies the decontaminated, holdout-free RL train pool.
- [`../optimize-api-workflow/SKILL.md`](../optimize-api-workflow/SKILL.md) — the API-workflow final-state validator and metric axes that become the reward.
- [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) — the cheaper local weight-update rung to rule out before hosted RL.
- [`../package-verifier-env/SKILL.md`](../package-verifier-env/SKILL.md) — packages this env for the partner and builds the return-eval.
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) — the hosted RL-training handoff this skill ends on.
- Prime Intellect Verifiers overview: `https://docs.primeintellect.ai/verifiers/overview`
- Prime Intellect Verifiers training: `https://docs.primeintellect.ai/verifiers/training`
