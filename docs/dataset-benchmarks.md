# Dataset benchmarks — labeled rows on the benchmark spine

`understudy benchmarks from-dataset` is the dataset entrance to the benchmark
foundry: a labeled dataset (JSONL/CSV/TSV/XLSX) becomes a first-class benchmark
directory, so classification workloads (the und-289 Instacart Shopper Stage-4
shape) land on exactly the same spine as trace-derived benchmarks — same
tasks.jsonl, same benchmark.json proposal, same generated verifiers
environment, same run queue, floors, calibration, rigor report, experiments
lineage, and Pareto.

## The Derek journey, end to end

Derek has a CSV of support segments with model-assigned labels and wants to
know whether a cheaper model can do the labeling. He is not an eval engineer.

### 1. Drop → benchmark

```bash
understudy benchmarks from-dataset segments.csv \
  --output ~/.understudy/benchmarks/shopper-stage4 \
  --label-column l3 --input-column segment_text --group-column raw_review \
  --taxonomy shopper_taxonomy_map.json
```

Input/label columns are inferred when not given (the same heuristics as
`understudy capture-import inspect-csv`); flags override. What comes out:

- **One task per kept row.** The task prompt is the row's input text under an
  authored (`--system-prompt`, `@file` supported) or derived system prompt
  that lists the full taxonomy and demands `{"label": "<label>"}`. The outcome
  contract is exactly one `contains_category` response obligation carrying the
  gold label, scored through the shared fence-tolerant JSON path — prose-
  wrapped or ```json-fenced answers score the same as bare JSON.
- **Curation with an audit report, not questions.** Automatically, and always
  recorded:
  - exact duplicates removed (dedupe key: NFKC + casefold + whitespace-
    collapsed input text) — listed in `curation/duplicates.jsonl`;
  - label conflicts quarantined (the same normalized input carrying two
    different labels is ambiguous gold; ALL members quarantined) — listed in
    `curation/conflicts.jsonl`;
  - empty inputs/labels removed — `curation/unusable.jsonl`.
  `curation-report.md` explains every step in plain language; the same numbers
  live machine-readably in `manifest.json` under `curation`
  (`understudy.dataset_curation.v1`). Derek never gets silently wrong data OR
  twenty questions.
- **GROUPED splits (leakage prevention).** Every row belongs to a leakage
  group — the normalized `--group-column` value (und-289: the raw review a
  segment came from), else the normalized input text. A group lands in exactly
  one of train/dev/holdout: zero group overlap by construction, asserted at
  build time. Ratios default 0.8/0.1/0.1 (`--train/--dev/--holdout`).
- **An oracle that scores 1.0 by construction.** Each row's gold response
  (`{"label": …}`) is stored as a synthetic capture, so the standard offline
  oracle validates every contract before the benchmark exists; a build whose
  oracle cannot pass refuses to claim otherwise (`oracle_pass` on the
  manifest).
- **Class support + imbalance surfaced.** Per-label support by split, thin
  classes (<5 examples), taxonomy classes with zero examples, and the majority
  share are all in the report — with the majority_class floor arm auto-included
  in the recommended run.

### 2. Review (born accepted)

Dataset tasks follow the same born-accepted inbox semantics as trace tasks:
with no `review-policy.json`, generated tasks are accepted by default and
machine signals render as attention flags. Nothing new to learn; the hub and
`understudy benchmarks review` work unchanged.

### 3. Run — floors first

```bash
understudy runs queue --benchmark <dir> \
  --models gemma-4-e2b,claude-sonnet --trivial-arms null_agent,majority_class --split dev
