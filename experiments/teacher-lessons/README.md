# teacher-lessons (experiment)

Status: scaffold. See the proposal:
[`docs/proposals/teacher-lessons.md`](../../docs/proposals/teacher-lessons.md).

Retrieve decisive segments of past coding-agent traces, compress them into
compact worked examples ("lessons"), inject them into a local model's context,
and A/B whether they move task completion on final-state-scored tasks.

## Layout (planned)

```
extractor/    query a local session index for similar-task segments
normalizer/   map source-harness tool vocabulary -> target tool schema
compressor/   segment -> <=800-token worked example
runner/       with/without-lessons A/B on a pinned local model
fixtures/     synthetic traces only — never real session content
results/      aggregate metrics (committed), raw runs (gitignored)
```

## Rules

- Local-first; no uploads. Real traces stay on-machine; only aggregate
  metrics land in git.
- Pin everything per run: model rung, decode settings (QAT rungs:
  temperature 1.0 / top_p 0.95 / top_k 64), lesson count, prompt hashes.
- Never retrieve lessons derived from frozen dev/holdout tasks when scoring
  eval tasks (see `curate-trajectories`).

## MVP milestones

1. Extractor + normalizer produce 10 lessons from real local session history
   (manual spot-check for tool-schema correctness).
2. Runner completes a 5-task smoke A/B on Gemma 4 E2B QAT.
3. Full A/B: >=20 tasks, >=3 seeds, with/without lessons; report deltas on
   completion, parse failures, retries, tokens.
4. Decision: cook (lesson-library + GEPA over extraction prompts) or write up
   the negative result.
