# Browser Inference with WebGPU — reference example

The [Gemma 4 WebGPU Kernels](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels)
space by webml-community is a working reference for running a compressed LLM
entirely in the browser via WebGPU compute shaders. It demonstrates that
browser-based local inference is real today — and it points directly at an
opportunity to deploy Understudy's stacked QAT compression in a new runtime.

## What the reference does

- Runs **Gemma 4 E2B QAT Mobile** (`google/gemma-4-E2B-it-qat-mobile-transformers`)
  fully in-browser on WebGPU — no server, no download step beyond the initial
  page load.
- Custom WGSL compute kernels for every operation: quantized matmul, fused
  attention, RMSNorm, GELU, argmax. The 550 KB JS bundle (`gemma-4-e2b.js`)
  is a complete inference engine — it does not use transformers.js or ONNX
  Runtime Web.
- Per-tensor quantization baked into the kernel design: each weight tensor
  carries its own `bits`, `scaleT` (scale factor), and `codesT` (codebook
  indices), enabling mixed-precision decode at the WGSL level.
- GPU tier detection: the landing page probes `WEBGL_debug_renderer_info` and
  classifies the device (Apple GPU = high-tier, old Intel = low-tier) to
  adjust the visual quality budget and leave GPU headroom for inference.
- Pauses the WebGL background when the chat view scrolls into view, freeing
  the GPU for the WebGPU model.

## Why this matters for Understudy

### The deployment surface opportunity

SaaS applications have product surfaces where local inference is strictly
better than hosted:

| Surface | Why local | Example |
|---|---|---|
| **Summarization** | Privacy + latency (no round-trip) | Summarize an email thread without sending it to a server |
| **Offline workloads** | No connectivity required | Field-worker forms, airplane mode, poor connectivity |
| **Simple tool calling** | $0 cost + instant response | Triage, routing, entity extraction on the client |
| **Draft assistance** | Privacy for sensitive content | Legal/medical drafting where content can't leave the device |

The WebGPU reference proves this is deployable today in a browser tab. The
Gemma 4 E2B QAT model is small enough (~1-2 GB in mobile format) to download
as part of the page load and run at interactive speeds on Apple Silicon.

### The mobile-QAT gap

The reference uses Google's `qat-mobile-transformers` format — a
mobile-optimized QAT variant designed for on-device deployment. This format
is:

- **Not the same as desktop QAT.** It uses a different weight layout and
  quantization scheme optimized for mobile NPUs/GPUs, not for Apple Silicon's
  unified memory.
- **Not tool-call optimized.** It was calibrated for general chat quality,
  not for structured output. The tool-call fidelity issues we documented
  (trigger failures, parse failures) apply equally here.
- **Single-precision.** No sensitivity-driven layer allocation. Every layer
  gets the same bit-width.

### The Understudy opportunity

Our stacked compression method (QAT + g32 + tool-call calibration) produces
an artifact that is:

1. **Higher fidelity** for tool-calling (0.398 vs ~0.35 for mobile QAT)
2. **Mixed-precision** — the WebGPU kernels already support per-tensor
   `bits`/`scaleT`/`codesT`, which is exactly the interface OptiQ's
   mixed-precision allocation produces. The kernel infrastructure for
   layer-aware quantization already exists in the reference.
3. **Tool-call calibrated** — the calibration data source can be tuned to
   the SaaS app's specific tool schemas (CRM tools, coding tools, etc.)

## How to reimplement with Understudy's stacked method

The path from the reference to an Understudy-powered browser inference:

1. **Export the stacked artifact in a browser-compatible format.** The
   stacked method produces MLX safetensors. For WebGPU, the weights need to
   be in a flat binary format with per-tensor metadata (bits, scale, codebook).
   This is a serialization step, not a re-quantization — the bit allocations
   are already determined by the OptiQ conversion.

2. **Reuse the WGSL kernel infrastructure.** The reference's kernels already
   handle per-tensor quantized matmul with scale factors. The mixed-precision
   allocation from our stacked method maps directly to the per-tensor `bits`
   field — some layers decode at 4-bit, some at 8-bit, using the same kernel.

3. **Calibrate to the app's tool schemas.** Instead of our generic 58%
   tool-call calibration, build calibration data from the SaaS app's actual
   tool definitions and traces. This makes the compressed model specifically
   good at calling the app's tools.

4. **Serve via the browser, certify with Understudy.** Use the same
   certification checklist (generation, tool calls, OpenAI compat, scored
   eval) but run it in a headless browser (Playwright + WebGPU) instead of
   `mlx_vlm.server`.

## Technical reference: the WGSL quantized matmul

The reference's kernel design is directly compatible with our mixed-precision
allocation. From the decompiled source:

```js
// Per-tensor quantization metadata (exactly what OptiQ produces)
{
  bits: 4,           // or 8 — per-layer, from optiq_metadata.json
  scaleT: <tensor>,  // per-group scale factor
  codesT: <tensor>,  // codebook indices (for learned codebook quant)
  inScale: <float>,  // input quantization scale (for activation quantization)
  outScale: <float>  // output scale (for chaining to next layer)
}
```

Each weight tensor in the reference carries its own bit-width and scale.
This is the same interface OptiQ's `per_layer` metadata exposes. An export
script that reads `optiq_metadata.json` and emits the browser format would
preserve the full mixed-precision allocation.

## Current limitations

- **WebGPU is not yet universal.** Safari 26+ (in beta) adds WebGPU support;
  Chrome/Edge have it; Firefox is partial. The reference detects and falls
  back gracefully, but deployment requires a WebGPU-capable browser.
- **Model size for initial download.** The E2B QAT Mobile is ~1-2 GB in
  browser format. The stacked method's 4.3 GB MLX artifact would be larger
  in browser format due to the different serialization. Caching via
  `Cache-Control` + `IndexedDB` makes this a one-time cost.
- **No tool-call format in-browser.** The reference does chat completions,
  not structured tool calls. Adding Gemma's tool-call token format to the
  browser tokenizer and chat template is a straightforward extension.

## Source

- **HF Space:** https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels
- **Model:** `google/gemma-4-E2B-it-qat-mobile-transformers`
- **Kernels:** Custom WGSL (see the space source)
- **License:** Check the space README for current terms
