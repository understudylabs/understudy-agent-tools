# Cookbook: from prior traces to a verifiers environment

The dead-simple path from "I have traces / tests / a playbook" to "any model
change runs through a simulator before prod." Every stage has a working
implementation in
[`../examples/event-categorizer/`](../examples/event-categorizer/README.md) —
copy it and swap parts, don't start blank. Pin `verifiers==0.2.0` (v0 API,
frozen upstream; landscape in [`../reference.md`](../reference.md)).

## The short version (what the agent actually runs)

```sh
cp -r skills/design-simulated-environment/examples/event-categorizer my-workload-env
cd my-workload-env
python convert_captures.py --captures <redacted-captures.jsonl> --out-dir .
# edit: tools, _conforms(), the quality reward, smoke.py's oracle
uv run --with verifiers==0.2.0 --prerelease=allow --no-project smoke.py   # until green
uv venv && . .venv/bin/activate && uv pip install --prerelease=allow -e .
vf-eval my-workload-env -m gateway-incumbent -n 20 -r 5 --shuffle --shuffle-seed 7 -s
```

From there: playbook variants via
`-a '{"playbook_path": "..."}'`, ship/no-ship verdicts via
[`../../simulate-before-launch/SKILL.md`](../../simulate-before-launch/SKILL.md),
model sweeps via `compare-model-sweep`, and — much later, if the gates say so —
RL via `prepare-verifier-handoff`.

## Stage 0 — what you need before authoring

- **Traces — and the app's own observability counts.** Before concluding "no
  traces", *look for the instrumentation the app already has*: OpenTelemetry
  exporter config (`OTEL_EXPORTER_OTLP_*`, collector/instrumentation files),
  Vercel AI SDK `experimental_telemetry`, Mastra tracing, or HTTP-client
  interceptors (e.g. axios) that log LLM request/response bodies. An export
  of those spans as JSONL from the team's own backend is a first-class
  capture source — the converter reads Vercel AI SDK and GenAI-semconv span
  attributes directly (shape D), alongside gateway capture exports, provider
  logs, and the input/expected pairs from existing test scripts. (Understudy
  gateway capture retrieval is moving to self-service; until then the team's
  own telemetry export is usually the fastest path.) **Redact first** via
  [`../../ingest-traces/SKILL.md`](../../ingest-traces/SKILL.md) — everything
  downstream contains whatever you feed it.
- **One workload at a time.** One system prompt = one workload = one env. The
  converter enforces this (skips rows whose system prompt differs) — if you
  have several, run it once per workload.
- **A gold policy** (stage 1 explains the three options).

## Stage 1 — harvest tasks

`convert_captures.py` normalizes capture lines (three common shapes
auto-detected) into task rows: `question` (the user payload), `gold`, and
`info.recorded_tools` (every tool call + result seen). Decisions:

