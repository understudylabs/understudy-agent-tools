# Providers — where to run a hosted job (reference)

Per-provider detail for routing hosted ML jobs. Compiled **2026-06-07**. Tags:
**[V]** verified from a primary/official source · **[U]** unverified / could not
confirm — flagged. **Marketplace and serverless prices drift; treat every figure as
"as of 2026-06-07, verify live."** Vendor performance claims are marketing unless
independently benchmarked.

This file is reference data for [`SKILL.md`](../SKILL.md). It states public facts about
third-party providers to help an agent route work; it is not an endorsement and
implies no commercial relationship.

## At-a-glance pricing (verify live before quoting)

| Provider | Cheapest open-model inference | GPU rental ($/hr) | Managed RFT / RL | Raw clusters |
|---|---|---|---|---|
| **Lilac** (getlilac) | Gemma 4 31B $0.11 in / $0.35 out per 1M [V] | — | No | No |
| **Together AI** | Llama 3 8B Lite $0.14/$0.14; Llama 3.3 70B $1.04/$1.04 [V] | H100 $5.49 (cluster) – $6.49 (dedicated) [V] | No self-serve RFT [V] | **Yes — InfiniBand, up to 4,000+ GPUs** [V] |
| **Fireworks AI** | per-token rates not on pricing page [U] | H100 $7.00 on-demand [V] | **Yes — GRPO RFT** [V] | No (managed platform) [V] |
| **Prime Intellect** | — (compute/training, not a serverless catalog) | **H100 $2.43 on-demand / $0.94 spot** [V] | **Yes — verifiers + prime-rl + Lab** [V] | Yes — marketplace, 1–256 GPUs [V] |
| **GCP** | — (hyperscaler IaaS / Vertex) | A100/L4/H100 via Compute + Vertex (see GCP pricing) | Vertex custom jobs (you bring the recipe) | Yes (you manage) |
| **Azure / Microsoft Foundry** | Foundry/OpenAI model endpoints | NCads H100 v5 (see Azure pricing calculator) [V] | Foundry SFT/DPO/RFT by model [V] | Yes (you manage) |

---

## Source freshness (for maintenance)

