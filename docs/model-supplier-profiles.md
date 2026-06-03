# Model Supplier Profiles

Use this when deciding where to run a model. A model profile answers "what is
this model good for?" A supplier profile answers "where should this model run,
what will it cost, and what data leaves the machine?"

Pricing and availability drift. Every supplier profile must include a source URL
and `date_checked`. Do not copy prices from private notes into public docs.

## Supplier Profile Template

```yaml
---
profile_type: model-supplier
schema_version: model-supplier-profile.v1
supplier: <fireworks|openrouter|prime-intellect|tinker|gcp-vertex|aws-bedrock|lilac|local-mlx|local-ollama|understudy-inference|other>
route_type: <frontier-api|hosted-open-weight|hosted-training|local-runner|aggregator|understudy-inference>
models_supported:
  - <exact model id or model class>
pricing:
  date_checked: <YYYY-MM-DD>
  source_url: <https://...>
  input_usd_per_1m_tokens: <number|null>
  output_usd_per_1m_tokens: <number|null>
  cache_write_usd_per_1m_tokens: <number|null>
  cache_read_usd_per_1m_tokens: <number|null>
  training_usd: <description|null>
  hosting_usd: <description|null>
  notes: <pricing caveats>
artificial_analysis:
  source_url: <https://artificialanalysis.ai/... or API endpoint>
  checked: <YYYY-MM-DD>
  endpoint_label: <exact endpoint label or null>
  intelligence_index: <number|null>
  output_speed_tps: <number|null>
  latency_ms: <number|null>
  price_per_million_tokens_usd: <number|null>
data_boundary:
  runs_local: <true|false>
  uploads_prompt_or_trace: <true|false>
  uploads_training_data: <true|false>
  stores_provider_side: <unknown|no|yes>
  approval_required: <download|spend|upload|training|none>
---
```

## Supplier Classes

| Supplier class | Examples | Best use | Pricing profile must include |
| --- | --- | --- | --- |
| Aggregator / router | OpenRouter | Fast frontier/open-weight access, model shopping, fallback, broad route discovery. | Exact OpenRouter model id, pricing object, top provider, transforms, supported parameters, date checked. |
| Hosted open-weight serverless | Fireworks, Lilac | Fast cost/latency comparisons and cheap candidate sweeps. | Exact provider route, price per token/request, latency/speed if public, provider-specific support for JSON/tool/logprobs. |
| Hosted training/adaptation | Fireworks, Prime Intellect, Tinker, GCP/Vertex, AWS Bedrock/SageMaker-adjacent paths | SFT/LoRA/RL after eval proves residual failures. | Training price shape, hosting/deploy price shape, upload boundary, supported base models. |
| Cloud platform model garden | GCP/Vertex, AWS Bedrock | Enterprise procurement, cloud credits, VPC/governance, regional controls. | Exact model id, region, input/output/cache pricing, provisioned-throughput options, data policy. |
| Local runner | MLX, Ollama, llama.cpp, LM Studio, vLLM, SGLang, Transformers | Privacy, zero marginal inference cost, latency tests, app-routing smoke. | Download size, disk/RAM/VRAM fit, local hardware, runner version, no provider token price. |
| Understudy inference | Understudy API key / managed route | Avoid provider glue and compare routes faster. | Understudy route, data boundary, capped spend, whether it is using BYO or managed keys. |

## Current Model-Class Supplier Coverage

| Model class | Likely suppliers to profile | Current status |
| --- | --- | --- |
| GLM 5.1 | OpenRouter, Fireworks, Lilac, GCP, AWS, or local quantized routes when a public route exists; model-owner docs are source evidence only. | Initial public-source profile started; exact supplier availability and pricing must be refreshed before use. |
| Gemma 4 | Local MLX/Ollama/llama.cpp where supported, plus Fireworks, Lilac, OpenRouter, GCP, or AWS routes when public. | Local and model-card profile started; hosted supplier rows are source-required per exact variant. |
| Kimi 2.6 | OpenRouter, Fireworks, Lilac, GCP, AWS, or quantized local routes when a public route exists; model-owner docs are source evidence only. | Model-card profile started; exact supplier availability and pricing must be refreshed before use. |
| GPT-5.5 class | OpenRouter, GCP, AWS, Understudy inference, or direct model-owner route when the user supplies that key. | Exact current model id and pricing source required before cost claims. |
| Anthropic Claude class | OpenRouter, AWS Bedrock, GCP Vertex, Understudy inference, or direct model-owner route when the user supplies that key. | Exact current model id and cache pricing required before cost claims. |
| Gemini class | GCP Vertex, OpenRouter, AWS where available, Understudy inference, or direct model-owner route when the user supplies that key. | Exact model id/API surface and pricing source required. |

## Initial Supplier Matrix

These are the provider profiles to maintain. They are seed profiles, not final
pricing claims. Refresh before using them in a recommendation.

