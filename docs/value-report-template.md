# Value Report Template

Use this template after a Workload Card, confirmed harness/environment,
baseline rerun, validation result, and Route Decision Packet exist.

A Value Report may size opportunity from scenarios, but a public savings,
latency, or quality claim requires a separate claim packet with measured
baseline and candidate evidence.

```json
{
  "schema_version": "understudy.value_report.v1",
  "evidence_level": 1,
  "workload_card": ".understudy/workload-discovery/workload-card.json",
  "route_decision_packet": ".understudy/route-decision/route-decision-packet.json",
  "claim_packet": null,
  "claim_status": "not-claimable|claim-packet-required|claim-supported",
  "requests_per_month": 10000,
  "decision": "measure-baseline-first",
  "scenario_basis": "artifact|override",
  "overrides": {
    "baseline_cost_usd": null,
    "baseline_latency_ms": null,
    "candidate_cost_usd": null,
    "candidate_latency_ms": null
  },
  "baseline": {
    "provider": null,
    "model": null,
    "cost_usd_per_request": null,
    "latency_ms": null,
    "input_tokens": null,
    "output_tokens": null,
    "monthly_cost_usd": null,
    "rerun_artifact": null,
    "rerun_after_harness_metric_splits": false,
    "harness_sha256": null,
    "metric_sha256": null,
    "splits_sha256": null
  },
  "candidate": {
    "provider": null,
    "model": null,
    "cost_usd_per_request": null,
    "latency_ms": null,
    "quality_delta": null,
    "monthly_cost_usd": null,
    "validation_artifact": null,
    "validated_on_holdout": false
  },
  "scenario": {
    "baseline_monthly_cost_usd": null,
    "candidate_monthly_cost_usd": null,
    "monthly_savings_usd": null,
    "latency_delta_ms": null,
    "quality_delta": null
  },
  "claim_packet_required_fields": [
    "workload_card",
    "harness_environment",
    "metric_validator",
    "split_boundary",
    "baseline_rerun_artifact",
    "candidate_validation_artifact",
    "harness_sha256",
    "metric_sha256",
    "splits_sha256",
    "baseline_sha256",
    "candidate_sha256",
    "holdout_result",
    "sample_size",
    "pricing_basis",
    "caveats"
  ],
  "approval_required_before": [
    "live model calls",
    "uploads",
    "hosted jobs",
    "production rollout",
    "public savings claims"
  ],
  "caveats": [],
  "recommended_next_command": "understudy-tools validate-and-optimize check --repo ."
}
```

Scenario overrides are planning inputs. They can size opportunity, but they are
not evidence of savings, speedup, or quality until validated with measured
evaluation results.

Do not publish savings, speedup, quality, or route-superiority claims from this
report unless `claim_status` is `claim-supported` and the referenced claim
packet is available for review. Baseline numbers must be rerun after harness,
metric, validator, or split changes, and the claim packet must cite matching
artifact hashes. GEPA results must show that optimization used train/dev only
and that holdout was reserved for final validation.