Every claim about an outside party references a third party and **will drift**. Each row
carries a source-type and a **Checked** date so an agent can re-verify and bump it. Source
types: **primary** (vendor's own page / docs / repo), **secondary**, **aggregator**,
**unverified**. Maintenance: re-fetch the URL, confirm the value, bump Checked — or flag
drift. Treat any row **Checked > ~90 days** ago, or any non-primary row, as
verify-before-quoting; pricing especially.

| What we cite | Source type | URL | Checked |
|---|---|---|---|
| Prime Intellect stack + H100 $2.43/$0.94 | primary (site + repos) | primeintellect.ai · github.com/PrimeIntellect-ai | 2026-06-07 |
| Prime renderers | primary | primeintellect.ai/blog/renderers · github.com/PrimeIntellect-ai/renderers | 2026-06-07 |
| Prime A100 $/hr | **unverified** | — | 2026-06-07 |
| Fireworks GPU $ / FT $ | primary | fireworks.ai/pricing | 2026-06-07 |
| Fireworks RFT (GRPO, reward-kit) | primary | fireworks.ai/reinforcement-fine-tuning | 2026-06-07 |
| Fireworks RPM / 429 / autoscale | primary | docs.fireworks.ai (account-quotas, billing-scaling) | 2026-06-07 |
| Fireworks per-token serverless rates | **unverified** (not on pricing page) | docs.fireworks.ai | 2026-06-07 |
| Together pricing + Batch API | primary | together.ai/pricing · together.ai/batch-inference | 2026-06-07 |
| Together rate-limits (dynamic, 429) | primary | docs.together.ai/docs/rate-limits | 2026-06-07 |
| Together batch token limits | **unverified** (sources conflict) | x.com/togethercompute | 2026-06-07 |
| Lilac models + per-token pricing | primary | getlilac.com | 2026-06-07 |
| Lilac rate-limits / batch | **not documented** (verify w/ provider) | docs.getlilac.com | 2026-06-07 |
| GCP GPUs + Cloud Run GPU | primary docs (live $ in console) | cloud.google.com/compute/gpus-pricing · .../run/.../gpu | 2026-06-07 |
| Azure H100 VMs + Foundry fine-tuning/RFT | primary docs | learn.microsoft.com/azure/virtual-machines/ncads-h100-v5 · learn.microsoft.com/azure/foundry/openai/how-to/fine-tuning | 2026-06-08 |
| Lilac↔Databricks name collision | primary | ycombinator.com/companies/lilac · databricks.com/blog | 2026-06-07 |

## Prime Intellect — primeintellect.ai

**Core offering [V]:** "The Open Stack for Self-Improving Agents." On-demand GPU
**marketplace** aggregating GPUs across 50+ providers (1–256 GPUs, SLURM/K8s,
InfiniBand), plus Liquid Reserved Clusters. Full post-training stack: **Lab** (hosted
RL training), **Verifiers** (OSS RL-environment library), **Prime-RL** (large-scale
async RL), **Environments Hub** (2,500+ open RL environments), Hosted Evaluations,
and Deployments (inference with LoRA adapters).

**RL story (the differentiator) [V]:**
- **Verifiers** (MIT) — build an RL **environment** = dataset + harness (tools /
  sandboxes / context mgmt) + reward/rubric, distributed as pip wheels. Native to the
  Environments Hub; integrates with prime-rl and hosted training. Includes a minimal
  `vf.RLTrainer` and plugs into other RL stacks.
- **Prime-RL** — open framework for large-scale **asynchronous** RL; single-node →
  1000+ GPUs; first-class **multi-turn / tool-use (agentic) RL**; covers synthetic
  data → SFT → RL → eval.
- **Lab** — hosted RL training without managing clusters.
- **Renderers** [V] — a Python library that makes model chat templates programmable
  objects, solving **tokenization drift** (re-rendered samples retokenize differently,
  e.g. `false`→`False`) and preserving **multi-turn prefix continuity** via
  `bridge_to_next_turn` (extends prior sampled tokens verbatim instead of re-rendering
  history). Reports ~3× packing savings and clean loss-mask construction; used by both
  `verifiers` (parsing) and `prime-rl` (token-native training). Directly relevant to
  agentic/multi-turn RL correctness. (primeintellect.ai/blog/renderers)
- Model-family agnostic; config examples reference Qwen (e.g. `Qwen3-30B-A3B`). A
  GRPO-on-small-Qwen/Gemma job fits the verifiers + prime-rl path. [V] (An explicit
  end-to-end GRPO-on-small-Gemma doc was **not** found — [U].)

**Pricing [V/U]:** on-site tiles show **H100 $2.43/hr on-demand, $0.94/hr spot**; H200
single-node $0.47–$1.99/hr; B300 $4.99/hr. A secondary "H100 $1.49 / A100 $0.79" did
**not** match the site — do not quote; **A100/hr unconfirmed [U]**. Marketplace prices
fluctuate.

**OSS [V]:** verifiers (MIT) + prime-rl (open); open-weight **INTELLECT-1/2/3** models
(INTELLECT-2 = first model trained via globally distributed RL; INTELLECT-3 = 106B MoE,
~12B active, MIT, 131K ctx).

**Route to Prime Intellect when** you need to *train* (not just infer) — especially
multi-turn/agentic RL or GRPO — and want a reusable, open environment spec that scales
from one GPU to a cluster, with an option to offload to a hosted Lab.

Sources: https://www.primeintellect.ai/ · https://github.com/PrimeIntellect-ai/verifiers
· https://github.com/PrimeIntellect-ai/prime-rl · https://github.com/PrimeIntellect-ai/renderers
· https://www.primeintellect.ai/blog/renderers · https://www.primeintellect.ai/blog/environments
· https://docs.primeintellect.ai/guides/rl-training · https://docs.primeintellect.ai/hosted-training/what-is-lab
· https://docs.primeintellect.ai/verifiers/overview · https://huggingface.co/PrimeIntellect/INTELLECT-3

---

## Fireworks AI — fireworks.ai

**Core offering [V]:** low-latency serverless + per-GPU-second dedicated deployments +
fine-tuning + **managed reinforcement fine-tuning (RFT)**. It is a managed platform,
**not** a raw GPU-cluster IaaS.

**Fine-tuning / RL [V]:** LoRA + full-param SFT, DPO, and **self-serve GRPO-based RFT**
(GA Nov 2025): define a reward/evaluator, run multi-turn agent rollouts in your own
environment, train via GRPO, one-click deploy. Delta-compressed checkpoints (~98%
smaller), sub-minute hot-loading. Base families: Llama, Qwen 2.5/3, Phi 3/4,
DeepSeek V3/R1, Kimi K2. **Trajectory generation is built into the RFT training loop** —
the integrated path when rollouts feed straight into training.

**Pricing [V]:** on-demand GPU/hr **H100 $7.00 · H200 $7.00 · B200 $10.00 · B300 $12.00**
(RFT billed per-GPU-second at the same rate). Fine-tuning per 1M training tokens (≤16B):
LoRA SFT **$0.50** / LoRA DPO $1.00 / Full SFT $1.00 / Full DPO $2.00 (higher tiers up to
>300B). Batch & cached input = 50% of serverless. **Per-token serverless rates are not on
the pricing page** (deferred to docs) — [U].

**Scaling / quotas [V]:** on-demand deployments **autoscale to 0 when idle**, bill **per
GPU-second**, and throughput "scales with GPU allocation" (default 8 A100/H100, 100 LoRAs).
Documented account limits: **6,000 RPM** account-wide fixed ceiling with credits (**10 RPM**
without), and on on-demand an HTTP **429** "typically means deployment saturation (GPUs
busy)," not a TPM-tier cap. Size for *effective* sustained throughput, not peak, when
planning large rollout jobs (see
[`cost-estimation.md`](cost-estimation.md) §3d).
Sources: https://docs.fireworks.ai/faq/deployment/ondemand/billing-scaling (autoscale/billing)
· https://docs.fireworks.ai/guides/quotas_usage/account-quotas (RPM ceiling + 429 meaning)

