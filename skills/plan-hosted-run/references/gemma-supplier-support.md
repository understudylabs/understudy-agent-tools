# Gemma on Tinker vs Fireworks — supplier support (reference)

Where the recent open-weight **Gemma** models can actually be supervised-fine-tuned,
served for evaluation, and compared across suppliers. Compiled **2026-08-01**. Tags:
**[V]** verified from a primary/official source (provider docs, provider catalog JSON,
or a read-only provider API call) · **[U]** unverified or conflicting — flagged.
**Catalogs and prices drift; re-verify before any spend.**

Reference data for [`SKILL.md`](../SKILL.md); provider-wide routing detail stays in
[`providers.md`](providers.md). Nothing here was launched — every check below is a
read-only catalog lookup.

## Bottom line

| Question | Answer |
|---|---|
| Recent Gemma trainable on **Fireworks**? | Yes — `gemma-4-26b-a4b-it` and `gemma-4-31b-it`, managed **LoRA** SFT/DPO only [V] |
| Recent Gemma trainable on **Tinker**? | **No — Gemma appears nowhere in Tinker's live catalog or docs** [V] |
| Same Gemma base comparable across both? | **Not possible today.** Cross-supplier A/B needs a non-Gemma base [V] |
| Cheapest honest next step | **$0** — read-only catalog checks + local template/token rendering (see [No-spend recommendation](#no-spend-recommendation)) |

## Gemma 4 family (context)

Released **2026-04-02**, **Apache 2.0**, 256K context, image input, native function
calling, configurable thinking. Sizes: **E2B, E4B, 12B (unified), 26B-A4B (MoE, 3.8B
active), 31B (dense)**; BF16 31B ≈ 69.9 GB, i.e. one 80 GB GPU [V].
Hugging Face repos (`google/gemma-4-31B-it`, `google/gemma-4-26B-A4B-it`) are
**public and ungated** — weights, tokenizer, and `chat_template.jinja` download without
a license click, which is what makes the no-spend path below possible [V].

Sources: https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/ ·
https://ai.google.dev/gemma/docs/core · https://huggingface.co/google/gemma-4-31B-it

## Tinker — no Gemma, at any size

Four independent checks, all on 2026-08-01, all negative:

| Check | Result |
|---|---|
| Live `ServiceClient.get_server_capabilities()` (read-only, free) | 28 models, **0 Gemma** [V] |
| Docs machine-readable catalog `tinker/models.json` | 24 rows, **0 Gemma** [V] |
| Full docs search index (1,428 entries) | **0 occurrences of "gemma"** [V] |
| `tinker/model-deprecations/` (retired models) | **no Gemma ever listed** → never offered, not merely retired [V] |
| `tinker-cookbook/tinker_cookbook/renderers/` | renderers exist for qwen3, qwen3_5, gpt_oss, kimi_k2*, deepseek_v3, llama3, nemotron3, tml_v0 — **no gemma renderer** [V] |

Tinker's live families are Inkling (first-party), Qwen3/3.5/3.6, GPT-OSS, Kimi-K2.6,
Nemotron-3, DeepSeek-V3.1. Tinker trains **LoRA only** (no full fine-tuning) and bills
per token (prefill / sample / train) plus $0.10/GB/month checkpoint storage; serverless
inference is beta and **Inkling-only** [V].

A Gemma run on Tinker would require Thinking Machines to add the base model — a custom
renderer alone is not enough, since Tinker only trains models it hosts. Treat "Gemma on
Tinker" as unavailable, not as a configuration problem.

Sources: https://tinker-docs.thinkingmachines.ai/tinker/models/ ·
https://tinker-docs.thinkingmachines.ai/tinker/models.json ·
https://tinker-docs.thinkingmachines.ai/tinker/model-deprecations/ ·
https://tinker-docs.thinkingmachines.ai/tinker/lora-primer/ ·
https://github.com/thinking-machines-lab/tinker-cookbook

## Fireworks — exact Gemma model IDs

Fireworks hosts 15 Gemma-family models; **only two are tunable**, both Gemma 4 [V]
(read-only `GET /v1/accounts/fireworks/models`, 2026-08-01):

| Model path | SFT LoRA | RL LoRA | Full-param | Tools | Serverless | Ctx | Train ctx |
|---|---|---|---|---|---|---|---|
| `accounts/fireworks/models/gemma-4-31b-it` | **yes** | yes | no (managed) | yes | **no** | 262,144 | 131,072 |
| `accounts/fireworks/models/gemma-4-26b-a4b-it` | **yes** | yes | no (managed) | yes | **no** | 262,144 | 131,072 |
| `gemma-4-31b-it-nvfp4` (quantized, inference) | no | no | no | yes | no | 262,144 | — |
| `gemma-4-e4b` | no | no | no | no | no | 131,072 | — |
| `gemma-3-27b-it`, `gemma-3-12b-it`, `gemma-3-4b-it`, `gemma-3-1b-it` | no | no | `gemma-3-27b-it` only (legacy `tunable: true`) | no | no | 131,072 | — |
| `gemma2-9b-it`, `gemma-7b(-it)`, `gemma-2b-it`, `codegemma-2b`, `codegemma-7b` | no | no | no | no | no | 8,192 | — |
| `medgemma-27b` | no | no | no | no | no | — | state `UPLOADING` [U] |

Managed training shapes for the two Gemma 4 models (docs training-shape registry,
generated 2026-07-31) [V]:

| Shape | Method | Managed SFT | Managed DPO | GPUs (train) | Shape ctx |
|---|---|---|---|---|---|
| `gemma-4-31b-256k-b200-lora` | LoRA | yes | yes | 4 × B200 | 262,144 |
| `gemma-4-31b-256k-b200` | Full-Param | **no** | **no** | 4 × B200 | 262,144 |
| `gemma-4-26b-a4b-256k-b200-lora` | LoRA | yes | yes | 4 × B200 | 262,144 |
| `gemma-4-26b-a4b-256k-b200` | Full-Param | **no** | **no** | 4 × B200 | 262,144 |

Managed **RFT is not available** for either Gemma 4 model (`rftLoraManaged: false`,
`rlTunable: false`), even though `rlLoraTunable: true` marks them eligible for RL LoRA
through the Training API surfaces [V]. Gemma is also **absent from the Serverless
Training API** catalog (Qwen 3.5 9B, Qwen 3.6 27B, Kimi K3 only) [V] — so the
Tinker-style "no provisioning, per-token training" surface does not cover Gemma.

### Supervised LoRA on Fireworks — what the docs commit to

- Dataset format: **OpenAI chat-completions JSONL** (`messages`, optional `system`
  first, per-message `weight`, sample-level `weight`, `tools` array for function
  calling, `reasoning_content` for thinking traces). 3 to 3M examples [V].
- Train context is **131,072**, not the 262,144 serving context — long-context traces
  get split or truncated [V].
- Price: LoRA SFT is billed per 1M training tokens by parameter tier. Both Gemma 4
  models land in **16.1B–80B → $3.00 / 1M LoRA SFT** ($6.00 LoRA DPO) [V].
  26B-A4B is billed on *total* (26B), not active (3.8B), parameters [V].
- Thinking-trace SFT is documented for "the subset of models that supports thinking
  (e.g. DeepSeek R1, GPT OSS, Qwen3 thinking)" — **Gemma 4 is not named**, despite
  having a thinking mode [U].

Sources: https://docs.fireworks.ai/fine-tuning/models ·
https://docs.fireworks.ai/fine-tuning/managed-finetuning-intro ·
https://docs.fireworks.ai/fine-tuning/fine-tuning-models · https://fireworks.ai/pricing

## Chat and tool templates — the real risk

Gemma 4 ships a **canonical, non-HF-generic chat template**
(`chat_template.jinja`, "Published 2026-07-09 … Fixed tool-calling loops, turn closures,
and thinking content-ordering") with a bespoke wire format [V]:

- turns as `<|turn>system` / role turns, not `<|im_start|>`;
- tool declarations in a custom DSL (`name:{description:<|"|>…<|"|>,type:STRING,…}`),
  **not** JSON schema verbatim;
- tool calls as `<|tool_call>call:fn{arg:value}<tool_call|>`, results as
  `<|tool_response>`;
- reasoning rendered to a `<|channel>thought … <channel|>` channel gated by
  `enable_thinking` / `preserve_thinking`, with **prior-turn thoughts stripped** from
  history (Google states thoughts from earlier model turns must not be replayed).

Fireworks reports `useHfApplyChatTemplate: false` for both Gemma 4 models — it renders
with its **own internal `gemma4` renderer** rather than the published Jinja template
[V]. The two Qwen 3.5/3.6 entries behave the same way, while `qwen3-8b` and
`nemotron-nano-3-30b-a3b` are `true`, so this is per-model, not global [V].
**Fireworks publishes no spec of what its Gemma renderer emits for tool declarations,
tool results, or the thought channel [U].** The only documented way to see the exact
rendered tokens and loss mask is the **Render Samples** JSONL on a finished SFT job —
i.e. it costs a training job to inspect [V].

Practical consequence: for tool-calling workloads, treat template fidelity as an
explicit risk to retire before spending, not an assumption. A LoRA trained against a
renderer that differs from the template used at eval time will look like a bad model.

## Evaluation deployment

| | Fireworks (Gemma 4) | Tinker (any hosted base) |
|---|---|---|
| Serve a fine-tune | **On-demand dedicated only** — "Fine-tuned LoRA models … can **only** be deployed to on-demand (dedicated) deployments. Serverless deployment is not supported for LoRA models." [V] | Sampling client against saved sampler weights; per-token billing, no deployment [V] |
| Base-model eval | No serverless for any Gemma (`serverlessModes: []`) — dedicated deployment too [V] | Per-token sampling; serverless inference beta is Inkling-only [V] |
| Billing unit | GPU-hour: H100 $7.00 · H200 $7.00 · **B200 $10.00** · B300 $12.00, per GPU-second, autoscale-to-zero [V] | prefill / sample / train per 1M tokens + $0.10/GB/month checkpoints [V] |
| Serving modes | live-merge (1 LoRA per deployment, base-model speed) or multi-LoRA (many adapters, lower throughput) [V] | n/a |

Deployment GPU count for **inference** on Gemma 4 is **not documented**; the 4 × B200
figure above is the *training* shape. `worldSize: 1` in the model record and Google's
"BF16 fits on a single 80 GB H100" both suggest single-GPU serving is possible, but this
is inference **[U]** — confirm with `firectl` before assuming $10/hr rather than $40/hr.

So the Gemma eval loop on Fireworks carries a **GPU-hour floor that Tinker-style
per-token evaluation does not**: an idle-but-up deployment bills whether or not you are
sampling. Size eval batches to run against a short-lived deployment, and scale to zero.

Sources: https://docs.fireworks.ai/fine-tuning/deploying-loras · https://fireworks.ai/pricing

## Cross-supplier comparability

Gemma cannot be compared across these two suppliers — Tinker does not host it. If the
goal is "same base, two suppliers, one holdout", pick from the bases both catalogs
carry (2026-08-01) [V]:

| Base | Tinker ID | Fireworks ID |
|---|---|---|
| Qwen3-8B | `Qwen/Qwen3-8B` | `qwen3-8b` |
| Qwen3.5-9B | `Qwen/Qwen3.5-9B` | `qwen3p5-9b` |
| Qwen3.5-397B-A17B | `Qwen/Qwen3.5-397B-A17B` | `qwen3p5-397b-a17b` |
| Qwen3.6-27B | `Qwen/Qwen3.6-27B` | `qwen3p6-27b` |
| Qwen3.6-35B-A3B | `Qwen/Qwen3.6-35B-A3B` | `qwen3p6-35b-a3b` |
| Kimi-K2.6 | `moonshotai/Kimi-K2.6` | `kimi-k2p6` |
| Nemotron-3-Super-120B-A12B | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` | `nemotron-3-super-120b-a12b-bf16` |
| Nemotron-3-Nano-30B-A3B | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | `nemotron-nano-3-30b-a3b` |

Cleanest apples-to-apples surface: **Qwen 3.5 9B** or **Qwen 3.6 27B**, where Fireworks'
Serverless Training API publishes *identical* per-token rates to Tinker's
(9B: $0.66 prefill / $1.995 sample / $1.463 train; 27B: $1.86 / $5.595 / $4.103), so a
comparison isolates trainer and renderer behaviour rather than billing model [V].
Even then, both suppliers apply their own renderer to the same weights — hold the
rendered prompt constant (or diff rendered tokens) before attributing a quality delta to
the trainer.

If the requirement is specifically Gemma 4, the second supplier has to be someone other
than Tinker (own GPUs on the Apache-2.0 weights, or another host — see
[`providers.md`](providers.md)).

## Known conflicts and uncertainty

| Item | Conflict | Stance |
|---|---|---|
| `tunable` flag | Live API returns `tunable: false` for both Gemma 4 models while `supervisedLoraTunable: true`; docs tell users to confirm `Tunable: true` via `firectl model get` | The legacy `tunable` flag tracks the old full-param path; LoRA SFT eligibility is `supervisedLoraTunable` + a `-lora` shape. Do not read `tunable: false` as "cannot train" [U on the doc wording] |
| Supported-base tables | The managed-FT intro table and the training-shape registry disagree elsewhere (e.g. `llama-v3p3-70b-instruct`, `minimax-m2p5` vs `minimax-m3`) | Trust `/fine-tuning/models` (registry, dated) over prose tables |
| Serverless flags | Registry marks `qwen3p5-9b` / `qwen3p6-27b` / `kimi-k3` `hasServerless: true`; live model records return `supportsServerless: false` | Unresolved [U]; irrelevant for Gemma, where both say no |
| Tinker live vs docs | Live catalog still serves `meta-llama/Llama-3.2-3B`, `Qwen/Qwen3-30B-A3B`, `Qwen3-235B-A22B-Instruct-2507`, which docs list as retired 2026-06-12 | Query capabilities live before planning; docs lag [U] |
| Gemma thinking-trace SFT | Not named in the thinking-capable list | Assume unsupported until a render sample proves otherwise [U] |
| Inference GPU count for Gemma 4 | Undocumented | Confirm via `firectl` before quoting eval cost [U] |

## No-spend recommendation

**Do not launch a Gemma job on either supplier yet.** Fireworks is the only viable
supplier, and its two unknowns — renderer fidelity for tool traces and the eval
deployment's GPU footprint — are both cheaper to retire before a job than after one.
Every step below is free:

1. **Re-verify the catalogs at plan time** (read-only, no spend):
   - `curl -H "Authorization: Bearer $FIREWORKS_API_KEY" https://api.fireworks.ai/v1/accounts/fireworks/models/gemma-4-31b-it`
     → check `supervisedLoraTunable`, `supportsTools`, `supportsServerless`,
     `trainingContextLength`, `useHfApplyChatTemplate`.
   - `firectl list deployment-shapes` / `firectl model get -a fireworks gemma-4-31b-it`
     → resolve the **inference** GPU count, the one number that sets the eval floor.
   - Tinker: `ServiceClient().get_server_capabilities()` → confirm Gemma is still absent
     before writing it off (~1 s, free).
2. **Render locally against the published template.** Weights are Apache-2.0 and
   ungated: pull `chat_template.jinja` + tokenizer for `google/gemma-4-31B-it`, render
   the actual workload traces (tools, tool results, thinking on and off), and count
   tokens with the real tokenizer. This yields the exact training-token estimate and a
   golden rendering to diff against Fireworks' Render Samples later.
3. **Cost the run before approving it.** LoRA SFT $3.00/1M training tokens: e.g. 5M
   tokens ≈ **$15** — training is not the expensive part. Eval is: a dedicated B200
   deployment is **$10/GPU-hour**; a 2-hour eval window is $20 on one GPU and $80 on
   four. Budget eval, not training, and require the step-1 GPU count before quoting.
4. **Gate the first spend** on: (a) rendered-token diff between the local template and
   Fireworks' Render Samples on a deliberately tiny job, and (b) a scale-to-zero eval
   deployment plan with an explicit teardown step.
5. **If the actual goal is a two-supplier comparison rather than Gemma specifically**,
   switch the base to Qwen 3.5 9B or Qwen 3.6 27B and run it on Tinker vs Fireworks
   Serverless Training API, where pricing is identical and neither side needs a
   dedicated deployment.

## Source freshness (for maintenance)

| What we cite | Source type | URL | Checked |
|---|---|---|---|
| Tinker catalog + pricing (no Gemma) | primary | tinker-docs.thinkingmachines.ai/tinker/models/ · /tinker/models.json | 2026-08-01 |
| Tinker live catalog (28 models, no Gemma) | primary (read-only API) | `ServiceClient.get_server_capabilities()` | 2026-08-01 |
| Tinker deprecations (no Gemma ever) | primary | tinker-docs.thinkingmachines.ai/tinker/model-deprecations/ | 2026-08-01 |
| Tinker LoRA-only posture | primary | tinker-docs.thinkingmachines.ai/tinker/lora-primer/ | 2026-08-01 |
| Fireworks training-shape registry | primary (dated 2026-07-31) | docs.fireworks.ai/fine-tuning/models | 2026-08-01 |
| Fireworks Gemma model records / flags | primary (read-only API) | api.fireworks.ai/v1/accounts/fireworks/models | 2026-08-01 |
| Fireworks SFT data format + train ctx | primary | docs.fireworks.ai/fine-tuning/fine-tuning-models | 2026-08-01 |
| Fireworks LoRA serving restriction | primary | docs.fireworks.ai/fine-tuning/deploying-loras | 2026-08-01 |
| Fireworks GPU + training prices | primary | fireworks.ai/pricing | 2026-08-01 |
| Fireworks Serverless Training API catalog | primary | docs.fireworks.ai/fine-tuning/training-api/serverless | 2026-08-01 |
| Gemma 4 family, license, sizes | primary | blog.google · ai.google.dev/gemma/docs/core | 2026-08-01 |
| Gemma 4 canonical chat template | primary | huggingface.co/google/gemma-4-31B-it → chat_template.jinja | 2026-08-01 |
| Gemma 4 function calling | primary | ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4 | 2026-08-01 |
