# Provider Integration Cookbook

This cookbook maps public provider docs to the Understudy workflow. It is not a
promise that a route is configured or approved. Provider keys are local machine
state; spend, uploads, downloads, hosted jobs, and live calls still require
explicit approval.

## Integration Pattern

Every provider integration should follow the same public-safe order:

1. Start from a Workload Card.
2. Check redacted provider-key readiness.
3. Refresh supplier profile, pricing source, data boundary, and exact model or
   training route.
4. Produce a Route Decision Packet.
5. Run a local dry-run or fake-provider path when possible.
6. Ask for capped approval before live calls, downloads, uploads, hosted jobs,
   training, or benchmark submission.
7. Write a Decision Packet before reporting or publishing.

## Provider Use Cases

| Provider | Primary Use Case | Understudy Stage | Public Methodology |
| --- | --- | --- | --- |
| Fireworks | Serverless open-weight inference, batch-style sweeps, fine-tuning/LoRA paths, dedicated deployments when volume justifies it. | Route decision, capped live eval, hosted training handoff. | Compare exact route economics and support for structured outputs/tool calls/logprobs before calling it a replacement. |
| OpenRouter | Broad route discovery, aggregator fallback, endpoint/provider comparison, frontier/open-weight shopping with one API surface. | Route decision and capped eval. | Treat model id and provider endpoint as separate facts; pricing and behavior can differ by provider route. |
| Prime Intellect | Verifier environments, hosted RL training, `prime-rl`, agentic rollouts, LoRA/adaptation after eval evidence. | Training handoff after Workload Card, eval, and Decision Packet. | Use only after provenance, split boundaries, reward/verifier readiness, budget, and upload boundary are explicit. |
| Tinker | Fine-tuning / post-training API and Cookbook recipes such as Verifiers RL where user-controlled training logic matters. | Hosted training handoff or method exploration after local evidence. | Treat as a training/sampling lane, not a default inference provider, unless a public inference route is explicitly configured. |
| GCP / Vertex | Gemini API, Vertex AI, Model Garden/open-weight routes, enterprise cloud controls, regional/procurement constraints. | Frontier baseline, cloud route, hosted training handoff. | Record exact model id, API surface, region, pricing page, and data boundary before recommending. |
| AWS / Bedrock | Bedrock model access, enterprise procurement, provisioned throughput, Claude/open model routes through a customer cloud. | Frontier/open model route and enterprise deployment path. | Record model id, region, on-demand vs provisioned pricing, and data retention boundary. |
| Lilac | Hosted open-weight inference and high-volume route comparison where logprob-rich or OpenAI-compatible access is useful. | Capped eval, data collection, serverless route comparison. | Treat as an endpoint-specific service object; measure quality, latency, and output contract on the workload. |
| Local MLX / Ollama | Local privacy, zero marginal provider spend, Apple Silicon smoke tests, app routing with OpenAI-compatible local servers. | Local-model readiness and local replay. | Track hardware, download size, memory pressure, quantization, context, and latency; token price is not total cost. |

## CLI Automation Pattern

The public CLI should migrate provider automation in layers:

```text
understudy-tools provider-integrations status
understudy-tools keys doctor --redacted
understudy-tools model status
understudy-tools local-models doctor --json
understudy-tools workload-discovery plan --repo .
```

Planned follow-on commands should keep the same local-first shape:

```text
understudy-tools model lookup --id <model> --source public --dry-run
understudy-tools route-decision create --from .understudy/workload-discovery/workload-card.json --dry-run
understudy-tools evaluate plan --workload-card .understudy/workload-discovery/workload-card.json --dry-run
understudy-tools decision-packet create --from .understudy/evaluate/eval-plan.json --dry-run
```

Until a command exists, skills should state the intended artifact and route the
user to the closest implemented local command.

## Methodology Guardrails

- Do not conflate model family with provider endpoint. Hosted open-weight APIs
  are service objects: model variant, protocol behavior, context capacity,
  price, latency, throughput, reliability, and task feasibility can vary by
  provider.
- Do not conflate configured keys with approval to spend.
- Do not compare local marginal token price against hosted end-to-end cost
  without naming hardware, setup time, memory, and maintenance.
- Do not train before output-control, context triage, route fit, and small eval
  evidence have been checked.
- Do not publish provider pricing, availability, rank, or latency claims without
  source URL and date checked.

## Public Sources

- Fireworks platform overview and serverless inference: [Fireworks docs](https://docs.fireworks.ai/) and [serverless overview](https://fireworksai-docs.mintlify.app/serverless/overview).
- Fireworks fine-tuning: [Fine-tuning service overview](https://docs.fireworks.ai/faq/models/fine-tuning/service-overview).
- OpenRouter model catalog/API: [OpenRouter models docs](https://openrouter.ai/docs/models) and [Models API](https://openrouter.ai/docs/api/api-reference/models/get-models).
- Prime Intellect Verifiers and training: [Verifiers overview](https://docs.primeintellect.ai/verifiers/overview), [environments](https://docs.primeintellect.ai/verifiers/environments), and [training](https://docs.primeintellect.ai/verifiers/training).
- Prime Intellect RL infrastructure background: [INTELLECT-2](https://arxiv.org/abs/2505.07291).
- Tinker Cookbook: [Verifiers RL recipe](https://tinker-docs.thinkingmachines.ai/cookbook/recipes/verifiers-rl/).
- GCP / Gemini / Vertex pricing: [Vertex AI generative AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).
- AWS Bedrock pricing: [Amazon Bedrock pricing](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-pricing.html).
- Lilac serverless inference: [Lilac serverless inference API](https://getlilac.com/serverless-inference-api).
- Local MLX: [MLX](https://github.com/ml-explore/mlx) and [MLX LM](https://github.com/ml-explore/mlx-lm).
- Hosted open-weight APIs as service objects: [measurement study](https://arxiv.org/abs/2605.02821).
