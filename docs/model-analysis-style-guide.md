# Model Analysis Style Guide

Use this guide when writing public model guidance for Understudy skills,
reports, or docs. The goal is to help developers reach economic value quickly
without publishing private customer methodology or stale model folklore.

## Model Lanes

Every model analysis must classify the model into one primary lane.

| Lane | Examples we commonly touch | Default question |
| --- | --- | --- |
| Local small open-weight | Qwen3/Qwen3.5 small models, Gemma 4 edge models, GLM 5.1 quantized routes, Kimi 2.6 derivatives when available, Phi/Granite-class small models | Can this run locally fast enough to reduce cost or preserve privacy? |
| Local Apple Silicon / MLX | MLX-converted Qwen/Gemma/GLM-class checkpoints and adapters | Does this fit memory, use the right MLX runtime, and produce useful latency? |
| Local OpenAI-compatible | Ollama, llama.cpp server, LM Studio, vLLM, SGLang, Transformers server | Can an existing app route to this with minimal code changes? |
| Hosted open-weight serverless | Fireworks, Lilac, OpenRouter routes | Can this beat the incumbent on cost or latency with acceptable quality? |
| Hosted training / adaptation | Fireworks LoRA/SFT, Prime Intellect, Tinker, GCP/Vertex, AWS Bedrock-adjacent paths | Is upload/training justified by measured residual failures? |
| Remote frontier incumbent | OpenAI GPT-class, Anthropic Claude-class, Google Gemini-class | What is the baseline quality, latency, and cost we must beat or route around? |
| Remote frontier judge | Claude/OpenAI/Gemini judge routes used offline | Can a judge clarify quality without becoming the production dependency? |

## Public Model Families

These are safe public labels for the model types reflected in private
Understudy knowledge. Do not copy private benchmark numbers into public docs.

| Family | Public profile stance | Required citations |
| --- | --- | --- |
| Gemma 4 | Strong Google open-model candidate class, especially for local, Apple Silicon, hosted open-weight, and adaptation comparison. Profile exact Gemma 4 variant, size, modality, and runtime. | Google/Hugging Face model card; MLX/Ollama/provider docs. |
| GLM 5.1 | Open-weight/hosted reasoning, coding, and long-horizon agentic candidate. Profile exact GLM 5.1 route and serving support. | Z.ai docs, Hugging Face model card, NVIDIA/model host docs, or technical report. |
| Kimi 2.6 | Large open-weight MoE/agentic candidate class. Treat local self-hosting as infra-heavy unless using a hosted route or quantized derivative. | Moonshot/Hugging Face model card or official technical page. |
| GPT-5.5 class | Frontier incumbent, judge, and fallback route. Profile exact GPT-5.5 variant, pricing, tool/structured-output support, and date checked. | OpenAI model docs, launch note, system card, and pricing page. |
| Anthropic Claude class | Frontier incumbent, judge, and high-quality agentic route. Profile exact Claude model id, pricing/cache behavior, tool support, and date checked. | Anthropic model/pricing/system-card docs. |
| Gemini class | Frontier incumbent, multimodal route, judge, and structured-output candidate. Profile exact Gemini model id and API surface. | Google AI model/API docs and pricing docs when used. |

## Citation Rules

Model facts drift. Every public model profile must cite current public sources.

Required citations:

- model card or official product/model documentation;
- license or acceptable-use source for open-weight models;
- pricing source for any economic claim;
- runner/provider documentation for local or hosted compatibility;
- Artificial Analysis source link or API response when using benchmark,
  ranking, speed, price-performance, or provider-endpoint data;
- date checked for every pricing, availability, and context-window claim.

Allowed source types:

- official provider docs;
- Hugging Face model cards from the model owner or clearly named host;
- arXiv/OpenReview technical reports;
- runner docs from project maintainers;
- public benchmark pages only when the profile says the benchmark is external,
  not Understudy-measured evidence.

Do not cite:

- private Understudy lab notes in public docs;
- customer artifacts;
- uncited memory from an agent run;
- stale pricing copied from old notes;
- model availability from a provider UI without a stable public page.

## Profile Standard

Each profile must separate four kinds of evidence.

| Evidence type | What it can support | What it cannot support |
| --- | --- | --- |
| Catalog fact | Model size, license, context, modality, public availability. | Quality or replacement claims. |
| Artificial Analysis profile | Public external ranking, benchmark aggregate, speed, and price-performance context. | Workload-specific replacement claims. |
| Runtime smoke | Loads, generates, route works, rough latency/memory. | Production quality or broad reliability. |
| Local replay/eval | Directional quality, parser validity, latency, cost estimate on a named sample. | Production rollout unless live traffic shape matches. |
| Live heldout eval | Candidate decision, promotion, fallback, or training recommendation. | Claims outside the measured workload and split. |

