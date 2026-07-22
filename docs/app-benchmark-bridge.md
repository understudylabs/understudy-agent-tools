# Desktop app → benchmark/experiment spine bridge

The desktop drag-drop training flow (CSV/JSONL → prepared dataset → local
classification / local SFT / remote training) now feeds the same
machine-readable spine the CLI and benchmark hub use. A self-service user gets
lineage, approval gates, and benchmark comparison from the flow that already
exists — no new workflow to learn.

## What the app records

**Experiment lineage (`understudy.experiment.v1`).** Every training start
creates one record via `understudy benchmarks experiment create <dir>
--plain-dir` (a small additive CLI mode that writes `experiments.jsonl` next
to the prepared dataset, before any benchmark exists):

- `hypothesis` — auto-drafted from the training config;
- `data_selection` — the split hashes the drop flow already verified
  (train-split sha256 as the selection hash, plus a digest over the frozen
  train/dev/holdout hashes);
- `status` transitions `training → concluded/abandoned`, with a conservative
  verdict mapping (the app never auto-`promote`s; the strongest outcome of a
  single run is `shadow`);
- local SFT runs attach the produced LoRA adapter as `produced_artifact`.

The compact lineage card (`ExperimentLineageCard`) renders the record —
experiment id, status, data hash, provider, cleared gates, verdict — in each
training run view.

## The approval gate (und-289 discipline, as a hard boundary)

Before any REMOTE submission the confirm screen is an explicit approval gate:
provider, estimated maximum cost, and the fact that the listed artifacts leave
the machine. Approving appends
`{gate: "provider_training_spend", approved_by: <app identity>, at}` to the
experiment record FIRST; only then is `start_remote_training` invoked — and
that Tauri command independently re-reads `experiments.jsonl` and **refuses to
upload** unless the newest record carries the cleared gate
(`verify_provider_training_spend_approval` in
`apps/homescreen/src-tauri/src/experiment_lineage.rs`). Local training needs
no gate.

## Benchmark linkage

Where a dropped dataset has a benchmark dir (`<artifact_root>/benchmark` by
convention), the training result view offers **Compare on benchmark**: it
queues one `understudy.run_request.v1` through the existing file queue
(`understudy runs queue --local-arm <label>=<adapter> --models <incumbent>
--incumbent <incumbent> --trivial-arms majority_class --experiment <id>`) and
polls `runs list` for status. The app never executes models; `understudy runs
execute --watch` does.

Feature detection, honestly surfaced (`BenchmarkLinkagePane`):

- benchmark exists + servable artifact → "Compare on benchmark";
- benchmark exists, no servable artifact (e.g. the ModernBERT classifier) →
  an honest "can't take an arm yet" state;
- no benchmark, but the CLI has `benchmarks from-dataset` (detected at runtime
  via `understudy benchmarks --help`; the verb ships separately) → "Build
  benchmark from this dataset";
- neither → the benchmark entrance landing state.

## Additive CLI surface

- `understudy benchmarks experiment create|update … --plain-dir` — lineage in
  a plain directory (validation unchanged; `list`/`show` already work there).
- `understudy runs queue --experiment <id>` — cross-links a queued run to an
  experiment, with the same must-already-exist check the hub/MCP queue path
  enforces. When queueing against a benchmark whose `experiments.jsonl` lacks
  the record, the app copies the dataset-side record in first.
