# Nemotron 3 on Tinker vs Fireworks — documented support (2026-08-01)

Supplier-support reference for NVIDIA Nemotron 3 open-weight models on **Tinker**
(Thinking Machines) and **Fireworks AI**, focused on supervised LoRA, tool/chat
templates, evaluation deployment, and whether the *same base model* can be compared
across both suppliers.

Compiled from official provider docs and catalogs on **2026-08-01**, then confirmed
against both providers' **live APIs** with read-only calls (see
[Phase-0 verification](#phase-0-verification-run-2026-08-01-read-only-no-spend)).
Tags: **[V]** verified against a primary source (linked in [Sources](#sources)) ·
**[L]** confirmed live against the provider API on 2026-08-01 · **[U]** unverified —
flagged inline. Prices and catalogs drift; re-verify before any spend. Nothing here
was launched, deployed, or billed — no training jobs and no deployments were created.

## Bottom line

- **One base model is comparable across both suppliers today: Nemotron 3 Nano
  30B-A3B BF16.** Both suppliers serve the *same* Hugging Face checkpoint
  (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`) and both offer managed **supervised
  LoRA** on it. [V]
- **Nano's chat template is identical across the comparison** [L]: Tinker's
  `nemotron3` renderers are token-exact against the model's HF chat template (44/44
  cookbook tests + an independent tool-calling round-trip), and Fireworks renders Nano
  with that same HF template (`useHfApplyChatTemplate: true`). Three-way parity.
- **Super 120B-A12B BF16 *is* supervised-LoRA tunable on Fireworks** — the live API
  says `supervisedLoraTunable: true`; the docs table that omits it is stale. [L] But
  Super sets `useHfApplyChatTemplate: false`, so Fireworks renders it with an internal
  renderer you cannot override — template parity with Tinker is **unproven**. [U]
- **Ultra 550B-A55B is not comparable for training**: Tinker offers LoRA on the BF16
  checkpoint; Fireworks reports `supervisedLoraTunable: false` (a LoRA *shape* exists
  but managed SFT is off). [L]
- **Adapters are almost certainly not portable Tinker → Fireworks** for this family
  (Mamba `in_proj`/`out_proj` targets are outside Fireworks' documented import
  allow-list). Plan on training once per supplier, not train-once-serve-both. [V/U]
- **No-spend recommendation:** the Phase-0 provider checks are **done** (below, all
  read-only); the only remaining pre-spend work is freezing the eval + grader. Then, if
  a pilot is authorized, run the **Tinker Nano arm first** — it is per-token with no GPU-hour floor, while the
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
| `nemotron-3-super-120b-a12b-bf16` | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` | **LoRA ✔** | ✖ | ✔ |
| `nvidia-nemotron-3-super-120b-a12b-fp8` | — | ✖ | ✖ | ✔ |
| `nvidia-nemotron-3-super-120b-a12b-nvfp4` | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | ✖ | ✖ | ✔ |
| `nemotron-3-ultra-bf16` | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16` | ✖ | ✖ | ✔ |
| `nemotron-3-ultra-nvfp4` | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4` | ✖ | **✔** (only serverless Nemotron) | ✔ |
| `nvidia-nemotron-3-nano-omni-30b-a3b` | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16` | ✖ | ✖ | ✔ |
| `nvidia-nemotron-nano-9b-v2` / `nvidia-nemotron-nano-12b-v2` / `nemotron-nano-v2-12b-vl` | gen-2 checkpoints | ✖ | ✖ | ✔ |

Training shapes from the live registry (catalog `generatedAt` 2026-07-31 21:02 UTC):

| Base model | Shape | Method | GPUs | Shape ctx | Managed SFT / DPO | Model train ctx |
|---|---|---|---|---:|---|---:|
| `nemotron-nano-3-30b-a3b` | `nemotron-nano-3-30b-a3b-262k-b200-lora` | LoRA | 2×B200 (1 node, TP2/EP2) | 262,144 | ✔ / ✔ | 131,072 |
| `nemotron-3-super-120b-a12b-bf16` | `nemotron-3-super-120b-a12b-bf16-128k-lora` | LoRA | 8×B200 (1 node, CP8/EP8) | 262,144 | ✔ / ✔ | 65,536 |
| `nemotron-3-super-120b-a12b-bf16` | `nemotron-3-super-120b-a12b-bf16` | Full-Param | 8×B200 | 262,144 | ✖ / ✖ | 65,536 |
| `nemotron-3-ultra-bf16` | `nemotron-3-ultra-550b-a55b-bf16-lora` | LoRA | 8×B300 × 2 nodes | 262,144 | ✖ / ✖ | 65,536 |
| `nemotron-3-ultra-bf16` | `nemotron-3-ultra-550b-a55b-bf16` | Full-Param | 32×B300 | 262,144 | ✖ / ✖ | 65,536 |

GPU layouts, `maxSupportedContextLength: 262144`, and `Validated: true` for the Nano
and Super LoRA shapes were read live from `firectl training-shape-version get`. [L]

No Nemotron model exposes managed **RFT/RL** (`rftLoraManaged: false`,
`rlLoraTunable: false`) and none is on the **serverless training** pool (private
preview: Qwen 3.5 9B, Qwen 3.6 27B, Kimi K3 only). [V]

**Documentation conflict — resolved [L]:** the Fireworks *Supported base models* doc
table lists only `nemotron-nano-3-30b-a3b` (and still lists `minimax-m2p5`, absent
from the live catalog), but the live API reports `supervisedLoraTunable: true` for
Super BF16 as well. The doc table is stale; trust the API. Note also that the
model-level `tunable: false` on every Nemotron entry refers to *full-parameter*
tunability — it is not a contradiction of `supervisedLoraTunable`.

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

**Fireworks** reports `supportsTools: true` for every Nemotron 3 entry and accepts
`tools`/`tool_calls` in SFT data, but rendering is not yours to choose: the base
model's registered renderer applies, and Training V2 rejects a custom Jinja template.
The decisive live field is **`useHfApplyChatTemplate`**: [L]

| Fireworks model | `useHfApplyChatTemplate` | Consequence |
|---|---|---|
| `nemotron-nano-3-30b-a3b` | **true** | renders with the model's own HF `chat_template.jinja` — the same template Tinker's renderer is token-exact against ⇒ **template parity holds** |
| `nemotron-3-super-120b-a12b-bf16` | **false** | internal Fireworks renderer, not overridable ⇒ parity **unproven** [U] |
| `nemotron-3-ultra-bf16` / quantized variants | false | same caveat (moot — no managed SFT) |

So Nano is the only variant where "same prompt bytes on both suppliers" is currently
demonstrable. Thinking mode is still yours to pin explicitly on the Tinker side
(reasoning off is the easiest to hold equal); Fireworks does not document which mode
its pipeline selects. [U]

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

**Yes for Nano 30B-A3B BF16 — same HF checkpoint, managed supervised LoRA on both, and
verified identical chat-template rendering.** Super BF16 is trainable on both, but its
Fireworks rendering is opaque, so an A/B there carries an unmeasured template variable.
No for Ultra (no Fireworks managed SFT; the only serverless Ultra is the **NVFP4**
quantization, a different artifact from the BF16 both trainers use).

**Residual blocker — checkpoint revision [U]:** neither provider publishes the HF
*commit* it pinned. Fireworks exposes only `huggingFaceUrl` +
`snapshotType: FULL_SNAPSHOT` (Nano's entry last updated 2026-07-22), and Tinker
exposes only the repo-shaped model ID. "Same repo" is provable; "same revision" is an
assumption. The local checks here pinned
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16@2d59de1cbd51c0adf384eb906b766d1aee0e0517`;
ask both vendors to confirm the revision if the comparison has to be defensible.

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
adapter upload before designing around it (an upload creates a resource, so it was
**not** attempted during no-spend verification). The proven external-serving path for a
Tinker Nemotron adapter is **vLLM** (verified in the cookbook for Nano TP=2 / Super
TP=4).

## Phase-0 verification run 2026-08-01 (read-only, no spend)

Every check below is a metadata read or a local CPU computation. No training job, no
deployment, no paid inference.

| Check | Command / method | Result |
|---|---|---|
| Tinker live model list | `tinker.ServiceClient().get_server_capabilities()` | 28 models; **exactly 5** Nemotron IDs, matching the table above (no Nano 256K variant) |
| Tinker prices/IDs | `GET tinker/models.json` | matches the price table above (50%-off rates live) |
| Fireworks model metadata | `firectl get model -a fireworks <id> --api-key …` and `GET /v1/accounts/fireworks/models/<id>` | Nano: `supervisedLoraTunable: true`, `useTrainingV2: true`, `useHfApplyChatTemplate: true`, `supportsTools: true`, `trainingContextLength: 131072`, `state: READY`. Super BF16: same but `useHfApplyChatTemplate: false`, `trainingContextLength: 65536`. Ultra BF16: `supervisedLoraTunable: false` |
| Fireworks training shapes | `firectl training-shape-version list` / `get` | Nano LoRA 2×B200 TP2/EP2, Super LoRA 8×B200 CP8/EP8, both `Validated: true`, `Max Supported Context Length: 262144`; Ultra LoRA shape exists (8×B300 × 2 nodes) but its model has managed SFT off |
| Tinker renderer ↔ HF template | `pytest tinker_cookbook/renderers/nemotron3_test.py` (real tokenizer, CPU) | **44/44 passed** |
| Tool-calling round-trip | independent script: system + tools + assistant `tool_call` + `tool` response + final assistant, rendered by `get_renderer("nemotron3"\|"nemotron3_disable_thinking")` vs `tokenizer.apply_chat_template(…, tools=…)` | **token-identical** (399 tokens) for both modes, supervised and generation prompts; `LAST_ASSISTANT_TURN` masks 54 trained tokens |

Notes: `firectl training-shape list` returns `PermissionDenied` on a normal account
(use `training-shape-version list`), and `deploymentShapes` reads are also denied — so
the exact GPU count of the *serving* deployment for a fine-tuned Nano could not be
confirmed; the linked deployment shape is `nemotron-nano-3-30b-a3b-grouped`. [U]

## No-spend recommendation

**Phase 0 — done (see the verification run above).** What is left before spend is not a
provider probe: freeze the eval set + grader first (outcome-first, not tool-name
accuracy — see `docs/benchmark-rigor.md`), and size the dataset so LoRA params ≥
completion tokens.

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
| Live Fireworks model metadata + training shape versions | `firectl` 1.7.33 / `api.fireworks.ai/v1` (read-only) |
| Live Tinker model list | `tinker` 0.24.0 `get_server_capabilities()` |
| Renderer ↔ HF template token parity | `pytest tinker_cookbook/renderers/nemotron3_test.py` + local round-trip script |
