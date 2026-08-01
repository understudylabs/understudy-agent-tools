# Training evidence (`understudy.training_evidence.v1`)

[`schemas/understudy.training_evidence.v1.schema.json`](../schemas/understudy.training_evidence.v1.schema.json)
is the smallest artifact that records a scored **rollout** as reusable training
evidence. One row is one **episode**: a single attempt at a task, decomposed
into **steps**, each carrying the **candidate** generation(s) the policy (or a
teacher/reference) produced, the **verifier outcome** for each candidate, and
**optional token-logprob** records.

The point of one shared row is that **SFT, DPO, and GRPO all project from the
same evidence** without re-running the workload — and every projection is gated
by the same two safety rules (split membership and the privileged-context
boundary).

It reuses conventions from the schemas already in this repo:

- **`understudy.eval_result.v1`** — nullable, additive-extensible rows
  (`additionalProperties: true`, consumers ignore unknown fields); `split`
  vocabulary (`train`/`dev`/`holdout`/`none`/null); "a real 0 is a scored
  value, null is missing"; never-invent-prices `cost`.
- **`understudy.verifier_handoff.v1`** — `splits`/`splits_sha256`/
  `holdout_sha256`/`contamination`; **terminal fractional reward by default,
  any shaping explicit and optional**.

This is a **local evidence artifact**. Reference source records, step prompts,
candidate outputs, and raw logprob arrays by hash or path
(`source.source_sha256`, `prompt_ref`, `output_ref`, `provenance.artifact_refs`)
when confidentiality requires it; **only inline text you are allowed to train
on**.

## Row shape

| Field | Meaning |
| --- | --- |
| `episode_id` (req) | This rollout. The join key to canonical conversation-runtime evidence. |
| `task_id` (req) | The task this is a rollout of. |
| `steps[]` (req) | Ordered decision points; a single-turn workload has one step. |
| `split` | `train` / `dev` / `holdout` / `none` / null — the training gate. |
| `seed` | Sampling seed; needed to reproduce a GRPO candidate group. |
| `model` | `{id, version, route, provider}` — the **model/version** that rolled out. |
| `policy_version` | Which policy iteration these rollouts were sampled under (on/off-policy). |
| `source` | The **source pin**: `{pin, source_sha256, dataset_id, task_version}`. |
| `reward` | Episode-level **terminal** reward `{value, kind, max, basis}`. |
| `latency_ms`, `cost` | Rollout cost/latency (`cost.usd` null unless a real basis exists). |
| `privileged_context` | The **privileged-context boundary** (see below). |
| `splits` | `{boundary, splits_sha256, holdout_sha256, contamination}`. |
| `provenance` | `{harness_sha256, split_sha256, verifier_sha256, artifact_refs}`. |

### Step

`{step_index, kind?, prompt?/prompt_ref?, candidates[], chosen_candidate_id?,
privileged_context?}`. `candidates` is non-empty: **one** candidate = a single
trajectory; **many** = a sampled group.

### Candidate

`{candidate_id, role?, model?, output?/output_ref?, reward?, verifier?,
token_logprobs?, selected?, privileged?}`.

- `role`: `policy` (the trainee), `reference` / `teacher` / `oracle` /
  `baseline` (comparison or supervision sources).
- `reward`: the **per-candidate** signal DPO/GRPO read.
- `verifier`: the verifier outcome — `{outcome (pass/fail/partial/error/
  unscored), score (0..1), verifier_id, reward, detail}`. `unscored` rows are
  excluded from reward stats, never counted as 0 (matching `eval_result.v1`).
- `token_logprobs[]`: `{token, token_id?, logprob, top_logprobs?}` — natural-log
  probs under the **sampling (old) policy**. Required for GRPO importance
  weighting; optional for SFT/DPO.

## The two safety gates

Every training projection MUST enforce both, or it can silently leak
evaluation signal into the weights:

1. **Split gate.** Training pools draw only from `split: "train"` (and, where a
   producer allows it, `"dev"`). `"holdout"` rows are evidence for return-eval
   scoring only and must never enter a training pool. Cross-check
   `splits.holdout_sha256` / `splits.contamination` — a `contaminated` or
   `unknown` pool is not train-safe until curated (see
   [`curate-trajectories`](../skills/curate-trajectories/SKILL.md)).
2. **Privileged-context boundary.** `privileged_context.in_policy_input === true`
   means a privileged signal (gold answer, oracle hint, teacher rationale,
   future/simulator state) reached the **trainable input**, so the row is not
   safe to train on as-is. The safe case is `verifier_only`: privilege used to
   *score* a candidate, never shown to the policy. A `teacher`/`oracle`
   candidate, or any candidate with `privileged: true`, is a valid comparison
   or reward source but must not become an SFT target or a DPO `chosen` side.

## Safe projections (SFT / DPO / GRPO)

All three read the same rows. `tests/training-evidence.test.mjs` ships
reference projectors (`sftTargets`, `dpoPairs`, `grpoGroups`) that demonstrate
the gates; the shapes below are the contract.

- **SFT** — for each train-safe episode, take the `selected` (or
  `chosen_candidate_id`) candidate per step whose `privileged !== true`; train
  on `(step.prompt, candidate.output)`.
- **DPO** — within a step, form `(chosen, rejected)` from two non-privileged
  candidates whose `reward.value` differs; higher reward is `chosen`. A
  `reference`/`teacher` candidate may be the reference side, but a `privileged`
  candidate is never the `chosen` policy target.
- **GRPO** — take the step's group of `role: "policy"` candidates, compute the
  group-relative advantage `reward.value - mean(group)`, and weight by the
  stored `token_logprobs` (importance sampling against the sampling policy).
  The `seed` reproduces the group; `policy_version` records which iteration it
  was sampled under so off-policy rows are corrected, not silently reused.

## No provider calls, no spend

Producing or consuming this artifact never calls a provider and never spends:
it records evidence you already have and projects it locally. Hosted training
that *consumes* the projected pool is authorized separately (a
`understudy.verifier_handoff.v1` packet with an explicit budget/approval), never
by the existence of these rows.

## Producers / consumers

- **Producers** stamp `schema_version`, `episode_id`, `task_id`, and at least
  one `step` with one candidate; everything else is nullable and enriched over
  time. Never change the meaning of a field — that requires
  `training_evidence.v2`.
- **Consumers** ignore unknown fields and honor both safety gates before any
  row enters a training pool.
