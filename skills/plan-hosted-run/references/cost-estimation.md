# Cost estimation — how long and how much (reference)

Cited numbers and worked math for [`SKILL.md`](../SKILL.md). Compiled **2026-06-07**.
Tags: **[MEASURED]** real benchmark / live rate · **[SPEC]** vendor datasheet ·
**[ESTIMATE]** rule-of-thumb. **Cloud and per-token prices drift monthly — re-fetch
the live pricing page before quoting.** Where an aggregator disagreed with a vendor's
own page, the vendor page wins.

## Re-verify here (don't hard-code prices)

- https://cloud.google.com/compute/gpus-pricing · https://www.runpod.io/pricing
  · https://azure.microsoft.com/pricing/calculator/ · https://www.primeintellect.ai/
  · https://www.runpod.io/pricing · https://lambda.ai/pricing · https://www.together.ai/pricing
  · https://fireworks.ai/pricing · https://getlilac.com/
- Apple-Silicon throughput: https://github.com/ggml-org/llama.cpp/discussions/4167
  · LoRA: https://github.com/ml-explore/mlx-examples/blob/main/lora/README.md

---

## Source freshness (for maintenance)

Every figure below references an outside party and **will drift**. Each row carries a
source-type and a **Checked** date so an agent can re-verify and bump it. Source types:
**primary** (vendor's own page / datasheet / first-party repo), **aggregator** (third-party
price tracker), **blog** (third-party write-up). Treat any row **Checked > ~90 days** ago,
or any **aggregator/blog** row, as verify-before-quoting. To maintain: re-fetch the URL,
confirm the value, bump Checked — or flag drift.

| What we cite | Source type | URL | Checked |
|---|---|---|---|
| Apple-Silicon decode tok/s (§1a) | primary (community bench) | github.com/ggml-org/llama.cpp/discussions/4167 | 2026-06-07 |
| MLX-specific tok/s (§1a) | blog | sitepoint.com/local-llms-apple-silicon-mac-2026 | 2026-06-07 |
| MLX LoRA train tok/s (§1b) | primary | github.com/ml-explore/mlx-examples (lora/README) | 2026-06-07 |
| GCP GPU $/hr (§2a) | **aggregator** (primary page JS-rendered) | gpucost.org/provider/gcp → verify cloud.google.com/compute/gpus-pricing | 2026-06-07 |
| GCP Cloud Run GPU (§2a) | primary | docs.cloud.google.com/run/docs/configuring/services/gpu | 2026-06-08 |
| Azure H100 VM / Foundry pricing (§2a) | primary docs + live calculator | learn.microsoft.com/azure/virtual-machines/ncads-h100-v5 · azure.microsoft.com/pricing/calculator | 2026-06-08 |
| RunPod / Lambda $/hr (§2b) | primary | runpod.io/pricing · lambda.ai/pricing | 2026-06-07 |
| CoreWeave $/hr (§2b) | secondary | coreweave.com/pricing | 2026-06-07 |
| Marketplace spot floors (§2b) | **aggregator** | spheron.network · aimultiple.com/gpu-marketplace | 2026-06-07 |
| Prime Intellect H100 $/hr (§2b) | primary | primeintellect.ai | 2026-06-07 |
| Together serverless/GPU $ (§2c) | primary | together.ai/pricing | 2026-06-07 |
| Fireworks GPU $ / FT $ (§2c) | primary | fireworks.ai/pricing | 2026-06-07 |
| Fireworks per-token tiers (§2c) | secondary | tokenmix.ai + fireworks docs | 2026-06-07 |
| Lilac model $ (§2c) | primary | getlilac.com | 2026-06-07 |
| Lilac batch/concurrency (§3d) | **not documented** | docs.getlilac.com | 2026-06-07 |
| Fireworks RPM / 429 (§3d) | primary | docs.fireworks.ai/guides/quotas_usage/account-quotas | 2026-06-07 |
| Together rate-limits (§3d) | primary | docs.together.ai/docs/rate-limits | 2026-06-07 |
| NVIDIA H100/A100 FLOPS (§3b) | primary (datasheet) | nvidia.com H100/A100 datasheets | 2026-06-07 |
| 6ND / MFU method (§3a) | primary (papers) | arxiv.org/abs/2203.15556 | 2026-06-07 |

## 1. Local — Apple Silicon / MLX

### 1a. Inference decode throughput (tok/s) [MEASURED]

llama.cpp Apple-Silicon thread, **LLaMA-7B Q4_0**, text-generation (decode):

| Chip (GPU cores) | tok/s decode |
|---|---|
| M1 Max (32) | 61 |
| M2 Max (38) | 66 |
| M3 Max (40) | 66 |
| M4 Max (40) | 83 |
| M2 Ultra (76) | 94 |
| M3 Ultra (80) | 92 |

Prefill ≫ decode (M4 Max ~886 tok/s prefill @512-batch vs 83 decode). MLX is ~20–87%
faster than llama.cpp for sub-14B generation; Llama-8B 4-bit ~72 tok/s on M3 Max; tiny
3B models can exceed ~1,100 tok/s on M4 Max (bandwidth-bound).
Sources: github.com/ggml-org/llama.cpp/discussions/4167 ; sitepoint.com/local-llms-apple-silicon-mac-2026

