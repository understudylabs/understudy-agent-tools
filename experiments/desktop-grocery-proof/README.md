# Desktop grocery-marketplace proof

This local-only experiment sends one frozen synthetic slice through three
routes behind the same authenticated Desktop API:

1. the small local model alone;
2. the main local model alone;
3. the small model supervised by the main model.

The tasks cover codebase analysis, cart substitution, and operations
classification. Scoring is deterministic field equality; no remote judge,
provider call, upload, or customer data is involved.

With Understudy Desktop 0.3.2+ running and both slots warm:

```sh
node experiments/desktop-grocery-proof/run.mjs \
  --student-slot 9 \
  --teacher-slot 5
```

Evidence is written owner-only beneath
`~/.understudy/proofs/grocery-marketplace/<proof-id>/`: frozen tasks, one
canonical event JSONL per run, scored results JSONL, and a summary. Every row
retains the exact `run_id` and frozen suite SHA-256.
