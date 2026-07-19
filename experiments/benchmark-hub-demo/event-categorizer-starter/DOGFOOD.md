# Dogfood report: event-categorizer starting benchmark (understudy.benchmark.v1)

Date: 2026-07-19. Customer-role run: create a small benchmark manifest from the
repo's own scaffold, run it end-to-end on Understudy inference, project results
to `understudy.eval_result.v1` rows.

## Inference rung reached: 1 — Understudy gateway

- `~/.understudy/credentials.json` had a live `sk_*` key; `GET
  https://api.understudylabs.com/v1/models` returned 200 with 14 models.
- No local MLX server was up on `:8081`, and the mock server was not needed.
  The gateway rung worked first try, so no fallback was exercised.

## What was run

Benchmark: `benchmark.json` (`event-categorizer-starter`) — 8 tasks from the
scaffold's `tasks.jsonl` across 3 categories (security, billing, noise),
splits train 3 / dev 3 / holdout 2, strict metric `category_correct` (the only
weight-1.0 reward fn in the scaffold's rubric; `structured_output_ok`,
`tool_calls_ok`, `nonempty_ok` are zero-weight contract metrics).

Validated with the repo's own code:

```sh
node experiments/benchmark-hub-demo/validate-manifest.mjs   # uses dist/benchmark.js validateBenchmarkManifest
```

Environment setup (from `experiments/benchmark-hub-demo/`):

```sh
uv venv .venv --python 3.12
. .venv/bin/activate
uv pip install --prerelease=allow -e ../../skills/design-simulated-environment/examples/event-categorizer
```

Rollouts (2 arms x 8 tasks x 2 rollouts = 16 rollouts per arm):

```sh
export UNDERSTUDY_API_KEY=<from ~/.understudy/credentials.json>
vf-eval event-categorizer -m claude-sonnet-4-6 \
  --api-base-url https://api.understudylabs.com/v1 --api-key-var UNDERSTUDY_API_KEY \
  -n 8 -r 2 -a '{"tasks_path": "<abs>/tasks-subset.jsonl"}' \
  --save-results --output-dir raw --disable-tui
# same for -m gemma-4-31b-it
```

Normalization + projection:

```sh
node normalize-and-project.mjs raw/evals/event-categorizer--claude-sonnet-4-6/541ee699/results.jsonl claude-sonnet-4-6 bench-demo-sonnet-20260719
node normalize-and-project.mjs raw/evals/event-categorizer--gemma-4-31b-it/f18dbd97/results.jsonl  gemma-4-31b-it  bench-demo-gemma-20260719
```

Wall-clock: env setup (uv venv + install) ~45 s; sonnet arm 11 s; gemma arm
22 s; manifest authoring + validation + normalization scripting dominated the
session (~25 min total agent time). Inference itself was the cheap part.

## Leaderboard summary (16 rollouts per arm, via Understudy gateway)

| arm | category_correct (strict) | structured_output_ok | tool_calls_ok | avg gen time/rollout | avg out tokens |
| --- | --- | --- | --- | --- | --- |
| claude-sonnet-4-6 | **1.000** | 0.9375 | 1.000 | ~3 s | 113.8 |
| gemma-4-31b-it | **1.000** | 1.000 | 1.000 | ~9 s | 104.4 |

Both arms saturate the strict metric — this starter benchmark is too easy to
discriminate. The only signal is the contract metric: sonnet fenced one JSON
answer (`structured_output_ok` 15/16), the exact failure mode the scaffold's
sentinel exists to catch, while gemma was contract-clean. A real customer's
takeaway: the small open model matches the frontier here at 3x the latency.

Artifacts: `benchmark.json`, `tasks-subset.jsonl`, `raw/evals/...` (untouched
vf-eval output), `traces/traces-<model>.jsonl` (TraceNode records),
`rows/rows-<model>.jsonl` (eval_result.v1, 16 rows/arm).

## Friction list (numbered, honest)

1. **v0/v1 results seam — flat results, no DAG.** verifiers 0.2.0
   `--save-results` writes one flat row per rollout; there is no traces.jsonl
   message DAG anywhere in the output. The benchmark.v1 results contract
   ("traces.jsonl DAG retained as evidence, one row per root-to-leaf branch")
   has nothing to consume: I had to fabricate single-node linear traces just
   so `extractBranches` had something to walk. `normalizeTraceRecord`'s
   comment says its field mapping "must stay pinned by a golden fixture
   generated from a real `uv run eval` run" — no such fixture exists in
   `tests/fixtures/`, and a real run couldn't produce one today.
2. **task_id is dropped on the floor by the env.** The scaffold's
   `load_environment()` maps `tasks.jsonl` rows to `{question, answer, info}`
   and discards `task_id`; results rows only have `example_id` (an index into
   a possibly-shuffled dataset). I recovered task identity by string-matching
   the user message back to `tasks.jsonl` questions. Works here; breaks the
   moment two tasks share a question or a template renders. Any customer
   wiring rows/ to a manifest hits this. Fix belongs in the scaffold: put
   `task_id` in `info` and surface it via `--state-columns` or the row.
3. **environment.format enum can't tell the truth.** The schema only allows
   `"verifiers.v1"`, but the scaffold README and pin are explicit that this is
   the *v0 API* of verifiers==0.2.0 ("Built for the frozen v0 API"). I had to
   stamp `verifiers.v1` on a v0 package. Either the enum needs `verifiers.v0`
   or the docs need to define `verifiers.v1` as "the verifiers package format,
   any pinned version" — right now the manifest is subtly lying.
4. **Selecting a task subset is DIY.** The manifest declares 8 of 12 tasks,
   but nothing connects the manifest to the runner: `vf-eval -n 8` would just
   take the *first* 8 of tasks.jsonl. I had to hand-write `tasks-subset.jsonl`
   and pass `-a '{"tasks_path": ...}'` with an **absolute** path (relative
   paths resolve against vf-eval's cwd, undocumented). A customer would
   reasonably expect a "compile manifest -> runnable env" step; it doesn't
   exist yet. Same story for splits: nothing enforces or even reports the
   train/dev/holdout boundary at run time.
5. **Endpoint registry vs model choice mismatch.** `configs/endpoints.toml`
   hardcodes `model = "gpt-4o"` for the gateway endpoints, but the gateway's
   `/v1/models` doesn't list gpt-4o. Following the README verbatim
   (`vf-eval ... -m gateway-incumbent`) would target a model id the gateway
   may not serve. I bypassed the registry with explicit `--api-base-url` /
   `--api-key-var` flags. The registry pattern is good; its contents are stale
   relative to the live gateway catalog.
6. **Minor: `uv pip install -e .` needs `--prerelease=allow`** even after the
   README's smoke-test step — the README does warn about this for `uv run`
   but a reader can miss that it applies to the editable install too. (It bit
   me for zero seconds only because the README note was fresh in mind.)
7. **Minor: benchmark.v1 has no place for run/arm registry.** The manifest is
   results-free by design, but there's also no conventional sidecar naming for
   "these runs exist for this benchmark" — rows/ and traces/ layout here is
   invented. A viewer will need a convention.

Items 1-4 are the ones a real customer would stall on; item 4 (manifest is
not executable) is the biggest gap between the promise of the schema and the
five-minute experience.
