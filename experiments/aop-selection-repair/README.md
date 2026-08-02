# WL-aop repair arm: action-option selection

One workload, end to end: validate a sanitized synthetic benchmark for it, size
it from telemetry aggregates, and try to repair it with offline DPO on an
open-weight base. Everything here is either an aggregate or a hash — no raw
traces, prompts, completions, payloads, or identifiers.

**Verdict: do not promote.** The DPO candidate does not beat base on dev, and
one of the two decode settings regresses badly. The gate work and the aggregates
stand; the repair attempt is a negative result and is reported as one.

## Where this fits the unified Workflow

| aspect | this arm |
|---|---|
| role | **verifier/contract** (the sealed slice + gates) plus one **candidate-method** (near-hit pair mining → DPO) |
| not | a controller, poller, queue, inbox, or second state database |
| artifact contract | [`executor-submit.json`](executor-submit.json), validating against `understudy.executor-submit.v1` |
| idempotency | payload bytes are a pure function of (experiment_id, candidate_id, attempt) + hashed policy; resubmitting the same attempt reproduces the same bytes, so a retry cannot become a second paid job |
| boundary | refs + SHA-256 only; **holdout is structurally absent** from the submit payload |
| holdout state | **clean — never executed.** Only its frozen hash is recorded. |

`tests/aop-selection-submit-payload.test.mjs` validates the emitted payload
against the vendored copy of the canonical schema and asserts the payload
carries no holdout reference and no raw material.

## 1. Gate validation

Slice: `aop-selection-offline` / `aop-selection/api`, fixture
`aop-selection-offline-v1`, 60 tasks (36 train / 12 dev / 12 holdout), six
families over three bands. Full description and frozen hashes:
[`docs/aop-selection-slice.md`](../../docs/aop-selection-slice.md).

No slice for this workload existed, so this one was built to mirror the task
shape: read one event, resolve which action option it selects, apply it to
exactly one account, and touch nothing else.

| gate | result |
|---|---|
| oracle score | `1.0` on all 60 tasks, 0 forbidden effects |
| activity sentinel | `0.0` on all 60 tasks, forbidden effect recorded on every one |
| do-nothing policy | `0.0` on all 60 tasks (no task pre-satisfied) |
| over-acting regression | correct write + one out-of-scope write scores `0.0` |
| observation leakage | no grader key, assertion path, or allowed-write path in any observation |
| oracle reachability | every write literal reachable from the prompt or a read-only result |
| deterministic reset | byte-identical, timestamp-free, non-default seeds refused |
| frozen-holdout refusal | holdout pool refuses to load without the exact frozen hash; wrong hash refused |
| eval rows | `understudy.eval_result.v1` rows validate |
| sanitization | ids/domains pass the denylist |

`node --test tests/aop-selection-offline.test.mjs` — 21/21 pass.

## 2. Repair-target sizing (aggregates only)

Numbers: [`telemetry-aggregates.json`](telemetry-aggregates.json). Derived from
gateway outer spans joined to per-event cost rows; no row-level data was
exported or committed.

| dimension | value | reading |
|---|---|---|
| requests (30d) | 14,027 | steady ~3.3k/week since early in the window |
| customer cost (30d) | $193.29 | $13.78 per 1k requests |
| share of project | 1.54% of requests, 0.62% of cost | small but not noise |
| input tokens | p50 3,694 / p95 11,397, 17.9% cache-read | prompt-heavy, partially cached |
| output tokens | p50 217 / p95 253 / max 346 | **bounded** |
| p95/p50 output ratio | 1.17 | tight — this is the key property |
| streaming | 0 of 14,027 | request/response, no partial-output semantics |
| success rate | 100% | failures are semantic, not transport |

**Suitability: good target, small prize.** The workload is high-repeatability
(one narrow task shape at 3.3k/week), fully bounded in output length, and
non-streaming, so it dodges the variable-length failure mode that makes
open-weight substitution unstable on generative workloads — a 346-token
worst case is comfortably inside any small model's reliable window. What it does
not have is scale: at $193/month it is a *method* target, not a savings target.
The right reason to work it is that a repair proven here transfers to the other
bounded selection workloads in the project, which together are much larger.

**Failing bands.** Against the synthetic mirror, the base model's weakness is
not restraint — it never wrote out of scope in 336 scored episodes — it is
`direct` and `disambiguation`, i.e. resolving *which* option and *which* account:

| band | base mean (greedy) | base mean (T=1, 4 samples) |
|---|---:|---:|
| direct | 0.750 | 0.563 |
| disambiguation | 1.000 | 0.875 |
| restraint | 1.000 | 0.750 |

The dominant defect is emission discipline, not judgment: 96% of base episodes
at T=1 contained at least one malformed tool emission, each of which burns a
turn out of the step budget.