- **Where gold comes from.** (a) *Trusted incumbent* (`--gold response`):
  the captured responses are the answer key — valid only when the incumbent
  was doing the job well, which is exactly the pre-launch case ("don't
  regress what works"). (b) *Labeled tests*: you already assert expected
  outputs somewhere — port those pairs. (c) *Hand pass*: for a first env,
  20 hand-checked rows beat 500 unchecked ones.
- **How many.** A gate needs rate estimates: aim for ≥20 tasks; the repeats
  (`-r`) do the rest.
- **Freeze before optimizing.** The moment anyone tunes against these rows,
  they're a train set — freeze splits via
  [`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md) first.

## Stage 2 — tools: three stub strategies

Pick per tool, from strongest to weakest:

1. **Fixture-backed (preferred, what the example does).** Give each task a
   small state slice (`accounts` in the example) and implement the tool
   against it. Any model's reasonable-but-different call still gets a real
   answer — this is what makes the env fair to a *different* brain. The
   per-task scoping pattern is a `ToolEnv` subclass whose `env_response`
   parks `state["info"]` in a contextvar before the tool runs
   (concurrency-safe; see `EventCategorizerEnv`).
2. **Record/replay.** Serve the captured result when the call matches
   (`info.recorded_tools` has what you need), a canned "not found" otherwise.
   Cheap, but penalizes models that take a different valid path — fine for
   single-lookup workloads, wrong for exploratory ones.
3. **Live read-only.** Only for genuinely idempotent reads you're willing to
   let the eval hit. Never for writes: the env's writes stay in memory.

Multi-turn agent loops that *mutate* state need a seeded world, not stubs —
that's this skill's main recipe (world + gold final state + validator), and
[`../../prepare-verifier-handoff/references/stage-1-author-env.md`](../../prepare-verifier-handoff/references/stage-1-author-env.md)
when it graduates to RL.

## Stage 3 — the rubric: quality + contract, separated

Two kinds of axes, deliberately kept apart:

- **Quality** (weighted): did it get the right answer? One function against
  gold — `category_correct` in the example.
- **Contract** (weight 0.0 — metrics, not reward): would production parse
  this? `structured_output_ok` (bare, schema-conformant JSON — valid JSON
  inside markdown fences must FAIL, that's the exact bug that leaves an
  SDK's `.object` undefined while monitoring shows zero errors),
  `tool_calls_ok`, `nonempty_ok`. Copy them nearly verbatim; only
  `_conforms()` is workload-specific.

Why zero-weight: the contract axes must never be tradable against quality —
a model can't "make up for" broken JSON by being smarter. They report as
rates and gate independently (see `simulate-before-launch`).

## Stage 4 — the playbook is an argument, not code

Load the system prompt from a file and expose the path as a
`load_environment` kwarg. Then a prompt/playbook change is:

```sh
vf-eval my-workload-env -a '{"playbook_path": "playbook-variant.md"}' ...
```

Same frozen tasks, same tools, same rubric — the diff in the axis rates *is*
the answer to "I modified the instructions, will it work?" No wait-and-see
in prod.

## Stage 5 — validate the validator (before trusting any model score)

`smoke.py` is the template — offline, no network, no key:

1. **Construct** the env (catches dataset/rubric/tool wiring errors).
2. **Oracle**: a scripted correct trajectory must score reward 1.0 with all
   contract axes 1.0, on every task.
3. **Sentinels** the validator must reject: empty run; plausible-but-wrong
   values; off-catalog tool call; and the **right-answer-wrong-contract**
   run (gold JSON in fences) — quality must stay 1.0 while the contract axis
   reads 0.0, proving the two questions are actually separated.

A validator that hasn't rejected its sentinels has not been tested. Keep
`smoke.py` green forever — it's the env's own regression test.

## Stage 6 — run, gate, and grow

- **Score through the served path**, not the raw provider:
  `configs/endpoints.toml` points `vf-eval -m` at the gateway or a local
  server. `-r` (rollouts per task) is what catches intermittent failures —
  sizing table in
  [`../../simulate-before-launch/reference.md`](../../simulate-before-launch/reference.md).
- **Gate changes**: `simulate-before-launch` turns two runs (incumbent arm,
  candidate arm) into a `pass`/`block` launch verdict that `ramp-and-verify`
  consumes.
- **Grow into**: model sweeps (`compare-model-sweep`), prompt evolution
  (`optimize-workload`), and the RL handoff (`prepare-verifier-handoff`) —
  all against the same env. That reuse is why the env, not any run, is the
  durable asset.

## Gotchas (all hit for real while building the example)

- `uv` refuses verifiers `0.2.0` without `--prerelease=allow` — its
  `renderers` dependency is dev-pinned (`>=0.1.8.dev40`).
- `Rubric.score_rollout(state)` returns `None`: it writes
  `state["reward"]` and `state["metrics"]`.
- Reward funcs receive **typed** message objects (`.role`, `.content`,
  `.tool_calls` with `.name`/`.arguments`) in real rollouts — but drivers
  and tests often hand dicts. The example's `_field`/`_text`/`_tool_calls`
  helpers accept both; keep that pattern.
- Dataset rows: `question`/`answer` must be strings and `info` a dict —
  verifiers derives `prompt` and `example_id`.
- The env id maps to the module name (`my-env` → `my_env.py`); the
  `load_environment(**kwargs)` entry point is the convention `vf-eval -a`
  feeds.