> **M5 flag:** M5-generation numbers are **not yet** in the canonical benchmark table.
> Treat any M5 throughput as **unverified** — run a probe (below) instead of assuming.

### 1b. LoRA/QLoRA fine-tuning throughput [MEASURED]

`mlx-examples` LoRA (Llama-7B, WikiSQL): **~475 tok/s on M2 Ultra**, **~250 tok/s on
M1 Max (32GB)**; reference run 1000 iters, val loss 2.659→1.230. Use these as the
anchor, not looser blog estimates. Apple-Silicon training is far below an H100 — plan
**hours-to-days** for non-trivial datasets.
Source: github.com/ml-explore/mlx-examples/blob/main/lora/README.md

### 1c. Memory rule of thumb [ESTIMATE]

- **Model GB ≈ N(B params) × bytes/param**; bytes/param = 2.0 (BF16), 1.0 (8-bit),
  ~0.5 (4-bit). A 7–8B model ≈ 14–16 GB BF16, ~8 GB int8, **~4–5 GB 4-bit**.
- **QLoRA** 7B ≈ ~7 GB (4-bit base + adapter) vs ~14 GB plain LoRA.
- **Unified-memory ceiling:** weights + KV-cache + activations + OS must fit. Keep the
  model under ~60–70% of RAM. 16 GB runs a 4-bit 7–8B; ~128 GB to QLoRA up to ~70B.

### 1d. The 2-minute local probe (beats any generic number)

Measure tok/s on the actual machine before estimating: serve the target model with
`mlx_lm.server`, send a fixed prompt, divide generated tokens by elapsed seconds. Use
that as the local throughput in §3. For training, run ~50 `mlx_lm.lora` iters and read
the reported tok/s.

---

## 2. Cloud pricing ($/GPU-hour) [MEASURED — snapshots, verify live]

### 2a. Hyperscalers — GCP / Azure (VMs may bill more than GPU component)

**GCP** [aggregator, checked 2026-06-07]:

| GPU | On-demand | Spot |
|---|---|---|
| H100 80GB (A3) | $9.80 | $2.25 |
| A100 80GB (A2) | $3.93 | $1.57 |
| A100 40GB (A2) | $2.93 | $1.15 |
| L4 (G2) | $0.56 | $0.22 |

Source: gpucost.org/provider/gcp — cross-check cloud.google.com/compute/gpus-pricing.
GCP often bills the whole VM (e.g. a3-highgpu-1g ≈ $11/hr incl. host).
For serverless managed-container inference, Cloud Run GPU supports GPU services that
scale to zero; verify live region/GPU availability and pricing before using it for
rollouts.

**Azure / Microsoft Foundry** [primary docs, checked 2026-06-08]:
NCads H100 v5 VMs are documented for Applied AI training and batch inference workloads
with 1× or 2× NVIDIA H100 NVL GPUs (94 GB each). Pricing is region/subscription/credit
dependent; quote from the live Azure pricing calculator or portal, not this document.
Foundry/OpenAI fine-tuning and RFT costs depend on model, region, and access tier.

### 2b. GPU-rental marketplaces (most volatile category)

| GPU | RunPod (community) | Lambda | CoreWeave | Marketplace spot floor |
|---|---|---|---|---|
| H100 SXM | $3.29 | $4.29 (→$3.99 @8×) | ~$4.25 PCIe | ~$1.03 |
| A100 80GB | $1.49 | $1.99 | ~$2.21 PCIe | ~$0.60 |
| A100 40GB | — | $1.99 | — | — |
| L40S 48GB | $0.86 | — | — | — |

Sources: runpod.io/pricing ; lambda.ai/pricing ; coreweave.com/pricing ;
spheron.network/blog/gpu-cloud-pricing-comparison-2026 ; primeintellect.ai.
Spot floors are best-case, not guaranteed. Prime Intellect on-site: H100 $2.43
on-demand / $0.94 spot.

### 2c. Serverless per-token (per 1M tokens, in/out) [MEASURED]

- **Together:** Llama-3.3-70B $1.04/$1.04 · Llama-3.x-8B Lite $0.14/$0.14 ·
  Qwen2.5-7B Turbo $0.30/$0.30 · Gemma 4 31B $0.39/$0.97. Dedicated H100 $6.49/hr.
- **Fireworks:** ≤16B tier ~$0.20 · >16B tier ~$0.90. On-demand H100 $7.00/hr. LoRA
  SFT $0.50/1M tok (≤16B).
- **Lilac (getlilac):** Gemma 4 31B $0.11/$0.35 · Kimi K2.6 $0.70/$3.50 · GLM 5.1
  $0.90/$3.00 (verify input-vs-cache split live). Batch/concurrency is not publicly
  documented; treat it as a probe path until confirmed.

