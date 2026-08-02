# AutomationBench GEPA vs GRPO lab note

Date: 2026-08-02

Status: completed local evidence package; no production or deployment claim.

## Verdict

On this Tinker serving/sampling path, GEPA was **redundant with GRPO, not
additive**. The 2x2 prompt cells collapse because the DEV-selected GEPA
prompt is the empty suffix. GRPO raises the score and, in the measured
three-repeat sample, removes the score variance observed in the base model.

This is scoped to the pinned fixture, renderer, protocol, model checkpoint,
and sampling configuration below. “Removes variance” means zero disagreement
in these three repeats, not a claim that the checkpoint is deterministic under
all future conditions.

The base model had only about `0.090278` mean-reward headroom from the base
TRAIN baseline (`0.909722`) to the GRPO checkpoint (`1.000000`). The measured
GRPO uplift is therefore a policy/training effect, not prompt headroom exposed
by this experiment.

## Goal and frozen protocol

The goal was an auditable comparison:

```text
(base model vs SFT+GRPO checkpoint)
×
(baseline protocol prompt vs selected/transfer prompt)
```

The benchmark is the deterministic offline fixture:

```text
benchmark:       automationbench-simple-api-offline
fixture:         automationbench-simple-api-offline-v1
source:          zapier/AutomationBench
subset:          simple/api
verifiers pin:   ab65b6e8d34b03d162408d4bcb854430a86809e6
split seed:      7
tasks:           48 TRAIN, 12 DEV, 12 HOLDOUT
```

The verifier pin is sourced from
`docs/automationbench-offline-subset.md:37`, which identifies it as the
audited `verifiers.v1` pin.

Fixture and split hashes:

