# WL-DI results — gates, base, and DPO on Nemotron/Tinker

Slice `domain-identification-offline-v1` (48 synthetic tasks, 24 train / 8 dev /
16 holdout). Base and candidate are scored through the *same* OpenAI-compatible
Tinker shim, so the only difference between the two arms is the weights.

```
base model  nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16   renderer nemotron3
fixture     e6b660733b03d97076035f980488642c32701beb25142b9b0a1c4a12ed88b402
train / dev / holdout
            b358c36f…93017 / 3934011a…c345a2 / ec915453…fac2b   (holdout sealed)
```

## 1. Gate validation — pass

[`outputs/gate-validation.json`](outputs/gate-validation.json); enforced in CI by
`tests/domain-identification-slice.test.mjs`.

| Gate | Result |
| --- | --- |
| Oracle scores 1.0 on every task | 48/48 |
| Oracle triggers no forbidden write | 0 |
| Reward-hacking sentinel scores 0.0 on every task | max reward 0.0 |
| No grader key or assertion path leaks into an observation | 0 findings |
| No prompt restates an assertion path | 0 tasks |
| No task is already satisfied at reset | 0 pre-satisfied |
| Frozen holdout refuses a missing or wrong hash | 2/2 refusals |
| Frozen holdout opens for the exact hash only | 16 tasks |
| Reset is deterministic | 48/48 |

## 2. Base behaviour

Base Nemotron on dev (temperature 0, one episode per task):
overall **0.625**, and the bands split exactly the way the memo predicted —
`direct-match` and `near-match` at 1.0, `parent-join` at 0.5, `abstain` at
**0.0**. Over 336 sampled train episodes the same shape holds
(`direct-match` 0.72, `near-match` 0.68, `parent-join` 0.61, `abstain` 0.08):
the base identifies the right entity most of the time and then cannot stop —
when nothing matches it routes a lookalike's owner anyway.

Note what the base does *not* do: it never wrote outside the addressed ticket in
any run (0 forbidden writes across 528 episodes). Its failure is over-answering,
not vandalism.

## 3. DPO

22 near-hit pairs mined from those base rollouts and verified by replay — each
pair's chosen and rejected decision are re-applied to a fresh environment at the
winner's own prefix, and the pair is kept only if chosen still reaches 1.0 there
and rejected does not. Pairs cover 6 train tasks (`abstain` 14, `near-match` 4,
`parent-join` 4); 16 train tasks produced no losing write at all and 2 produced
no winning one.
Gate: [`outputs/pairs.validation.json`](outputs/pairs.validation.json) —
22 accepted, 0 rejected, train-split only, `pairs_sha256`
`0babec62da22760a0ca409f32a11df4f2e5a91b906e93dcd2796c1250a36a744`.

Training ([`outputs/train-receipt.json`](outputs/train-receipt.json)):
LoRA rank 32, **beta 0.1, 3 epochs**, lr 1e-5, batch 4, 539 s on Tinker.
Train-side preference accuracy reached 1.0 with margin ≈ 0.23 by the second
epoch — the preference was learned.

## 4. Lift — dev, then the sealed holdout (read once per arm)

| band | tasks | base | DPO | delta |
| --- | ---: | ---: | ---: | ---: |
| abstain | 2 | 0.00 | 0.50 | **+0.50** |
| direct-match | 2 | 1.00 | 0.50 | **−0.50** |
| near-match | 2 | 1.00 | 1.00 | +0.00 |
| parent-join | 2 | 0.50 | 1.00 | **+0.50** |
| **dev overall** | 8 | **0.625** | **0.750** | **+0.125** |

| band | tasks | base | DPO | delta |
| --- | ---: | ---: | ---: | ---: |
| abstain | 4 | 0.25 | 0.00 | −0.25 |
| direct-match | 4 | 0.75 | 0.50 | −0.25 |
| near-match | 4 | 0.50 | 0.75 | +0.25 |
| parent-join | 4 | 0.25 | 0.50 | +0.25 |
| **holdout overall** | 16 | **0.438** | **0.438** | **+0.000** |

Regression guards, both splits: over-acting episodes 0 → 0, forbidden writes
0 → 0, errors 0 → 0. The candidate does not buy its band movements with
out-of-scope writes.

## 5. What this says

