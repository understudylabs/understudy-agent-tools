# Decision Packet Template

Use this template after evaluation or optimization, before recommending promote,
hold, rerun, train, or publish.

```json
{
  "schema_version": "understudy.decision_packet.v1",
  "workload_card": ".understudy/workload-discovery/workload-card.json",
  "route_decision_packet": ".understudy/route-decision/route-decision-packet.json",
  "result_type": "dry-run|replay|validation|heldout|live",
  "decision": "promote|hold|rerun|optimize|train|publish",
  "baseline": {
    "provider": null,
    "model": null,
    "sample_size": null,
    "quality_metric": null,
    "latency_ms": null,
    "cost_usd": null
  },
  "candidate": {
    "provider": null,
    "model": null,
    "sample_size": null,
    "quality_metric": null,
    "latency_ms": null,
    "cost_usd": null
  },
  "split_boundary": {
    "train": null,
    "dev": null,
    "holdout": null
  },
  "failure_taxonomy": [],
  "fallback_route": null,
  "demotion_trigger": null,
  "caveats": [],
  "approval_required_before": [
    "production rollout",
    "hosted training",
    "public claims"
  ],
  "recommended_next_command": null
}
```

Do not call a candidate production-ready unless the packet includes heldout or
live evidence, sample size, split boundary, cost basis, latency basis, and
caveats.
