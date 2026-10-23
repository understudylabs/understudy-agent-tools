# Optimize Workload Contract

This is the implementation contract for the public `optimize-workload`
step. It extends:

- [`methodology-framework.md`](methodology-framework.md)
- [`oss-release-boundary.md`](oss-release-boundary.md)
- [`workload-card-template.md`](workload-card-template.md)
- [`value-report-template.md`](value-report-template.md)

Runtime order:

```text
understudy
  -> capture-evidence
  -> optimize-workload
```

`capture-evidence` owns harness attachment, environment capture,
metric/validator confirmation, split freezing, and incumbent baseline rerun.
`optimize-workload` consumes those artifacts read-only, refuses stale or
unapproved inputs, runs optimization only on train/dev, and creates a
`claim.json` only after sealed holdout validation.

## Runtime Model

The Python CLI prototype and skill-local Python helper scripts have been
removed. The repo surface is now skills plus TypeScript CLI. Python is still
allowed for small local optimizer environments because GEPA/DSPy are
Python-native, but those envs are runtime state, not repo infrastructure.
Use the bridge contract in [`uv-python-bridge.md`](uv-python-bridge.md) for any
future Python-native ports from `understudy-agent`.

Use `uv` when possible:

```bash
understudy skills --search gepa
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --help
```

The named adapter owns its exact `uv run --no-project` package set; do not
preinstall a floating DSPy/GEPA environment. Do not install packages or run provider calls without explicit
approval. TypeScript gates and skill-led inspection must fail closed on missing
files, stale hashes, unapproved metrics, or touched holdout data.

## Required Artifacts

`optimize-workload` consumes these files from
`.understudy/capture-evidence/`:

| File | Owner | Purpose |
| --- | --- | --- |
| `harness.json` | `capture-evidence` | Workload command, entrypoint, timeout, env names, runner notes. |
| `environment.json` | `capture-evidence` | Runtime, package manager, lockfile status, hardware, required env var names without values. |
| `metric.json` | `capture-evidence` | Human-confirmed validator, score, threshold, feedback function, approval state. |
| `splits.json` | `capture-evidence` | Frozen train/dev/holdout row ids or source refs. |
| `baseline.json` | `capture-evidence` | Incumbent rerun result plus `harness_sha256`, `metric_sha256`, and `splits_sha256`. |

`optimize-workload` writes to `.understudy/optimize-workload/`:

| File | Purpose |
| --- | --- |
| `candidate.json` | Frozen optimized candidate, including prompt/component hashes. |
| `eval.json` | Train/dev and optional holdout measurements. |
| `proof-packet.json` | Dry-run or blocked-run proof packet. |
| `claim.json` | The only artifact that supports a public savings, latency, quality, or route-superiority claim. |

Hash-binding is the gate. Recompute hashes for `harness.json`, `metric.json`,
and `splits.json`; fail closed if they do not match the values in
`baseline.json`. Staleness is a hash mismatch, not file presence.

## Metric With Feedback

`metric.json` must include:

```json
{
  "schema_version": "understudy.metric.v1",
  "approved": true,
  "primary_metric": "exact_match",
  "threshold": 0.95,
  "validator": {
    "kind": "command|callable|schema|rubric|llm-judge|human-review",
    "command": null,
    "callable": null,
    "schema_path": null,
    "rubric_path": null
  },
  "feedback": {
    "required": true,
    "source": "validator_failure|assertion_error|schema_error|review_note"
  }
}
```

Rules:

- Refuse optimization when `metric.json.approved` is not `true`.
- The score must come from the confirmed validator, not a proxy.
- Feedback is required and must describe the actual validator failure.
- If only a proxy metric exists, run diagnostic mode only and do not emit
  `claim.json`.
- Holdout rows, labels, validators, thresholds, and sampling are immutable once
  optimization begins.

## Optimizer Boundary

Do not implement the GEPA algorithm in this repo. Depend on upstream optimizer
packages only inside an approval-gated local `uv` env, and do not auto-install
packages. The public tool should own the adapter, feedback contract, local
artifact gates, and report writers.

GEPA, when used, receives train/dev examples only. Holdout validation happens
after the candidate is frozen.

