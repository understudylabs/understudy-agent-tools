# Nemotron curriculum ladder: results and workflow handoff

## Decision headline

The v2 hard split changes the decision. On the sealed 60-task holdout, the
base policy with the `nemotron-v1` prompt scored `0.4456`. Every tuned rung
was lower overall:

| Cell | Overall mean | Strict pass | v1-style tier | Hard tier |
|---|---:|---:|---:|---:|
| Base + `nemotron-v1` | 0.4456 | 0.3333 | 0.7778 | 0.3626 |
| Base + GEPA v3 | 0.1431 | 0.1167 | 0.3611 | 0.0885 |
| SFT epoch 4 + `nemotron-v1` | 0.3175 | 0.2333 | 0.8611 | 0.1815 |
| SFT epoch 4 + GEPA v3 | 0.3129 | 0.2500 | 0.7361 | 0.2071 |
| GRPO step 20 + `nemotron-v1` | 0.3313 | 0.2333 | 0.8611 | 0.1989 |
| GRPO step 20 + GEPA v3 | 0.3673 | 0.2667 | 0.7361 | 0.2751 |
| DPO epoch 2 + `nemotron-v1` | 0.3300 | 0.2333 | 0.8611 | 0.1972 |
| DPO epoch 2 + GEPA v3 | 0.3129 | 0.2333 | 0.7361 | 0.2071 |

The honest cumulative-ladder conclusion is that the v1-fixture curriculum
bought in-distribution polish at the cost of hard-task generalization. The
v1 tier improves from `0.778` to approximately `0.861` for the tuned
policies, while the hard tier falls from `0.363` to approximately
`0.18–0.20`. This became visible only after the saturated v1 fixture was
replaced by the harder v2 split.

Relative to base + `nemotron-v1`, the marginal overall changes are:

| Transition | Overall delta |
|---|---:|
| SFT + v1 | -0.1281 |
| GRPO + v1 | -0.1143 |
| DPO + v1 | -0.1156 |
| Base + GEPA | -0.3025 |
| SFT + GEPA | -0.1327 |
| GRPO + GEPA | -0.0783 |
| DPO + GEPA | -0.1327 |

The GEPA prompt is a lane-dependent transfer result, not a statement that
the prompt is intrinsically bad. It was a clear win on the Fireworks lane,
but was strongly negative on the Tinker
`nemotron3_disable_thinking` lane for the base policy. It was positive only
for GRPO on the holdout (`0.3313` to `0.3673`), and negative for SFT and DPO.

## Composition and parser findings

The first full GEPA Tinker evaluation produced discarded all-zero cells. The
cause was a harness composition bug: replacing the system prompt also
removed the `Available tools` block that the GEPA runner appends to the user
message. The GEPA text assumes that catalog is supplied separately; the
v1 prompt embeds its schema in the system message.

Evidence from the discarded R1 transcripts included 78 unknown-tool errors,
including:

```text
{"error":"unknown tool: GET"}
```

The discarded transcripts also had 166 empty assistant messages and ran to
the twelve-turn limit. The fix returns the observation tool catalog from
`/reset` and appends it to the user message for every prompt variant. The
corrected R1/R2/R3 cells were rerun. The corrected full-dev means were:

```text
R1 base + GEPA: 0.1944
R2 SFT + GEPA:  0.4101
R3 DPO + GEPA:  0.3499
```

The v1 cells were also rerun because their rendered prompts were not
byte-identical after the composition change. The earlier v1 dev values are
superseded; the corrected v1 means were:

```text
R0 base + v1: 0.4798
SFT + v1:     0.4173
DPO + v1:     0.4497
GRPO + v1:    0.4590
```

The tolerant parser was applied uniformly across all cells. It accepts bare
JSON, fenced/prose-wrapped JSON, the `<tool_call>...</tool_call>` wrapper,
and `<finish/>` as the terminal action. Replay of 27 recorded v1 rows from
the SFT/GRPO and DPO artifacts preserved every sealed per-task reward
byte-for-byte. The parser replay test passed with 10 tests and zero failures.

## DPO versus GRPO

Deltas below are DPO minus GRPO.

### Dev

| Prompt | Overall | v1-style | Hard | Discovery | Single-write | Multi-write |
|---|---:|---:|---:|---:|---:|---:|
| v1 | -0.0093 | -0.0278 | 0.0000 | -0.2500 | 0.0000 | +0.1667 |
| GEPA | -0.0827 | 0.0000 | -0.1240 | 0.0000 | -0.1063 | 0.0000 |

### Holdout

| Prompt | Overall | v1-style | Hard | Discovery | Single-write | Multi-write |
|---|---:|---:|---:|---:|---:|---:|
| v1 | -0.0014 | 0.0000 | -0.0017 | 0.0000 | -0.0016 | 0.0000 |
| GEPA | -0.0544 | 0.0000 | -0.0680 | 0.0000 | -0.0627 | 0.0000 |

