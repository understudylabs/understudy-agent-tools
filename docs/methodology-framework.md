# Methodology Framework

This is the public, OSS-safe Understudy methodology. It turns a local repo into
decision-grade evidence without exposing customer data or private optimization
mechanics.

## Journey

```text
local repo or artifact -> capture/import scan -> Workload Card
  -> Route Decision Packet -> evaluation plan -> latency/output triage
  -> pairwise or deterministic review -> Decision Packet -> report or handoff
```

The user should see useful local value before any spend, upload, model
download, hosted job, or training run.

## Evidence Ladder

Use the smallest evidence level that can change the decision.

| Level | Evidence | Use It For | Do Not Claim |
| --- | --- | --- | --- |
| 0 | Static local scan | Find candidate workloads and likely value. | Model quality, latency, or cost wins. |
| 1 | Workload Card | Agree on owner, metric, baseline, data class, and approval gates. | Candidate superiority. |
| 2 | Fixture or dry-run plan | Validate paths, schemas, and artifacts. | Production readiness. |
| 3 | Local replay or existing eval suite | Compare deterministic signals without uploads. | Hosted economics unless measured. |
| 4 | Small capped live run | Measure direction with real provider behavior. | Broad rollout readiness. |
| 5 | Heldout validation | Decide whether to promote, stop, or optimize. | Training readiness without provenance. |
| 6 | Training or hosted handoff | Prepare SFT, preference, RL, or adapter work. | Spend/upload approval from key presence. |

Every report should name the evidence level, sample size, split boundary,
baseline route, candidate route, cost basis, latency basis, and caveats.

## Workload Card

The Workload Card is the first reusable artifact. It should be source-metadata
only by default.

Template: [`workload-card-template.md`](workload-card-template.md).

When the user already has traces, eval fixtures, prompts, logs, datasets, or
benchmarks, start with [`current-functionality.md`](current-functionality.md). The capture
scan is metadata-only until the user approves payload reading, redaction, and
data-boundary handling.

Required public-safe fields:

- `schema_version`
- `workload_id`
- `source_path`
- `workload_shape`
- `value_lens`
- `success_metric`
- `baseline`
- `data_class`
- `split_boundary`
- `evaluation_inputs`
- `promotion_gate`
- `fallback_route`
- `route_requirements`
- `approval_gates`

Do not copy prompt bodies, completions, trace payloads, dataset rows, customer
names, private repo paths, or secrets into the card by default.

Provider integration patterns should be restored as TypeScript command docs
only when the corresponding CLI surface exists.

## Context Triage

Before calling a candidate model weak, check whether the workload fits the
candidate route.

Classify rows by effective context budget:

- `fits`: below 80 percent of budget;
- `tight_fit`: 80-95 percent of budget;
- `needs_compression`: 95-120 percent of budget;
- `fallback_only`: above 120 percent of budget.

Report quality separately by bucket. A candidate that fails rows it cannot fit
has an infrastructure mismatch, not necessarily a reasoning failure.

Use long-context benchmark literature such as RULER as background for why
advertised context length and effective task performance can diverge.

## Pairwise Review

For bounded qualitative workloads, compare candidates against the incumbent
instead of relying only on absolute scores.

Recommended layers:

1. Infrastructure metrics: latency, error rate, cost/request, retries, cache
   hit rate, schema failure rate.
2. Deterministic structural checks when applicable: JSON validity, tool-call
   shape, entity overlap, citation overlap.
3. Pairwise judge review: randomized order, swapped-order checks for important
   rows, ties and abstentions as first-class outcomes.
4. Sparse human review: stakeholder review for flagged rows and a calibration
   sample.

Do not let the judge share a model family with the incumbent or candidate when
that would create avoidable self-preference risk. Treat pairwise review as a
decision aid, not proof that both outputs are good.

## Route Decision Packet

The Route Decision Packet is the missing bridge between a Workload Card and an
evaluation run. It should rank local, existing-key, hosted open-weight,
frontier, and Understudy routes without granting spend approval.

Template: [`route-decision-packet-template.md`](route-decision-packet-template.md).

Recommended fields:

- incumbent provider and model;
- workload shape and value lens;
- privacy boundary and data class;
- token and context budget assumptions;
- latency target;
- local runner fit;
- provider-key readiness, redacted;
- supplier profile and pricing source;
- Artificial Analysis snapshot, when used as an external prior;
- candidate route shortlist;
- approval required before live calls, downloads, uploads, or hosted jobs;
- recommended next command.

Artificial Analysis, provider catalogs, and supplier pricing are priors. They
help choose what to try first; they do not replace workload-specific evals.

## Decision Packet

Template: [`decision-packet-template.md`](decision-packet-template.md).

Value reports use [`value-report-template.md`](value-report-template.md).
Scenario overrides can size opportunity before a measured eval, but they are
not evidence of savings, speedup, or quality until validated on the workload.

The Decision Packet owns the final recommendation. It should not hide weak
evidence behind confident prose. If the result is a dry-run, replay, or small
validation, the decision should usually be `rerun`, `optimize`, or `evaluate`
rather than `promote`.

## Training Last

Training should come after cheaper levers are tested or ruled out:

- output/schema control;
- parser or renderer repair;
- prompt/context compression;
- route compatibility;
- local/open-weight smoke;
- small live comparison;
- heldout validation.

SFT, preference training, RL, adapter work, or hosted training should require
provenance, split boundaries, upload approval, budget cap, and a fallback route.

## Public References

- DSPy and GEPA: [DSPy GEPA docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md), [GEPA paper](https://arxiv.org/abs/2507.19457), and [DSPy paper](https://huggingface.co/papers/2310.03714).
- Pairwise judging: [MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) and [position-bias study](https://arxiv.org/abs/2406.07791).
- Long context: [RULER](https://arxiv.org/abs/2404.06654).
- Local models: [MLX LM](https://github.com/ml-explore/mlx-lm) and [MLX](https://github.com/ml-explore/mlx).
- Provider and partner docs: [Fireworks docs](https://docs.fireworks.ai/), [Fireworks serverless overview](https://docs.fireworks.ai/serverless/overview), [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/get-models), [Prime Intellect Verifiers](https://docs.primeintellect.ai/verifiers/overview), [Prime Intellect training](https://docs.primeintellect.ai/verifiers/training), [Tinker Verifiers RL](https://tinker-docs.thinkingmachines.ai/cookbook/recipes/verifiers-rl/), and [Artificial Analysis API](https://artificialanalysis.ai/api-reference/beta).
