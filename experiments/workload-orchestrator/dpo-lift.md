# WL-OR DPO lift — Nemotron-3-Nano-30B-A3B on Tinker

**Verdict: not promotable.** Dev moves +0.10, the sealed holdout moves **0.00**,
and the run's real result is a *safety* change, not a capability change:
over-acting and forbidden writes go to zero and stay there. Emission discipline
— the dominant failure — is untouched.

## Run

| | |
| --- | --- |
| base | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`, renderer `nemotron3`, served through `scripts/tinker-openai-shim.py` |
| method | DPO, LoRA rank 32, beta 0.1, lr 1e-5, 3 epochs, batch 8 |
| pairs | 160 (86 outcome, 74 format) from 20 train tasks, 6 base samples/task at T=0.8 |
| pairs sha256 | `61f5e9d7c49a1b09fd9183167a388e1f22c1ed6d8b7c66f4fb8921bc6e5d55ec` |
| validation | [`artifacts/dpo-pairs.validation.json`](artifacts/dpo-pairs.validation.json) — 160/160 accepted, 0 dev/holdout ids |
| checkpoint | `tinker://…:train:0/sampler_weights/final` (ref only; no weights committed) |
| scoring | T=0, one attempt/task, malformed emissions rejected, outcome-first |
| holdout | read **once**, with frozen hash `6144b62…f8144` |

Base and candidate are scored by the same scorer through the same shim; only
the served weights differ.

## Dev (5 tasks) — [`artifacts/band-report-dev.json`](artifacts/band-report-dev.json)

| Band | tasks | base | DPO | Δ | base over-act / forbidden | DPO over-act / forbidden |
| --- | --- | --- | --- | --- | --- | --- |
| multi-write | 4 | 0.063 | 0.188 | **+0.125** | 2 / 2 | **0 / 0** |
| single-write | 1 | 0.000 | 0.000 | 0.000 | 0 / 0 | 0 / 0 |
| **all** | 5 | **0.050** | **0.150** | **+0.100** | 2 / 2 | **0 / 0** |

Zero-score rate 0.80 → 0.60; exact-1 stays 0.00; malformed-emission rate stays
1.00.

## Sealed holdout (5 tasks) — [`artifacts/band-report-holdout.json`](artifacts/band-report-holdout.json)

| Band | tasks | base | DPO | Δ | base over-act / forbidden | DPO over-act / forbidden |
| --- | --- | --- | --- | --- | --- | --- |
| multi-write | 4 | 0.188 | 0.188 | 0.000 | 0 / 0 | 0 / 0 |
| single-write | 1 | 0.000 | 0.000 | 0.000 | 0 / 0 | 0 / 0 |
| **all** | 5 | **0.150** | **0.150** | **0.000** | 0 / 0 | 0 / 0 |

Per family the holdout is not even flat underneath: the candidate gains
`summary-orchestration` (0.00 → 0.50) and loses `agent-state-partial-failure`
(0.50 → 0.00), netting zero. On 5 tasks that is one task each way — noise, not
a trend.

## Reading it honestly

- **The dev gain does not survive the seal.** Dev and holdout are 5 tasks each;
  +0.10 on dev is two half-credit assertions. The holdout is the number that
  counts, and it is 0.00. Nothing here justifies routing traffic.
- **The guardrail result is real and one-directional.** Base wrote outside the
  addressed set in 2 of 5 dev episodes; the candidate does so in 0 of 10
  episodes across dev and holdout. Preference pairs that punish an
  outcome-zeroing write taught scope, not skill. No over-acting regression was
  introduced anywhere — the thing this run had to not break, it did not break.
- **Format discipline was not learned.** Every episode of both policies still
  contains at least one rejected emission. The 74 format pairs were mined from
  the base's own retries, so `chosen` is the base's own imperfect recovery —
  the pairs teach "recover after being told", not "emit correctly first time".
  This is the defect to fix before the next attempt, and it caps the ceiling:
  a policy that burns turns on malformed output cannot finish a 4-leg chain
  inside the step budget.
- **What would change the answer.** (1) Rejection-sample a *correct* emission
  for the chosen side instead of reusing the base's retry; (2) widen the slice —
  30 tasks with a 5-task holdout cannot resolve a 0.05 effect; (3) fix format
  at the decoding layer (constrained/grammar decoding) and spend the preference
  budget on chain completion instead.

## Cleanup

Both sampling shims are stopped after scoring. The only paid artifacts are the
one Tinker training run and the rollouts listed above; the checkpoint is
referenced by URI and no weights, pairs beyond the synthetic fixture, or raw
telemetry are committed.
