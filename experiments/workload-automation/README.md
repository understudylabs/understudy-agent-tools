# WL-AU — synthetic workload repair arm

WL-AU is the neutral code for one production workload studied as a repair
target: can a small open model, tuned on outcome-changing preference pairs,
stand in for frontier inference without changing what the customer sees?

The short answer from this arm: **the workload is worth repairing, and this
particular repair did not measurably work.** The dev delta is +0.019 with a 95%
interval of [-0.051, +0.090]. That interval contains zero, and 11 tasks improved
against 11 that regressed. Reporting it as a win would be reporting noise.

## What is here

| Artifact | What it is |
| --- | --- |
| `gate-validation.json` | fixture gate result: oracle 1.0, sentinel 0.0, leakage clean, frozen-holdout refusal |
| `aggregates.json` | telemetry aggregates for WL-AU — counts, tokens, USD, distributions. No rows. |
| `repair-memo.md` | why WL-AU is a repair target and which bands fail |
| `candidate-policy.json` | the hashed candidate policy (base model, DPO hyperparameters, mining rules) |
| `pairs.manifest.json`, `pairs.validation.json` | mined-pair identity and the fail-closed gate verdict |
| `train-receipt.json` | Tinker run: pair hash, hyperparameters, checkpoint ref, wall clock |
| `dpo-lift.json` | the lift table plus an `understudy.experiment-result.v1` record |
| `scores/` | per-task scores for every scored run |
| `contracts/` | vendored sealed platform schemas this arm validates against |
| `workflow-contract.md` | how this arm maps onto Workflow steps and artifacts |
| `scripts/` | the pair miner and the contract-artifact emitter |

## 1. Gate validation

The fixture `automationbench-simple-api-offline-v2` already existed, so this arm
validated and reused it rather than minting a competing slice.

| Gate | Result |
| --- | --- |
| Oracle mean reward | 1.0000 |
| Sentinel max reward | 0.0000 |
| Label / observation leakage | clean |
| Unreachable literals | none |
| Frozen-holdout refusal | refuses with no hash and with a wrong hash; 60 tasks with the correct hash |

216 tasks, split 120 train / 36 dev / 60 holdout, fixture
`918023a1…`, splits `fa96e121…`. Every task is an index-generated synthetic
record.

## 2. Repair target

Full reasoning in `repair-memo.md`; aggregates in `aggregates.json`. The
headline: WL-AU is **10.1% of project requests but 26.8% of project cost**, rank
2 of 21 workloads, and 72.7% of its requests finish inside 512 output tokens.
That bounded majority is the repairable slice — it sidesteps the variable-length
failure mode that makes the 4,096-token tail unattractive.

## 3. DPO lift

Base `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`, served and trained on Tinker,
renderer `nemotron3`. 960 rollouts over the 120 train tasks at temperature 0.9
yielded **126 preference pairs** across all nine bands, each one a pair of
rollouts from the same task that diverge at a *canonical action signature* —
wording differences are discarded before pairing, so the model is only ever
taught a difference that changed the outcome. DPO: beta 0.1, 3 epochs, LoRA rank
32, 126 pairs, 530 s wall clock.

Primary evidence is the sampled protocol: 4 samples per dev task at temperature
0.7, 144 episodes per arm, `max_tokens` 1024.

| Metric | Base | DPO | Δ |
| --- | --- | --- | --- |
| Mean score | 0.8030 | 0.8219 | +0.0189 |
| Exact-1 rate | 0.7153 | 0.7292 | +0.0139 |
| Zero rate | 0.1250 | 0.1042 | −0.0208 |
| Malformed rate | 0.4444 | 0.4792 | +0.0348 |
| Over-acting episodes | 0 | 0 | 0 |
| Forbidden effects | 5 | 3 | −2 |

Paired over 36 dev tasks: mean delta **+0.019**, 95% bootstrap CI
**[−0.051, +0.090]**, 11 wins / 11 losses / 14 ties, sign-test p = 1.0.
**Not significant.**

