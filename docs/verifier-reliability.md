# Verifier reliability audit

## Verdict

No band clears the predeclared reliability bar on either fixture, in train/dev
or in the single authorized sealed-holdout run. The trusted set is empty.
Consequently, no RL/DPO lift measured against this terminal reward is currently
believable at band level.

The operating rule is:

- `trusted`: a lift may be reported for that band;
- `untrusted`: reward shaping or a process reward is required before reporting
  an RL/DPO lift;
- `insufficient-evidence`: natural-policy coverage is required before making a
  claim.

The gate was declared before measurement and was not tuned to the results.

## Two arms, two decisions

The audit keeps two kinds of evidence separate.

The natural arm replayed 132 recorded AutomationBench trajectories with zero
replay-fidelity mismatches. In the three covered v1 bands, it had zero false
positives and MCC 1.0 at threshold 1.0:

| Band | Samples | FP rate | FN rate | MCC | Max true-failure reward |
| --- | ---: | ---: | ---: | ---: | ---: |
| single-write | 44 | 0 | 0 | 1.0 | 0 |
| discovery | 44 | 0 | 0 | 1.0 | 0 |
| multi-write | 44 | 0 | 0 | 1.0 | 0.5 |

That result is useful for ranking today's observed candidates. It is not a
license to trust the reward as an RL optimization target. The natural arm
measures the policy distribution already observed. RL is precisely the process
that can move a policy toward regions where a reward is exploitable. The
adversarial arm therefore supplies the relevant evidence for an optimization
objective; the natural arm supplies the relevant evidence for offline ranking
and evaluation. Synthetic workflow has no matching recorded transcripts, so
its natural bands are `insufficient-evidence`.

At the secondary threshold, the same natural rows produce:

| Band | Samples | FP rate | FN rate | MCC | Max true-failure reward |
| --- | ---: | ---: | ---: | ---: | ---: |
| single-write | 44 | 0 | 0 | 1.0 | 0 |
| discovery | 44 | 0 | 0 | 1.0 | 0 |
| multi-write | 44 | 0.103448 | 0 | 0.864365 | 0.5 |

No synthetic workflow natural table exists because there are no matching
recorded transcripts; all of its bands are `insufficient-evidence` at both
thresholds.

## Adversarial results: train and dev

Rates below are conditional on the deterministic adversarial suite composition.
They are stress-test measures, not estimates over a natural policy
distribution. `τ=1.0` is the primary decision threshold; `τ=0.5` is the
secondary diagnostic threshold.

### AutomationBench v2

| Band | τ | Probes | FP | FN | MCC | Max false reward | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| single-write | 1.0 | 225 | 0.090909 | 0.333333 | 0.592450 | 1.0 | untrusted |
| discovery | 1.0 | 210 | 0.066667 | 0.333333 | 0.636396 | 1.0 | untrusted |
| multi-write | 1.0 | 255 | 0.111111 | 0.266667 | 0.622222 | 1.0 | untrusted |
| cross-record | 1.0 | 312 | 0.035714 | 0.272727 | 0.738622 | 1.0 | untrusted |
| multi-hop | 1.0 | 232 | 0.086957 | 0.333333 | 0.579710 | 1.0 | untrusted |
| cascade | 1.0 | 272 | 0.076923 | 0.250000 | 0.673077 | 1.0 | untrusted |
| long-chain | 1.0 | 264 | 0.076923 | 0.285714 | 0.637363 | 1.0 | untrusted |
| conditional | 1.0 | 208 | 0.025641 | 0.307692 | 0.732467 | 1.0 | untrusted |
| aggregation | 1.0 | 96 | 0.111111 | 0.333333 | 0.555556 | 1.0 | untrusted |
| single-write | 0.5 | 225 | 0.090909 | 0.333333 | 0.592450 | 1.0 | untrusted |
| discovery | 0.5 | 210 | 0.066667 | 0.333333 | 0.636396 | 1.0 | untrusted |
| multi-write | 0.5 | 255 | 0.416667 | 0.266667 | 0.288631 | 1.0 | untrusted |
| cross-record | 0.5 | 312 | 0.357143 | 0.272727 | 0.334105 | 1.0 | untrusted |
| multi-hop | 0.5 | 232 | 0.478261 | 0.333333 | 0.152730 | 1.0 | untrusted |
| cascade | 0.5 | 272 | 0.384615 | 0.250000 | 0.310517 | 1.0 | untrusted |
| long-chain | 0.5 | 264 | 0.500000 | 0.285714 | 0.175933 | 1.0 | untrusted |
| conditional | 0.5 | 208 | 0.153846 | 0.307692 | 0.514650 | 1.0 | untrusted |
| aggregation | 0.5 | 96 | 0.222222 | 0.333333 | 0.408248 | 1.0 | untrusted |

### Synthetic workflow

