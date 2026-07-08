# Optimize Local Model Compression — reference

Exact conversion commands, calibration data format, BPW recommendations, and
the full experimental evidence. All results measured on Gemma 4 E2B through
31B, Apple Silicon M5 Max 128 GB, zero API cost.

## Prerequisites

```bash
# MLX runtime (should already exist if manage-local-models ran)
uv venv .understudy/venvs/mlx && uv pip install --python .understudy/venvs/mlx/bin/python \
  'mlx-lm>=0.31' 'mlx-vlm>=0.6.2' 'huggingface_hub[cli]>=0.27'

# OptiQ (for sensitivity-driven conversions)
uv pip install --python .understudy/venvs/mlx/bin/python 'mlx-optiq'
```

> **Before installing mlx-optiq, tell the user and get consent.** The package
> is published on PyPI without a public source repository, so the code cannot
> be audited before install. Its model-loading path enables
> `trust_remote_code` by default, which executes arbitrary Python shipped
> inside model repos — pass `trust_remote_code=False` (or the CLI equivalent)
> unless the model source is trusted, and prefer weights from
> `mlx-community` or `models.understudylabs.com`. Known issue: its
> Anthropic-compatible streaming endpoint can hang; use the OpenAI-compatible
> path for serving.

## QAT group-size conversion (the g32 fix)

The single most impactful parameter. Google's QAT checkpoints are trained
against block-32 quantization noise. MLX defaults to group_size=64, which
silently breaks the QAT hardening.

```bash
# Convert a QAT checkpoint to MLX 4-bit with correct group size
VENV=.understudy/venvs/mlx/bin

$VENV/python -m mlx_vlm convert \
  --hf-path <path-to-qat-unquantized-source> \
  --mlx-path <output-name> \
  -q --q-bits 4 --q-group-size 32
```

**Verify the group size:**
```bash
python3 -c "
import json
cfg = json.load(open('<output-name>/config.json'))
q = cfg.get('quantization', {})
print(f'group_size: {q.get(\"group_size\")}  bits: {q.get(\"bits\")}')
assert q.get('group_size') == 32, 'GROUP SIZE MISMATCH — QAT hardening broken'
"
```

## Stacked conversion (QAT + g32 + tool-heavy calibration)

The best-in-class method. Combines QAT hardening, matched group size, and
sensitivity-driven allocation with tool-call-weighted calibration.

```bash
VENV=.understudy/venvs/mlx/bin

$VENV/optiq convert <path-to-qat-unquantized-source> \
  --target-bpw 5.0 \
  --candidate-bits 4,8 \
  --group-size 32 \
  --calibration-mix <path-to-tool-heavy-calibration.jsonl> \
  -o <output-dir>
```

The artifact is in `<output-dir>/optiq_mixed/`. Symlink it for serving:
```bash
ln -sf <output-dir>/optiq_mixed ~/.understudy/models/<serving-name>
```

### Critical: use BPW 5.0, not 4.0

