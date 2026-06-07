# author-rl-env — reference

Supplementary detail for [`SKILL.md`](SKILL.md): how the obs/action contract is
recovered, a worked wiring against a real sim, the determinism caveat, and the
replay-conformance recipe. Load this only when actually building the wrapper.

## Recovering the obs/action contract from recorded trajectories

The batch sim env's per-task export already encodes everything the step API
needs, so the contract is *recovered*, not invented:

- **obs** = the `messages` list (system + user + prior tool results) plus the
  tool catalog.
- **action** = one assistant message carrying `tool_calls`.
- **tool result** = a message appended after the action is applied.
- **terminal reward** = the existing fractional `score`.

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
shaping** under the reward-hacking guard (SKILL Flow step 5).

## Replay-conformance recipe

1. `reset` a fresh sim from `initial_state`.
2. Recover the action sequence from `messages[].tool_calls` (double-decode).
3. Apply each action through `step()` (api_fetch mutates; api_search is inert).
4. **Hard-assert** reproduced `score` == recorded `score` — this is the
   conformance signal (it is exactly what the trainer optimizes).
5. **Soft-check** `end_state` equality *modulo* the volatile default fields from
   step 3 of the SKILL Flow ("Make reset(task, seed) deterministic"); raw
   full-dump equality will spuriously fail.

A score that fails to round-trip means the inversion changed semantics — fix the
wrapper, not the fixture.
