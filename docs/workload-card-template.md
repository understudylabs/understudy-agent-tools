# Workload Card Template

Use this template after local workload discovery and before evaluation,
optimization, provider routing, or training.

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
  "baseline": {
    "provider": null,
    "model": null,
    "latency_ms": null,
    "input_tokens": null,
    "output_tokens": null,
    "cost_usd": null
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