## 3. DPO attempt (Nemotron on Tinker)

Base `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`, renderer `nemotron3`, served
through the same Tinker shim for base and candidate with identical sampling
parameters. LoRA rank 32, DPO beta 0.1, 3 epochs, lr 1e-5, batch 8.

Pairs are mined from base rollouts on the TRAIN split only, cut at the
divergence point of a passing and a near-miss episode of the same task, with
cosmetic pairs (both emissions parsing to the same tool call) dropped:

| | round 1 | round 2 (reported) |
|---|---:|---:|
| train episodes sampled | 144 | 288 |
| pairs | 72 | 184 |
| different-action / malformed-emission | 12 / 60 | 58 / 126 |
| cosmetic pairs dropped | 1 | 7 |
| validator verdict | pass | pass |

### Lift table — dev, per band

Greedy (T=0, 1 sample/task):

| band | base | DPO | delta |
|---|---:|---:|---:|
| direct | 0.750 | 0.750 | 0.000 |
| disambiguation | 1.000 | 0.500 | **−0.500** |
| restraint | 1.000 | 0.750 | **−0.250** |
| **all** | **0.917** | **0.667** | **−0.250** |

Sampled (T=1.0, 4 samples/task):

| band | base | DPO | delta |
|---|---:|---:|---:|
| direct | 0.563 | 0.625 | +0.063 |
| disambiguation | 0.875 | 0.938 | +0.063 |
| restraint | 0.750 | 0.750 | 0.000 |
| **all** | **0.729** | **0.771** | **+0.042** |

Guardrail (the regression this arm was required to prevent):

| metric | base | DPO |
|---|---:|---:|
| over-acting episodes | 0 | 0 |
| forbidden writes | 0 | 0 |
| zero-score tasks (T=1) | 1 | 0 |
| malformed-emission rate (T=1) | 0.958 | 0.896 |

Round 1 (72 pairs, 83% of them format diffs) was flat at greedy (0.917 → 0.917)
and clearly worse sampled (0.729 → 0.604), which is why round 2 doubled the
sampling and prioritized action diffs.

### Reading

No promotion. The +0.042 sampled gain is smaller than the noise floor of a
12-task dev split at 4 samples, and the same checkpoint is 0.250 *worse* under
greedy decoding — a candidate that only helps when you sample it is not a
repair. The guardrail did hold: over-acting stayed at zero and the sampled
zero-score task disappeared, so DPO did not trade correctness for recklessness.

The likely reason is in the pair mix. Two thirds of the mined pairs are
"valid tool call vs malformed emission", so most of the gradient teaches output
format rather than option selection, and the base already selects correctly at
greedy on 11 of 12 dev tasks — there is almost no headroom to win and plenty to
lose. The next lever for this workload is not more DPO on the same pairs; it is
removing the malformed-emission failure entirely (constrained/structured
decoding, or SFT on oracle trajectories), and only then mining preferences over
what remains, which would be selection errors by construction.

## Reproducing

```bash
npm run build
node --test tests/aop-selection-offline.test.mjs          # gates
node scripts/aop-selection-fixture-report.mjs             # frozen hashes

# base rollouts (train, sampled) -> pairs -> gate -> train
node scripts/aop-selection-rollout.mjs --model <base> --split train \
  --samples 4 --temperature 1.0 --out outputs/aop/base-train.json \
  --transcripts outputs/aop/base-train-episodes.jsonl
node scripts/aop-selection-dpo-mine.mjs --episodes outputs/aop/base-train-episodes.jsonl \
  --max-pairs-per-task 6 --out outputs/aop/dpo_pairs.jsonl \
  --manifest outputs/aop/dpo_pairs.manifest.json
node scripts/dpo-pairs-validate.mjs --fixture aop-selection-offline-v1 \
  --pairs outputs/aop/dpo_pairs.jsonl --manifest outputs/aop/dpo_pairs.manifest.json \
  --out outputs/aop/pairs.normalized.jsonl --report outputs/aop/pairs.validation.json
TINKER_API_KEY=… python scripts/tinker-dpo-train.py \
  --pairs outputs/aop/pairs.normalized.jsonl \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 --lora-rank 32 --beta 0.1 --epochs 3 \
  --out outputs/aop/dpo-train-receipt.json

# score both through the same shim, then diff per band
node scripts/automationbench-v2-band-report.mjs --base outputs/aop/base-dev.json \
  --candidate outputs/aop/dpo-dev.json --out receipts/band-report-dev-greedy.json
```

Run receipts are in [`receipts/`](receipts). Rollout artifacts (episode
transcripts, pair bodies, per-task rows) stay out of the repository; the
receipts carry their hashes.
