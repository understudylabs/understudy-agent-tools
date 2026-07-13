# Desktop strict-tool proof

This no-spend local proof compares warm Desktop models on the exact same
versioned tool-call inputs. By default it calls each warm model directly through
Pi, using Desktop only for the authenticated read-only tool executor. Synthetic
benchmark attempts therefore do not enter the genuine Desktop release cohort.
It scores the canonical trace rather than trusting the final prose: one exact
zero, one, or an ordered sequence of exact named tools; exact parsed arguments;
paired successful results; no orphan results; and the requested final output.
The frozen suite includes no-tool abstention, decoy tool names, numeric argument
typing, malformed-JSON pressure, nested wrapper arguments, and ordered two-step
tool rounds in addition to the basic one-call cases.
Each attempt has a 30-second terminal timeout by default so a slow local tool or
model becomes explicit cancellation evidence instead of hanging the suite; use
`--timeout-ms` only when deliberately testing a slower environment.

```sh
node experiments/desktop-tool-proof/run.mjs \
  --candidate 4b:7 \
  --candidate 12b:6 \
  --candidate 26b:5 \
  --repetitions 3
```

For a causal probe against an exact frozen task, repeat `--task-id` as needed:

```bash
node experiments/desktop-tool-proof/run.mjs \
  --candidate 26b-bf16:9 \
  --task-id two-step-catalog-models \
  --repetitions 3
```

Filtered proofs hash and persist only the selected task subset, so they cannot
be confused with evidence from the full frozen suite.

For Gemma 4 MoE compression repair, the local converter preserves QAT's
group-size-32 contract, keeps routers at 8-bit, and protects an explicit layer
set at 6-bit while leaving the remaining body at 4-bit:

```bash
python experiments/desktop-tool-proof/convert-gemma4-moe-mixed.py \
  --source <qat-bf16-source> \
  --output <candidate-output> \
  --protected-layers 15-29
```

Every generated artifact is a candidate until it passes both the exact
10-attempt causal probe and the full 51-attempt strict suite.

The direct runner resolves the selected slot from the authenticated residency
surface and cross-checks its model path against the local agent card. Portable
summary/results rows record the model id, Pi runtime, task hash, and exact
tool-schema hash, never the capability token. Owner-only canonical event files
preserve provider-emitted model fields and raw local tool results, so they can
contain machine paths or local trace data and must not be uploaded. Run
`npm run build` first when executing from a fresh source checkout.

`--desktop-api` retains the end-to-end Desktop turn path for integration
debugging. Do not use that mode for synthetic model comparisons during a release
observation window because those turns are intentionally recorded by the app.

Evidence is written owner-only under
`~/.understudy/proofs/tool-correctness/<proof-id>/`. The task-file SHA-256 is
stored in every row and the summary. A tiny local slice proves integration and
identifies failure modes; it is not sufficient by itself for a production
replacement claim.

See [`RESULTS.md`](RESULTS.md) for the latest sanitized aggregate comparison and
promotion decision. Raw canonical event files stay local.
