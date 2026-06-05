# Validate And Optimize Contract

This is the implementation contract for the OSS `validate-and-optimize` step.
It extends, rather than replaces:

- [`spine.md`](spine.md)
- [`oss-release-boundary.md`](oss-release-boundary.md)
- [`workload-card-template.md`](workload-card-template.md)
- [`value-report-template.md`](value-report-template.md)

Runtime order:

```text
understudy
  -> understand-workload
  -> validate-and-optimize
```

`understand-workload` owns harness attachment, environment capture,
metric/validator confirmation, split freezing, and incumbent baseline rerun.
`validate-and-optimize` consumes those artifacts read-only, refuses stale or
unapproved inputs, runs optimization only on train/dev, and creates a
`claim.json` only after sealed holdout validation.

## Optimizer Boundary

Do not implement the GEPA algorithm in this repo.

For the lean public toolchain, depend on the upstream `gepa` package when an
optimization run is requested. The public tool should ship the Understudy
adapter, metric/feedback contract, local artifact gates, and report writers.
It should not depend on the full private runtime, and it should not vendor or
copy the optimizer.

The GEPA docs describe the package as a public API for optimizing text
artifacts with LLM-guided evolution. They expose `gepa.optimize`, the
`GEPAAdapter` protocol, and the `optimize_anything` API. DSPy also exposes
`dspy.GEPA`; keep DSPy optional for users who are already optimizing DSPy
programs.

References:

- GEPA API overview: <https://gepa-ai.github.io/gepa/api/>
- GEPA adapter guide: <https://gepa-ai.github.io/gepa/guides/adapters/>
- GEPA quickstart: <https://gepa-ai.github.io/gepa/guides/quickstart/>
- DSPy GEPA overview: <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md>

Forward compatibility: keep optimizer execution behind a small local interface,
for example `Optimizer.run(...)`, so a future hosted or bundled backend can be
added without changing the artifact contract or skill.

## Install Ergonomics

`gepa` is not a hard dependency of `understudy-agent-tools`.

On the first non-dry-run optimize request:

1. Try to import `gepa`.
2. If it is missing, print an install command and stop.
3. Do not install packages automatically.

Use `uv` first:

```bash
uv pip install 'gepa>=0.0.27,<0.1'
```

If `uv` is blocked or unavailable, show a plain Python fallback:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install 'gepa>=0.0.27,<0.1'
```

DSPy mode is optional and explicit:

```bash
uv pip install 'dspy>=3.0.0'
```

The version ceiling is intentional. The adapter API is the surface this repo
will code against, so unexpected upstream API shifts should fail by install
range rather than silently changing behavior.

## Required Artifacts

`validate-and-optimize` consumes these files from
`.understudy/understand-workload/`:

| File | Owner | Purpose |
| --- | --- | --- |
| `harness.json` | `understand-workload` | Workload command, entrypoint, timeout, env names, runner notes. |
| `environment.json` | `understand-workload` | Runtime, package manager, lockfile status, hardware, required env var names without values. |
| `metric.json` | `understand-workload` | Human-confirmed validator, score, threshold, feedback function, approval state. |
| `splits.json` | `understand-workload` | Frozen train/dev/holdout row ids or source refs. |
| `baseline.json` | `understand-workload` | Incumbent rerun result plus `harness_sha256`, `metric_sha256`, and `splits_sha256`. |

`validate-and-optimize` writes to `.understudy/validate-and-optimize/`:

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

GEPA can only optimize the objective it is given. The load-bearing Understudy
artifact is therefore `metric.json`, not the optimizer package.

`metric.json` must include:

```json
{
  "schema_version": "understudy.metric.v1",
  "approved": true,
  "primary_metric": "exact_match",
  "threshold": 0.95,
  "validator": {
    "kind": "command|callable|schema|human-review",
    "command": null,
    "callable": null,
    "schema_path": null
  },
  "feedback": {
    "required": true,
    "source": "validator_failure|assertion_error|schema_error|review_note"
  }
}
```

The runtime contract is:

```python
def metric(example, prediction) -> MetricResult:
    return MetricResult(score=score, feedback=feedback_text)
```

Rules:

- Refuse optimization when `metric.json.approved` is not `true`.
- The score must come from the confirmed validator, not a proxy.
- Feedback is required and must describe the actual validator failure.
- If only a proxy metric exists, run diagnostic mode only and do not emit
  `claim.json`.

## Eval Input Adapter

The adapter maps local traces or datasets into GEPA examples:

```json
{
  "id": "row-001",
  "inputs": {},
  "target": {},
  "metadata": {
    "source_ref": "evals.jsonl:1"
  }
}
```

Accepted MVP sources:

- JSONL
- JSON
- CSV
- local trace exports that have already been previewed and redacted

Raw prompts, completions, labels, traces, and dataset rows stay local. The
public tool should prefer path refs, row ids, hashes, counts, and schemas in
reports.

## GEPA Adapter

For custom adapter mode, implement the upstream `GEPAAdapter` protocol:

```python
class UnderstudyGepaAdapter:
    def evaluate(self, batch, candidate, capture_traces=False):
        ...

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        ...
```

The adapter:

- runs candidates through the approved harness;
- scores outputs through the confirmed metric;
- captures trajectories only for train/dev;
- uses validator feedback to build reflective datasets;
- never sends holdout examples into GEPA.

For simple prompt-only MVPs, prefer the upstream `optimize_anything` or default
GEPA APIs when they are enough. Use a custom adapter only when the harness needs
batch control, trace capture, or custom reflective-dataset formatting.

## Skill-Local Bundle

Keep deterministic implementation details near the skill:

```text
skills/validate-and-optimize/
  SKILL.md
  templates/
    candidate.json
    claim.json
    eval.json
  examples/
    fresh-baseline-dry-run/
    stale-baseline/
  scripts/
    check_freshness.py
    prepare_examples.py
    gepa_run.py
    evaluate.py
    report.py
```

The CLI should remain a thin wrapper around these proven scripts. Do not move
the whole workflow into top-level CLI code.

## CLI Behavior

The existing dry-run command may stay:

```bash
understudy-tools validate-and-optimize dry-run --repo .
```

Future non-dry-run behavior:

```bash
understudy-tools validate-and-optimize run --repo . --budget-usd 10
```

Required behavior:

- Missing artifact: exit non-zero with the missing path.
- Invalid JSON: exit non-zero with the parser error.
- Hash mismatch: exit non-zero and route back to `understand-workload`.
- Unapproved metric: exit non-zero and ask for metric confirmation.
- Missing `gepa`: print uv-first install guidance and stop.
- Dry run: write `proof-packet.json` without provider calls or package installs.
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

## Build Order

1. Add skill-local templates and examples.
2. Add skill-local `check_freshness.py` and claim validator.
3. Add `prepare_examples.py` for JSONL/JSON/CSV.
4. Add dry-run report/proof scripts.
5. Add `gepa_run.py` behind detect-and-prompt install guidance.
6. Wire the top-level CLI only after the scripts are stable.

## Definition Of Done

- The skill refuses every missing, stale, unapproved, or proxy-only gate.
- Dry run writes a proof packet without provider calls or installs.
- GEPA, when installed and explicitly run, sees train/dev only.
- Holdout validation happens only after the candidate is frozen.
- `claim.json` is produced only for a holdout-validated result with matching
  hashes and caveats.
- No account, hosted gateway, full private runtime, hard `gepa` dependency, or
  auto-install is required.