**The dev gain did not survive the holdout.** Dev moved +0.125 and the sealed
holdout moved +0.000: the two bands that improved (`near-match`, `parent-join`,
each +0.25) were paid for exactly by the two that fell (`abstain`,
`direct-match`, each −0.25). On 16 tasks scored once each, every band is four
tasks wide, so a ±0.25 band delta is one task — this is a redistribution inside
the noise floor, not a measured improvement. Reporting it as a win would require
ignoring the split that was sealed to prevent exactly that.

The most likely cause is pair coverage, not the method: 22 pairs over 6 of 24
train tasks, 64% of them from one band. The base solves the easy bands too
reliably to produce losing writes there, so mining from base rollouts
concentrates the preference signal on `abstain` and starves the rest — and a
preference learned to 1.0 train accuracy on six tasks is a preference about six
tasks.

Also unmoved: output length. Mean completion stayed ~2,300 tokens per episode in
both arms, against a workload whose incumbent runs at p95 = 114 output tokens.
Length discipline is a separate repair from identification, and DPO on decision
pairs did not touch it — consistent with the standing finding that a small base
learns *what* to call long before it learns *how much* to emit.

**Verdict: not promotable.** The honest next step is more preference coverage
before more epochs — sample the easy bands hard enough to surface their rare
losing writes (or mine pairs from a weaker prompt so every band produces
near-misses), rebalance so no band exceeds ~35% of pairs, and only then re-seal
and re-measure. A second holdout read on this slice is not available; a
re-measurement needs a fresh frozen split.

## 6. Claim boundary

These numbers describe a 48-task synthetic slice built to mirror the workload's
shape. They are evidence about the *method* on that shape, not a measurement of
the production workload, and no production traffic was scored. Cost and volume
figures in the memo are telemetry aggregates only.

## 7. Receipts and cleanup

| Artifact | Contents |
| --- | --- |
| `outputs/gate-validation.json` | the gate receipt above, with fixture + split hashes |
| `outputs/base-train-sampled.json` | 144 sampled train episodes (scores only, no transcripts) |
| `outputs/dpo_pairs.jsonl`, `outputs/dpo_pairs.manifest.json` | the mined pairs and their hash |
| `outputs/pairs.validation.json` | fail-closed pair gate result |
| `outputs/train-receipt.json` | Tinker DPO run receipt incl. checkpoint ref |
| `outputs/{base,dpo}-{dev,holdout}.json` | the four scoring runs |
| `outputs/lift-{dev,holdout}.json` | the two lift tables |

Transcripts were kept off-repo; only scores, counts, and hashes are committed.
Both Tinker shims were shut down after the last scoring run and no sampler
resources were left allocated. Spend was the single DPO run (539 s) plus the
sampling passes on the slice; no production traffic and no ambiguous charges.

## 8. Reproducing

```sh
npm run build
node experiments/domain-identification-repair/gate-check.mjs --out outputs/gate-validation.json

TINKER_API_KEY=... python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 --port 8099

node experiments/domain-identification-repair/rollout.mjs --model base \
  --base-url http://localhost:8099/v1 --split train --samples 6 --temperature 0.9 \
  --out outputs/base-train-sampled.json --transcripts /tmp/train-transcripts.jsonl
node experiments/domain-identification-repair/mine-pairs.mjs \
  --transcripts /tmp/train-transcripts.jsonl --max-pairs-per-task 4 \
  --out outputs/dpo_pairs.jsonl --manifest outputs/dpo_pairs.manifest.json
node experiments/domain-identification-repair/validate-pairs.mjs \
  --pairs outputs/dpo_pairs.jsonl --manifest outputs/dpo_pairs.manifest.json \
  --out /tmp/pairs.normalized.jsonl --report outputs/pairs.validation.json

TINKER_API_KEY=... python scripts/tinker-dpo-train.py \
  --pairs /tmp/pairs.normalized.jsonl \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 \
  --lora-rank 32 --beta 0.1 --epochs 3 --batch-size 4 --out outputs/train-receipt.json

# serve the checkpoint on :8100 with --model-path tinker://…, score both arms,
# then read the sealed holdout ONCE per arm with the frozen hash:
node experiments/domain-identification-repair/rollout.mjs --model dpo \
  --base-url http://localhost:8100/v1 --split holdout \
  --frozen-holdout ec9154535b1105f696b6ff9efd72d8457c14e1ed4ff65be043f68188bc9fac2b \
  --out outputs/dpo-holdout.json
node experiments/domain-identification-repair/band-report.mjs \
  --base outputs/base-holdout.json --candidate outputs/dpo-holdout.json \
  --out outputs/lift-holdout.json
```
