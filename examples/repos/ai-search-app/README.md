# Synthetic AI Search App

This public fixture demonstrates the recommended first-run Understudy journey:
scan a local repo, find an AI workload, draft a Workload Card, then decide
whether a live route comparison is worth approval.

Run from this directory:

```sh
understudy-tools demo scan --repo .
understudy-tools demo plan --repo .
understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json
understudy-tools value report --workload-card .understudy/workload-discovery/workload-card.json --route-decision .understudy/route-decision/route-decision-packet.json --requests-per-month 10000
understudy-tools value report --workload-card .understudy/workload-discovery/workload-card.json --route-decision .understudy/route-decision/route-decision-packet.json --requests-per-month 10000 --baseline-cost-usd 0.012 --candidate-cost-usd 0.004
```

Both commands write local artifacts under:

```text
.understudy/workload-discovery/
.understudy/route-decision/
.understudy/value/
```

The fixture is synthetic. It contains no customer data, private prompts, real
traces, provider keys, or production URLs.