Use these result labels:

- `catalog`
- `artificial-analysis`
- `runner-smoke`
- `local-smoke`
- `replay`
- `validation`
- `heldout`
- `live`

## Local Model Rules

Be helpful, not timid:

- If the user has Apple Silicon and the model is plausibly local, suggest MLX or
  Ollama/llama.cpp rather than stopping at a no-op dry run.
- If a public model download is the fastest route to value, ask for download
  approval with model id, estimated size, destination, and command.
- If the model is too large for local hardware, say so and suggest a hosted
  open-weight route or Understudy inference.
- If an app already speaks OpenAI-compatible APIs, prefer a local
  OpenAI-compatible server or proxy smoke before rewriting the app.
- If latency is the target, measure startup, first-token latency, decode
  throughput, and steady-state request latency separately.

Local profile fields must include:

- hardware and OS;
- runner: MLX, Ollama, llama.cpp, LM Studio, vLLM, SGLang, Transformers, other;
- exact model id and quantization;
- download size or disk footprint when known;
- memory pressure or VRAM/RAM requirement;
- context-window budget;
- tokenizer/chat-template compatibility;
- structured-output/tool-call support;
- measured local smoke command and artifact path.

## Remote Frontier Rules

Frontier models are often the incumbent or judge. Treat them as the baseline to
beat, not as the default recommendation.

Remote frontier profile fields must include:

- exact model id and provider, for example GPT-5.5, Anthropic Claude, or Gemini-class route;
- date pricing was checked;
- input/output/cache pricing when relevant;
- tool-call and structured-output support;
- context-window and token-cap fit;
- observed cost/request and latency on the workload when measured;
- whether it is production route, judge route, fallback, or teacher route.

## Hosted Open-Weight Rules

Hosted open-weight routes are often the fastest path to savings when local
hardware is insufficient.

Hosted open-weight profile fields must include:

- exact provider route;
- model id and version;
- pricing date;
- tool-call/JSON/logprob support;
- context-window fit;
- latency and throughput;
- whether data is uploaded to a third-party provider;
- approval and budget cap used for live runs.

## Artificial Analysis Rules

Artificial Analysis is useful for public, external context: broad model ranking,
benchmark aggregate, speed, latency, price, and provider endpoint comparison.
Use it to decide what to try first, not to claim that a model wins on the user's
workload.

When a model profile uses Artificial Analysis, include:

- source page or API endpoint URL;
- date checked;
- model label exactly as Artificial Analysis reports it;
- Intelligence Index or comparable ranking metric, if present;
- rank and leaderboard slice, if present;
- output speed, latency, and price fields, if present;
- provider endpoint or host, if the data is provider-specific;
- note that the ranking is external and may not predict task-specific quality.

Do not average Artificial Analysis scores with local Understudy evals. Keep
them in separate rows: external benchmark context vs measured workload evidence.

## What To Keep Private

Do not publish:

- customer prompts, traces, schemas, labels, rubrics, or outputs;
- exact route-promotion recipes;
- private provider negotiations or capacity tactics;
- internal control-plane or storage details;
- private margin by customer;
- patent-sensitive orchestration sequencing.

Public profiles may say "Understudy should compare local/open-weight and
frontier routes on the user's workload." They should not reveal private
replacement-loop mechanics.

## Public Source Starter Set

Use these as starter citations, then refresh before publishing time-sensitive
claims:

- GLM-5.1 docs: https://docs.z.ai/guides/llm/glm-5.1
- GLM-5.1 NVIDIA model card: https://build.nvidia.com/z-ai/glm-5.1/modelcard
- Gemma 4 E2B model card: https://huggingface.co/google/gemma-4-e2b-it
- Kimi K2.6 model card: https://huggingface.co/moonshotai/Kimi-K2.6
- GPT-5.5 model docs: https://developers.openai.com/api/docs/models/gpt-5.5/
- GPT-5.5 launch note: https://openai.com/index/introducing-gpt-5-5/
- Artificial Analysis leaderboard: https://artificialanalysis.ai/
- Artificial Analysis API reference: https://artificialanalysis.ai/api-reference/beta
- Supplier profile standard: model-supplier-profiles.md
- MLX LM: https://github.com/ml-explore/mlx-lm
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- OpenAI model comparison docs: https://developers.openai.com/api/docs/models/compare
- OpenAI API pricing: https://openai.com/api/pricing/
- Anthropic pricing: https://docs.anthropic.com/en/docs/about-claude/pricing
- Anthropic Claude Opus docs: https://www.anthropic.com/claude/opus
- Google Gemini model docs: https://ai.google.dev/gemini-api/docs/models
- Google Gemini API reference: https://ai.google.dev/api
