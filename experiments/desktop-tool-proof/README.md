# Desktop strict-tool proof

This no-spend local proof compares warm Desktop models on the exact same
versioned tool-call inputs. By default it calls each warm model directly through
Pi, using Desktop only for the authenticated read-only tool executor. Synthetic
benchmark attempts therefore do not enter the genuine Desktop release cohort.
It scores the canonical trace rather than trusting the final prose: one exact
named tool, exact parsed arguments, one paired successful result, no orphan
result, and the requested final output.

```sh
node experiments/desktop-tool-proof/run.mjs \
  --candidate 4b:7 \
  --candidate 12b:6 \
  --candidate 26b:5 \
  --repetitions 3
```

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
