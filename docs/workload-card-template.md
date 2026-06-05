# Workload Card Template

Use this template after local workload discovery and before baseline rerun,
evaluation, optimization, provider routing, or training.

The Workload Card should prove that the OSS loop has moved from "interesting
workload" to "measurable workload":

1. understand the workload;
2. attach the harness and environment;
3. confirm the metric, validator, and holdout boundary;
4. rerun the baseline before any optimization or value claim.

The measured artifacts live under `.understudy/capture-evidence/`. The
incumbent baseline rerun writes `baseline.json` with `harness_sha256`,
`metric_sha256`, and `splits_sha256` for the exact `harness.json`,
`metric.json`, and `splits.json` it used.

```json
{
  "schema_version": "understudy.workload_card.v1",
  "workload_id": "workload-001",
  "workload_name": null,
  "owner": null,
  "candidate_id": "candidate-001",
  "source_path": "src/example.py",
  "mode": "local-only",
  "workload_shape": ["structured-output"],
  "value_lens": ["quality", "latency", "cost"],
  "success_metric": null,
  "validator": {
    "name": null,
    "type": "unit|golden|llm-judge|human-review|custom",
    "source_path": null,
    "approval_required_for_payload_access": true
  },
  "harness": {
    "name": null,
    "command": null,
    "source_path": null,
    "environment": {
      "runtime": null,
      "dependencies_lockfile": null,
      "provider_keys_required": false,
      "network_required": false
    }
  },
  "baseline": {
    "provider": null,
    "model": null,
    "latency_ms": null,
    "input_tokens": null,
    "output_tokens": null,
    "cost_usd": null,
    "rerun_required": true,
    "rerun_reason": "required after harness, metric, validator, or split confirmation",
    "rerun_artifact": null,
    "harness_sha256": null,
    "metric_sha256": null,
    "splits_sha256": null
  },
  "data_class": "source-metadata-only",
  "split_boundary": {
    "train": null,
    "dev": null,
    "holdout": null
  },
  "evaluation_inputs": [],
  "promotion_gate": null,
  "fallback_route": null,
  "route_requirements": {
    "privacy_boundary": "local-only until explicit approval",
    "latency_target_ms": null,
    "structured_output_required": false,
    "tool_calling_required": false,
    "pricing_source_required_before_hosted_recommendation": true,
    "supplier_profile_required_before_hosted_recommendation": true
  },
  "optimization_rules": {
    "gepa_uses_train_dev_only": true,
    "holdout_reserved_for_final_validation": true
  },
  "approval_gates": [
    "sending source, prompts, traces, or eval rows to any provider",
    "running live model calls",
    "downloading local models",
    "submitting hosted benchmarks or training jobs"
  ]
}
```

Do not include prompt bodies, completions, trace payloads, dataset rows,
customer identifiers, private repo paths, or secrets by default.

Do not treat `register` or `login` as prerequisites for this card. Account
creation belongs to the CLI or hosted upsell path after the local Workload Card
shows there is a measured reason to route through hosted infrastructure.