| Supplier | Route type | Model class | Pricing status | Artificial Analysis status | Data boundary | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Fireworks | hosted-open-weight / hosted-training | Gemma 4 or supported open-weight routes | Source-required per exact serverless or training route; Fireworks documents pay-per-token serverless inference and per-job/LoRA training shapes. | Include provider endpoint if tracked. | Remote provider call or training upload; spend/upload approval required. | https://docs.fireworks.ai/serverless/overview and https://fireworks.ai/training |
| OpenRouter | aggregator | Frontier and open-weight routes, including GLM/Kimi/GPT/Claude/Gemini classes when listed | Use OpenRouter Models API pricing object per exact model id; aggregator pricing can differ by route/provider and can change frequently. | Use only if Artificial Analysis or OpenRouter exposes exact endpoint. | Remote provider/aggregator call; spend/upload approval required. | https://openrouter.ai/docs/models |
| Prime Intellect | hosted-training | RL/LoRA training and hosted training environments | Source-required per hosted training run; docs describe dedicated orchestrator plus trainer/inference components and per-token efficiency shape. | Usually not endpoint-ranked unless exposed as model provider. | Hosted training upload/execution; training approval required. | https://docs.primeintellect.ai/hosted-training/what-is-lab and https://primeintellect.mintlify.app/verifiers/training |
| Tinker | hosted-training | SFT/RL/DPO/LoRA-style training handoff when supported | Source-required per account/job; profile as hosted training, not inference supplier, unless a public inference endpoint is used. | Usually not endpoint-ranked. | Hosted training upload/execution; training approval required. | public Tinker/provider docs required before recommendation |
| GCP / Vertex | cloud-platform / frontier-api / hosted-training | Gemini class, Model Garden/open-weight routes, Vertex training where supported | Use official Vertex/Gemini pricing per exact model id and region. Include cloud credits only as account-specific context, not public pricing. | Include exact endpoint if Artificial Analysis tracks it; otherwise use as supplier-only profile. | Remote provider call or training upload; spend/upload approval required. | https://cloud.google.com/vertex-ai/generative-ai/pricing and https://ai.google.dev/gemini-api/docs/pricing |
| AWS Bedrock | cloud-platform / frontier-api | Claude class and Bedrock-supported model garden routes | Use official Bedrock pricing per exact model id and region; include on-demand vs provisioned throughput if relevant. | Include exact endpoint if Artificial Analysis tracks it. | Remote provider call; spend/upload approval required. | https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-pricing.html |
| Lilac | hosted-open-weight | Supported open-weight routes, including Gemma/Kimi/GLM when listed | Source-required per exact model route; profile token pricing, speed, and support for OpenAI-compatible SDK usage. | Include provider endpoint if tracked. | Remote provider call; spend/upload approval required. | https://getlilac.com/serverless-inference-api |
| Local MLX | local-runner | Gemma 4, Qwen, compatible local checkpoints | No token price; profile download size, hardware, memory pressure, setup time, and local latency. | Not provider-priced; use Artificial Analysis only for model context if exact label exists. | Local process; download approval may be required. | https://github.com/ml-explore/mlx-lm |
| Local Ollama / OpenAI-compatible | local-runner | Quantized local models available in library | No token price; profile download size, local endpoint, hardware, and latency. | Not provider-priced; use Artificial Analysis only for model context if exact label exists. | Local process; download approval may be required. | https://docs.ollama.com/api and https://docs.ollama.com/api/openai-compatibility |
| Understudy inference | understudy-inference | Configured frontier/open-weight routes through selected suppliers | Source-required from Understudy account or docs before public claim; can simplify route comparison across the provider set above. | May attach Artificial Analysis context for underlying exact route. | Depends on BYO vs managed key and route; explicit spend/upload approval required. | Understudy account/config |

## Pricing Rules

- Do not present a supplier as cheaper without a dated pricing source.
- For remote frontier models, include input, output, and cache pricing where
  applicable.
- For hosted open-weight suppliers, include both token price and observed or
  cited latency/speed when available.
- For local runners, token price is `0` only for marginal provider spend. Still
  record hardware, download size, setup time, and memory pressure.
- For training suppliers, separate training cost from inference hosting cost.
- For aggregators, record whether the supplier is a pass-through, hosted route,
  or model-substitution layer when public docs say so.
- Artificial Analysis price/speed/ranking is external context. Keep it separate
  from Understudy workload measurements.
- For cloud providers, record region, quota, procurement path, credits, and
  whether pricing is first-party model pricing or marketplace/provider pricing.

## Starter Pricing And Supplier Sources

Refresh these before publishing exact numbers:

- Fireworks serverless: https://docs.fireworks.ai/serverless/overview
- Fireworks training: https://fireworks.ai/training
- OpenRouter Models API: https://openrouter.ai/docs/models
- Prime Intellect hosted training: https://docs.primeintellect.ai/hosted-training/what-is-lab
- Prime Intellect Verifiers training: https://primeintellect.mintlify.app/verifiers/training
- GCP Vertex generative AI pricing: https://cloud.google.com/vertex-ai/generative-ai/pricing
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- AWS Bedrock pricing: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-pricing.html
- Lilac serverless inference: https://getlilac.com/serverless-inference-api
- MLX LM: https://github.com/ml-explore/mlx-lm
- Ollama API: https://docs.ollama.com/api
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- Artificial Analysis: https://artificialanalysis.ai/
- Artificial Analysis API reference: https://artificialanalysis.ai/api-reference/beta
