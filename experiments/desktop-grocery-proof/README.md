# Desktop grocery-marketplace proof

By default this local-only experiment sends a three-task frozen synthetic smoke slice through
three routes behind the same authenticated Desktop API:

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

The separate promotion suite freezes 30 harder tasks—10 per workflow—behind
the same routes, scorer, run identity, and evidence contract. Use it after the
smoke passes:

```sh
node experiments/desktop-grocery-proof/run.mjs \
  --suite promotion \
  --student-slot 9 \
  --teacher-slot 5
```

The buyer report summarizes a promotion run at the three workflow-cluster
level and keeps all 30 task decisions in a collapsed audit. It remains
synthetic qualification evidence, not a production replacement claim.
Every route-task pair gets a unique session plus an exact `capture_run_id`, so
later tasks cannot inherit earlier answers and every result joins directly to
its canonical event trace. Supervisor reporting separates intervention
precision and recall from correction success, missed errors, false positives,
and interventions that noticed a bad answer but still failed to repair it.
Every turn has a two-minute default ceiling. A timeout requests exact Desktop
run cancellation or aborts the Pi incumbent run, preserves the canonical
terminal event, and counts as a failed task rather than hanging or disappearing.
Use `--turn-timeout-ms <milliseconds>` only when a deliberately slower baseline
needs a different frozen ceiling.

To compare a hosted incumbent on the identical slice, opt in explicitly. This
fourth route uses Pi and the same canonical event contract; it does not add a
second benchmark harness in Rust. The command requires the credential by
environment-variable name, user-supplied token prices, a worst-case spend fuse,
and `--confirm-spend` before any synthetic prompt leaves the machine:

```sh
export INCUMBENT_API_KEY='<set in the terminal, never in chat>'
node experiments/desktop-grocery-proof/run.mjs \
  --student-slot 9 \
  --teacher-slot 5 \
  --incumbent-base-url https://provider.example/v1 \
  --incumbent-model incumbent-model-id \
  --incumbent-provider-kind openai-compatible \
  --incumbent-api-key-env INCUMBENT_API_KEY \
  --incumbent-input-usd-per-million 2.50 \
  --incumbent-output-usd-per-million 10.00 \
  --budget-usd 0.10 \
  --confirm-spend
```

The proof stores the model id, a SHA-256 of the base URL, the supplied price
basis, conservative budget preflight, and provider-reported actual usage. It
never stores the key or the cleartext remote URL. Omitting all incumbent flags
retains the no-network three-route proof.

Evidence is written owner-only beneath
`~/.understudy/proofs/grocery-marketplace/<proof-id>/`: frozen tasks, one
canonical event JSONL per run, scored results JSONL, and a summary. Every row
retains the exact `run_id` and frozen suite SHA-256.

Each run also writes a self-contained `report.html` plus its structured
`report.json` model. The report leads with a bounded route recommendation,
quality/latency/cost comparison, per-task decision, supervisor audit, caveats,
and next pilot gate. The supervisor audit preserves each verdict reason and shows
chosen-verdict first-token probability without presenting it as calibrated
correctness. It contains no raw prompts or completions and makes no remote
requests.

To render the current buyer report from older immutable evidence without
rerunning models:

```sh
node experiments/desktop-grocery-proof/run.mjs \
  --report-from ~/.understudy/proofs/grocery-marketplace/<proof-id>
```

The command never edits the source proof. It writes a content-addressed,
owner-only report package beneath
`~/.understudy/reports/grocery-marketplace/`, including the current
`report.html`, structured `report.json`, and a manifest binding source-file and
renderer hashes. Repeating the command is idempotent; a changed source or
renderer produces a new package rather than overwriting evidence. Use
`--report-output-root <path>` only when automation needs a different local
destination.

For a buyer-facing walkthrough, use the
[30-minute grocery-platform demo](DEMO.md). It keeps the measured judge miss in
the story and separates deterministic synthetic evidence from a production
promotion claim.
