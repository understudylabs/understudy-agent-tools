# Multi-base bake-off — results

One verifier, one serving contract, one fixture, the same ladder (base → SFT → GRPO) on three
owned bases. Everything below comes from the artifacts in `outputs/bakeoff/` (not committed);
each carries `contract_sha256`, `fixture_sha256` and `split_sha256`, and the ranker refuses to
compare rows that disagree on any of them.

| | |
| --- | --- |
| Fixture | `automationbench-simple-api-offline-v2`, 216 tasks (120 train / 36 dev / 60 sealed holdout), split seed 7 |
| `fixture_sha256` | `918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22` |
| `contract_sha256` | `721851ba0edfce0890e6d092eeac3c9693c1517fcf217cb045cd8f858bfe839b` |
| Serving contract | `understudy.bakeoff.serving_contract.v1` — one JSON tool call per turn, temp 0, max 2000 tokens, 14 turns, 3 malformed strikes, 4000-char observations |
| Verifier | `automationbench-offline` terminal `partialCredit`, identical for scoring, SFT export and RL reward |
| Lane | Tinker LoRA for all three bases, served through the repo's OpenAI-compatible shim so the wire protocol is identical across bases |
| Ladder coverage | base (both renderers) → SFT → GRPO complete on all three bases; GRPO-from-SFT probed on Qwen3.5-9B and receipted as a structural no-op |
| Holdout | **clean — not executed.** Ranking basis is dev. |

## Ranked table (dev basis)

| Rank | Base (best rung) | Dev | p50 req s | Task s | Tok/task | $/1k tasks |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `Qwen3.5-9B` / SFT | **1.0000** | 1.29 | 7.1 | 3089 | 2.19 |
| 2 | `Qwen3.6-27B` / SFT | **1.0000** | 1.48 | 7.7 | 3114 | 6.21 |
| 3 | `Nemotron-3-Nano-30B-A3B` / SFT | 0.9861 | 11.06 | 70.5 | 5730 | — |

Cost is an estimate: measured token counts × Fireworks serverless list price (see
`price-card.json`), not a reconciled invoice. Nemotron has no published serverless price and
ranks without a cost column. Ties on score break toward the cheaper, faster candidate — which
is the whole decision this bake-off exists to make.

**Recommendation: standardize on Qwen3.5-9B + oracle SFT for this workload.** It ties the 27B on
every band and every tier at a third of the token cost and the lowest latency. The 27B is the
fallback if a future workload separates them; Nemotron is not competitive here at 10× the
latency for a lower score.

Every band and both tiers select the same candidate, because two candidates are perfect on dev
and the tie-break is serving cost. Per-band separation on this fixture would need the holdout
(not run) or a harder fixture.

## The ladder

| Rung | Split | n | Mean | v1 | hard | Over-action | Malformed | p50 req s | Task s | Tok/task |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `nemotron3-nano-base-nothink` | dev | 36 | 0.3902 | 0.6528 | 0.2589 | 8 | 0.111 | 2.15 | 22.0 | 7820 |
| `nemotron3-nano-base-think` | dev | 36 | 0.9031 | 0.9167 | 0.8963 | 0 | 0.083 | 12.27 | 129.4 | 10800 |
| `nemotron3-nano/grpo-from-base` | dev | 36 | 0.8337 | 0.8750 | 0.8130 | 2 | 0.028 | 14.70 | 117.5 | 9046 |
| `nemotron3-nano/sft` | dev | 36 | **0.9861** | 1.0000 | 0.9792 | 0 | 0.028 | 11.06 | 70.5 | 5730 |
| `qwen3.5-9b-base-nothink` | dev | 36 | 0.6832 | 0.7778 | 0.6359 | 1 | 0.194 | 1.27 | 9.9 | 6755 |
| `qwen3.5-9b-base-think` | dev | 36 | 0.3380 | 0.2500 | 0.3819 | 1 | 0.472 | 2.51 | 35.2 | 9791 |
| `qwen3.5-9b/grpo-from-base` | dev | 36 | 0.6647 | 0.7778 | 0.6081 | 2 | 0.111 | 1.47 | 12.9 | 7122 |
| `qwen3.5-9b/sft` | dev | 36 | **1.0000** | 1.0000 | 1.0000 | 0 | 0.000 | 1.29 | 7.1 | 3089 |
| `qwen3.6-27b-base-nothink` | dev | 36 | 0.9220 | 0.9167 | 0.9246 | 0 | 0.028 | 1.46 | 9.3 | 5132 |
| `qwen3.6-27b-base-think` | dev | 36 | 0.9405 | 1.0000 | 0.9107 | 0 | 0.083 | 3.62 | 34.0 | 7989 |
| `qwen3.6-27b/grpo-from-base` | dev | 36 | 0.8942 | 0.9167 | 0.8829 | 1 | 0.056 | 1.50 | 11.0 | 5311 |
| `qwen3.6-27b/sft` | dev | 36 | **1.0000** | 1.0000 | 1.0000 | 0 | 0.000 | 1.48 | 7.7 | 3114 |

