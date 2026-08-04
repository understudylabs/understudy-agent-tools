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
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --samples samples.json --input-keys question --output-keys answer --model student-model --reflection-model reflection-model --budget-usd <approved-usd> --input-usd-per-million <conservative-input-price> --output-usd-per-million <conservative-output-price> --num-threads 1 --execute
understudy optimize-workload adapter run --repo . --adapter eval-input-gepa --manifest eval-input-manifest.json --execute
```

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
  price-basis upper bound before every request. Stop before a reservation could cross the
  cap; fail closed when usage is missing or exceeds the reservation. Run
  train/dev rows only, exclude holdout rows, and write owner-only candidate,
  proof, and terminal run-state artifacts with reservation and attribution
  evidence. The attribution is not a provider-invoice claim. The runtime is
  exactly `dspy==3.3.0` plus `gepa[dspy]==0.1.1`; it records and verifies both
  installed versions before any model call.
- Eval-input GEPA adapter: require `--execute`, read a local manifest with
  `rows`, `inputs`, or `inputs_path`, support exact-match label and tool-call
  objectives, invoke upstream `gepa.optimize` through `uv`, run train/dev rows
  only, exclude holdout rows, and write `eval-input-candidate.json` plus a
  proof packet. It must report `provider_calls: false` unless an explicit
  model-backed path is added and approved.
- Holdout access during optimization: mark the run contaminated and require a
  new split contract before any claim.

### DSPy 3.3 GEPA controls

The DSPy adapter forwards these GEPA controls without reimplementing GEPA:
`--reflection-minibatch-size`, `--candidate-selection-strategy` (`pareto` or
`current_best`), `--component-selector` (`round_robin` or `all`),
`--use-merge`, `--max-merge-invocations`, `--num-threads`, `--seed`,
`--log-dir`, and `--track-stats`. Student and reflection sampling are explicit
and hash-bound with `--temperature`, `--reasoning-effort`,
`--reflection-temperature`, and `--reflection-reasoning-effort` (conservative
defaults: `0.1` and `none`). Start a new workload at `--num-threads 1`.
The adapter always enables upstream `track_best_outputs` for result lineage.
The log directory is owner-only and contains a config binding; an existing log
directory is resumable only when the exact package, workload-source, data,
admission, model, optimizer, and spend configuration hash matches.

The single user-supplied input/output price basis covers both model names. It
must therefore be a conservative upper bound for the student and reflection
deployments. Both independent LM instances share the same cumulative ledger,
reserve before every request, disable retries, and fail closed on incomplete
usage evidence.

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

DSPy 3.3.0 exposes `teacher` in the compile signature but its GEPA adapter
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
the candidate, and proof packet. These receipts contain hashes and redacted
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