Adapter execution is registry-backed. The TypeScript CLI validates options,
resolves approval/auth boundaries, writes the small Python runtime, and invokes
`uv run --no-project`; the Python side only imports Python-native optimizer
packages and executes the selected adapter.

## CLI Behavior

Future TypeScript commands should follow this behavior:

```bash
understudy optimize-workload dry-run --repo .
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --samples samples.json --input-keys question --output-keys answer --model student-model --reflection-model reflection-model --budget-usd <approved-usd> --input-usd-per-million <conservative-input-price> --output-usd-per-million <conservative-output-price> --execute
understudy optimize-workload adapter run --repo . --adapter eval-input-gepa --manifest eval-input-manifest.json --execute
```

`dspy-gepa` streams its progress while it runs and supports warm starts, climb
rounds, stoppers, multi-proposal search, per-model prices, and an opt-in
holdout evaluation. See [`dspy-gepa-hill-climbing.md`](dspy-gepa-hill-climbing.md).

Required behavior:

- Missing artifact: exit non-zero with the missing path.
- Invalid JSON: exit non-zero with the parser error.
- Hash mismatch: exit non-zero and route back to `capture-evidence`.
- Unapproved metric: exit non-zero and ask for metric confirmation.
- Missing optimizer package: print install guidance and stop.
- Dry run: write `proof-packet.json` without provider calls or package installs.
- Generic optimizer smoke/scaffold commands stay out of the CLI. Use named
  adapters for real execution and skill reference recipes for setup guidance.
- Rubric scoring and DSPy scaffold/parity: keep as skill/reference guidance
  guidance unless a concrete adapter needs executable support.
