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
understudy optimize-workload --uv
uv venv .understudy/venvs/optimize
uv pip install --python .understudy/venvs/optimize/bin/python 'gepa>=0.0.27,<0.1' 'dspy>=3.0.0'
```

Do not create the env, install packages, or run provider calls without explicit
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
understudy optimize-workload run --repo . --budget-usd 10
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --samples samples.json --input-keys question --output-keys answer --model gpt-4o-mini --execute
understudy optimize-workload adapter run --repo . --adapter eval-input-gepa --manifest eval-input-manifest.json --execute
```

Required behavior:

- Missing artifact: exit non-zero with the missing path.
- Invalid JSON: exit non-zero with the parser error.
- Hash mismatch: exit non-zero and route back to `capture-evidence`.
- Unapproved metric: exit non-zero and ask for metric confirmation.
- Missing optimizer package: print install guidance and stop.
- Dry run: write `proof-packet.json` without provider calls or package installs.
- Rubric scoring and DSPy scaffold/parity: keep as skill/cookbook/workflow
  guidance unless a concrete adapter needs executable support.
- DSPy GEPA adapter: expose through `adapter run`, require `--execute`, require
  an explicit model/deployment, resolve the Understudy API key without printing
  it, pass auth only through the child environment, run train/dev rows only,
  exclude holdout rows, and write a candidate/proof packet with
  `provider_calls: true`.
- Eval-input GEPA adapter: require `--execute`, read a local manifest with
  `rows`, `inputs`, or `inputs_path`, support exact-match label and tool-call
  objectives, invoke upstream `gepa.optimize` through `uv`, run train/dev rows
  only, exclude holdout rows, and write `eval-input-candidate.json` plus a
  proof packet. It must report `provider_calls: false` unless an explicit
  model-backed path is added and approved.
- Holdout access during optimization: mark the run contaminated and require a
  new split contract before any claim.

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
