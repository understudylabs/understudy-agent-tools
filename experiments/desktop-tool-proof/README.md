# Desktop strict-tool proof

This no-spend local proof compares warm Desktop models on the exact same
versioned tool-call inputs. It scores the canonical trace rather than trusting
the final prose: one exact named tool, exact parsed arguments, one paired
successful result, no orphan result, and the requested final output.

```sh
node experiments/desktop-tool-proof/run.mjs \
  --candidate 4b:7 \
  --candidate 12b:6 \
  --candidate 26b:5 \
  --repetitions 3
```

Evidence is written owner-only under
`~/.understudy/proofs/tool-correctness/<proof-id>/`. The task-file SHA-256 is
stored in every row and the summary. A tiny local slice proves integration and
identifies failure modes; it is not sufficient by itself for a production
replacement claim.