- DSPy GEPA adapter: expose through `adapter run`, require `--execute`, require
  explicit student and reflection model/deployments, positive dollar cap, and non-zero user-supplied
  token-price basis before resolving auth. Pass auth only through the child
  environment, disable client-side retries, and reserve a conservative
  price-basis upper bound before every request. Committed spend (settled bounds plus
  the full reservation of usage-ambiguous calls) plus every in-flight reservation must
  never exceed the cap; settle a completed call's reservation to a conservative billable
  bound once its usage is known (the larger of output and total minus input, plus
  separately reported reasoning when the total adds nothing, plus reported cache writes;
  never above the reservation), while in-flight and usage-ambiguous calls keep their
  full reservation. A call that fits once in-flight calls settle waits for them
  (bounded, 90 s, under DSPy's 120 s straggler timeout) instead of failing. With `--evaluate-holdout`, optimization runs
  under the cap minus a holdout reserve and stops gracefully before it (see the spend
  governor below); the holdout then runs under the full cap. A call the full cap cannot
  fit is refused, and every later reservation in that run is refused too, latched
  under the same lock as the reservation; fail closed the same way when usage is
  missing (including zero input and zero output tokens) or exceeds the reservation. Run
  train/dev rows only, exclude holdout rows (refuse a train or dev split that names
  the holdout, or equal train and dev splits, and assert the rows are disjoint before
  any provider call), and write owner-only candidate,
  proof, and terminal run-state artifacts with reservation and attribution
  evidence. The attribution is not a provider-invoice claim. The runtime is
  exactly `dspy==3.4.1`, `gepa[dspy]==0.1.4`, and `cloudpickle==3.1.2`, with
  `litellm>=1.83,<2`, on Python 3.13 (`uv run --no-project --python 3.13`); it
  records and verifies all four installed versions before any model call.
  The sole exception to the dollar cap is the explicit `--no-spend-ledger`
  observe-only mode for built-in sample runs: it rejects `--budget-usd`, is
  refused for program bridges, still records per-call usage, and marks every
  receipt `spend_enforcement: none`.
- Eval-input GEPA adapter: require `--execute`, read a local manifest with
  `rows`, `inputs`, or `inputs_path`, support exact-match label and tool-call
  objectives, invoke upstream `gepa.optimize` through `uv`, run train/dev rows
  only, exclude holdout rows, and write `eval-input-candidate.json` plus a
  proof packet. It must report `provider_calls: false` unless an explicit
  model-backed path is added and approved.
- Holdout access during optimization: mark the run contaminated and require a
  new split contract before any claim.

### DSPy 3.4 GEPA controls

The DSPy adapter forwards these GEPA controls without reimplementing GEPA:
`--reflection-minibatch-size`, `--candidate-selection-strategy` (`pareto` or
`current_best`), `--component-selector` (`round_robin` or `all`),
`--use-merge`, `--max-merge-invocations`, `--num-threads`, `--seed`,
`--log-dir`, and `--track-stats`. Student and reflection sampling are explicit
and hash-bound with `--temperature`, `--reasoning-effort`,
`--reflection-temperature`, and `--reflection-reasoning-effort` (conservative
defaults: `0.1` and `none`). Output caps are separate: `--max-tokens` for the
student and `--reflection-max-tokens` for reflection (both default `2048`;
GEPA's structured proposals are truncated under a student-sized cap).
`--num-threads` defaults to `16`, or `1` with `--program-bridge` (bridge
workload Python has no thread-safety contract), and is hash-bound like the
rest; the spend ledger throttles concurrent calls near the cap rather than
refusing them. A log directory or admission receipt made before the default
changed binds the old value, so resume it with `--num-threads 1`.
The adapter always enables upstream `track_best_outputs` for result lineage.
The log directory is owner-only and contains a config binding; an existing log
directory is resumable only when the exact package, workload-source, data,
admission, model, optimizer, search, and spend configuration hash matches.
Each climb round (`--rounds`) is its own GEPA run: round 1 uses the log
directory and round N uses `<log-dir>/round-N` under the same binding.

Climb and search controls are hash-bound into the same config:
`--rounds`/`--min-round-gain`, the stoppers `--stop-after-stale`,
`--stop-at-score`, `--max-minutes` and an always-armed
`.understudy/optimize-workload/dspy-gepa/STOP` file (cleared at start),
`--proposals-per-iteration` (GEPA 0.1.4 `IndependentSampling` plus
`BestImprovement`), and `--proposer-skill`/`--proposer-note`/
`--proposer-max-chars` (DSPy's `InstructionProposer`; skill files are bound by
content hash). `--seed-instructions`, `--match-mode`, `--evaluate-holdout`,
and `--task-spec` act on the built-in scaffold and are refused for program
bridges. `--component-selector` and `--frontier-type` are recorded in `search`;
`objective`, `hybrid`, and `cartesian` frontiers need a task spec. Every stop
and selection reads the dev split only.

A `--task-spec` (`understudy.dspy_gepa_task_spec.v1`) replaces
`--input-keys`/`--output-keys` with several typed predictors. The CLI requires a
regular, non-symlink, owner-readable file; the runtime re-validates it, binds
its content hash and normalized form into the config, and checks every used
sample row's gold values against it before any provider call, failing with the
row index and predictor name only. The schema and scoring are in
[`dspy-gepa-hill-climbing.md`](dspy-gepa-hill-climbing.md#multi-predictor-task-specs).

Spend is metered at the DSPy engine seam: each LM owns a metering engine that
wraps DSPy's LiteLLM engine, so every `complete(Request)` reserves before and
records usage after the provider call, and DSPy copies share one ledger. The
credential and base URL live on the inner engine, never on `dspy.LM`. An error
DSPy wraps around a budget or usage failure is still classified as
`budget-blocked` or `spend-evidence-error`.

The spend governor sits on that ledger and can only make a run wait or stop
earlier, never admit more spend:

- **Throttle.** A reservation is admitted only while committed spend plus
  in-flight reservations plus the new reservation fit the current limit. If it
  would fit once in-flight calls settle, it waits on the ledger lock's
  condition (at most 90 s in total, then it counts as exhausted) and emits a
  rate-limited `spend-throttled` event. The bound stays under DSPy 3.4.1's
  `ParallelExecutor` straggler timeout (120 s), after which DSPy resubmits the
  row and abandons the original thread.
- **Phase limit.** While optimizing, the limit is the cap minus a holdout
  reserve (zero without `--evaluate-holdout`): holdout rows x 2 programs x
  predictors per row x the observed student calls per predictor invocation
  (DSPy's ChatAdapter-to-JSONAdapter parse fallback makes it 1 or 2; measured
  from the baseline call on, 2 before anything is observed) x 1.25 x the 90th
  percentile (nearest rank) settled student call cost (the worst-case student
  reservation before any student call settles), plus one worst-case student
  reservation so the last holdout call can still reserve. The worst case is the
  larger of the largest admitted student reservation and the call being
  checked. The baseline call runs under the full cap and calibrates it.
  Reaching the phase limit records `phase_exhausted` and refuses further
  optimization calls without latching the run-wide failure; the holdout
  evaluation runs under the full cap, which still protects it (`incomplete-budget`)
  if the percentile-sized reserve runs out.
- **Phases and leftover calls.** Every phase switch (optimization, then
  `finalizing`, then `holdout`) wakes waiting calls. A call that entered
  `reserve()` in an earlier phase, or comes from a thread last admitted during an
  ended optimization phase (other than the thread that runs the phases), is
  refused without latching (`late-call-refused`, counted in `late_refusals`).
  Before the candidate's and the final spend evidence are sampled, the run waits
  (at most 60 s) until no call is waiting or in flight; a timeout emits
  `spend-drain-timeout`, and in-flight calls keep their full reservation in the
  evidence.
- **Graceful stop.** A `SpendStopper` GEPA stop callback runs between
  iterations. It ends the round when the phase is exhausted, or when committed
  plus in-flight spend plus 1.5x the largest of the last three iteration costs
  (measured on committed spend, so never negative) plus one worst-case call
  reservation would cross the phase limit, and emits `budget-stop`. The run then finalizes normally with GEPA's best candidate
  (`stopped_by: "spend-governor"` in `candidate.json`, the proof packet, the
  run state and the payload), scores the holdout if asked, and exits 0 with
  `candidate-created`; no further climb round starts. If a refused call escapes
  `compile`, the streamed `best-so-far.json` for this config and round is
  applied to the round's starting program; a later round that streamed nothing
  falls back to the previous round's result. With nothing to recover the run
  stays `budget-blocked` (exit 4, reason `optimization-phase-limit-reached`). A
  recovered candidate carries no GEPA stats (`gepa_stats: null`,
  `gepa_stats_status: "unavailable"`). Only a `SpendBudgetExceeded` in the
  error's cause chain (or DSPy's cause-less executor cancellation after
  refusals), raised while optimizing, is treated this way; any other error keeps
  its own classification.
- **Partial dev evaluations.** DSPy scores a swallowed refusal as a 0 row while
  reporting the whole dev split as evaluated. A dev evaluation during which the
  ledger refused a call is marked `partial` on its `gepa-valset-evaluated` event;
  it never becomes `best-so-far.json`, its candidate is excluded from
  `gepa_stats` (`partial: true`, `partial_candidate_indices`), and if GEPA
  returned it, the round keeps its best fully scored candidate
  (`recovered_candidate_from: "fully-scored-candidate"`), else the previous
  round's result. With no fully scored candidate in the run the result is
  `budget-blocked` (exit 4, reason `no-candidate-fully-scored`).
- **Telemetry.** Every ledger snapshot (`spend_evidence.spend_governor`, also in
  `run-state.json` and the payload) carries committed, in-flight and attributed
  spend, the USD/min rate over the run and the last 60 s, the phase limit, the
  holdout reserve, refusals and throttle counts, and the stopper's latest
  projection (spend for the remaining metric-call budget, minutes to the phase
  limit). The stopper emits `spend-rate` once per iteration and a one-time
  `spend-projection-warning` after three iterations if the projection exceeds
  the phase limit.

By default one user-supplied input/output price basis covers both model names
and must be a conservative upper bound for both deployments. Each call may
instead resolve a narrower basis, in order: `--reflection-input-usd-per-million`
/`--reflection-output-usd-per-million` for reflection calls, a repeatable
`--model-price MODEL=IN,OUT` for the requested model, a price the Understudy
gateway publishes for a gateway-routed role (`--prices-from-gateway
auto|off|require`; bridge routes to other providers never take gateway prices),
then the global basis. The resolved prices are part of the hash-bound config,
and every ledger entry records its role, price source, and rates. A model with
no price from any source stops the run before the first provider call. Both
independent LM instances share the same ledger, reserve before
every request, disable retries, and fail closed on incomplete usage evidence.

`--evaluate-holdout` is a post-freeze diagnostic, not a claim: after
`candidate.json` is written and hashed, the baseline and optimized programs are
scored once on the holdout rows and the result goes to owner-only
`dspy-gepa/holdout-evaluation.json`, bound to the candidate and config hashes.
It always reports exact and case-insensitive scores (`by_match`), never feeds
selection, keeps `holdout_accessed_during_optimization: false`, runs under the
full cap (optimization kept its reserve back), and marks a budget stop
mid-evaluation `incomplete-budget` instead of discarding the candidate.

A bridge may route either LM independently with optional non-secret
`inference_routes.student` and `inference_routes.reflection` objects. Each
explicit object contains exactly `route_id`, credential-free `base_url`,
`api_key_env`, `requested_model`, and `executed_model`. `requested_model` must
equal the corresponding CLI model; `executed_model` is the exact DSPy/LiteLLM
model identifier passed to that route. Missing role entries retain the
Understudy Gateway default. The runtime reads credentials only from the named
environment variables, executes each LM against its bound base URL, and records
requested/executed/DSPy model identities plus URL/host hashes in config,
admission, spend, export, and terminal receipts. Per-call provider-returned
model and a recognized effective-model response header are recorded only when
the response exposes them; otherwise each field is explicitly unavailable.
Neither a route name nor `workload_capture: false` proves ZDR eligibility.

### Opt-in program bridge

`--program-bridge path/to/bridge.py` plus a non-secret JSON
`--program-bridge-config` replaces the simple Signature/Predict scaffold with
workload-owned components. The config schema is exactly
`understudy.dspy_gepa_bridge_config.v1`; secret values are forbidden and
credentials are referenced only by environment-variable name. The bridge is
imported explicitly; no bridge is auto-discovered. A workload that needs Python
dependencies supplies `--program-project` with committed `pyproject.toml` and
`uv.lock`; execution uses `uv run --project ... --locked` and verifies every
`workload_package_pins` distribution. These pins are workload-scoped. The
generic adapter never upgrades or promotes a verifier/MCP version from one
workload into another. It must define these functions:

```python
def admit_understudy_dspy_gepa(context) -> dict: ...
def build_understudy_dspy_gepa(context) -> dict: ...
def live_admit_understudy_dspy_gepa(context, program) -> dict: ...
```

Use two separate commands for a bridged run. First pass `--admission-only`.
Phase A runs with socket connections blocked, builds the program, then Phase B
runs exactly one live fixed-task canary and exits before `GEPA.compile` with
zero optimizer student/reflection calls. It writes owner-only
`admission-receipt.json`. Inspect that receipt, then invoke the compile command
with `--admission-receipt <path>`. Compile fails before optimization unless the
receipt hash binds the exact static config, offline receipt, live receipt,
package/lock state, bridge/config hashes, budget allocation, model sampling,
and resume configuration.

Phase A returns a JSON-safe redacted receipt with `admitted: true` and a
`bundle_validation` object proving zero validation network calls. Two semantic
identities are kept separate: `input_bundle_sha256` binds the typed,
provider-free optimizer/admission rows, while `loaded_bundle_schema_version`
and `loaded_bundle_sha256` bind the executable policy bundle actually loaded by
the endpoint. The bridge config must declare matching `input_bundle_sha256`,
`endpoint_bundle_schema_version`, and `endpoint_bundle_sha256`; the validator
never compares the typed-row hash to the executable-bundle hash. It also binds
exact workload-adapter, tool-schema, and package/lock receipt SHA-256 values
plus package versions. `typed_request_contract` attests typed `model`,
`messages`, `tools`, and `sampling`. `oracle_contract` is discriminated:
exact-message workloads require a materialized expected object and
continuation/provenance;
state-verifier workloads require typed task/initial state plus assertion,
Prime-receipt, and reward-metric binding hashes and must not fabricate an
expected assistant message for root tasks.

For an exact-message workload, map the provider-free Phase-A request fixtures
to `input_bundle_sha256` and the executable runtime policy artifact to the
endpoint bundle fields. Neither identity aliases its package/lock receipt.

Tool workloads additionally include `tool_contract_probe`. For an
OpenAI-compatible tool call, `function.arguments` must remain a string on the
wire, parse as valid JSON, and decode to an object. Record request and executed
argument types/hashes plus any validation-exception hash; do not persist raw
bodies. When a write/world delta is required, admission fails unless the probe
both succeeds and changes world state. A parser failure after HTTP 200, a
hash-only expectation, or a missing write is an admission failure, not model
behavior.

Both source-rollout and reflection prompts require renderer, tokenizer,
checkpoint, route, token arithmetic, and complete task/eligible-route coverage
proofs. Each gate requires `prompt_tokens + max_tokens + safety_margin <
context_limit`; equality fails closed. Reflection feedback may contain only
ordered redacted structural events
(tool/method category, success/error type, mutation, and stop flags), plus a
hash of the full native trace; arguments, URLs, secrets, and answer keys are
excluded. Provider-free inline-versus-loaded deployment parity must prove exact
messages/tools/sampling hashes, one bundle load, no outer policy, and no
duplicate policy injection.

`candidate_mutation_contract.enforcement_status` is currently
`declared_not_enforced`, with `promotion_guarantee: false`. It documents the
workload hook's intended per-proposal receipts but is not admission or promotion
proof. For the final exported candidate, `mutation_claimed: true` enforces a
changed hash and complete atomic evidence. A stable seed/no-change export uses
`mutation_claimed: false`, `outcome: non_improved`, and
`promotion_eligible: false`; it is valid output, not an artifact failure. Do not
claim per-mutation persistence,
unchanged-hash quarantine, or Pareto integrity until a runtime interceptor and
audit tests enforce them.

The builder receives `dspy`, separate `student_lm` and `reflection_lm`
instances, the admitted receipt, configuration, local rows, and repo path. It
returns:

```python
{
    "student": student,
    "trainset": trainset,
    "valset": valset,
    "metric": metric,  # returns ScoreWithFeedback
    "teacher": None,
    "export_candidate": export_candidate,  # optional callable
    "program_state": {"redacted": "workload metadata"},  # optional JSON
    "holdout_count_excluded": 0,
}
```

DSPy 3.4.1 exposes `teacher` in the compile signature but its GEPA adapter
rejects non-null teachers. The bridge field is retained for forward-compatible
shape, but this pinned runtime fails explicitly when it is non-null. A workload
may precompute teacher-derived examples or feedback before the approved run;
it must not disguise an unmetered teacher call inside the bridge.

When present, `export_candidate(optimized, export_dir, context)` writes a
deployable bundle under the supplied owner-only directory and returns JSON-safe
metadata containing `provenance` and `continuation_parent` (`null` for a root
bundle). The runtime rejects symlinks/empty exports, hashes sorted relative
paths, sizes, and file SHA-256 values, and records `bundle_sha256` in
`bundle-manifest.json`, `candidate.json`, the proof packet, and terminal state.
Metadata environment variables alone are not evidence that the executable
bundle was loaded; that proof belongs in admission.

Successful runs persist owner-only `package-state.json`, `config.json`,
`admission-receipt.json`,
`program-state.json`, `bundle-manifest.json` when exported, `run-state.json`,
the candidate, and proof packet. While a run is going it also streams
owner-only `events.jsonl` (append-only, one `run_id` per invocation), a
`run-state.json` with `status: running` and the current `phase`, and
`best-so-far.json` whenever a new best clears the full dev split. These receipts contain hashes and redacted
structure, never API keys or raw malformed response bodies.

## Claim Packet

`claim.json` must include:

```json
{
  "schema_version": "understudy.claim.v1",
  "workload_card": ".understudy/workload-discovery/workload-card.json",
  "harness_sha256": null,
  "metric_sha256": null,
  "splits_sha256": null,
  "baseline_sha256": null,
  "candidate_sha256": null,
  "holdout_result": null,
  "sample_size": null,
  "score_delta": null,
  "latency_basis": null,
  "cost_basis": null,
  "pricing_basis": null,
  "request_volume_assumption": null,
  "confidence": "low|medium|high",
  "fallback_route": null,
  "demotion_trigger": null,
  "caveats": []
}
```

Do not emit `claim.json` from train/dev evidence, proxy metrics, stale
baselines, or unfrozen candidates.

## Definition Of Done

- The skill refuses every missing, stale, unapproved, or proxy-only gate.
- Dry run writes a proof packet without provider calls or installs.
- Optimizer runs, when explicitly approved, see train/dev only.
- Holdout validation happens only after the candidate is frozen.
- `claim.json` is produced only for a holdout-validated result with matching
  hashes and caveats.
- No account, hosted gateway, full private runtime, hard optimizer dependency,
  or auto-install is required.
