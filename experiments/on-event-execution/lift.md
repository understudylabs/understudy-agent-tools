# DPO lift — synthetic workload `on-event-execution`

Base vs. DPO on the workload's own synthetic slice. Outcome-first scoring:
terminal final state, not argument text.

## Arm

| Pin | Value |
| --- | --- |
| fixture | `on-event-execution-offline-v1` (96 tasks: train 56 / dev 16 / holdout 24) |
| fixture sha256 | `8cfffb5500f40c03a8394d3f244b3277a20a4815faead4def326236a7e511190` |
| dev split sha256 | `74a6cdbfe6a5ec504e82dc0ce550a91300a5a6f705ec7ce402b063382abf79f5` |
| base | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`, renderer `nemotron3` |
| method | DPO, beta 0.1, 3 epochs, LoRA rank 32, lr 1e-5, batch 8 |
| pairs | 42 mined near-hit pairs (bounded 23 / extended 15 / variable 4), sha256 `437e4fce9e5423dd5de734bdc3157d88b32071bcf9d6c6ca3f46af9f26df184a` |
| scoring | both arms through the same sampling shim at temperature 0 |

Base and candidate differ only in weights: same shim, same renderer, same
sampling parameters, same frozen dev split.

## Lift, per band

| Band | Tasks | Base | DPO | Δ | Base exact-1 | DPO exact-1 | Base zero | DPO zero |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bounded | 10 | 0.400 | 0.667 | **+0.267** | 2 | 4 | 5 | 2 |
| extended | 4 | 0.500 | 0.750 | **+0.250** | 1 | 2 | 1 | 0 |
| variable | 2 | 0.400 | 0.400 | +0.000 | 0 | 0 | 1 | 1 |
| **overall** | **16** | **0.425** | **0.654** | **+0.229** | 3 | 6 | 7 | 3 |

## Regression guards

The regression this arm has to rule out is a candidate that raises its mean by
**over-acting** — writing records the event never addressed. It did not.

| Guard | Base | DPO |
| --- | ---: | ---: |
| over-acting episodes | 0 | 0 |
| forbidden writes | 0 | 0 |
| malformed episodes | 16/16 | 15/16 |
| malformed emissions | 49 | 43 |

Zero forbidden writes on both sides, so the lift is real work, not extra work.

## What this does not show

- **The variable band did not move**, and it is the band the memo flags as the
  tail risk. Two dev tasks and four training pairs is not enough to move it or
  to claim it is unmovable — it is unmeasured, not disproven. Its malformed
  emissions also rose (6 → 11) while its score stayed flat, which is the shape
  of length-control trouble rather than intent trouble. That is the next thing
  to fix, with more variable-band pairs.
- **The dev split is 16 tasks.** A +0.229 mean on 16 tasks is a direction, not
  an interval. Do not quote it as a production delta.
- **The holdout split is clean and was never executed.** Running it was dropped
  by explicit instruction after this arm started; its frozen hash is carried in
  the verifier contract and appears in no submit payload. There is therefore
  **no unseen-split confirmation** of this lift, and the dev number carries
  whatever selection pressure came from configuring on dev.
- Everything is measured on synthetic fixtures. No production request was
  replayed; no production output was scored.

## Budget vs actual

Actual, not estimated:

| Step | Sampled / trained tokens | Elapsed |
| --- | ---: | ---: |
| base dev (16 tasks) | 251,184 | 431 s |
| base train sweep (56 tasks × 4 rollouts) | 3,787,208 | 5,608 s |
| DPO training (42 pairs, 3 epochs) | 442,621 | 201 s |
| DPO dev (16 tasks) | 273,282 | 497 s |