### Per band (sampled, 4 samples/task)

| Band | Tasks | Base | DPO | Δ |
| --- | --- | --- | --- | --- |
| single-write | 4 | 0.750 | 1.000 | +0.250 |
| discovery | 4 | 0.875 | 0.875 | 0.000 |
| multi-write | 4 | 0.802 | 0.719 | −0.083 |
| cross-record | 6 | 0.875 | 0.896 | +0.021 |
| multi-hop | 4 | 0.531 | 0.625 | +0.094 |
| cascade | 4 | 0.953 | 0.812 | −0.141 |
| long-chain | 4 | 0.565 | 0.679 | +0.113 |
| conditional | 4 | 0.938 | 0.969 | +0.031 |
| aggregation | 2 | 1.000 | 0.750 | −0.250 |

Each band holds two to six tasks. The chained bands move up and the short bands
move around, which is the shape you would want if the tuning were working — but
at n = 4 per band none of these cells can carry an argument on its own.

### Safety guards

Over-acting stayed at zero episodes in both arms, and forbidden effects fell
from 5 to 3. The guard held: nothing about the tuning made the model write more
freely. With counts this small, the drop is a reassurance, not a result.

### Holdout

`state: holdout_locked`. The base model was scored once on the sealed holdout
with the frozen hash (0.8056 mean, 60 episodes) before the instruction to stop
executing the holdout arrived; the candidate was never scored on it. There is
therefore **no held-out comparison**, and the base number is a reference point
only. `dpo-lift.json` records this asymmetry as `holdout_executed: true` with
`holdout_clean: false` rather than hiding it.

## Why `max_tokens` is 1024

At 512 the model's reasoning preamble regularly consumed the whole budget before
it emitted its tool call, and the episode died malformed: base dev scored 0.640
with an 83% malformed rate. At 1024 the same base scores 0.825 with 47%. The
lower setting was measuring truncation, not decision quality, so both mining and
scoring are pinned to 1024. Malformed emissions remain the single largest
failure cluster in both arms and are the obvious next target — ahead of any
further preference tuning.

## What would make the next arm conclusive

The binding constraint is the dev split, not the method. Thirty-six tasks cannot
resolve a two-point effect; the interval is roughly ±0.07 wide no matter how
carefully the pairs are mined. Before running this again: widen the synthetic
dev split, or repeat across seeds and pool. A larger pair yield would help too —
126 pairs from 960 rollouts is thin, and three bands contributed fewer than ten
pairs each.

## Reproducing

```bash
npm run build
node scripts/automationbench-v2-freeze.mjs                      # gates
node experiments/workload-automation/scripts/mine-near-hit-pairs.mjs \
  --samples 8 --temperature 0.9 --max-tokens 1024 --concurrency 64 \
  --out-dir outputs/workload-automation/pairs
node scripts/dpo-pairs-validate.mjs \
  --pairs outputs/workload-automation/pairs/dpo_pairs.jsonl \
  --manifest outputs/workload-automation/pairs/dpo_pairs.manifest.json \
  --out outputs/workload-automation/pairs/pairs.normalized.jsonl \
  --report outputs/workload-automation/pairs/pairs.validation.json
python scripts/tinker-dpo-train.py \
  --pairs outputs/workload-automation/pairs/pairs.normalized.jsonl \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 \
  --lora-rank 32 --beta 0.1 --epochs 3 \
  --out outputs/workload-automation/train-receipt.json
node scripts/automationbench-v2-zeroshot.mjs --split dev --max-tokens 1024 \
  --temperature 0.7 --base-url http://localhost:8100/v1 --model nemotron-3-nano-dpo \
  --out outputs/workload-automation/dpo-dev.json
```

## Privacy

Training and evaluation touch synthetic fixture records only. Production
telemetry enters this arm exclusively as the aggregates in `aggregates.json` —
counts, tokens, USD, and distributions — and no raw row, prompt, completion, or
identifier is committed anywhere in it.