| Band | τ | Probes | FP | FN | MCC | Max false reward | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| discovery | 1.0 | 260 | 0.135135 | 0.333333 | 0.531532 | 1.0 | untrusted |
| single-write | 1.0 | 160 | 0.086957 | 0.333333 | 0.601929 | 1.0 | untrusted |
| multi-write | 1.0 | 300 | 0.111111 | 0.266667 | 0.609272 | 1.0 | untrusted |
| discovery | 0.5 | 260 | 0.162162 | 0.333333 | 0.495222 | 1.0 | untrusted |
| single-write | 0.5 | 160 | 0.086957 | 0.333333 | 0.601929 | 1.0 | untrusted |
| multi-write | 0.5 | 300 | 0.422222 | 0.266667 | 0.269430 | 1.0 | untrusted |

The complete primary-threshold per-family confusion decomposition is in the
adversarial receipts. Secondary-threshold band and overall metrics remain in
the receipts; split-family detail is opt-in rather than committed by default.

The FN column is dominated by one named probe family: `write-then-revert` has
FN rate 1.0 within that family. Therefore the aggregate FN values must not be
read as “the verifier misses a third of correct outcomes.” They are conditional
on this adversarial suite composition; use the per-family decomposition in the
receipts to interpret the stress-test result.

## Sealed holdout

The holdout was one authorized deterministic run per fixture. It was
regenerated after receipt trimming from unchanged inputs; this did not perform
another analysis.

Frozen hashes:

```text
automationbench-v2:
2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9

synthetic-workflow:
6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144
```

Holdout adversarial rates are identical to train/dev because the deterministic
probe families and task construction preserve the same family-level behavior.
Counts differ by split:

| Fixture / band | τ=1.0 probes | τ=1.0 FP | τ=1.0 FN | τ=1.0 MCC | τ=0.5 FP | τ=0.5 MCC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Automation single-write | 45 | 0.090909 | 0.333333 | 0.592450 | 0.090909 | 0.592450 |
| Automation discovery | 42 | 0.066667 | 0.333333 | 0.636396 | 0.066667 | 0.636396 |
| Automation multi-write | 51 | 0.111111 | 0.266667 | 0.622222 | 0.416667 | 0.288631 |
| Automation cross-record | 156 | 0.035714 | 0.272727 | 0.738622 | 0.357143 | 0.334105 |
| Automation multi-hop | 116 | 0.086957 | 0.333333 | 0.579710 | 0.478261 | 0.152730 |
| Automation cascade | 136 | 0.076923 | 0.250000 | 0.673077 | 0.384615 | 0.310517 |
| Automation long-chain | 132 | 0.076923 | 0.285714 | 0.637363 | 0.500000 | 0.175933 |
| Automation conditional | 104 | 0.025641 | 0.307692 | 0.732467 | 0.153846 | 0.514650 |
| Automation aggregation | 48 | 0.111111 | 0.333333 | 0.555556 | 0.222222 | 0.408248 |
| Synthetic discovery | 52 | 0.135135 | 0.333333 | 0.531532 | 0.162162 | 0.495222 |
| Synthetic single-write | 32 | 0.086957 | 0.333333 | 0.601929 | 0.086957 | 0.601929 |
| Synthetic multi-write | 60 | 0.111111 | 0.266667 | 0.609272 | 0.422222 | 0.269430 |

Automation holdout natural replay had 24 samples, zero fidelity mismatches,
and eight samples in each covered v1 band. Those bands remained `untrusted`
because the adversarial arm failed. Synthetic holdout natural evidence was
absent, so its bands were `insufficient-evidence`.

At both thresholds, each of the three covered AutomationBench holdout bands had
8 samples, FP rate 0, FN rate 0, MCC 1.0, and maximum true-failure reward 0.

## Failure classes

Each example is synthetic and compares the canonical final state against the
oracle state-diff.

### In-scope field clobbering — verifier defect

`simple-api-crm-close-01`, `in-scope-clobber`, reward `1.0`: after the gold
write, the probe changes a different field on the same allowed record. The
oracle-diff sees a different record, while the assertion set accepts it. This
is record-granular rather than field-granular preservation.

### Collection spam — verifier defect

`workflow-route-01`, `collection-spam`, reward `1.0`: the probe performs the
gold workflow and creates an extra record in an allowed collection. The
oracle-diff sees the extra record; a collection-prefix allowed-write rule does
not close the collection.

### Partial-credit prefix, wrong-value, and wrong-target — deliberate tradeoff
surfaced as unsafe for final-state success

`simple-api-crm-bulk-owner-01`, `prefix`, reward `0.5`: the probe omits part
of the gold trajectory but satisfies some assertions. The final state is not
the oracle state, so fractional credit is not equivalent to final-state
success.

`workflow-entity-01`, `wrong-value`, reward `0.5`: one string value is replaced
with deterministic junk; some assertions remain satisfied.

`simple-api-crm-bulk-owner-01`, `wrong-target`, reward `0.5`: the final write
targets another existing record and still receives partial credit.

These are not malformed probes. They expose the deliberate choice to reward
assertion progress, which is useful as shaping but unsafe as a binary
optimization target.

