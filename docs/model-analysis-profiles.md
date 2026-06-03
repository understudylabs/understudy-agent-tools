# Model Analysis Profiles

This is the public-safe profile index for model classes Understudy commonly
handles. Profiles are intentionally cited and high level. They do not include
private customer results or private route-promotion methods.

Use [`model-analysis-style-guide.md`](model-analysis-style-guide.md) and
[`model-analysis-profile-template.md`](model-analysis-profile-template.md) before
adding or editing profiles. Use
[`model-supplier-profiles.md`](model-supplier-profiles.md) before recommending a
specific provider, hosted route, local runner, or training supplier.

Artificial Analysis data can be included for each model class as external
ranking context. When used, record the exact model label, leaderboard slice,
rank, Intelligence Index, speed, price, source URL, and date checked. Do not
present Artificial Analysis rankings as workload-specific Understudy evidence.

Starter Artificial Analysis links:

- https://artificialanalysis.ai/
- https://artificialanalysis.ai/api-reference/beta

## Open-Weight / Local Candidates

### GLM 5.1

- Lane: hosted open-weight, local quantized route when available, reasoning and
  coding candidate.
- Public sources: Z.ai documentation, NVIDIA NIM model card, Hugging Face route
  when available, and current provider docs.
- Understudy stance: strong candidate class for coding, reasoning, and
  long-horizon agentic comparison. Treat provider/runtime support, context
  behavior, and tool/structured-output compatibility as first-class gates.
- Profile requirements: exact model id, exact host or runner, context budget,
  reasoning/direct mode behavior, tool-call/JSON support, latency, cost, and
  data-upload boundary. Include Artificial Analysis rank/index/speed/price when
  available for the exact GLM 5.1 label.
- Starter citations:
  - https://docs.z.ai/guides/llm/glm-5.1
  - https://build.nvidia.com/z-ai/glm-5.1/modelcard

### Gemma 4

- Lane: local small open-weight, local MLX, hosted open-weight, hosted training.
- Public sources: Google/Hugging Face model cards, runner/provider docs.
- Understudy stance: strong Google open-model candidate class for local,
  Apple-Silicon, hosted open-weight, and adaptation comparisons. Always profile
  exact Gemma 4 variant, size, modality, runtime, and whether the checkpoint is
  text-only or multimodal.
- Profile requirements: exact model id, parameter or active-parameter shape when
  public, modality, license/terms, context budget, MLX/Ollama/provider route,
  quantization, memory fit, and runtime family. Include Artificial Analysis data
  only when it names the exact Gemma 4 variant or provider endpoint.
- Starter citations:
  - https://huggingface.co/google/gemma-4-e2b-it
  - https://github.com/ml-explore/mlx-lm

### Kimi 2.6

- Lane: hosted open-weight, large MoE, agentic candidate, local only for
  quantized derivatives or serious infrastructure.
- Public sources: Moonshot/Hugging Face model card or official technical page.
- Understudy stance: useful for agentic/tool-heavy and coding-heavy workloads,
  but local self-hosting should be treated as infrastructure-heavy unless the
  user selects a smaller derivative, quantized build, or hosted route.
- Profile requirements: exact variant, total/active parameters if public,
  context, serving engine, tool-use claims, license/terms, hosted route,
  expected data upload, latency, and cost. Include Artificial Analysis
  rank/index/speed/price when available for the exact Kimi 2.6 label.
- Starter citation:
  - https://huggingface.co/moonshotai/Kimi-K2.6

### Qwen / Qwen3

- Lane: local small open-weight, hosted open-weight, hosted training.
- Public sources: Qwen model cards and technical reports.
- Understudy stance: still a useful local and distillation family, but it is no
  longer the primary named example in public docs when the current task calls
  for the latest classes above. Use exact model ids and fresh citations.
- Profile requirements: exact model id, size, tokenizer/chat template,
  reasoning mode behavior if relevant, quantization, runner, context budget,
  structured-output/tool-call behavior, and training/handoff compatibility.
  Include Artificial Analysis data only for exact model labels still present on
  the current leaderboard.
- Starter citations:
  - https://huggingface.co/Qwen/Qwen3-8B
  - https://arxiv.org/abs/2505.09388

## Local Runners

### MLX / MLX LM

- Lane: local Apple Silicon / MLX.
- Public source: MLX LM project docs.
- Understudy stance: preferred Apple Silicon route when model and adapter
  compatibility are clear. Always verify runtime family before rejecting a
  checkpoint.
- Profile requirements: hardware, memory, MLX package, exact checkpoint,
  quantization, adapter path, runtime module, generation smoke, and artifact
  path.
- Starter citation:
  - https://github.com/ml-explore/mlx-lm

### Ollama / Local OpenAI-Compatible

- Lane: local OpenAI-compatible.
- Public source: Ollama API and OpenAI-compatibility docs.
- Understudy stance: fastest app-integration path when a product already uses an
  OpenAI-style client and the model is available locally.
- Profile requirements: installed model name, endpoint, OpenAI-compatible API
  support, request shape, latency, memory, and app base URL wiring.
- Starter citations:
  - https://docs.ollama.com/api
  - https://docs.ollama.com/api/openai-compatibility

## Remote Frontier Models

### GPT-5.5 Class

- Lane: remote frontier incumbent, judge, fallback, or teacher.
- Public sources: OpenAI model docs, model comparison docs, launch note, system
  card, and pricing.
- Understudy stance: strong frontier baseline and judge class. Evaluate as a
  route to beat, a capped live comparison route, or a high-quality judge, not as
  the automatic default for production economics.
- Profile requirements: exact GPT-5.5 variant, pricing date, tool and
  structured-output support, context/token cap, role in eval, workload cost
  estimate, latency, and upload boundary. Include Artificial Analysis rank,
  Intelligence Index, speed, and price when available for the exact GPT-5.5
  label and leaderboard slice.
- Starter citations:
  - https://developers.openai.com/api/docs/models/gpt-5.5/
  - https://openai.com/index/introducing-gpt-5-5/
  - https://openai.com/api/pricing/

### Anthropic Claude Class

- Lane: remote frontier incumbent, judge, fallback, or teacher.
- Public sources: Anthropic model/pricing docs and system card when relevant.
- Understudy stance: strong high-quality incumbent/judge route. Pricing, cache
  behavior, model id, and tool support must be profiled explicitly before cost
  or quality claims.
- Profile requirements: exact Claude model id, pricing date, cache pricing,
  tool support, context/token cap, role in eval, workload cost estimate, and
  upload boundary. Include Artificial Analysis data for the exact Claude label
  rather than the family name.
- Starter citations:
  - https://www.anthropic.com/claude/opus
  - https://docs.anthropic.com/en/docs/about-claude/pricing

### Gemini Class

- Lane: remote frontier incumbent, judge, fallback, structured-output route, or
  multimodal route.
- Public sources: Gemini API model docs, API reference, and pricing docs when
  used.
- Understudy stance: useful for multimodal, structured-output, and frontier
  comparison routes. Exact model id and API surface matter more than family
  branding.
- Profile requirements: exact Gemini model id, modality, structured-output
  support, context/token cap, pricing date, role in eval, workload cost
  estimate, latency, and upload boundary. Include Artificial Analysis data for
  the exact Gemini label rather than the family name.
- Starter citations:
  - https://ai.google.dev/gemini-api/docs/models
  - https://ai.google.dev/api
