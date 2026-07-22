# Route Decision Packet Template

Use this template after a Workload Card exists and before recommending a local,
existing-key, hosted open-weight, frontier, or Understudy route.

```json
{
  "schema_version": "understudy.route_decision_packet.v1",
  "workload_card": ".understudy/workload-discovery/workload-card.json",
  "decision": "evaluate-first",
  "incumbent": {
    "provider": null,
    "model": null,
    "known_latency_ms": null,
    "known_cost_usd": null
  },
  "constraints": {
    "workload_shape": [],
    "privacy_boundary": "workflow-bound cloud unless Local is selected",
    "data_class": "source-metadata-only",
    "context_budget_tokens": null,
    "latency_target_ms": null,
    "quality_gate": null
  },
  "readiness": {
    "local_runner_fit": "unknown",
    "provider_keys_redacted": [],
    "supplier_profiles_checked": [],
    "pricing_sources_checked": [],
    "artificial_analysis_snapshots": []
  },
  "candidate_routes": [
    {
      "route_id": "route-001",
      "kind": "local|existing-key|hosted-open-weight|frontier|understudy",
      "provider": null,
      "model": null,
      "why_try": null,
      "approval_required": false,
      "pricing_source": null,
      "supplier_profile": null,
      "external_prior_only": true
    }
  ],
  "recommended_next_command": "understudy optimize-workload check --repo .",
  "approval_required_before": [
    "expanding data, destination, spend, retention, or production impact"
  ]
}
```

Artificial Analysis, provider catalogs, and supplier pricing are external
priors. They help choose what to try first, but they are not workload-specific
quality evidence.
