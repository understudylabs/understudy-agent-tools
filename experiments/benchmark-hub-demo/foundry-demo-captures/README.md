# foundry-demo-captures

Fully synthetic gateway captures (schema_version 4) — every payload is
invented, so committing them and the derived `../proposed-event-triage/`
foundry output raises no privacy issue. They exist so the benchmark hub always
has a real proposed-stage benchmark to render in demo mode.

- `make-captures.mjs` writes `captures.jsonl`: three execution groups covering
  multi-round tool use, an exact retry, a branch, an SSE-encoded response, and
  a read-only (no-mutation) group — one task per foundry split
  (construction / fit / heldout).
- Rebuild the derived benchmark with:

```sh
node experiments/benchmark-hub-demo/foundry-demo-captures/make-captures.mjs
node dist/bin.js traces build-benchmark \
  --source experiments/benchmark-hub-demo/foundry-demo-captures \
  --output experiments/benchmark-hub-demo/proposed-event-triage \
  --max-age-days 36500
```
