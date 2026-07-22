# Artifact contracts: who writes what, who reads it, and where the codec lives

The benchmark stack is file-based: the CLI (foundry, author, run executor)
writes artifacts into a benchmark directory and the Benchmark Hub
(`apps/benchmark-hub`) reads them. Historically the two sides forked their
parse/serialize logic and drifted (the schema-name collision, the renamed
proposal stamp, the "accept both grounding shapes" patch, the legacy-journal
newline saga). The fix that stuck is the **runs-core pattern**: the hub
re-imports the CLI's compiled `dist/` module, so writer and reader physically
cannot drift.

Shared codec home: [`src/benchmark-artifacts.ts`](../src/benchmark-artifacts.ts)
(compiled to `dist/benchmark-artifacts.js`), re-exported hub-side by
[`apps/benchmark-hub/lib/artifacts-core.ts`](../apps/benchmark-hub/lib/artifacts-core.ts).
Contract invariants (one-line-one-row JSONL, tolerant readers, torn-tail rule,
portable recorded paths) are documented in that module and enforced by
`tests/artifact-contracts.test.mjs` (round-trips + schema drift) and
`apps/benchmark-hub/tests/relocation.test.mjs` (directory relocation).

## Inventory

| Artifact | Schema id | Writer module | Reader module(s) | Codec |
| --- | --- | --- | --- | --- |
| `manifest.json` | `understudy.trace_foundry.v1` | `src/trace-foundry.ts` (`writeFoundryArtifacts`) | `apps/benchmark-hub/lib/data-core.ts` (`loadProposedEntryFromDir`) | **shared** — schema id + portable artifact paths from `benchmark-artifacts` |
| `tasks.jsonl` | `understudy.benchmark_task.v1` (per line) | `src/trace-foundry.ts`, enriched by `src/trace-author.ts` | hub `data-core.ts`, `trace-viewer-core.ts`; CLI `run-executor.ts`, `trace-foundry.ts` (promote/regenerate) | **shared** — JSONL codec + schema id |
| `benchmark.json` (pre-promotion) | `understudy.benchmark_proposal.v1` (older builds: colliding `understudy.benchmark.v1`) | `src/trace-foundry.ts` (`benchmarkManifestFrom`) | hub `data-core.ts` (cross-check only, never consumed as promoted) | **shared** schema ids |
| `benchmark.json` (promoted) | `understudy.benchmark.v1` | `src/trace-foundry.ts` (`promoteTraceBenchmark`) | hub `benchmark-core.ts` → **re-export of `dist/benchmark.js`** (was a vendored copy) | **shared** — `validateBenchmarkManifest` |
| `promotion-record.json` | `understudy.promotion_record.v1` | `src/trace-foundry.ts` | hub `data-core.ts` | **shared** schema id |
| `reviews.jsonl` | `understudy.benchmark_review.v1` | hub `app/api/reviews/route.ts` (via shared `makeBenchmarkReview`/`serializeReviewLine`) | hub `data-core.ts`; CLI `trace-foundry.ts` promote (via shared `readReviews`) | **shared** — constructor, validator, superseding rule |
| `source-dag.json` | `understudy.source_dag.v1` | `src/trace-foundry.ts` | hub `data-core.ts` | **shared** schema id |
| `runs/queue/<run>.json` | `understudy.run_request.v1` | `src/run-executor.ts` (hub queues via `runs-core` re-export) | same module both sides | **shared** — `runs-core.ts` re-exports `dist/run-executor.js` (the original pattern) |
| `runs/events.jsonl` | `understudy.run_event.v1` (per line) | `src/run-executor.ts` (`appendEvent` via shared `serializeRunEvent`) | shared `readRunEvents` (CLI-side tail/debug; hub polls the request file) | **shared** |
| `runs/live/<run>-<model>.jsonl` (live journal) | journal entries (`kind: call\|result`) | generated world server (`world.py` `_journal`, mirrors the codec) + `run-executor.ts` `oracleRunner` (shared `appendJournalEntry`) | hub `app/api/runs/live/route.ts` (shared `parseJournalText` + `journalCalls`) | **shared** (Python writer is a documented mirror; round-trip tested) |
| `rows-<run>-<model>.jsonl`, `rows/*.jsonl` | `understudy.eval_result.v1` (per line) | `src/run-executor.ts` (shared `serializeJsonlLine`); `dist/benchmark.js` projection | hub `data-core.ts` (`loadEvalRows`) | **shared** — JSONL codec + schema id |
| `viewer/data/captures/<hash>.json` (capture bodies) | normalized capture | `src/trace-foundry.ts` (file id via shared `captureFileId`) | hub `data-core.ts` `captureBodyPath`, `trace-viewer-core.ts` (both via shared derivation) | **shared** — hash-derived name, never a recorded/client path |
| `environment/.../servers/schemas.json` | tool schemas (declared + inferred) | `src/trace-foundry.ts` (`writeVerifiersEnvironment`) | generated `world.py` (same package) | writer+reader ship together in one package — no cross-repo fork |
| `flags.jsonl` | `understudy.benchmark_flag.v1` | hub `app/api/flags/route.ts` | hub `data-core.ts` | **shared** schema id + JSONL codec (constructor still hub-side: flags have no CLI writer) |
| `versions.jsonl` | viewer-side convention (`created_at` lines) | external/manual | hub `data-core.ts` | shared JSONL codec; candidate for benchmark.v1.1 |
| `benchmark-overview.json` | `understudy.benchmark_overview.v1` | `src/trace-author.ts` (`--overview` pass) | hub `data-core.ts` (`loadOverview`) | **shared** schema id |
| `normalized-captures.jsonl`, `capture-ledger.jsonl`, `goal-state.json`, `goal-events.jsonl`, `authoring-events.jsonl` | foundry/author internals | `src/trace-foundry.ts` / `src/trace-author.ts` | same modules (CLI-only; hub does not read them) | single-writer, no fork possible |

## Path hygiene

Recorded paths inside artifacts are **benchmark-dir-relative with POSIX
separators** (`toPortablePath` / `fromPortablePath` in the shared module);
readers accept legacy absolute paths. Specifically:

- `manifest.json` `artifacts.*` — relative since this change (was absolute).
- run request `live.journal` — already relative (`relative(dir, journalPath)`).
- capture index `path` — already relative (`data/captures/<hash>.json`), and
  readers recompute the hash-derived name rather than trusting it.
- `benchmark.json` `provenance.source_refs`, `environment.package_ref`,
  `gold.ref` — already relative.

`manifest.json` `output_dir` and `source` remain historical records of where
the compile ran; nothing resolves through them (enforced by the relocation
test).

## Drift enforcement

- `tests/artifact-contracts.test.mjs` — byte-level write→read→write
  round-trips for the live journal, reviews, run events, and eval rows
  (including legacy-shape tolerance), plus validation of current writer output
  against `schemas/understudy.*.schema.json` so a format change without a
  schema change fails loudly.
- `apps/benchmark-hub/tests/drift.test.mjs` — hub `benchmark-core` (now a
  re-export) behavior-equals `dist/benchmark.js`.
- `apps/benchmark-hub/tests/relocation.test.mjs` — a generated benchmark dir
  still loads after being moved.