Under the matching v1 prompt, DPO and GRPO are effectively tied. Under the
mismatched GEPA prompt, GRPO is ahead, especially on hard and single-write
tasks.

The DPO arm used approximately 778K evaluator tokens and 24 optimizer steps;
the arm's own receipts are under
`experiments/nemotron-tinker-dpo/artifacts/`. GRPO used approximately 5.35M
tokens across its multi-stage training/evaluation receipts under
`experiments/nemotron-tinker-grpo/artifacts/`. This is the cost separator:
the quality result is close under the matching prompt, while the training
protocols are not cost-equivalent.

## Transfer and forgetting

Resolution caveat first: the event target has only 10 train+dev tasks and is
ceiling-limited. The synthetic target has a 12-task dev slice. Neither target
can resolve a small one- or two-task difference as a strong finding.

The transfer run used native target protocols, not the AutomationBench
prompt, and evaluated train+dev only. The machine-readable matrix is
`transfer-matrix.json`; the generalization-harness outputs are
`transfer-manifest.json`, `transfer-report.json`, and `transfer-report.md`.

### Event Categorizer

All four policies scored train mean `0.9625` and dev mean `1.0000`, with no
parse or termination failures. Tuned-minus-base deltas were zero for SFT,
GRPO, and DPO on both splits. This is a ceiling result, not evidence that
small differences are absent.

### Synthetic Workflow

| Policy | Train delta | Dev delta | Combined train+dev delta |
|---|---:|---:|---:|
| SFT epoch 4 | +0.0365 | -0.0208 | +0.0250 |
| GRPO step 20 | -0.0104 | +0.0347 | -0.0014 |
| DPO epoch 2 | +0.0087 | -0.0486 | -0.0028 |

The aggregate synthetic result is effectively unchanged within fixture
resolution. The small dev declines for SFT/DPO and the small GRPO increase
should not be promoted to a strong forgetting or transfer claim.

## Cost and receipts

Tinker pricing was verified from the official model page:

<https://tinker-docs.thinkingmachines.ai/tinker/models/>

For Nemotron-3-Nano:

| Rate | Undiscounted | Displayed 50% discount |
|---|---:|---:|
| Prefill/input | $0.39/M tokens | $0.195/M |
| Sampling/output | $0.99/M tokens | $0.495/M |
| Training | $0.88/M tokens | $0.44/M |

Measured inference spend by phase:

| Phase | Undiscounted | Discounted |
|---|---:|---:|
| Three-task diagnostics/probes | $0.0879 | $0.0439 |
| Corrected full dev cells | $1.0421 | $0.5210 |
| Sealed eight-cell holdout sweep | $1.8313 | $0.9156 |
| Train+dev transfer check | $0.4720 | $0.2360 |

The transfer receipts explicitly distinguish measured usage from budget and
carry `evidence_scope`. The evaluator usage endpoint returned empty deltas
for the local ladder receipts, so token-derived costs are marked as measured
local token accounting rather than provider-account billing.

The arm created no on-demand deployment. Its Tinker sampler processes were
ephemeral local services and have been stopped. No Fireworks deployment or
other provider deployment was created by this arm, so there is nothing to
tear down.

## Limitations and claim boundary

- One seed and one sample per task.
- Greedy decoding at temperature `0.0`.
- The holdout has 60 tasks, while transfer targets are small.
- Synthetic fixtures only; no customer or private data was used.
- Holdout was evaluated exactly once per preregistered cell and was not reread
  during transfer or contract work.
- Results do not establish production behavior or deployment readiness.

## Workflow contract mapping

This arm is a verifier/contract plus candidate-method surface. It does not
create a controller, queue, poller, state database, background loop, or
provider execution path.

`src/workflow-executor.ts` turns one ladder cell into a canonical
`understudy.executor-submit.v1` payload. Candidate identity is represented
by the prompt SHA and `tinker://` checkpoint reference. Workload identity and
train/dev split references are hash-bound; holdout fields are structurally
absent and rejected if supplied.

`FixtureExperimentExecutor` exposes the executor-shaped methods
`submit`, `inspect`, `cancel`, and `reconcileUsage`. Submission is
deterministically idempotent over experiment, candidate, attempt, split
hashes, prompt SHA, and checkpoint reference. It makes no provider calls.
Events are redacted and validated against the canonical event schema.
Usage reconciliation carries the run's `evidence_scope` rather than
hardcoding it.

The canonical schema's `executor` enum does not contain `tinker`; this adapter
therefore registers as `fixture` and does not smuggle `tinker` into another
field. The enum gap is explicitly left for PR #545 to resolve.

## Artifacts

- `PREREGISTRATION.md`
- `transfer-manifest.json`
- `transfer-matrix.json`
- `transfer-report.json`
- `transfer-report.md`
- `artifacts/` row, receipt, transcript, probe, dev, and holdout evidence
- `schemas/vendor/understudy-experiment-v1/` vendored contracts and provenance
