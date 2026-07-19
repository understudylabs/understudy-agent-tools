# Dogfood report: importing zapier/AutomationBench into understudy.benchmark.v1

Replaces the earlier hand-seeded synthetic demo in this directory with a real
import from https://github.com/zapier/AutomationBench, pinned at commit
`a321764ace3cfbe42289e6a13abef2f0f4f56fad`, plus a real 12-task scored slice
run through the Understudy gateway.

## What was imported

- 48 tasks: the first 8 per public domain (sales, marketing, operations,
  support, finance, hr) in the upstream dataset's own deterministic order.
  Upstream ships 600 public tasks (100/domain) plus a 200-task `simple`
  baseline domain (excluded here, as upstream excludes it from scoring).
- Converter: `convert.py` (runs inside the AutomationBench clone's own uv
  environment because tasks are hand-authored Python functions, not data
  files). Emits `benchmark.json` + `tasks-subset.jsonl`; validated clean by
  `dist/benchmark.js` `validateBenchmarkManifest` (0 errors) and the repo test
  suite stays green.

## License verdict

Upstream `LICENSE` is plain **MIT** ("Copyright (c) 2026 Zapier, Inc."), and
source files carry `SPDX-License-Identifier: MIT` headers. Import,
redistribution of converted task metadata, and derived results are all fine
with attribution. `provenance.imported_from.license = "MIT"`.

## Field-by-field conversion, two example tasks

### `sales.multi_hop_lookup` (upstream `example_id` 501)

| benchmark.v1 field | Source | Fidelity |
| --- | --- | --- |
| `task_id` = `sales.multi_hop_lookup` | upstream `row["task"]` (unique per domain) | clean |
| `category_id` = `sales` | domain module the task lives in | clean |
| `seed` = 501 | upstream `example_id` | **lossy in meaning**: it's a stable integer id, not an RNG seed — the "seeded initial state" is a literal Python dict, deterministic without any seed |
| `genesis` = `imported`, `split` = `none` | fixed | clean (upstream has no train/dev/holdout split; the private leaderboard set is never released) |
| `gold.kind` = `final-state`, `gold.ref` = `github.com/...:automationbench/domains/sales/tasks.py#sales.multi_hop_lookup` | pointer to task definition | **lossy**: the gold is really a list of assertion rubrics (e.g. `salesforce_field_equals`, `gmail_message_sent_to_with_body_contains`, exclusion assertions) evaluated against the simulated end state; benchmark.v1 has no place to embed the assertion list itself, only a ref |
| prompt / initial_state / tool list | not representable in benchmark.v1 | **dropped from the manifest**; user prompt + `zapier_tools` preserved in `tasks-subset.jsonl` for run matching |

### `finance.invoice_email_extract` (upstream `example_id` 4001)

Same mapping; notable specifics:

- 8 `zapier_tools` (gmail/sheets-centric); the union of tool prefixes across
  all 48 imported tasks becomes `environment.tool_surface` (coarsened from 47
  full simulated tools to their app prefixes, e.g. `gmail`, `salesforce`,
  `quickbooks`) — **lossy but honest**: the manifest field is a surface
  summary, not a tool registry.
- Unstructured-text extraction gold (invoice details inside email bodies) is
  again assertion-encoded upstream; only the ref survives conversion.

## Environment / verifier mapping decisions

- `environment.format` = `verifiers.v0`: upstream pins
  `verifiers>=0.1.12.dev2` (pre-1.0 API; `vf.StatefulToolEnv` in
  `automationbench/runner.py`). Also published on Prime Intellect's Hub
  (`prime env install zapier/AutomationBench`), noted in `package_ref`.
- `verifier` = final-state, strict `task_completed_correctly` (1.0 iff every
  assertion passes), dense `partial_credit` (fraction of assertions passed) —
  exactly upstream's rubric (`automationbench/rubric/__init__.py`).
- `replayable` = false: assertion scoring runs inside the rollout; there is no
  standalone "replay assertions against a recorded end state" entrypoint
  (the exported `end_state` + `assertion_results` suggest one could be built).
- `splits.contamination` = `unknown`: public tasks published on GitHub; models
  may have seen them.

## Fresh scored slice (real run)

Rung reached: **repo-harness run** (upstream `uv run auto-bench` from the
pinned clone; the Prime Hub env was not needed since the repo harness exposes
`--base-url`/`--api-key-var` directly). 12 tasks (first 2 per domain), both
arms through the Understudy gateway, OpenAI Chat Completions path, 50-step
budget. Pricing assumptions in `NOTES.md`. Rows projected with
`project-rows.mjs` via `dist/benchmark.js` into `rows/rows-<model>.jsonl`
(single-node linear traces — harness output is flat).

### Results (real scores, 12 tasks, 1 rollout each)

| Arm | Strict pass rate (`task_completed_correctly`) | Mean `partial_credit` | Total cost | Median per-task model time |
| --- | --- | --- | --- | --- |
| claude-sonnet-4-6 | 1/12 (8.3%) | 0.409 | $13.54 (list price) | 92 s |
| gemma-4-31b-it | 1/12 (8.3%) | 0.429 | $0.54 (demo pricing) | 128 s |
| glm-5.2 | 1/12 (8.3%) | 0.475 | $3.77 (demo pricing) | 138 s |
| gemma-4-e2b (Spark, self-hosted) | 0/12 (0%) | 0.000 | $0 (self-hosted) | 12.5 s |

Per-domain mean partial_credit (2 tasks each; strict passes in bold):

| Domain | sonnet | gemma | glm-5.2 |
| --- | --- | --- | --- |
| sales | 0.40 | 0.40 | 0.40 |
| marketing | **0.86** (1 pass) | 0.52 | 0.62 |
| operations | 0.47 | 0.57 | 0.57 |
| support | 0.32 | **0.79** (1 pass) | **0.76** (1 pass) |
| finance | 0.40 | 0.30 | 0.50 |
| hr | 0.00 | 0.00 | 0.00 |

The glm-5.2 arm was added 2026-07-19 (plan asked for glm-5.1; the gateway now
serves glm-5.2 — see NOTES.md for its demo pricing assumption).

Context: upstream's own 600-task leaderboard has frontier models at 24–30%
strict, so single-digit strict pass on a hard 12-task slice with one rollout
is in-family, and the sample is far too small to rank the two arms — the
takeaway is that partial_credit is comparable while sonnet cost 25x more.
Raw harness exports live in `raw/` (per-task assertion results, end states,
full message transcripts).

## Friction list

1. Tasks are Python functions, not data — the converter must execute upstream
   code inside upstream's own uv env (`uv run --project <clone>`), and HF
   `Dataset` stringifies the `info` dict, so the converter has to
   `json.loads` it back.
2. benchmark.v1 has no slot for assertion rubrics, prompts, or initial state;
   gold degrades to a repo-path ref and the run-matching data has to live in a
   sidecar (`tasks-subset.jsonl`).
3. `seed` is semantically wrong for imported deterministic tasks (kept as the
   upstream integer id; a `source_id` field would be more honest).
4. Upstream `--export-json` is rich (per-task assertions, tokens, wall time,
   cost) but per-run per-model; run identity (gateway vs direct) only lives in
   how you invoked the CLI, so rows must carry `route` from the operator.
5. Gemma pricing on the gateway is not published; cost had to be injected via
   `--input-cost/--output-cost` demo assumptions.
6. `claude-*` model names silently switch the harness to the Anthropic
   Messages client unless the base URL is non-Anthropic — worth knowing before
   assuming gateway traffic.
