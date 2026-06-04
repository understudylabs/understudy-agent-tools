# Value Report Template

Use this template after a Workload Card and Route Decision Packet exist.

```json
{
  "schema_version": "understudy.value_report.v1",
  "evidence_level": 1,
  "workload_card": ".understudy/workload-discovery/workload-card.json",
  "route_decision_packet": ".understudy/route-decision/route-decision-packet.json",
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
    "monthly_cost_usd": null
  },
  "candidate": {
    "provider": null,
    "model": null,
    "cost_usd_per_request": null,
    "latency_ms": null,
    "quality_delta": null,
    "monthly_cost_usd": null
  },
  "scenario": {
    "baseline_monthly_cost_usd": null,
    "candidate_monthly_cost_usd": null,
    "monthly_savings_usd": null,
    "latency_delta_ms": null,
    "quality_delta": null
  },
  "approval_required_before": [
    "live model calls",
    "uploads",
    "hosted jobs",
    "production rollout",
    "public savings claims"
  ],
  "caveats": [],
  "recommended_next_command": "understudy-tools evaluate plan --workload-card .understudy/workload-discovery/workload-card.json --dry-run"
}
```

Scenario overrides are planning inputs. They can size opportunity, but they are
not evidence of savings, speedup, or quality until validated with measured
evaluation results.
