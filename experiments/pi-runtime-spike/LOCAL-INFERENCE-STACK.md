# Local inference stack decision — 2026-07-11

Status: source-reviewed against:

- `Blaizzy/mlx-vlm` commit `8e2638b71f1834f3aead54acac5118e333d2175d`
  and release `v0.6.4`;
- `ml-explore/mlx-swift-lm` commit
  `2c1dd13d41586f63f40ba9ce45ce201026ab52b0` and release `3.31.4`;
- `ml-explore/mlx-swift` and the official MLX Swift examples.

## Decision

Keep `mlx-vlm` as the production local inference and training provider for this
migration. Do not put an MLX Swift rewrite on the critical path for replacing
the Rust conversation harness.

Run a narrow MLX Swift provider spike only after Pi passes the frozen runtime
contract through the existing `mlx-vlm` path. Promote the Swift provider only
if it passes the same exact models and evidence gates and produces a measurable
packaging, startup, memory, or reliability win.

## The layers are different products

```text
Apple MLX
  tensor runtime, Metal kernels, unified-memory execution

Apple MLX Swift + MLX Swift LM
  native Swift APIs and reusable LLM/VLM model implementations

Blaizzy mlx-vlm
  Python model implementations plus a batteries-included local runtime:
  serving, batching, multimodal processing, logprobs, training, conversion,
  caching, model switching, metrics, and compatibility work

Understudy
  Pi conversation state, supervision, tools, capture, eval, repair, and UX
```

`mlx-vlm` is not a fork or replacement for Apple's MLX. It is a higher-level
runtime built on MLX, analogous to a model-serving and Transformers layer built
on a tensor framework.

## Why both need to exist

The official Swift package is designed for developers embedding MLX models into
native macOS, iOS, tvOS, and visionOS applications. It provides model loading,
LLM/VLM implementations, generation, tool parsing, KV caches, speculative
decoding, cancellation, and LoRA/full fine-tuning APIs. It does not currently
ship an OpenAI-compatible HTTP server or a production model-lifecycle daemon.

`mlx-vlm` is designed for the Python/Hugging Face research and local-serving
ecosystem. Its current package includes a CLI, OpenAI Chat Completions and
Responses APIs, an Anthropic-compatible route, continuous batching, automatic
prefix caching, vision-feature caching, top-token logprobs, metrics, unload and
model switching, multi-image input, audio/video/omni models, conversion, and
LoRA/QLoRA training.

The Python project also moves faster across new model families. At the reviewed
snapshot, `mlx-vlm` contained 89 top-level model implementation directories
spanning text, VLM, omni, OCR, image generation, and detection families. The
official Swift `VLMTypeRegistry` contained 18 keys representing 17 distinct
VLM families or aliases. Counts are not a quality benchmark, but they show the
different coverage goals.

## Is Swift faster?

Unknown until measured on identical model artifacts and prompts. No credible
cross-project, apples-to-apples benchmark was found.

Both paths use MLX kernels, so autoregressive decode is usually dominated by
the same Metal work and memory bandwidth. Swift can improve native packaging,
process control, cancellation, startup integration, and possibly host-language
overhead. `mlx-vlm` can win service throughput through its existing continuous
batching, cache, and request scheduler. Language choice alone does not establish
the winner.

## Understudy-specific promotion blockers

The current Understudy lane depends on features that are already working in
`mlx-vlm` but would need to be proven or implemented in a Swift service:

1. exact compatibility with the published Gemma 4 E2B, E4B, 12B, 26B A4B,
   31B, DiffusionGemma, Qwen VL, and Understudy QAT artifacts;
2. top-token logprobs for trustworthy supervisor verdict probabilities;
3. OpenAI-compatible streaming, images, tool calls, usage, and malformed-call
   preservation;
4. continuous batching and cache behavior under concurrent student/teacher
   work;
5. cancellation during both prefill and decode without wedging the process;
6. offline local-path loading with no tokenizer or weight fetch;
7. model unload, switch, restart, diagnosis, and repair;
8. adapter and local-training compatibility.

The Swift generation API computes logits internally, but its public
`Generation` stream currently exposes text chunks, tool calls, and completion
information rather than the top-token logprob envelope Understudy consumes.
That signal is implementable in a thin provider, but it is not free parity.

## Frozen bakeoff

The optional Swift spike must run the same model files and frozen requests as
the incumbent. Compare:

- output and tool-call validity;
- image and multi-turn image behavior;
- exact prompt/completion token attribution;
- top-k logprob fidelity;
- cancellation latency during prefill and decode;
- cold start and time to first token;
- prompt and generation tokens per second;
- idle and loaded resident memory;
- two concurrent chats and student/teacher concurrency;
- restart, repair, and fully offline loading.

Until that report passes, the production shape is:

```text
Understudy desktop -> Pi conversation runtime -> mlx-vlm provider
                                      fallback -> native Rust for one release
```

Primary sources:

- <https://github.com/ml-explore/mlx>
- <https://github.com/ml-explore/mlx-swift>
- <https://github.com/ml-explore/mlx-swift-lm>
- <https://github.com/ml-explore/mlx-swift-lm/blob/main/Libraries/MLXVLM/VLMModelFactory.swift>
- <https://github.com/ml-explore/mlx-swift-lm/blob/main/Libraries/MLXLMCommon/Evaluate.swift>
- <https://github.com/ml-explore/mlx-swift-examples>
- <https://github.com/Blaizzy/mlx-vlm>
- <https://github.com/Blaizzy/mlx-vlm/blob/main/README.md>