Sources: together.ai/pricing ; fireworks.ai/pricing ; getlilac.com.
**Drift flag:** Together's live rates rose vs older blog citations ($0.88→$1.04 for
70B) — use the live page.

---

## 3. Methodology (the math)

### 3a. Training compute — the 6ND rule [ESTIMATE]

**C ≈ 6 × N × D** FLOPs (N params, D tokens; 2 fwd + 4 bwd FLOPs/param/token). Origin:
Kaplan et al. 2020; Chinchilla (Hoffmann 2022) adds compute-optimal D/N ≈ 20.
LoRA reduces *trainable* params but fwd/bwd still flow through full N — use full N for
wall-clock. Sources: arxiv.org/abs/2203.15556 ; en.wikipedia.org/wiki/Neural_scaling_law

**Wall-clock:** `time = (6 × N × D) / (num_GPUs × peak_FLOPS × MFU)`.

### 3b. Realistic GPU FLOPS [SPEC] — use *dense*, halve marketing sparse

| GPU | BF16 dense | (2:4 sparse marketing) |
|---|---|---|
| H100 SXM5 | **989 TFLOPS** | 1,979 |
| H100 PCIe | 756 TFLOPS | 1,513 |
| A100 40/80GB | **312 TFLOPS** | 624 |

Sources: NVIDIA H100/A100 datasheets. **MFU (Model FLOPs Utilization)** = achieved ÷
peak; realistic **0.3–0.5** (Llama-3.1 ~38–43% on H100; 8B on A100 ~31%). After MFU,
an H100 realizes ~300–500 dense TFLOPS — "about half of marketing."
Sources: medium.com/better-ml/using-model-flops-utilization-mfu-7b17de07faec

### 3c. Inference → wall-clock → $

- **Wall-clock** = `total_tokens / throughput_tok_s` (local: §1a/probe; cloud: deployment benchmark).
- **Serverless $** = `(in_tok × $/M_in + out_tok × $/M_out) / 1e6` (§2c).
- **Rented GPU $** = `(total_tokens / throughput_tok_s / 3600) × $/GPU-hr` (§2a/2b).

### 3d. RL trajectory generation + the crossover [ESTIMATE]

`total_tokens = num_prompts × rollouts × avg_tokens_per_trajectory`.

- **Serverless** = `total_tokens × per-token-rate` — wins for small/bursty jobs (no idle, no warmup).
- **Rented deployment** = `(total_tokens / sustained_throughput) × $/GPU-hr` — wins
  only when you keep the box highly utilized. Break-even where
  `per-token-rate × throughput_tok_s × 3600 ≈ $/GPU-hr`.

> **Effective ≠ peak throughput.** Providers publish request rate limits and return
> **429** when exceeded, so a large rollout rarely sustains headline tok/s. Documented
> examples (verify live): **Fireworks** caps account-wide requests at **6,000 RPM**
> (10 RPM without credits) and returns 429 on deployment saturation
> (https://docs.fireworks.ai/guides/quotas_usage/account-quotas); **Together** uses
> **dynamic** per-model limits — read the `x-ratelimit-reset` header and pace ~1 RPS
> rather than bursting (https://docs.together.ai/docs/rate-limits). Estimate with
> *effective* throughput, add retries/backoff, and **shard across jobs rather than
> cranking per-job concurrency**.

**Worked example.** Together Llama-8B serverless ≈ $0.14/M = $1.4e-7/token. A RunPod
H100 at ~$3.29/hr (§2b) serving Llama-8B at ~2,500 tok/s sustained →
$3.29 / (2500 × 3600) ≈ **$3.7e-7/token** — *more* than serverless, because serverless
batches across tenants. The rented box wins only if you sustain higher batched
throughput, need a model/quant no serverless host offers, or run enormous sustained
volume. **Always compute both with the deployment's *measured* throughput — don't
assume the rented GPU is cheaper.**

---

## 4. Worked local-vs-cloud examples

**SFT cold-start, ~4B model, 1k long trajectories (~8k tok each), 3 epochs (D≈24M tok):**
- Local M-series (LoRA ~250–475 tok/s [MEASURED §1b]): 24e6 / 350 ≈ **~19 hr, $0** —
  overnight, free, but slow. (M5 throughput unverified — probe to confirm.)
- Cloud A100-80GB spot ($1.57/hr GCP [§2a], down to ~$0.60 marketplace floor [§2b]):
  same job far faster; even at 10× the local tok/s, ~2 hr × ~$1.57 ≈ **~$3**. The trade
  is dollars-for-hours.

**Generate 50k RL trajectories, ~2k tok each (D≈100M tok):**
- Serverless Llama-8B @ $0.14/M: 100 × $0.14 ≈ **~$14**, no infra.
- Cheap open-weight via Lilac Gemma 4 31B @ $0.11/$0.35: dominated by output tokens.
- Local M-series @ ~80 tok/s decode: 100e6 / 80 ≈ ~347 hr — **impractical** for this volume.

Pattern: **SFT → local is the free, tolerable-time path; large-scale generation and RL
training → cloud**, matching the Understudy local-SFT / cloud-RL split.