### What the ladder says

**Thinking is a renderer choice, not a base property, and it flips sign per base.** Nemotron goes
0.39 → 0.90 with thinking on; Qwen3.5-9B goes 0.68 → 0.34. Selecting a renderer per base on dev
before training is not a nicety — picking one renderer for all three bases would have mis-ranked
two of them. The renderer is part of the hashed candidate policy for exactly this reason.

**SFT is where the value is on this workload.** 563 oracle turns from 120 train tasks take every
base to ≥0.986 dev, and it *lowers* serving cost: Qwen3.5-9B drops from 6755 to 3089 tokens/task
and from 9.9 s to 7.1 s, because a trained policy stops exploring and stops emitting prose.
Malformed rate goes to zero. The largest base advantage at the base rung (0.92 vs 0.68) disappears
entirely after SFT — the thing the 27B was buying you was recoverable by 120 tasks of supervision.

**GRPO bought nothing here, for two different reasons.**
- *From SFT:* the SFT checkpoints score **1.000 on all 120 train tasks**, so every rollout group is
  constant-reward and is dropped by the group filter. Receipt
  `outputs/bakeoff/grpo/qwen3.5-9b-from-sft-receipt.json` records `frac_all_good = 1.0` and
  `reward/total = 1.0` for every group — a structurally guaranteed no-op, not a tuning failure.
- *From base:* 8 steps × 8 groups × 8 rollouts moved train reward around (0.43 → 0.73 within a
  batch) but landed at 0.665 dev for Qwen3.5-9B, 0.894 for Qwen3.6-27B and 0.834 for Nemotron —
  every one at or below its own best base rung. The result is consistent across all three bases,
  so it is a property of the budget and the fixture, not of one model. RL from base at this budget
  does not reach what SFT reaches in 10 minutes, and RL on top of SFT has no gradient left.

The honest reading is that **this fixture is saturated by SFT**, so it cannot rank bases post-RL.
Ranking post-RL, as originally scoped, needs a fixture where oracle imitation does not reach 1.000
— the sealed holdout may or may not be such a fixture, and it was not run.

## Failure clusters

| Cluster | Where it shows |
| --- | --- |
| Malformed output (prose instead of one JSON object) | Qwen3.5-9B base with thinking, 0.472 of episodes; the model narrates the observation instead of acting |
| Over-action (writes outside `allowedWrites`) | Nemotron base without thinking, 8 of 36 episodes — it scores zero on the whole task, which is most of the 0.39 |
| Long-chain truncation | Qwen3.6-27B base without thinking, band `long-chain` at 0.548 while every other band is 1.000. It survives RL: Nemotron GRPO-from-base is 1.000 on five bands and 0.440 on `long-chain` |
| All three vanish after SFT | zero over-action, zero forbidden writes, zero malformed at the SFT rung on every base |

Long-chain is the one band that separates candidates at every rung except SFT, which is where a
harder fixture should concentrate: it is the only place the ladder still has signal left.

## Evidence semantics

- **Budget vs actual** — token counts, request counts and latency are measured per episode; dollar
  figures are *estimated upper bounds from list prices*, explicitly not reconciled usage. No
  provider usage record is attached to any number here.
- **Evidence scope** — dev split, 36 tasks per row, one attempt per task, temperature 0.
- **Request isolation** — every episode gets a fresh verifier handle; no state crosses tasks.
- **Hash-bound splits** — every artifact carries fixture/split/contract hashes; the ranker fails
  closed on any disagreement.
- **Holdout** — clean, never read. `holdout_executed: false` in `ranked.json`.
- **Calibration** — n = 36 per row. A one-task difference is 0.028, so 0.986 vs 1.000 is one task,
  and nothing here separates the top two candidates on quality at all.
- **Claim boundary** — this ranks three bases on one synthetic offline API-automation fixture at
  one budget, on dev. It does not claim a holdout result, does not claim RL is useless in general,
  and does not extrapolate to workloads outside this fixture's nine bands.

## Artifacts

| Artifact | Contract |
| --- | --- |
| `outputs/bakeoff/*-dev.json` | `understudy.bakeoff.evidence_row.v1` |
| `outputs/bakeoff/sft/oracle-train.manifest.json` | `understudy.bakeoff.sft_manifest.v1` |
| `outputs/bakeoff/{sft,grpo}/*-receipt.json` | `understudy.bakeoff.train_receipt.v1` (checkpoint refs only, never weights) |
| `outputs/bakeoff/ranked.json` | `understudy.bakeoff.ranked_table.v1` |
| `experiments/multi-base-bakeoff/contracts/experiment-executor-submit-request.json` | vendored `understudy.executor-submit.v1` |
