# Nemotron 3 on Tinker vs Fireworks — documented support (2026-08-01)

Supplier-support reference for NVIDIA Nemotron 3 open-weight models on **Tinker**
(Thinking Machines) and **Fireworks AI**, focused on supervised LoRA, tool/chat
templates, evaluation deployment, and whether the *same base model* can be compared
across both suppliers.

Compiled from official provider docs and catalogs on **2026-08-01**. Tags: **[V]**
verified against a primary source (linked in [Sources](#sources)) · **[U]** unverified
or documentation conflicts — flagged inline. Prices and catalogs drift; re-verify
before any spend. Nothing here was launched or billed — no jobs were run.

## Bottom line

- **One base model is comparable across both suppliers today: Nemotron 3 Nano
  30B-A3B BF16.** Both suppliers serve the *same* Hugging Face checkpoint
  (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`) and both offer managed **supervised
  LoRA** on it. [V]
- **Super 120B-A12B BF16 is probably comparable too, but the Fireworks docs conflict
  with the Fireworks live shape catalog** — verify with `firectl` before planning
  it. [U]
- **Ultra 550B-A55B is not comparable for training**: Tinker offers LoRA on the BF16
  checkpoint; Fireworks publishes no managed-SFT shape for it. [V]
- **Adapters are almost certainly not portable Tinker → Fireworks** for this family
  (Mamba `in_proj`/`out_proj` targets are outside Fireworks' documented import
  allow-list). Plan on training once per supplier, not train-once-serve-both. [V/U]
- **No-spend recommendation:** do the Phase-0 verification below (catalog probes +
  local template rendering + a frozen eval), then, if a pilot is authorized, run the
  **Tinker Nano arm first** — it is per-token with no GPU-hour floor, while the
  Fireworks arm needs a dedicated 2×B200 deployment ($20/hr [V]) merely to evaluate.

## Exact model IDs

### Tinker — `create_lora_training_client(base_model=...)` / `create_sampling_client(...)`

| Model | Tinker ID | Ctx | Prefill / 1M | Sample / 1M | Train / 1M |
|---|---|---|---:|---:|---:|
| Nemotron-3-Nano-30B-A3B | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | 64K | $0.195 ($0.039 cached) | $0.495 | **$0.44** |
| Nemotron-3-Super-120B-A12B | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` | 64K | $0.57 ($0.114) | $1.44 | $1.276 |
| Nemotron-3-Super-120B-A12B (256K) | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16:peft:262144` | 256K | $0.76 ($0.152) | $1.92 | $2.32 |
| Nemotron-3-Ultra-550B-A55B | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16` | 64K | $2.49 ($0.498) | $6.225 | $5.478 |
| Nemotron-3-Ultra-550B-A55B (256K) | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16:peft:262144` | 256K | $3.32 ($0.664) | $8.30 | $9.96 |

Prices are the **current limited-time 50%-off** rates per 1M tokens; list is double.
Checkpoint storage $0.10/GB/month. There is **no 256K variant for Nano** — 64K is the
cap. [V]

### Fireworks — `accounts/fireworks/models/<id>`

| Model path (`accounts/fireworks/models/…`) | HF checkpoint | Managed SFT | Serverless inference | Function calling |
|---|---|---|---|---|
| `nemotron-nano-3-30b-a3b` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | **LoRA ✔** | ✖ | ✔ |
| `nemotron-3-super-120b-a12b-bf16` | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` | **LoRA ✔** [U] | ✖ | ✔ |
| `nvidia-nemotron-3-super-120b-a12b-fp8` | — | ✖ | ✖ | ✔ |
| `nvidia-nemotron-3-super-120b-a12b-nvfp4` | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | ✖ | ✖ | ✔ |
| `nemotron-3-ultra-bf16` | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16` | ✖ | ✖ | ✔ |
| `nemotron-3-ultra-nvfp4` | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4` | ✖ | **✔** (only serverless Nemotron) | ✔ |
| `nvidia-nemotron-3-nano-omni-30b-a3b` | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16` | ✖ | ✖ | ✔ |
| `nvidia-nemotron-nano-9b-v2` / `nvidia-nemotron-nano-12b-v2` / `nemotron-nano-v2-12b-vl` | gen-2 checkpoints | ✖ | ✖ | ✔ |

Training shapes from the live registry (catalog `generatedAt` 2026-07-31 21:02 UTC):

| Base model | Shape | Method | GPUs | Shape ctx | Managed SFT / DPO | Model train ctx |
|---|---|---|---|---:|---|---:|
| `nemotron-nano-3-30b-a3b` | `nemotron-nano-3-30b-a3b-262k-b200-lora` | LoRA | 2×B200 | 262,144 | ✔ / ✔ | 131,072 |
| `nemotron-3-super-120b-a12b-bf16` | `nemotron-3-super-120b-a12b-bf16-128k-lora` | LoRA | 8×B200 | 262,144 | ✔ / ✔ | 65,536 |
| `nemotron-3-super-120b-a12b-bf16` | `nemotron-3-super-120b-a12b-bf16` | Full-Param | 8×B200 | 262,144 | ✖ / ✖ | 65,536 |
| `nemotron-3-ultra-bf16` | `nemotron-3-ultra-550b-a55b-bf16-lora` | LoRA | 16×B300 | 262,144 | ✖ / ✖ | 65,536 |
| `nemotron-3-ultra-bf16` | `nemotron-3-ultra-550b-a55b-bf16` | Full-Param | 32×B300 | 262,144 | ✖ / ✖ | 65,536 |

No Nemotron model exposes managed **RFT/RL** (`rftLoraManaged: false`,
`rlLoraTunable: false`) and none is on the **serverless training** pool (private
preview: Qwen 3.5 9B, Qwen 3.6 27B, Kimi K3 only). [V]

**Documentation conflict [U]:** the Fireworks *Supported base models* table lists only
`nemotron-nano-3-30b-a3b` (and still lists `minimax-m2p5`, which is absent from the
live catalog), while the live shape catalog shows `nemotron-3-super-120b-a12b-bf16`
with `managedSft: true` on its LoRA shape. The table appears stale. Resolve with
`firectl model get -a fireworks nemotron-3-super-120b-a12b-bf16` (look for `Tunable`)
and the shape list before planning a Super run.

## Supervised LoRA

| | Tinker | Fireworks |
|---|---|---|
| Method | LoRA only (no full fine-tune, by design) | LoRA and full-param, per shape; Nemotron: LoRA only for managed SFT |
| Rank | default **32**, any integer; cookbook rule: LoRA params ≥ completion tokens | **power of 2, ≤ 32**, default 8 |
| LR | not calibrated in `get_lr` for Nemotron-3 → cookbook suggests **~5e-4** LoRA | platform default (not documented per-model) [U] |
| Data format | your own dataset builder → renderer → `build_supervised_example` | OpenAI-chat JSONL (`tools`, `tool_calls`, `reasoning_content`, per-message `weight`) |
| Rendering control | you choose the renderer (see below) | base model's **registered renderer**; Training V2 **rejects** a custom `jinja_template` |
| Price | per-token: **$0.44/1M** train tokens (Nano, current discount) | per training token: **$3.00/1M** (16.1–80B tier → Nano) · **$6.00/1M** (80–300B → Super) |
| Ctx cap for training | 64K (Nano/Super base IDs; Super has a 256K `:peft:` ID) | 131,072 (Nano) / 65,536 (Super) model train ctx |

At the same 5M-training-token budget the Nano arm is ≈**$2.20 on Tinker** vs
≈**$15 on Fireworks** in training tokens alone (estimated, before any eval/serving) —
and Fireworks additionally requires a dedicated deployment to use the result.

## Tool / chat templates

**Tinker** ships a first-class Nemotron-3 renderer family, token-exact against the HF
chat template (cookbook has generation + supervised, single- and multi-turn tests): [V]

| Renderer | Mode |
|---|---|
| `nemotron3` | reasoning on (Nano/Super) |
| `nemotron3_low_thinking` | `low_effort=True` — **Super only** |
| `nemotron3_disable_thinking` | reasoning off |
| `nemotron3_ultra` / `nemotron3_ultra_medium_thinking` / `nemotron3_ultra_disable_thinking` | Ultra variants (`medium_effort=True` for the middle one) |

Nemotron-3 differs from the Qwen3.5 format it subclasses: tool declarations are
**XML inside `<tools>…</tools>`** (not JSON-per-line), the system prompt comes
**before** the tools block, `<think></think>` is prepended to *all* assistant messages
lacking thinking, and Ultra uses no separator newline after `</think>`. Tool calls are
emitted as `<tool_call>` blocks and parsed back into `ToolCall` objects;
`TrainOnWhat.LAST_ASSISTANT_TURN` trains on a full turn including tool calls and
responses.

**Fireworks** reports `Function Calling: Supported` for every Nemotron 3 entry and
accepts `tools`/`tool_calls` in SFT data, but rendering is not yours to choose: the
base model's registered renderer applies, and Training V2 rejects a custom Jinja
template. Practical consequence for a cross-supplier comparison: **thinking-mode
handling is a supplier-controlled variable on Fireworks and a caller-controlled one on
Tinker** — pin the mode explicitly (reasoning off is the easiest to hold equal) and
diff a rendered sample from each side before trusting an A/B. [V/U — Fireworks does not
document which Nemotron thinking mode its renderer selects]

## Evaluation and deployment

| | Tinker | Fireworks |
|---|---|---|
| Inference on the trained model | `SamplingClient` on the checkpoint, **per token** — no deployment, no GPU-hour floor | fine-tuned models serve on **on-demand (dedicated) deployments only** |
| Serverless | beta, **Inkling / Inkling-Small only** — not Nemotron | Nemotron: **only `nemotron-3-ultra-nvfp4`** (base model, not tunable) |
| GPU-hour cost to evaluate | none (per-token sampling) | B200 **$10/hr**, B300 **$12/hr**, per-GPU-second; Nano's LoRA shape is 2×B200 |
| Built-in eval harness | cookbook `run_benchmark(s)` incl. **`bfcl`** (function calling), `tau2_bench`, `swe_bench`, `terminal_bench`, plus in-loop `BenchmarkEvaluator` | none bundled; bring your own harness against the deployment |
| Weight export | `download()`, `build_hf_model()` (merge), `build_lora_adapter()` (PEFT). Nemotron-3 Nano + Super: merge ✔ adapter ✔ (bf16, `backbone.*`→`model.*` remap); vLLM 0.18 serving verified Nano TP=2, Super TP=4 | fine-tuned weights stay on-platform |

Tinker's Ultra checkpoint is absent from the cookbook weights support matrix (only Nano
and Super are listed) — assume export is unproven for Ultra. [U]

## Can the same base model be compared across both suppliers?

**Yes for Nano 30B-A3B BF16 — same HF checkpoint, managed supervised LoRA on both.**
Probably yes for Super BF16 pending the `firectl` check. No for Ultra (no Fireworks
managed SFT; the only serverless Ultra is the **NVFP4** quantization, a different
artifact from the BF16 both trainers use).

Variables to hold equal for an honest A/B — none of these are equal by default:

1. **LoRA rank/alpha** — Fireworks caps at 32 and requires a power of two; use r=32,
   alpha=32 on both.
2. **Sequence length** — Tinker Nano is capped at 64K; cap the Fireworks job to the
   same `max_seq_len` rather than its 131K.
3. **Learning rate / schedule** — Tinker's Nemotron LR is uncalibrated (~5e-4
   suggested); Fireworks' default is undocumented. Set it explicitly on both.
4. **Thinking mode and rendering** — pick one mode, and diff rendered samples.
5. **Token accounting** — Fireworks bills training tokens with multi-turn/reasoning
   unrolling; Tinker bills prefill/sample/train separately. Cost comparisons must be
   normalized, not read off the price tables.
6. **One frozen eval, one grader, one decode config**, run against both arms.

### Adapter portability (train once, serve on the other supplier?)

Likely **not available** for this family:

- Fireworks' imported-LoRA allow-list is `q_proj, k_proj, v_proj, o_proj,
  up_proj|w1, down_proj|w2, gate_proj|w3, block_sparse_moe.gate, lm_head`, with rank
  4–64 and no embedding modules. [V]
- Tinker's Nemotron adapter conversion emits Mamba-mixer targets — `in_proj` (a
  **fusion of `gate_proj`+`x_proj` at doubled rank**) and `out_proj` — which are not on
  that list, and the doubled rank can exceed 64. [V]
- Uploading a **merged** full model instead runs into the custom-model architecture
  list, which does not mention NemotronH. [U]

So treat "train on Tinker, serve on Fireworks" as unproven; validate with a tiny
adapter upload before designing around it. The proven external-serving path for a
Tinker Nemotron adapter is **vLLM** (verified in the cookbook for Nano TP=2 / Super
TP=4).

## No-spend recommendation

**Phase 0 — verification, zero spend (do this before asking for budget):**

1. Pull the machine-readable Tinker catalog: `https://tinker-docs.thinkingmachines.ai/tinker/models.json`
   (and `serverless.json`) — confirms IDs and current prices without an API call.
2. `service_client.get_server_capabilities()` for the authoritative live Tinker model
   list (metadata call, no tokens billed).
3. `firectl model get -a fireworks nemotron-nano-3-30b-a3b` and
   `… nemotron-3-super-120b-a12b-bf16` — read `Tunable` / `Supports Lora`, and list
   training shapes. Resolves the Super conflict above.
4. Locally (CPU, tokenizer/config download only) render one tool-calling sample through
   the HF `apply_chat_template` and through `renderers.get_renderer("nemotron3_disable_thinking", …)`
   and diff the token IDs. That is the cheapest way to catch a template mismatch that
   would otherwise silently poison the comparison.
5. Freeze the eval set + grader first (outcome-first, not tool-name accuracy — see
   `docs/benchmark-rigor.md`), and size the dataset so LoRA params ≥ completion tokens.

**Phase 1 — if and when a pilot is authorized:** run **Nano BF16 on Tinker only**.
Per-token pricing with no deployment means a small SFT + eval is single-digit dollars,
and a negative result costs nothing further. Add the Fireworks arm **only** if the
Tinker arm clears the promotion gate *and* the question is explicitly "which supplier",
because the Fireworks arm carries ~7× the per-token training price plus a dedicated
2×B200 deployment for evaluation.

**Do not** plan a Fireworks Ultra or Nemotron RFT/RL path — neither is offered. If the
target workload is native tool-calling, note this repo's own measured caution: Nano
30B-A3B scored 2/10 on the AutomationBench discovery toolset at native precision
(`docs/open-model-spotlight.md`), so gate on a full-sequence outcome metric and
consider Super, or code-orchestration instead of native tool schemas.

## Sources

All fetched 2026-08-01.

| Claim | Source |
|---|---|
| Tinker model IDs, contexts, prices, serverless beta scope | https://tinker-docs.thinkingmachines.ai/tinker/models/ · models.json |
| Tinker is LoRA-only; weight download | https://tinker-docs.thinkingmachines.ai/tinker/ |
| LoRA rank/LR guidance | https://tinker-docs.thinkingmachines.ai/tinker/lora-primer/ |
| Nemotron renderers, XML tools, thinking modes | `tinker_cookbook/renderers/nemotron3.py`, `renderers/__init__.py` |
| Merge/adapter support, `backbone.*` remap, vLLM verification | `tinker_cookbook/weights/README.md` |
| Eval harness and benchmarks (incl. `bfcl`) | https://tinker-docs.thinkingmachines.ai/cookbook/eval/ |
| Fireworks Nemotron model pages (FT/serverless/function-calling/HF links) | https://fireworks.ai/models/fireworks/{nemotron-nano-3-30b-a3b, nemotron-3-super-120b-a12b-bf16, nemotron-3-ultra-bf16, nemotron-3-ultra-nvfp4, …} |
| Live training-shape catalog (GPUs, ctx, managed SFT/DPO flags) | https://docs.fireworks.ai/fine-tuning/models |
| Supported-base-model table (conflicting) | https://docs.fireworks.ai/fine-tuning/managed-finetuning-intro |
| SFT data format, `tools`, `reasoning_content`, `jinja_template` rejection, LoRA rank ≤32 | https://docs.fireworks.ai/fine-tuning/fine-tuning-models |
| Serverless training pool models | https://docs.fireworks.ai/fine-tuning/training-api/serverless |
| Imported LoRA adapter requirements; custom architectures | https://docs.fireworks.ai/models/uploading-custom-models |
| GPU-hour and training-token pricing | https://fireworks.ai/pricing |