At BPW 4.0, the stacked method scores **0.049** (catastrophic) — too many
layers compressed to 4-bit destroys the tool-call circuits. At BPW 5.0
(matching OptiQ's published bit budget), it scores **0.398** (best in class).

| BPW | Tool acc | Errors | Verdict |
|---|---|---|---|
| 4.0 | 0.049 | ~90 | Broken — too aggressive |
| **5.0** | **0.398** | **12** | **Best in class** |

## Calibration data format

The calibration file is JSONL, one sample per line. Each sample has a `domain`
field and a `messages` field (chat format):

```jsonl
{"domain": "tool", "messages": [{"role": "system", "content": "You are a CRM assistant..."}, {"role": "user", "content": "Search for contacts named Amanda Foster"}, {"role": "assistant", "content": "", "tool_calls": [{"name": "api_search", "arguments": {"query": "Amanda Foster"}}]}]}
{"domain": "prose", "messages": [{"role": "user", "content": "Write a summary of..."}, {"role": "assistant", "content": "Here is a summary..."}]}
```

The `domain` field controls how OptiQ weights the sample. The tool-heavy mix
uses 58% tool-domain samples (real tool-call traces from CRM automation, API
workflows, and coding agents) and 42% non-tool (prose, reasoning, code).

### How to build tool-call calibration data

1. Collect real tool-call traces from your production agent harness or
   benchmark suite. Each trace should be a complete request → tool-call pair.
2. Format as JSONL with `domain: "tool"`.
3. Mix with general-domain samples (prose, reasoning, code) at ~40% of total.
4. Target 24+ samples total for stable sensitivity measurement.

The Understudy tool-heavy calibration was built from AutomationBench
next-tool-call traces — real CRM automation scenarios with concrete tool
schemas.

## Serving the compressed model

```bash
VENV=.understudy/venvs/mlx/bin

$VENV/optiq serve \
  --model <serving-name> \
  --no-auth \
  --chat-template-args '{"enable_thinking": false}' \
  --temp 1.0 --top-p 0.95 --top-k 64 \
  --host 127.0.0.1 --port 8094
```

**Decode parameters matter.** Gemma 4 requires `temperature: 1.0, top_p: 0.95,
top_k: 64` (from the model card). Greedy decoding (temperature: 0) is
off-spec and breaks structured output.

## Certification checklist

After converting and serving, verify:

1. **Generation:** Model responds to a simple prompt ("What is 2+2?")
2. **Tool calls:** Model emits a valid tool call when given a tool-using prompt
3. **OpenAI compatibility:** `/v1/chat/completions` returns standard format
4. **Logprobs:** `/v1/chat/completions` with `logprobs: true` returns top-k
5. **Scored eval:** Run the 103-row NTC board and record tool_name_accuracy

```bash
# Quick smoke test
curl -s http://127.0.0.1:8094/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<serving-name>","messages":[{"role":"user","content":"What is 2+2?"}],"max_tokens":30,"temperature":1.0}' \
  | python3 -m json.tool
```

## Full experimental evidence

### Pareto frontier (Gemma 4 E2B, 103-row NTC board)

| Method | Size (GB) | Tool acc | Arg key | Errors | tok/s | On Pareto? |
|---|---|---|---|---|---|---|
| Naive 4-bit | 3.3 | 0.340 | 0.252 | 3 | 22.3 | ✅ cheapest |
| QAT g64 (broken) | 3.3 | 0.369 | 0.328 | 19 | 27.6 | ❌ dominated |
| OptiQ default (17% tool) | 4.9 | 0.350 | 0.292 | 17 | 22.9 | ❌ dominated |
| QAT g32 (matched) | 3.6 | 0.379 | 0.337 | 8 | 23.5 | ✅ |
| **Stacked (QAT+g32+58% tool)** | **4.3** | **0.398** | **0.352** | **12** | **45.4** | ✅ |
| QAT BF16 | 9.5 | 0.379 | 0.348 | 7 | 22.3 | ❌ dominated |
| Vanilla BF16 | 9.5 | 0.408 | 0.364 | 8 | 23.2 | ✅ highest |

### Group-size effect across model sizes

| Model | QAT g64 (broken) | QAT g32 (fixed) | Δ |
|---|---|---|---|
| E2B | 0.369 (19 errors) | 0.379 (8 errors) | +1.0pp |
| E4B | 0.155 (64 errors) | 0.252 (37 errors) | +9.7pp |
| 26B | 0.126 (62 errors) | 0.146 (53 errors) | +2.0pp |

### Calibration effect (same base, same BPW, same group size)

| Calibration | Tool weight | Tool acc | Arg key | Errors |
|---|---|---|---|---|
| OptiQ default (6-domain) | 17% | 0.350 | 0.292 | 17 |
| Stacked (tool-heavy) | 58% | 0.398 | 0.352 | 12 |

113 of 276 weight tensors receive a different bit-width assignment between the
two calibration mixes.

### Error taxonomy (Gemma 4 E2B, 103 rows)

| Method | Correct | No tool | Parse fail | Wrong tool | Other |
|---|---|---|---|---|---|
| Vanilla BF16 | 40 | 17 | 5 | 38 | 3 |
| QAT BF16 | 39 | 8 | 3 | 49 | 4 |
| Stacked | 33 | 19 | 11 | 39 | 1 |
| QAT g32 | 29 | 35 | 7 | 31 | 1 |
| OptiQ default | 30 | 19 | 12 | 37 | 5 |
| QAT g64 | 30 | 18 | 17 | 36 | 2 |
| Naive 4-bit | 12 | 75 | 1 | 13 | 2 |

### Decode speed (Gemma 4 E2B)

| Method | tok/s (avg) | tok/s (p95) |
|---|---|---|
| Stacked | **45.4** | **81.6** |
| QAT g64 | 27.6 | 50.4 |
| QAT g32 | 23.5 | 42.7 |
| Vanilla BF16 | 23.2 | 35.3 |
| OptiQ default | 22.9 | 42.5 |
| QAT BF16 | 22.3 | 34.2 |
| Naive 4-bit | 22.3 | 42.4 |

The stacked method's 2× speed advantage comes from the mixed-precision
allocation: sensitive layers at 8-bit (fast decode) + robust layers at 4-bit
(fast decode), with the 4.3 GB footprint fitting entirely in Apple Silicon's
GPU fast cache.

### Serving-path confound

The serving runtime independently affects measured fidelity. OptiQ's pre-built
artifact scored 0.301 through `optiq serve` but 0.350 when the serving path was
leveled. Always serve all variants through the same runtime when comparing.

### Best method by model size

| Size | Best NTC | Best agent | Recommendation |
|---|---|---|---|
| E2B | Stacked (0.398) | QAT g32 (0.533) | Stacked for single-step, g32 for multi-turn |
| E4B | OptiQ (0.359) | OptiQ (0.556) | OptiQ pre-built or stacked (pending) |
| 12B | *(serving issue)* | OptiQ (0.578) | OptiQ |
| 26B MoE | naive/g32 tie (0.146) | OptiQ (0.576) | OptiQ for agent tasks |
| 31B | naive (0.049) | naive (0.516) | Naive 4-bit |

## Reproduction

All experiments are reproducible from:
- **Eval harness:** `understudy workload evaluate automationbench-next-tool-call`
- **Models:** `mlx-community` on HuggingFace or `models.understudylabs.com`
- **Hardware:** Apple M5 Max, 128 GB unified memory
- **Decode:** temperature 1.0, top_p 0.95, top_k 64, max_tokens 16384