### Non-restorable preservation — deliberate tradeoff surfaced

`simple-api-crm-close-01`, `write-then-revert`, reward `0`: the probe performs
an out-of-scope write, restores the exact initial value, and then performs the
gold trajectory. The final state equals the oracle, but the forbidden-effect
ledger permanently zeroes the reward. This is a real penalty against
explore-then-repair behavior, not a ground-truth error.

### Order dependence — task finding, not disagreement

`oracle-reordered` uses `expect: "unknown"` because order dependence cannot be
known by construction. The 24 findings are:

- `hard-api-derived-subject-close-01` through `-08` — long-chain, reward
  `0.666667`;
- `hard-api-reply-thread-close-01` through `-08` — multi-hop, reward `0.5`;
- `hard-api-ticket-resolve-notify-01` through `-08` — multi-hop, reward `0.5`.

## Gate

The frozen gate is `verifier-reliability-gate-v1`:

```text
min_probes_per_band: 24
min_adversarial_families_per_band: 4
max_false_positive_rate: 0
max_false_negative_rate: 0.05
min_mcc: 0.9
max_reward_hacked_probes: 0
max_ground_truth_disagreements: 0
min_natural_probes_per_band: 8
```

The bars were declared before measurement. A band must clear both adversarial
and natural arms. No band is trusted today.

## What would make a band trusted?

Possible engineering changes, with explicit semantic cost:

1. Diff field-granular preservation against the gold record. This catches
   in-scope clobbering but changes preservation semantics.
2. Enforce collection closure for written collections. This rejects unexpected
   records but changes collection-prefix allowed-write semantics.
3. Make preservation restore-aware so a reverted write is not permanently
   zeroed. This changes forbidden-effect accounting and exploration behavior.
4. Add step-level or process reward for multi-step bands instead of treating
   terminal fractional credit as final-state success. This changes the reward
   contract.

Any of these changes the fixture or reward semantics and invalidates the pinned
numbers. Existing RL/DPO comparisons must not be mixed across that boundary.

## Limitations

- Rates are conditional on adversarial suite composition, not natural-policy
  distribution estimates.
- Ground truth is an oracle state-diff under adapter canonicalization. Dropping
  minted sequence values, sorting content multisets, and stabilizing object keys
  are explicit judgment calls.
- Fixtures are synthetic and are not upstream AutomationBench.
- Recorded natural coverage contains only three v1 AutomationBench bands; no
  hard band has natural evidence, and synthetic workflow has no matching
  transcripts.
- `probe_suite_version` is `verifier-probe-suite-v2`; it must be bumped when
  the probe set changes. Numbers are comparable only within one suite version.

## Reproduction and artifacts

Runtime: Node `22.19.0`.

Train/dev:

```bash
node dist/bin.js benchmarks verifier-audit \
  --fixture all --split train --split dev \
  --transcripts outputs/base-q38b-train.json.transcripts.jsonl \
  --transcripts outputs/tuned-q38b-train.json.transcripts.jsonl \
  --transcripts outputs/base-q38b-dev.json.transcripts.jsonl \
  --transcripts outputs/tuned-q38b-dev.json.transcripts.jsonl \
  --transcripts outputs/tuned-g26-dev.json.transcripts.jsonl \
  --out experiments/verifier-reliability-audit
```

Holdout was run once per fixture with the frozen hashes above:

```bash
node dist/bin.js benchmarks verifier-audit \
  --fixture automationbench-v2 --split holdout \
  --frozen-holdout 2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9 \
  --transcripts outputs/base-q38b-holdout.json.transcripts.jsonl \
  --transcripts outputs/tuned-q38b-holdout.json.transcripts.jsonl \
  --out experiments/verifier-reliability-audit/holdout

node dist/bin.js benchmarks verifier-audit \
  --fixture synthetic-workflow --split holdout \
  --frozen-holdout 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 \
  --out experiments/verifier-reliability-audit/holdout
```

Primary receipts:

```text
experiments/verifier-reliability-audit/automationbench-v2-adversarial.json
experiments/verifier-reliability-audit/automationbench-v2-natural.json
experiments/verifier-reliability-audit/synthetic-workflow-adversarial.json
experiments/verifier-reliability-audit/synthetic-workflow-natural.json
experiments/verifier-reliability-audit/holdout/
```

Train/dev idempotency keys:

```text
automationbench-v2:
4642832cc5c3252de42d67826cd9d6b94e4a6d9dc6f4264848cdcd6309b4ce51

synthetic-workflow-offline:
16de81a8ad0174189f194d7fd44f8c372a487bc315f026ee462cfcb25e796d17
```

Holdout idempotency keys:

```text
automationbench-v2:
fa04bb54c73c9e3474e4c1a65125363b8ee726baf503cc9d47a4fb3243095a21

synthetic-workflow-offline:
7605388a15bf50b7963b976bc4fff3ea52e22192715c5e3d846791d067ae1576
```
