# WL-07 DPO evidence

## Headline

**No reliable lift demonstrated.** The primary arm uses four sampled
rollouts per train task (`k=4`), 29 validated pairs, and a mix of 27 genuine
same-task sibling pairs plus 2 oracle-backed fallbacks. On the fixed
harness, the candidate's dev mean is unchanged from base (`0.5833` to
`0.5833`). The candidate does not add forbidden writes or over-acting, but it
retains a malformed rate of `7/12 = 0.5833`.

The secondary arm is explicitly **oracle-backed DPO (6 pairs), not
sibling-mined preference pairs**. It moved the dev mean from `0.5833` to
`0.6042`, but this small movement is not reliable evidence of a workload
repair.

Both comparisons below use the fixed WL-07 harness only. The earlier
pre-fix runs are not used.

## Lane pins and evidence scope

| Field | Value |
| --- | --- |
| Base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| Renderer | `nemotron3` |
| Backend | Tinker |
| DPO beta | `0.1` |
| DPO epochs | `3` |
| LoRA rank | `32` |
| Effective batch size | `1` |
| Dev temperature | `0` |
| Mining temperature | `0.7` |
| Mining max tokens | `1024` |
| Mining max turns | `8` |
| Mining request timeout | `180000 ms` |
| Mining episode cap | `600000 ms` |
| Primary mining coverage | 36/36 tasks, 4/4 rollouts per task |
| Achieved mining k | `k=4` |
| Sampling budget | 75-minute cap |

The runner was hardened with per-request timeout, per-episode wall-clock
cap, and bounded exponential retry for transient request failures. The
reduced sweep completed all 144 rollouts in four 36-task passes within the
75-minute cap.

Scoring used separate request-isolated shim runs for base and each candidate.
The mining sweep used concurrency 4; this is not evidence of production
throughput or provider isolation. No holdout task was read or executed.

## Hash-bound artifacts and gates

| Artifact | Reference |
| --- | --- |
| Fixture | `wl07-email-orchestration-offline-v1` |
| Train split SHA-256 | `8da73d592c6b0365e0538354175420c236b314754085cc266fb544dbe3ec78a7` |
| Dev split SHA-256 | `96ea61ca795a7e67f52481d82e96ab5bd5d9bcdab7d82b5e5f59b6283f20fcd0` |
| Sealed holdout SHA-256 | `e4e1c7538f5076ce2704169b75cfee8a12ced73f35add4d9106aab3dc2b36497` |
| Primary pair manifest | `outputs/dpo_pairs.sibling-mined-k4.manifest.json` |
| Primary pair validation | `outputs/dpo_pairs.sibling-mined-k4.validation.json` |
| Primary normalized trainer input | `outputs/dpo_pairs.sibling-mined-k4.normalized.jsonl` |
| Primary training receipt | `outputs/dpo-train-sibling-k4-receipt.json` |
| Fixed base dev run | `outputs/base-dev-fixed.json` |
| Primary fixed candidate dev run | `outputs/dpo-sibling-k4-dev-fixed.json` |
| Primary fixed band report | `outputs/dpo-sibling-k4-dev-band-report.json` |
| Secondary fixed candidate dev run | `outputs/dpo-dev-fixed.json` |
| Secondary fixed band report | `outputs/dpo-dev-fixed-band-report.json` |

Pair validation passed:

```text
lines: 29
accepted: 29
rejected: 0
train task membership: clean
WL-07 train hash: clean
```

The freeze gates remain clean: oracle mean `1`, sentinel maximum `0`, zero
oracle forbidden effects, deterministic split hashes, and holdout refusal
without the exact frozen hash.

## Pair provenance and coverage

| Provenance | Count |
| --- | ---: |
| Genuine sibling rollout pairs | 27 |
| Oracle-backed fallback pairs (no passing rollout for task) | 2 |
| Tasks with no pair | 7 |
| Validated primary pairs | 29 |
| Rollouts | 144 |
| Rollouts per train task | 4 |

For sibling pairs, the chosen side is a passing rollout from the same task
and the rejected side is the highest-scoring lower-scoring sibling available
in the retained candidate set. The first three pass artifacts were removed
after the initial mining pass; the k=4 corpus augments those retained pair
candidates with the fourth pass rather than re-reading all 144 raw rows.
For fallback pairs, no passing rollout existed for that
task, so the fixture oracle was used as chosen and the best available
lower-scoring rollout as rejected. Cosmetic-only pairs were not intentionally
selected; the validator also rejected identical chosen/rejected text.

This provenance mix means the primary arm is not a pure near-hit preference
experiment.

## Primary dev result: sibling-mined k=4 arm

| Policy | Tasks | Mean score | Exact-1 | Zero | Over-acting | Forbidden writes | Malformed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Base | 12 | 0.5833 | 0.5833 | 0.4167 | 0 | 0 | 3/12 |
| Sibling-mined candidate | 12 | 0.5833 | 0.5833 | 0.4167 | 0 | 0 | 7/12 |
| Delta |  | +0.0000 | +0.0000 | +0.0000 | 0 | 0 | +4 |

### Primary dev result by band

