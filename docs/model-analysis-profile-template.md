# Model Analysis Profile Template

Copy this template when creating a public model profile. Keep claims scoped to
the cited public facts and measured artifacts.

```yaml
---
profile_type: model-analysis
schema_version: model-analysis-profile.v1
model_family: <glm-5.1|gemma-4|kimi-2.6|gpt-5.5|anthropic-claude|gemini|qwen|other>
model_id: <exact model id>
lane: <local-small-open-weight|local-mlx|local-openai-compatible|hosted-open-weight|hosted-training|remote-frontier-incumbent|remote-frontier-judge>
status: <catalog|runner-smoke|local-smoke|replay|validation|heldout|live>
date_checked: <YYYY-MM-DD>
owner_or_provider: <model owner or serving provider>
license_or_terms: <license or terms summary with citation>
public_sources:
  - title: <model card or official docs>
    url: <https://...>
    checked: <YYYY-MM-DD>
  - title: <pricing or runner docs>
    url: <https://...>
    checked: <YYYY-MM-DD>
artificial_analysis:
  source_url: <https://artificialanalysis.ai/... or API endpoint>
  checked: <YYYY-MM-DD>
  model_label: <exact label from Artificial Analysis>
  leaderboard_slice: <intelligence|quality|speed|price|provider endpoint|other>
  rank: <rank or null>
  intelligence_index: <number or null>
  output_speed_tps: <number or null>
  latency_ms: <number or null>
  price_per_million_tokens_usd: <number or null>
  notes: <external ranking context only; not workload-specific evidence>
understudy_artifacts:
  - path: <.understudy/... or none>
    result_type: <catalog|artificial-analysis|runner-smoke|local-smoke|replay|validation|heldout|live>
safety:
  uploads_performed: false
  provider_spend_usd: 0
  public_safe: true
---
```

# <Model Family / Exact Model ID>

## Decision Summary

One paragraph:

- what this model is useful for;
- whether to try it locally, through an existing provider key, through
  Understudy inference, or not yet;
- what decision the next run should unlock.

## Public Facts

| Fact | Value | Source |
| --- | --- | --- |
| Owner | `<owner>` | `<source title>` |
| Exact model id | `<id>` | `<source title>` |
| Parameters or architecture | `<if public>` | `<source title>` |
| Context window | `<if public>` | `<source title>` |
| Modality | `<text|image|audio|multimodal>` | `<source title>` |
| License/terms | `<license or terms>` | `<source title>` |
| Pricing | `<if remote/hosted>` | `<source title>` |
| Artificial Analysis profile | `<rank/index/speed/price if used>` | `<Artificial Analysis source>` |

Never put an uncited model fact in this table.

## Understudy Fit

| Dimension | Assessment | Evidence |
| --- | --- | --- |
| Workload shapes | `<classification|tool-calling|structured-output|rag|agentic|coding|creative|other>` | `<catalog or measured artifact>` |
| Cost upside | `<none|low|medium|high|unknown>` | `<pricing or measured estimate>` |
| Latency upside | `<none|low|medium|high|unknown>` | `<runner smoke or live eval>` |
| Quality risk | `<low|medium|high|unknown>` | `<eval artifact or unknown>` |
| Local viability | `<yes|maybe|no|unknown>` | `<hardware/runtime evidence>` |
| Hosted viability | `<yes|maybe|no|unknown>` | `<provider docs or smoke>` |
| Training/adaptation viability | `<yes|maybe|no|unknown>` | `<public docs or measured handoff>` |

## Artificial Analysis

Use this section only when Artificial Analysis data is cited.

| Field | Value | Source |
| --- | --- | --- |
| Model label | `<exact Artificial Analysis label>` | `<source>` |
| Leaderboard slice | `<intelligence|quality|speed|price|endpoint>` | `<source>` |
| Rank | `<rank or n/a>` | `<source>` |
| Intelligence Index | `<score or n/a>` | `<source>` |
| Output speed | `<tokens/sec or n/a>` | `<source>` |
| Latency | `<ms or n/a>` | `<source>` |
| Price | `<USD/Mtok or n/a>` | `<source>` |

State explicitly: Artificial Analysis is external benchmark/ranking context, not
evidence that this model wins on the user's workload.

## Runtime Plan

Use one section only if relevant.

Before recommending a hosted or local route, create or reference a supplier
profile using [`model-supplier-profiles.md`](model-supplier-profiles.md).

### Local

- Runner:
- Hardware:
- Model id:
- Quantization:
- Download size or disk footprint:
- Command:
- Artifact path:
- Approval needed:

### Hosted Open-Weight

- Provider route:
- Pricing date:
- Budget cap:
- Data sent:
- Command:
- Artifact path:
- Approval needed:

### Frontier

- Provider route:
- Role: incumbent, judge, fallback, teacher, or candidate:
- Pricing date:
- Budget cap:
- Data sent:
- Command:
- Artifact path:
- Approval needed:

## Measured Results

Only include measured results from local artifacts or live runs. Label the result
type.

| Metric | Baseline | Candidate | Delta | Result type | Artifact |
| --- | --- | --- | --- | --- | --- |
| Quality | `<value>` | `<value>` | `<delta>` | `<type>` | `<path>` |
| Cost/request | `<value>` | `<value>` | `<delta>` | `<type>` | `<path>` |
| Latency p50/p95 | `<value>` | `<value>` | `<delta>` | `<type>` | `<path>` |
| Output validity | `<value>` | `<value>` | `<delta>` | `<type>` | `<path>` |
| Artificial Analysis rank/index | `<value>` | `<value>` | `<delta>` | `artificial-analysis` | `<source URL>` |

## Failure Triage

Check before blaming model quality:

- context-window or token-cap mismatch;
- tokenizer/chat-template mismatch;
- parser or schema failure;
- tool-call wire-format mismatch;
- route/provider error;
- latency outside inference;
- weak sample size;
- heldout leakage;
- true quality regression.

## Recommendation

One of:

- Try local smoke.
- Download public model with approval.
- Use existing provider key for capped eval.
- Use Understudy inference for route comparison.
- Keep as incumbent or judge.
- Skip for this workload.
- Escalate to optimization.
- Escalate to training handoff.

Include one next command and one approval boundary.