```text
fixture: 0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train:   783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev:     5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
holdout: a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

Every number in this note is a v1 72-task-fixture number, produced at base
commit `2278a77`. The base branch has since frozen an AutomationBench offline
v2 hard split (216 tasks, 60 holdout), and this branch was merged up to it.
The four hashes above were recomputed after that merge and are unchanged, so
the results here remain reproducible on the merged branch — but they are not
comparable to v2 numbers, and a v2 rerun would be a separate arm.

Models and renderer:

```text
base model:  nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
checkpoint:  tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020
renderer:    nemotron3_disable_thinking
temperature: 0
samples:     1
max turns:   12
```

The baseline protocol prompt is preserved in:

```text
artifacts/baseline-action-protocol-prompt.txt
```

The service’s reset path accepts a prompt override for the transfer and
full-rewrite experiments; the ordinary GEPA variants otherwise append suffixes
to the frozen baseline.

## Sanity gate

The real oracle/sentinel gate was run by
`scripts/automationbench-sanity-gate.mjs` on one single-write and one
multi-write TRAIN task:

| Task | Band | Oracle reward | Sentinel reward | Sentinel forbidden write |
|---|---|---:|---:|---|
| `simple-api-crm-close-01` | single-write | 1 | 0 | `crm.contacts.c-0` |
| `simple-api-crm-bulk-owner-01` | multi-write | 1 | 0 | `crm.contacts.c-0` |

Persisted gate output:

```text
artifacts/sanity-gate.json
```

The separate two-task Base smoke rollout is not the oracle/sentinel gate. It
is correctly labelled as a model plumbing check:

```text
artifacts/smoke-base-baseline.jsonl
artifacts/smoke-base-baseline.summary.json
```

The service/evaluator implementation is in `src/automationbench-offline.ts`
and `src/automationbench-rl-service.ts`; the exact sanity and smoke commands
are documented in `README.md`.

## 2x2 results

The selection result was:

```text
G_sel = empty suffix
G_best = no accepted non-empty candidate
```

### TRAIN and DEV

Because `G_sel` is empty, cells (b) and (d) reuse the baseline-equivalent
empty-prompt measurements. No extra calls were spent for those identical
cells.

| Cell | Model | Prompt | TRAIN single run | DEV single run | DEV repeat mean (n=3) | DEV repeat band |
|---|---|---|---:|---:|---:|---:|
| (a) | Base | Empty | 0.909722 | 0.944444 | 0.824074 | [0.694444, 0.944444] |
| (b) | Base | `G_sel = empty` | 0.909722 | 0.944444 | 0.824074 | [0.694444, 0.944444] |
| (c) | GRPO checkpoint | Empty | 1.000000 | 1.000000 | 1.000000 | [1.000000, 1.000000] |
| (d) | GRPO checkpoint | `G_sel = empty` | 1.000000 | 1.000000 | 1.000000 | [1.000000, 1.000000] |

The single-run columns are the original cell artifacts; the repeat columns
are the variance-aware measurements. In particular, `0.944444` is one Base
DEV draw, not the estimated Base DEV mean.

Baseline artifacts:

```text
artifacts/cell-a-base-baseline-train.summary.json
artifacts/cell-a-base-baseline-dev.summary.json
artifacts/cell-c-grpo-baseline-train.summary.json
artifacts/cell-c-grpo-baseline-dev.summary.json
```

### Sealed HOLDOUT

Holdout was declared in advance as exactly four runs and was accessed once.
The frozen hash was supplied on every call. The manifest explicitly records
that runs 1 and 2 are the sealed baseline-equivalent values for (a)/(b) and
(c)/(d), respectively.

| Run | Cell(s) | Model | Prompt | HOLDOUT |
|---:|---|---|---|---:|
| 1 | (a)/(b) | Base | Empty | 0.833333 |
| 2 | (c)/(d) | GRPO checkpoint | Empty | 1.000000 |
| 3 | Transfer | Base | Transfer prompt | 0.416667 |
| 4 | Transfer | GRPO checkpoint | Transfer prompt | 0.819444 |

Holdout is only 12 tasks, so one task is approximately `0.083333` reward.
The transfer declines are larger than one task and are directionally
consistent with the TRAIN/DEV transfer regressions.

Manifest and artifacts:

```text
artifacts/sealed-holdout-manifest.json
artifacts/sealed-base-empty-holdout.summary.json
artifacts/sealed-grpo-empty-holdout.summary.json
artifacts/sealed-base-transfer-holdout.summary.json
artifacts/sealed-grpo-transfer-holdout.summary.json
```

No holdout rerun, retuning, or holdout-based selection occurred.

## Noise bands and determinism

The three-repeat empty-prompt measurements are:

| Model | Split | Run means | Mean | Min | Max | Sample stdev | Per-task disagreements |
|---|---|---|---:|---:|---:|---:|---:|
| Base | TRAIN | 0.909722, 0.895833, 0.930556 | 0.912037 | 0.895833 | 0.930556 | 0.017476 | 4/48 |
| Base | DEV | 0.944444, 0.694444, 0.833333 | 0.824074 | 0.694444 | 0.944444 | 0.125257 | 4/12 |
| GRPO | TRAIN | 1.000000, 1.000000, 1.000000 | 1.000000 | 1.000000 | 1.000000 | 0.000000 | 0/48 |
| GRPO | DEV | 1.000000, 1.000000, 1.000000 | 1.000000 | 1.000000 | 1.000000 | 0.000000 | 0/12 |

Artifacts and computed summary:

```text
artifacts/noise-band-summary.json
artifacts/noise-base-train-2.jsonl
artifacts/noise-base-train-3.jsonl
artifacts/determinism-base-empty-dev-1.jsonl
artifacts/determinism-base-empty-dev-2.jsonl
artifacts/noise-grpo-train-2.jsonl
artifacts/noise-grpo-train-3.jsonl
artifacts/noise-grpo-dev-2.jsonl
artifacts/noise-grpo-dev-3.jsonl
```

The changed base DEV tasks were:

```text
simple-api-mail-draft-05
simple-api-mail-send-05
simple-api-crm-bulk-owner-05
simple-api-mail-send-and-close-05
```

The sampling API exposes `SamplingParams.seed`, but the runner omitted it.
The actual parameters were `temperature=0`, `top_p=1`, `top_k=-1`, and
`seed=None`. The changed-task artifacts show different sampled assistant
texts and action trajectories, not parser-only variation. For example,
`mail-draft-05` alternated between different draft body shapes, while
`mail-send-and-close-05` alternated between incomplete delivery, an invalid
status patch, and the correct `POST /mail/messages` delivery action.

This is an experiment bug and a future-arm requirement, not evidence of a
platform-level impossibility: pin a seed explicitly before using single-run
acceptance or selection numbers.

Sampling audit:

```text
artifacts/sampling-params-audit.json
```

## Transfer test

The sibling arm’s reported result was a `+0.125` DEV improvement on Nemotron
(`0.736` bare to `0.861` with GEPA) on a Fireworks deployment. Its winning
prompt hash is:

```text
cd40fea74a04902a3a96ddc4856a4480ff19d243396d414a4a59409c2f407727
```

The sibling prompt was transferred with its text-protocol output contract
adapted to this path’s one-JSON-object protocol. The source and adapted files
are:

```text
artifacts/transfer-gepa-prompt-source.txt
artifacts/transfer-gepa-prompt.txt
artifacts/transfer-gepa-metadata.json
```

Exact prompt diff (the transfer file is appended to the baseline by the
runner) is reproducible with:

```sh
diff -u artifacts/baseline-action-protocol-prompt.txt \
  artifacts/transfer-gepa-prompt.txt
