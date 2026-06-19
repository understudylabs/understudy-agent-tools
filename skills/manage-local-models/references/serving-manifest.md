# Understudy Serving Manifest (`understudy.serving.v1`)

A **machine-readable** record of the correct serving settings for a local model
artifact, so the launcher applies them by default instead of the operator
hand-specifying (and mis-specifying) flags. Lives **inside the model artifact
directory** as `understudy.serving.json` — alongside `config.json`,
`tokenizer.json`, and the README — so it travels with the weights through
`understudy models pull` and any R2 publish.

## Why

`manage-local-models` already tells agents to *"pre-research and record the
recommended serving settings at pull time."* That record was prose an operator
reads and then hand-translates into CLI flags — which is exactly where every
configuration mistake this project has hit originated:

- forgetting `--top-logprobs-k 20` (mlx_vlm defaults it to 0 → empty `top_logprobs`),
- `group_size=64` vs `32` (regresses tool-call parsing for QAT weights),
- serving the MTP assistant raw/unconverted or quantized (breaks speculative decoding),
- dropping to greedy decode (off-spec for `do_sample: true` models).

The manifest closes the loop: the model card is the source of truth, and
`serve-understudy-snapshot.mjs` reads it to emit the exact, correct serve command.

## File location

`<model-artifact-dir>/understudy.serving.json` (e.g.
`~/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy/understudy.serving.json`).
When publishing to R2, include it in the snapshot file set alongside the weights
and metadata.

## Schema

```jsonc
{
  "schema_version": "understudy.serving.v1",   // required
  "model_id": "<served id>",                   // required; matches the dir name
  "name": "<human-readable>",                  // optional
  "base_model": "<upstream hf id>",            // optional, for provenance
  "source_checkpoint": "<hf id>",              // optional
  "provenance": {                              // optional
    "conversion": "<command that produced this artifact>",
    "rationale": "<why these settings>",
    "license": "<upstream license>"
  },
  "server": {                                  // required
    "launcher": "<e.g. 'python -m mlx_vlm.server'>",
    "model_arg": "<--model>",
    "cwd": "<dir to launch from, if the launcher resolves the model relatively>",
    "required_flags": ["<flag>", "<value>", ...],   // flags the launcher MUST set
    "required_flags_note": "<why>",
    "runtime": "<e.g. 'mlx-vlm' | 'mlx-lm' | 'llama.cpp'>"
  },
  "decode": {                                  // required when the model prescribes sampling
    "temperature": <float>,
    "top_p": <float>,
    "top_k": <int>,
    "source": "<where these numbers come from, e.g. the vendor model card>",
    "warning": "<what NOT to do, e.g. 'do not drop to greedy'>"
  },
  "thinking": {                                // optional; thinking-mode default + how to toggle
    "default": "<on | off>",
    "rationale": "<why this default for the artifact's intended use>",
    "enable_server_arg": "<server flag/arg to turn thinking on>",
    "note": "<vendor guidance, e.g. per-size thinking-behavior differences>"
  },
  "quantization": {                            // optional; describes the artifact itself
    "format": "<mlx-4bit | bf16 | gguf-q4_0 | ...>",
    "group_size": <int>,
    "bits": <int>,
    "mode": "<affine | ...>",
    "disk_gb": <float>,
    "peak_runtime_memory_gb": <float>
  },
  "mtp": {                                     // optional; speculative-decoding wiring
    "enabled": <bool>,
    "assistant_model": "<artifact id>",
    "assistant_format": "<bf16 | 4bit | ...>",
    "draft_kind": "<mtp | eagle3 | dflash>",
    "draft_block_size": <int>,
    "note": "<constraints, e.g. 'do not quantize the assistant'>",
    "server_flags_when_enabled": ["<flag>", ...]
  },
  "certification": {                           // optional; the onboarding-rung bar
    "decode_used": "<the decode the cert ran at>",
    "generation": "<pass | fail>",
    "openai_compat_pi": "<pass | fail>",
    "logprobs_top_logprobs": "<pass | fail | pass-with-caveat>",
    "tool_calls": "<pass | fail>",
    "certified_at": "<YYYY-MM-DD>"
  }
}
```

## How it is consumed

- `scripts/serve-understudy-snapshot.mjs --model <id>` reads
  `<artifact-dir>/understudy.serving.json` and emits (or runs) the exact serve
  command: `<launcher> <model_arg> <id> <required_flags...>`, with the prescribed
  decode exported as the eval/smithers env. The operator cannot forget a flag.
- `understudy models pull` includes `understudy.serving.json` in the
  snapshot file set so a freshly-pulled artifact is immediately serve-correct.
- The `manage-local-models` skill's "verify + record" step writes/reads this
  manifest instead of leaving settings as prose in the profile.

## Versioning

`schema_version` is `understudy.serving.v1`. Additive, backward-compatible
changes keep `v1`; breaking changes bump to `v2` and the reader supports both.
When a manifest is absent, the launcher falls back to its current behavior
(never silently invents settings).