understudy runs execute --benchmark <dir>
```

The majority_class arm answers the most frequent TRAIN-split label on every
task — the imbalanced-classifier trap. Any model must clear that floor before
its accuracy means anything; the curation report says so in Derek's language.

### 4. Rigor + per-class metrics

`understudy benchmarks rigor <dir>` now adds, for classification-shaped
benchmarks:

- a **Majority-class floor** checklist row next to the null/spam floors;
- a **Class balance** row (class count, majority share);
- a **Per-class metrics** section per arm: support by split, accuracy (first
  rollout per task), pass@k (any of k rollouts), macro/micro accuracy, and a
  confusion summary of top gold→predicted misses.

Confusion is derived from eval rows: rows now carry an additive
`final_response_excerpt` (capped at 400 chars, local artifacts only), and the
predicted label is resolved deterministically — fenced/bare JSON
`{"label": …}` naming a known label, else the unique label whose tokens all
appear, else honestly unresolved. The derivation is a pure module
(`src/dataset-metrics.ts`, `understudy.class_metrics.v1`) the hub can render
later; no hub components ship with this feature.

### 5. Train → experiment lineage

The frozen split assignment has a hash: `splits.splits_sha256` on both
`benchmark.json` and the foundry manifest (also printed in
curation-report.md). A training run on this dataset records it in
`experiments.jsonl` (understudy.experiment.v1):

```bash
understudy benchmarks experiment create <dir> --input '{
  "hypothesis": "qwen3-8b full SFT reaches 90% exact L3 on the frozen holdout",
  "data_selection": {"selection_hash": "…", "source": "segments.csv",
                      "splits_sha256": "<splits.splits_sha256>"},
  "training": {"method": "sft", "base_model": "qwen3-8b", "provider": "fireworks",
                "config": {"max_context_length": 1024}, "approvals": []}
}'
```

Approval gates before provider spend (consensus audit, customer-data upload,
training fuse — the und-289 discipline) live on the same record; eval runs of
the produced artifact link back through `eval_run_ids`, and the four-way
verdict (promote/shadow/collect/stop) closes the loop.

### 6. Arms → Pareto → verdict

Local bundle arms (`--local-arm label=path`), gateway models, prompt-override
arms, and the floors all produce `understudy.eval_result.v1` rows in the same
files, so the existing leaderboard, Pareto, and claim tooling apply without
change.

## Schema decisions (why a sibling, not an extension)

- `manifest.json` is **`understudy.dataset_foundry.v1`**, a sibling of
  `understudy.trace_foundry.v1`. The trace manifest's blocks are capture-
  census-shaped (freshness cutoffs, capture ledger, source DAG); every one of
  them would be a lie for dataset rows. The parts that must not fork —
  benchmark.json, tasks.jsonl, the environment package, self_check, the
  leakage audit — are produced by the same shared code
  (`benchmarkManifestFrom`, `writeVerifiersEnvironment`,
  `runFoundrySelfCheck`), so the executable contract is identical in kind.
- `benchmark.json` stays `understudy.benchmark_proposal.v1` /
  `understudy.benchmark.v1` with the **additive provenance origin
  `derived-from-dataset`** and per-task genesis `imported`. Old readers fall
  through to their unknown-origin styling; the shared validator accepts it.
- Gold rides `normalized-captures.jsonl` as synthetic captures (the row's
  `{"label": …}` as the incumbent final response), which is exactly where the
  oracle runner and offline validation already look — no new gold channel.

## und-289 replication

Run against the und-289 Shopper high-confidence pool (5,398 rows,
`router_persona=Shopper`, `classify_confidence ≥ 0.90`), grouped by normalized
raw review, with the 157-label taxonomy:

| Measure | und-289 published | from-dataset |
| --- | --- | --- |
| Exact-text duplicates removed | 18 | 18 |
| Label-conflict rows excluded | 3 | 3 |
| Rows kept | 5,377 | 5,377 |
| L3s with examples / canonical | 148 / 157 | 148 / 157 (9 missing reported) |
| Splits (train/dev/holdout) | 4,272 / 546 / 559 | 4,301 / 538 / 538 |

Split totals match; per-split sizes differ slightly because the greedy group
allocation is a different deterministic algorithm at the same 0.8/0.1/0.1
ratios with the same zero-group-overlap guarantee. Floors on the built
benchmark: oracle 5,377/5,377, null agent 0%, majority_class 15.1% micro on
dev (majority label "Unable to classify or no clear actionable problem",
13.3% support) — the floor any candidate must beat.