```

The complete captured diff is also committed as:

```text
artifacts/transfer-prompt.diff
```

The changed contract is exactly:

```diff
-Allowed replies:
-{"tool":"api_search","arguments":{"query":"<text>"}}
-{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
-{"tool":"finish","arguments":{}}
+## Output contract (strict)
+Every turn, your entire visible output must be exactly one of these two forms — nothing else:
+1. A single tool call: {"tool":"api_search","arguments":{"query":"<text>"}}
+   or {"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
+2. The finish signal: {"tool":"finish","arguments":{}}
+Hard rules: one JSON action object per turn, no prose or markdown, valid JSON,
+wait for the result before the next call, and silently re-emit the canonical
+object after a parse rejection.
```

| Model | Split | Transfer mean | Empty reference | Empty repeat mean (n=3) | Transfer vs single draw |
|---|---|---:|---:|---:|---:|
| Base | TRAIN | 0.503472 | 0.909722 | 0.912037 | -0.406250 |
| Base | DEV | 0.625000 | 0.944444 | 0.824074 | -0.319444 |
| GRPO | TRAIN | 0.934028 | 1.000000 | 1.000000 | -0.065972 |
| GRPO | DEV | 0.916667 | 1.000000 | 1.000000 | -0.083333 |

The Base DEV empty reference is shown both ways to prevent quoting the
single draw as a stable baseline: the repeat mean is `0.824074`, with band
`[0.694444, 0.944444]`.

On sealed HOLDOUT the corresponding comparisons were:

```text
Base: 0.833333 empty → 0.416667 transfer
GRPO: 1.000000 empty → 0.819444 transfer
```

These are direct transfer failures, not an assumption about prompt content.
They support the scoped interpretation that the sibling arm’s main lever—
output-protocol discipline—was already hard-coded in this path’s baseline
prompt. They do not prove that no other prompt or protocol redesign could
help.

## Is GEPA lift additive on top of GRPO?

No additive lift was measured on this path: no non-empty GEPA prompt survived
full-TRAIN acceptance and DEV selection, so `G_sel` was empty and the 2x2
prompt cells collapsed. The one externally validated GEPA prompt available
for a direct test—the sibling arm’s DEV-selected winner—was negative on top
of GRPO as well as Base: sealed HOLDOUT fell from `1.000000` to `0.819444`
for GRPO and from `0.833333` to `0.416667` for Base.

This conclusion would be falsified by a stronger prompt found under a seeded,
variance-aware search; by a deliberately weaker baseline protocol prompt that
leaves output-protocol discipline unprovided; or by a materially larger
holdout showing a reliable positive additive effect.

The four-task parse probe preceded the transfer evaluations:

```text
artifacts/transfer-probe-base-train.summary.json
parse-error rate: 0%
```

## GEPA search history

All GEPA variants used TRAIN for optimization and DEV for selection. Holdout
remained untouched until the separately declared final four-run comparison.
The reflection model was `claude-sonnet-4-6`.

| Variant | Acceptance/representation | What it fixed | Result |
|---|---|---|---|
| v1 | Minibatch-gated suffix proposals | Initial GEPA plumbing | Acceptance signal was broken: minibatch means could be perfect while full TRAIN regressed |
| v2 | Failure-driven minibatches; full-TRAIN acceptance | Removed minibatch acceptance flaw; used multiple failure families and explicit failure taxonomy | All 8 children rejected; means 0.208333–0.479167 |
| v3 | v2 plus actual tool catalog, endpoint summaries, observed responses/errors, no-leakage audit | Removed invented-endpoint reflector artifact | All 8 children rejected; means 0.447917–0.760417 |
| v4 full rewrite | Full prompt replacement; frozen protocol prefix; four-task parse probe before full TRAIN | Removed append-position confound; rejected candidates whose probe parse rate exceeded baseline | All 8 children rejected; means 0.687500–0.833333 |

Selection for v2, v3, and v4-full was the empty prompt:

```text
DEV mean: 0.944444
G_sel: empty
G_best: none
```

The base TRAIN noise band was `[0.895833, 0.930556]`. Every v3 and v4-full
child fell below that band, including the best v4-full child (`0.833333`).
Thus every rejection was a measured regression rather than an
indistinguishable noise fluctuation, although each individual acceptance
decision still used one stochastic rollout per task.

Search artifacts:

```text
artifacts/gepa-log.jsonl
artifacts/gepa-v2-log.jsonl
artifacts/gepa-v3-log.jsonl
artifacts/gepa-v4-log.jsonl
artifacts/gepa-v4-full-log.jsonl
artifacts/gepa-v2-selection.json
artifacts/gepa-v3-selection.json
artifacts/gepa-v4-selection.json
artifacts/gepa-v4-full-selection.json
```

### v3 reflector environment

The v3 reflector received only public environment information:

```text
api_search: Read-only endpoint discovery. Args: {query: string}.
api_fetch:  Apply one API call. Args: {method: string, url: string, body?: object}.
finish:     End the episode and score the final state.

GET              /crm/contacts
GET, PATCH       /crm/contacts/{id}
GET, POST        /mail/drafts
GET, PATCH       /mail/drafts/{id}
GET, POST        /mail/messages
```

It also received the exact observed search results, fetch responses, and
errors from the failing rollouts. The catalog and responses contained no
assertions, gold labels, allowed writes, oracle state, or expected final
state. The audit reported zero leakage findings.

Artifact:

```text
artifacts/gepa-v3-environment.json
```

## Placebo control

The placebo controls isolate appended-text brittleness from useful content.
The empty baseline was `0.909722`.

| Prompt | Length | TRAIN mean | Delta | Parse-error rows | Forbidden-write rows | Turn-cap rows | Premature finishes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Empty | 0 | 0.909722 | — | 0 | 1 | 0 | 5 |
| P1: “Be careful and accurate.” | 4 words | 0.902778 | -0.006944 | 0 | 2 | 0 | 6 |
| P2: generic task/tool advice | 37 words | 0.899306 | -0.010417 | 0 | 2 | 1 | 5 |
| P3: benign irrelevant filler | 187 words | 0.798611 | -0.111111 | 1 | 0 | 0 | 12 |

P3 is the key methodological result: long harmless appended text alone cost
`-0.111111` on TRAIN and introduced a parse error. Short generic additions
were near baseline. This is why v4 tested full-prompt rewrite instead of
interpreting append-only GEPA as a clean content test.

Artifacts:

```text
artifacts/placebo-p1.txt
artifacts/placebo-p1-train.summary.json
artifacts/placebo-p2.txt
artifacts/placebo-p2-train.summary.json
artifacts/placebo-p3.txt
artifacts/placebo-p3-train.summary.json
```

## Base TRAIN failure diagnostic

The five base TRAIN failures in the baseline artifact were:

| Task | Score | Observable failure |
|---|---:|---|
| `simple-api-mail-draft-04` | 0.0 | Created a draft with a nested `draft` body instead of the observed flat fields; finished without the requested draft state |
| `simple-api-mail-send-04` | 0.0 | Recovered from an invalid guessed URL but used `PATCH /mail/drafts/{id} {"status":"sent"}`, which does not deliver a message |
| `simple-api-crm-mail-churn-04` | 0.0 | Sent a message despite the explicit “do not send” constraint |
| `simple-api-mail-send-and-close-03` | 0.333333 | Updated the CRM deal but abandoned mail delivery after lookup errors |
| `simple-api-mail-send-and-close-04` | 0.333333 | Updated the CRM deal but used draft status mutation instead of `POST /mail/messages` delivery |

These are execution, recovery, schema, and negative-constraint failures. The
model often discovered the environment but did not reliably complete all
requested state transitions. GRPO removed these baseline failures in the
measured empty-prompt cells.

## Receipts, cost, and cleanup

Headline cost: **approximately `$3` of the `$90` ceiling, sampling only; no
training and no deployments.** The billing endpoint exposes delayed token
usage rather than an authoritative per-run USD charge, so this is the
token-based sampling estimate for the full arm.

Provider and runtime:

```text
provider:        Tinker sampling API
base model:      nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
GRPO checkpoint: tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020
renderer:        nemotron3_disable_thinking
reflection:      claude-sonnet-4-6
```

Logged model-call totals:

| Group | Rollouts | Sampled tokens | Prompt tokens |
|---|---:|---:|---:|
| v1 GEPA, new calls | 428 | 91,459 | 1,932,139 |
| v2 | 448 | 161,639 | 4,395,622 |
| v3 | 448 | 116,766 | 3,125,405 |
| v4 conservative exploratory | 448 | 106,714 | 1,936,961 |
| v4 full rewrite | 480 | 108,595 | 1,904,000 |
| Placebos | 432 | 30,461 | 523,085 |
| Transfer TRAIN/DEV | 120 | 15,473 | 902,996 |
| Sealed holdout | 48 | 7,079 | 263,534 |
| Determinism repeats | 24 | 4,563 | 73,444 |
| Noise-band repeats | 216 | 28,533 | 461,960 |

The v1–v4 GEPA sampling subtotal was `2,252` rollouts,
`585,173` sampled tokens, and `13,294,127` prompt tokens. Including placebos,
the earlier estimate was approximately `$3.00` uncached-prefill equivalent
for the logged sampling calls.

The latest billing endpoint exposed token quantities, not authoritative USD
charges or reliable per-run attribution. The visible Nemotron sampling meter
was approximately `$1.19` under the current discounted-rate assumptions.
For the final handoff’s 1,266,954 prompt and 27,539 sampled tokens, the
token-based estimate was approximately `$0.261` assuming uncached prefill,
with an all-cached lower-bound estimate of `$0.063`.

Billing artifact:

```text
artifacts/billing-final-snapshot.json
```

No deployment or serving resource was created. The experiments used Tinker
sampling clients only; no serving deployment API was invoked, no local
evaluation process remains, and the GRPO checkpoint was pre-existing.

## What a future arm should do differently

1. Set `SamplingParams.seed` explicitly and record it in every artifact.
2. Use at least three seeded repeats for baseline, candidate acceptance, and
   DEV selection when score differences are smaller than the measured band.
3. Keep the canonical action protocol in the baseline and test content changes
   with full-prompt rewrite or controlled prompt placement, not only suffix
   appends.
4. Keep the reflector grounded in the public tool catalog and observed
   responses; reject invented paths, methods, fields, and task-specific values.
5. Treat the 12-task holdout as coarse evidence: one task is `0.083333`.
6. If prompt optimization still fails after seeded, variance-aware evaluation,
   move to policy/training interventions rather than claiming prompt
   impossibility from a noisy single-run gate.