**OSS [V]:** OpenAI-compatible API; open **Reward-kit** (reward/evaluator framework),
`firectl` CLI, Firefunction models on HF.

**Route to Fireworks when** you want to fine-tune *and* RL-train an open model with a
reward function and serve it on the same platform — the closed RFT→serving loop with
the least assembly.

Sources: https://fireworks.ai/pricing · https://fireworks.ai/reinforcement-fine-tuning
· https://fireworks.ai/blog/fireworks-rft · https://docs.fireworks.ai/fine-tuning/reinforcement-fine-tuning-models
· https://docs.fireworks.ai/tools-sdks/openai-compatibility

---

## Together AI — together.ai

**Core offering [V]:** broad AI-native cloud — serverless (per-token) + dedicated
endpoints + **raw InfiniBand GPU clusters (8 → 4,000+ GPUs)** + a **Batch API**. LoRA +
full SFT + DPO/preference fine-tuning that serves on a dedicated endpoint.

**RL [V/U]:** **No self-serve RFT/GRPO product.** RL presence is research/infra: a
"distribution-aware speculative decoding (DAS)" result (~April 2026) claiming up to 50%
faster RL rollouts, plus PyTorch RL on rented clusters — you assemble the RL stack. A
secondary note claimed GRPO/DPO on 70B needs ≥2×H100 — [U].

**Batch / trajectory generation [V/U]:** **Batch API** at ~50% off serverless, separate
rate-limit pool, up to **50,000 requests/batch**, 24h window, marketed for synthetic
data + evals. Per-model enqueued-token limits cited inconsistently (10M/model vs 30B) —
[U]. Best for a **standalone large rollout/synthetic-data job decoupled from training**,
or run your own engine on raw clusters.

**Pricing [V]:** serverless per 1M tok (in/out) — Llama 3 8B Lite $0.14/$0.14 · Llama 3.3
70B $1.04/$1.04 · Gemma 4 31B $0.39/$0.97 · Qwen 2.5 7B Turbo $0.30/$0.30. Dedicated H100
$6.49/hr; clusters on-demand H100 $5.49 (reserved $4.99). FT per 1M tok ≤16B SFT $0.48 /
DPO $0.54. Some catalog variant names looked like scraping drift — [U].

**OSS [V]:** OpenAI-compatible; large open-weight catalog; open **together-cookbook**;
strong research publishing (FlashAttention lineage, DAS).

**Route to Together when** you need breadth of compute under one roof — serverless +
dedicated + raw clusters — to run your own training/rollout engine at scale, or a
standalone large-batch trajectory job, often at a slightly lower GPU-hour price.

Sources: https://www.together.ai/pricing · https://www.together.ai/batch-inference
· https://docs.together.ai/docs/batch-inference · https://www.together.ai/fine-tuning
· https://github.com/togethercomputer/together-cookbook

---

## Lilac — getlilac.com  (NOT the Databricks "Lilac" data tool)

**Disambiguation [V]:** two unrelated companies share the name. **getlilac.com** (YC
Summer 2025, founded 2025) is the **serverless inference provider** described here.
**lilacml.com** is an open-source unstructured-data-curation tool **acquired by
Databricks (March 2024)** — different entity, do not conflate.

**Core offering [V]:** OpenAI-compatible inference API (`api.getlilac.com`, drop-in
base-URL swap, prepaid). Routes inference to **idle enterprise GPUs already powered on**
(clusters typically run 30–50% utilized), passing the savings to per-token price.

**Models hosted, with on-site pricing [V]** (confirm input-vs-cache split live — [U]):

| Model | Precision | $/M input | $/M output |
|---|---|---|---|
| Gemma 4 (31B) | BF16 | $0.11 | $0.35 |
| MiniMax M2.7 | FP8 | $0.30 | $1.20 |
| Kimi K2.6 | INT4 | $0.70* | $3.50 |
| GLM 5.1 | FP8 | $0.90* | $3.00 |