| Band | Tasks | Base | Candidate | Delta | Base malformed | Candidate malformed | Base forbidden | Candidate forbidden |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `cascade` | 2 | 1.0000 | 1.0000 | +0.0000 | 2 | 1 | 0 | 0 |
| `conditional` | 2 | 1.0000 | 1.0000 | +0.0000 | 0 | 1 | 0 | 0 |
| `cross-record` | 2 | 1.0000 | 1.0000 | +0.0000 | 1 | 1 | 0 | 0 |
| `discovery` | 2 | 0.0000 | 0.0000 | +0.0000 | 0 | 2 | 0 | 0 |
| `multi-hop` | 2 | 0.5000 | 0.5000 | +0.0000 | 0 | 0 | 0 | 0 |
| `single-write` | 2 | 0.0000 | 0.0000 | +0.0000 | 0 | 2 | 0 | 0 |

The candidate adds no forbidden writes or over-acting episodes, but its
malformed rate rises from 3/12 to 7/12. With only two tasks per band, these
deltas are especially unstable.

## Secondary dev result: oracle-backed DPO

This arm is **oracle-backed DPO (6 pairs), not sibling-mined preference
pairs**. It is retained as a clearly scoped secondary result only.

| Policy | Tasks | Mean score | Exact-1 | Zero | Over-acting | Forbidden writes | Malformed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Base | 12 | 0.5833 | 0.5833 | 0.4167 | 0 | 0 | 3/12 |
| Oracle-backed candidate | 12 | 0.6042 | 0.5000 | 0.3333 | 0 | 0 | 4/12 |
| Delta |  | +0.0208 | -0.0833 | -0.0833 | 0 | 0 | +1 |

| Band | Base | Candidate | Delta | Base malformed | Candidate malformed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `cascade` | 1.0000 | 0.8750 | -0.1250 | 2 | 0 |
| `conditional` | 1.0000 | 1.0000 | +0.0000 | 0 | 0 |
| `cross-record` | 1.0000 | 0.7500 | -0.2500 | 1 | 2 |
| `discovery` | 0.0000 | 0.5000 | +0.5000 | 0 | 1 |
| `multi-hop` | 0.5000 | 0.5000 | +0.0000 | 0 | 1 |
| `single-write` | 0.0000 | 0.0000 | +0.0000 | 0 | 0 |

The secondary candidate increases malformed episodes from 3 to 4 and
regresses both `cascade` and `cross-record`.

## Harness correction and failure clusters

The initial comparison was invalid because the old WL-07 runner used weaker
framing and a 512-token completion cap. Captured rows showed long reasoning
and prose frequently consuming the cap before the JSON tool object appeared.
The corrected runner:

- uses explicit exact-one-object examples and no-prose instructions;
- strips `<think>` blocks consistently with the v2 runner;
- defaults to `--max-tokens 1024`;
- continues to reject malformed output rather than repairing it;
- applies the same parser and scoring behavior to base and candidates.

The corrected base malformed rate is `3/12 = 0.25`. The primary candidate is
`7/12 = 0.5833`, more than twice the base malformed rate while scoring flat.
The oracle-backed candidate is `4/12 = 0.3333`. The remaining malformed
cluster is long-prose/reasoning emission, not a scoring repair.

The other operational failure cluster was sampling throughput. A prior
single-concurrency full pass stalled on a complex task for more than 28
minutes. The hardened runner converted request stalls into bounded retries
and completed the reduced k=4 sweep in 3437 seconds across four passes.

## Budget, duration, and spend

The authorized mining cap was 75 minutes for the reduced sweep. The achieved
four-pass k=4 sweep took approximately:

```text
pass 1: 1116 s
pass 2: 803 s
pass 3: 612 s
pass 4: 906 s
total: 3437 s (~57.3 minutes)
```

Other observed wall-clock durations:

```text
oracle-backed DPO training: 193 s
oracle-backed fixed dev scoring: 233 s
sibling-mined k=4 DPO training: 767.6 s
sibling-mined k=4 fixed dev scoring: 349 s
```

Tinker receipts expose no spend amount. Spend is therefore **not reported**,
not zero, and not inferred from wall clock or token counts. The upper-bound
sampling budget was 4500 seconds; actual observed sampling time was 3437
seconds.

## Holdout and claim boundary

**holdout: clean, not executed.** The holdout hash is recorded for provenance
only. No holdout task pool, prompt, completion, score, or payload was read.

The 12-task dev split, 29-pair primary corpus, 27 sibling pairs, and 2
oracle fallbacks do not support a promotion decision, a production route
change, a customer claim, or a general Nemotron claim. The primary result is
flat; the secondary oracle-backed movement is directional only. Safety counts
are clean in these dev runs, but they are not a guarantee outside this
fixture.

## What would make this conclusive

A conclusive workload decision would require:

1. At least 8 independently sampled rollouts for all 36 train tasks, with
   provenance-preserving sibling mining and a substantially larger validated
   pair set.
2. The same fixed harness and request-isolated scoring for base and
   candidate on all 12 dev tasks.
3. Calibration and failure-cluster review across multiple seeds or
   independently repeated dev evaluations, not one 12-task snapshot.
4. One pre-authorized execution of the sealed 24-task holdout, with its
   frozen hash supplied and no second holdout run.
5. Explicit accounting from the provider for actual spend, rather than
   wall-clock estimates.
