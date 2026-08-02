# Nemotron curriculum ladder

Start with [`PREREGISTRATION.md`](./PREREGISTRATION.md) for the fixed
holdout protocol and [`RESULTS.md`](./RESULTS.md) for the decision-oriented
writeup. Machine-readable rows, receipts, transcripts, manifests, and reports
are under [`artifacts/`](./artifacts/).

This experiment uses the v2 offline AutomationBench fixture with Tinker
sampling, `nemotron3_disable_thinking`, temperature `0.0`, and one sample per
task. The v2 fixture is the scoring authority:

- train: 120 tasks
- dev: 36 tasks
- holdout: 60 tasks
- holdout SHA-256: `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9`

The checked-in transfer-matrix artifacts under
`experiments/generalization-transfer-matrix/` were produced against the older
synthetic-workflow fixture. Their counts and hashes are historical and are not
restated as current results here.

`artifacts/cost-probe.json` contains the six-cell, three-task dev-only probe
and token/time extrapolations. No full dev matrix or holdout evaluation is
included in this probe.

The evaluator parser is held constant across all six cells and accepts bare
JSON, `<tool_call>JSON</tool_call>`, and `<finish/>`. Recorded v1 transcript
replay from the SFT/GRPO and DPO artifacts preserved every per-task reward.
The prior all-zero hard-task probe was diagnosed as step-limit exhaustion:
the base/v1 transcripts made twelve read-only calls, never emitted a terminal
action, and had no parse errors or forbidden effects. The oracle scores all
three probe tasks at `1.0`.

Tinker documents the Nemotron row at `$0.39` per million prefill tokens,
`$0.99` per million sampled tokens, and `$0.88` per million training tokens,
with a displayed limited-time 50% discount. The receipt records both rates
and the corresponding inference projections.

The free step-budget audit is recorded in `artifacts/step-budget.json`: the
v2 hard train+dev oracle requires 3–7 environment steps (p50 4, maximum 7),
while the model harness permits 12 turns. The limit is therefore not binding
and was left unchanged for every cell.

The full six-cell dev matrix is recorded in `artifacts/full-dev-matrix.json`
and the corresponding `ladder-full-*.summary.json` files. The GEPA prompt
scored zero with both tuned adapters, while the `nemotron-v1` prompt scored
0.4458 with SFT and 0.4921 with DPO. The prompt-carry decision is therefore
to retain `nemotron-v1` for the tuned adapters; no holdout evaluation was run.

The first full GEPA evaluation exposed a lane-composition bug: the Tinker
harness replaced the system prompt but omitted the `Available tools` block
that the GEPA runner appends to the user message. The R0 system prompt embeds
the API schema, while the GEPA prompt intentionally does not; consequently
the original R1 transcript had 166 empty-assistant parse results, 78 unknown
tool results, and no usable task progress. The harness now returns the
observation tool catalog from `/reset` and appends the same user-message
catalog block as the GEPA runner for every prompt variant.

After that fix, R1/R2/R3 were rerun on the full dev split. The corrected
results are in `artifacts/ladder-composed-r*-*-full.summary.json`; they are
not comparable to the earlier pre-composition R1/R2/R3 artifacts.

The v1-prompt cells were also rerun after the composition change because their
rendered user messages were not byte-identical: the corrected messages include
the observation-provided `Available tools` catalog. The corrected v1 results
are recorded as `artifacts/ladder-corrected-*.summary.json`.

The GRPO step-20 checkpoint was added as a first-class dev and holdout cell:

```text
tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020
```

The holdout sweep was preregistered and committed before execution in
`PREREGISTRATION.md`. All eight cells ran exactly once against the frozen
60-task split. Results, per-cell diagnostics, marginal lifts, and DPO-vs-GRPO
deltas are recorded in `artifacts/holdout-sweep.json`. No holdout result was
used for selection or tuning.

## Transfer and forgetting check

After the AutomationBench holdout was closed, the four retained policies were
evaluated on train and dev only for the native event-categorizer and expanded
synthetic-workflow verifiers. The AutomationBench prompt was not carried onto
either target. Both targets used their native protocol, the
`nemotron3_disable_thinking` renderer, greedy sampling, one sample, the
twelve-turn limit, and the uniform tolerant parser.

Auditable transfer artifacts are:

```text
transfer-manifest.json
transfer-report.json
transfer-report.md
transfer-matrix.json
artifacts/transfer-rows/
artifacts/transfer-receipts/
artifacts/transfer-transcripts/
```

Rows are `understudy.eval_result.v1` and carry split hashes, task content
hashes, native prompt hashes, checkpoint references, verifier revisions, and
measured cost alongside the budget and evidence scope. The report is produced
by the existing generalization harness rather than a bespoke scorer.

The event target has 8 train and 2 dev tasks. All four policies scored
identically: train mean `0.9625` and dev mean `1.0000`, with no parse or
termination failures. This is a ceiling result, not evidence of a small
transfer difference.

The synthetic target has 48 train and 12 dev tasks. Tuned-minus-base means
for train/dev were:

| Policy | Train delta | Dev delta |
|---|---:|---:|
| SFT epoch 4 | +0.0365 | -0.0208 |
| GRPO step 20 | -0.0104 | +0.0347 |
| DPO epoch 2 | +0.0087 | -0.0486 |

These differences are small relative to the fixture resolution and include
both fixed and regressed tasks. The synthetic train+dev aggregate has 60
tasks, but the prior sealed transfer evidence had only 2-task dev and
2-task holdout slices; those sealed splits were cited, not reread. No
holdout split was accessed in this phase.