\* a second source listed lower input + a separate cache rate — verify on the live page.

**Batch / trajectory throughput [U — NOT FOUND]:** as of 2026-06-07 the public inference
docs (quickstart) document **no** batch API, async endpoint, or rpm/concurrency limits
(verified by reading the docs). The trajectory-generation use case is **inferred** (fan
out parallel chat-completion calls against a cheap OpenAI-compatible endpoint), **not an
advertised feature**. **Confirm concurrency limits with the provider before a large
rollout job** and design for retries/backoff on overload. (By contrast, Fireworks and
Together publish concrete rate limits — see their entries above.)

**OSS [V]:** getlilac/lilac is itself open-source (connect compute from any source);
hosts open-weight families (GLM, Kimi/Moonshot, Gemma, MiniMax).

**Route to Lilac when** you need cheap, fast, OpenAI-compatible inference of open-weight
frontier models for a **small probe** or latency/cost comparison, and $/token matters
more than guaranteed reserved throughput. Do **not** make it the default high-volume
trajectory path until the provider confirms batch/concurrency support and retry/backoff
behavior.

Sources: https://getlilac.com/ · https://docs.getlilac.com/inference/quickstart
· https://www.ycombinator.com/companies/lilac · https://github.com/getlilac/lilac

---

## GCP — cloud.google.com

**Core offering:** hyperscaler IaaS — raw GPUs (A100-40GB/80GB, L4, H100) via Compute
Engine, and managed training/serving via **Vertex AI** custom jobs and endpoints. You
own the stack (drivers, orchestration, the RL/SFT framework); there is no turnkey RFT
product. GPU availability is **per-region quota** and often must be requested; spot
(preemptible) classes are cheaper but interruptible. For bursty inference / trajectory
generation without managing VMs, **Cloud Run GPU** offers serverless GPU containers that
scale to zero (https://docs.cloud.google.com/run/docs/configuring/services/gpu).

**Route to GCP when** you already hold quota, credits, or have data-residency / Vertex
integration needs, and are comfortable managing the training stack yourself — versus a
purpose-built RL platform (Prime Intellect) or managed RFT (Fireworks).

Pricing varies by region/commitment; quote from the live GCP pricing pages
(https://cloud.google.com/compute/gpus-pricing , https://cloud.google.com/vertex-ai/pricing)
rather than a cached number.

---

## Azure / Microsoft Foundry — azure.microsoft.com / learn.microsoft.com

**Core offering [V]:** hyperscaler GPUs via Azure Virtual Machines plus managed model
customization through Microsoft Foundry / Azure OpenAI. Azure NCads H100 v5 VMs are
documented for Applied AI training and batch inference workloads, with 1× or 2×
NVIDIA H100 NVL GPUs (94 GB each) and up to 640 GiB system memory.

**Fine-tuning / RFT [V]:** Microsoft Foundry documents SFT, DPO, and RFT support by
model. Current docs list SFT/DPO across GPT-4o/GPT-4.1 families, RFT for selected
reasoning/frontier models, and several open-source models for SFT in Foundry. Access,
regions, model availability, and deployment permissions are quota/RBAC-gated, so verify
the specific subscription and region before planning a run.

**Route to Azure when** Microsoft credits, quota, enterprise/data-boundary constraints,
or existing Foundry/OpenAI integration dominate the decision. Treat it like GCP for raw
GPU work: good if you already have quota/credits and can manage the stack, weaker as a
default than Prime/Fireworks when you want a purpose-built RL/RFT workflow.

Pricing varies by region, VM family, commitment, and credits. Quote from the live Azure
pricing calculator or portal before spend.

Sources: https://learn.microsoft.com/azure/virtual-machines/ncads-h100-v5
· https://learn.microsoft.com/azure/foundry/openai/how-to/fine-tuning
· https://devblogs.microsoft.com/foundry/whats-new-in-foundry-finetune-april-2026/

---

## Putting it together — the RL pipeline pattern

1. **Generate rollouts / trajectories** cheaply: Together Batch for published batch
   semantics, Fireworks when rollouts feed directly into managed RFT, or Lilac only
   after provider-confirmed concurrency for the target volume.
2. **Train** (GRPO / agentic RL): Prime Intellect (verifiers + prime-rl/Lab) or
   Fireworks managed RFT.
3. **Serve** the result: Fireworks/Together (managed) or your own GCP/cluster endpoint.

Generation, training, and serving can each live on a different vendor — pick per stage
by the strengths above, and always re-verify pricing before committing spend.
