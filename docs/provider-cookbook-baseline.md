# Provider cookbook baseline: Fireworks + Tinker, end-to-end timing and behavior

Run date: 2026-08-01 · Account: `accounts/understudy-dev` (Understudy Labs) · Budget: $150

Purpose: run the **providers' own** cookbook examples end-to-end, unmodified in task shape, to
establish a provider-blessed timing/behavior baseline we can contrast with AutomationBench and the
sanitized synthetic fixtures.

Sources pinned for this run:

| Source | Pin |
|---|---|
| Fireworks cookbook | `github.com/fw-ai/cookbook` @ `e219f1617aa662a73120e80beb85323681a82f7c` |
| Fireworks SDK | `fireworks-ai==1.2.5` (`fireworks.training.sdk`) |
| tinker-cookbook | `github.com/thinking-machines-lab/tinker-cookbook` @ `e0c61af431bf33aa81fcbb837bda37412957b2d9` |
| Tinker SDK | `tinker==0.24.0` (lane C); `tinker==0.23.0` pinned by the Fireworks cookbook (lanes A/B) |
| Fireworks docs | `docs.fireworks.ai/fine-tuning/training-api/{serverless,quickstart,dedicated,training-shapes,choose-infrastructure}` |
| Price cards | `fireworks.ai/pricing`, `tinker-docs.thinkingmachines.ai/tinker/models/` |

---

## 1. Headline findings

1. **Provisioning is the whole story.** Same model, same 24-row cookbook dataset, same LoRA rank,
   same 3 × batch-8 steps, three lanes:

   | | time to first gradient | total wall clock | cost |
   |---|---:|---:|---:|
   | Fireworks **dedicated** (lane A) | **604 s** | 676 s | **$5.64** |
   | Fireworks **serverless** (lane B2) | **1.1 s** | ~22 s | **$0.0048** |
   | **Tinker** (lane C1) | **1.1 s** | ~22 s | **~$0.005** |

   The dedicated lane spends 620 s on infrastructure (604 s provisioning + 15.6 s adapter hotload)
   to perform 51 s of work, and costs ~1,175× the serverless lane for the identical result. It buys
   back only steady-state latency: warm `forward_backward` 3–4 s vs 2.8–3.7 s, warm inference
   0.44 s vs 1.19 s.
2. **The serverless training preview is live on our account and has no provisioning stage at all.**
   Attaching a LoRA training session took **1.1 s** (9B) / **1.2 s** (27B). No queue, no trainer
   job, no deployment, no teardown obligation.
3. **Fireworks serverless training and Tinker are the same product shape at the same price.** Both
   expose Tinker-compatible primitives (`forward_backward` / `optim_step` /
   `save_weights_for_sampler` / sampling client), and the Qwen 3.5 9B and Qwen 3.6 27B per-1M rates
   are *identical to the cent* across the two vendors (train $1.463 / $4.103, sample $1.995 /
   $5.595). The Fireworks serverless lane is a Tinker-compatible surface, not merely a similar one.
4. **MiniMax M3 is inference-only for us.** It is `READY` in the catalog but reports
   `supportsLora=false` and has no training shape — it cannot be a training target on either lane.
5. **A cookbook task is a single-turn, gold-completion task. Ours are none of those things.** Every
   provider example trains on `(prompt, gold assistant completion)` pairs. AutomationBench and the
   sanitized synthetic fixtures contain **no gold assistant completions at all** — only prompts, hidden
   state, final-state assertions, and a grader-side oracle. See §6.
6. **No SDK first-token latency surface.** Neither the Fireworks Firetitan sampling client nor the
   measurements below can report time-to-first-token; only completed-sample wall clock. Any
   first-token number we publish has to come from the inference API, not the training SDK.

---

## 2. Observed model availability (measured, not documented)

Queried live from `GET /v1/accounts/fireworks/models` (293 models) and Tinker
`get_server_capabilities()` (28 models) on 2026-08-01.

### Fireworks — the launch models we were told are enabled

| Model | Catalog state | `supportsLora` | Serverless training | Dedicated SFT LoRA shape |
|---|---|---|---|---|
| `qwen3p5-9b` | READY | true | yes (verified, attached) | 2 × B200 |
| `qwen3p6-27b` | READY | true | yes (verified, attached) | 4 × B200 |
| `minimax-m3` | READY | **false** | no | none listed |
| `kimi-k3` | READY | — | listed on the serverless price card | — |

Adjacent shapes worth knowing, from the live training-shapes catalog (generated 2026-07-10):
`qwen3-4b` SFT LoRA = 1 × B200 (cheapest dedicated shape), `qwen3-8b` SFT LoRA = 8 × B200,
`qwen3p5-27b` = 4 × B200, `qwen3p5-397b-a17b` = 8 × B300.

`GET /v1/accounts/fireworks/trainingShapes` is **not readable with our key**; it returns verbatim:

```text
{"code": 7, "details": [], "message": ""}
```

so shape IDs and GPU counts have to come from the docs page, not the API.

### Tinker — 28 models, including the same two launch models

`Qwen/Qwen3.5-9B`, `Qwen/Qwen3.5-9B-Base`, `Qwen/Qwen3.6-27B`, `Qwen/Qwen3.5-4B`,
`Qwen/Qwen3.5-35B-A3B-Base`, `Qwen/Qwen3.5-397B-A17B`, `Qwen/Qwen3.6-35B-A3B`,
`moonshotai/Kimi-K2.6`, `deepseek-ai/DeepSeek-V3.1`, `openai/gpt-oss-{20b,120b}`,
`nvidia/NVIDIA-Nemotron-3-{Nano-30B-A3B,Super-120B-A12B,Ultra-550B-A55B}`,
`thinkingmachines/Inkling{,-Small}`, plus `:peft:` long-context variants.

Because `Qwen3.5-9B` is available on **both** vendors, lanes B and C below are a true
apples-to-apples comparison on the same base model at the same list price.

---

## 3. Price cards used for every cost number below

**Fireworks serverless training** (per 1M tokens): Qwen 3.5 9B — prefill $0.66 / cached $0.132 /
sample $1.995 / train $1.463. Qwen 3.6 27B — $1.86 / $0.372 / $5.595 / $4.103. Kimi K3 — $10.87 /
$2.17 / $27.11 / $32.55. Checkpoint storage free during preview.

**Fireworks dedicated Training API**: GPU-hour, billed per second, at on-demand rates —
H100 $7.00, H200 $7.00, B200 $10.00, B300 $12.00 per GPU-hour.

**Fireworks managed fine-tuning** (for contrast, not run here): per 1M training tokens —
$0.50 LoRA SFT for models ≤16B, $3.00 for 16.1–80B.

**Tinker** (per 1M tokens): Qwen3.5-9B train $1.463 / sample $1.995; Qwen3.6-27B train $4.103 /
sample $5.595. Checkpoint storage $0.10/GB-month.

The serverless-training and Tinker rate cards for these models are numerically identical.

---

## 4. Per-stage timing tables

All stages instrumented with `harness/timing.py`, which writes one JSONL span per stage
(`{run_id, lane, stage, t_start_iso, duration_s, ok, error, extra}`). Raw artifacts live under
`runs/<run>/{timing.jsonl,stdout.log}`.

### Lane A — Fireworks **dedicated Training API** (LoRA SFT → deployment → hotload → inference)

The cookbook's `training/examples/sft/run.sh` defaults to `qwen3-8b` with `--lora-rank 0`
(full-parameter). We deliberately did **not** run that shape: `qwen3-8b` SFT LoRA is 8 × B200
($80/hr) and its full-param shape is 4 × B200 ($40/hr), against 2 × B200 ($20/hr) for
`qwen3p5-9b` — which is also one of the launch models we care about, and LoRA is required for the
adapter-hotload half of the lane. Everything else — the recipe and its bundled 24-row
`text2sql_dataset.jsonl` — is the cookbook's, unchanged, and the batch shape is identical to
lanes B2 and C1.

Resolved shape `accounts/fireworks/trainingShapes/qwen3p5-9b-256k-lora/versions/p6o371lz`;
deployment shape `accounts/fireworks/deploymentShapes/rft-qwen3p5-9b-v2/versions/pcxyecdg`.
Trainer hardware **2 × NVIDIA_B200_180GB**, deployment **1 × NVIDIA_B200_180GB**.

| Stage | Duration (s) |
|---|---:|
| dataset prep + tokenization (local, 24 datums / 2,804 tokens) | 3.117 |
| **trainer create + trainer READY + deployment create + deployment READY** | **604.181** |
| `forward_backward`, step 0 / 1 / 2 | 39.977 / 3.194 / 3.959 |
| `optim_step`, step 0 / 1 / 2 | 0.319 / 0.402 / 0.319 |
| `save_weights_for_sampler` | 2.186 |
| **adapter hotload / weight sync** | **15.604** |
| first inference (75 prompt tokens) | 1.631 |
| warm inference (same prompt) | 0.442 |
| sampler close | 0.000 |
| deployment delete | 0.104 |
| trainer delete | 0.233 |
| post-teardown REST listings | 0.624 |
| **total run wall clock** | **676.29** |

Trainer `accounts/understudy-dev/rlorTrainerJobs/training-api-service-e2ee2f67`, deployment
`accounts/understudy-dev/deployments/lane-a-1785625731`, checkpoint `lane-a-final-795ebbad`.

**Cost.** GPU-hour, billed per second, 3 × B200 = $30/hr while both resources are up.
Final run: 676.29 s × 3 × $10/3600 = **$5.64**. Four attempts were needed (three corrected for
local SDK-usage bugs, §5); summing all four lifetimes gives **≈$24** for the lane, under the $30
cap I set for it.

**The number that matters:** provisioning is **604 s** — 99.98% of it before a single gradient is
computed, and 547× the 1.1 s serverless attach. Add the 15.6 s adapter hotload and the dedicated
lane spends **620 s** on infrastructure to do **51 s** of actual training and inference. The
first `forward_backward` also costs 40 s (warm-up); subsequent ones are 3–4 s, i.e. slightly
*faster* than serverless (2.8–3.7 s) once warm, and warm inference is 0.442 s versus serverless's
1.194 s. Dedicated wins on steady-state latency and loses catastrophically on time-to-first-step.
For a 3-step job the dedicated lane costs ~1,175× the serverless lane ($5.64 vs $0.0048) for the
same work on the same model.

### Lane B — Fireworks **serverless training** preview

Three runs. B1 = the cookbook's own `examples/serverless_rl/countdown_rl.py` (its bundled 32-row
Countdown dataset, its `composite_reward`), shrunk to 3 steps × 2 prompt groups × 4 samples,
`max_sample_tokens=256`, LoRA rank 8. B2 = serverless **SFT** (`cross_entropy`) over 24 rows of the
cookbook's `text2sql_dataset.jsonl`, batch 8 × 3 steps. B3 = B1's shape at 1 step on the 27B.

| Stage | B1 · 9B RL (s) | B2 · 9B SFT (s) | B3 · 27B RL (s) |
|---|---:|---:|---:|
| tokenizer + renderer load (local) | 2.606 | 2.404 | 2.479 |
| dataset render (local) | — | 0.032 | — |
| **session attach (= all "provisioning")** | **1.132** | **1.107** | **1.210** |
| `save_weights_for_sampler` (min/med/max) | 1.203 / 1.234 / 1.407 | 1.335 / 1.606 / 2.236 | 3.426 |
| `create_sampling_client` | 0.025 / 0.026 / 0.029 | 0.025 / 0.025 / 0.028 | 0.029 |
| single-sample probe (256 tok) | 2.383 / 2.449 / 2.455 | 1.127 / 1.443 / 1.538 | 4.263 |
| grouped sampling (2 prompts × 4) | 1.449 / 1.697 / 1.780 | — | 2.597 |
| `forward_backward` | 3.991 (step 0 only) | 2.789 / 3.586 / 3.667 | not reached |
| `optim_step` | 0.520 | 0.535 / 0.556 / 0.584 | not reached |
| final checkpoint save | 1.207 | 1.484 | 2.951 |
| final inference call | — | 1.194 | — |
| teardown (`sampler.close` + `service.close`) | ~0.001 | ~0.001 | ~0.001 |
| **measured cost** | **$0.01985** | **$0.00480** | **$0.01609** |

Sessions observed: `ts-506b442927284926a588d65001726fbf` (B1),
`ts-076955e57d3c4873ae19482069c07bdb` (B2), `ts-5c65b2d71e67488da14a6c1cda7c9395` (B3).

B2 learned: `loss:sum/response_tokens` fell 0.892 → 0.431 → 0.364 over three steps, and the trained
adapter answered the held prompt with
`SELECT pick FROM table_name_15 WHERE school = "Lamar High School"`.

B1's RL reward was 0.125 raw / 0.250 filtered on step 0 and then **zero reward spread** on steps 1–2,
so those steps produced no trainable datums and were skipped. That is expected at this tiny sample
budget (4 samples per group) — GRPO drops groups with no spread — but it means a smoke-size
serverless RL run mostly measures latency, not learning.

### Lane C — Tinker

Two runs. C1 = a matched-shape instrumented SFT run (`harness/tinker_sft_lane.py`) on
`Qwen/Qwen3.5-9B`, LoRA rank 8, the **same** 24 rows of the same `text2sql_dataset.jsonl`, batch 8 ×
3 steps — deliberately identical to Fireworks B2. C2 = the cookbook's own
`tinker_cookbook/recipes/sl_basic.py` (NoRobots, `Qwen/Qwen3.5-9B-Base`) at smoke size.

| Stage | C1 · matched SFT (s) |
|---|---:|
| dataset load (local) | 0.0002 |
| tokenizer + renderer load (local, `qwen3_5` renderer) | 8.212 |
| `ServiceClient` construct | ~0.000 |
| **`create_lora_training_client` (= all "provisioning")** | **1.132** |
| datum build, 24 datums / 2,804 tokens (local) | 0.028 |
| `forward_backward` (cross-entropy) | 5.904 / 1.548 / 1.564 |
| `optim_step` | 0.535 / 0.542 / 0.511 |
| `save_weights_for_sampler` | 0.975 |
| `create_sampling_client` | 0.215 |
| first inference call (73 prompt → 128 sampled tok) | 7.643 |
| warm inference call (same prompt) | 1.682 |
| teardown | ~0.000 |

C1 loss: 7.598 → 3.838 → 2.851. C2 (`sl_basic`, 3 steps × batch 8): **18.31 s** total wall clock,
per-step `time/step` 1.868 / 1.183 / 1.078 s, `train_mean_nll` 1.722 / 1.930 / 1.401.

Lane C cost ≈ **$0.02** total (C1 ≈ $0.005 on 2,804 train tokens + 256 sampled; C2 ≈ $0.014 on
9,378 train tokens).

### The cross-lane comparison that matters

Fireworks serverless B2 and Tinker C1 are the same base model, same LoRA rank, same dataset, same
batch shape, same list price:

| | Fireworks serverless | Tinker |
|---|---:|---:|
| session/client attach | 1.107 s | 1.132 s |
| `forward_backward` (batch 8, ~940 tok) | 2.789–3.667 s | 1.548–5.904 s (first call warms) |
| `optim_step` | 0.535–0.584 s | 0.511–0.542 s |
| checkpoint save | 1.484 s | 0.975 s |
| sampling client create | 0.025 s | 0.215 s |
| inference (warm) | 1.194 s | 1.682 s |
| cost for the run | $0.00480 | ~$0.005 |

They are the same product, within noise, at the same price. There is no measured latency reason to
prefer one over the other for LoRA experiments on this model.

## 5. What failed, verbatim

Nothing failed on the provider side in lane B or C. Every error encountered was local
instrumentation, but they are recorded here in full because the task asked for verbatim errors.

```text
FileNotFoundError: [Errno 2] No such file or directory: '/home/ubuntu/cookbook-bench/harness/data/countdown_train.jsonl'
```
Copying `countdown_rl.py` out of the cookbook tree changes its `HERE`-relative default dataset path.
Anyone forking that example must pass `dataset` explicitly. (No API call was made.)

```text
AttributeError: 'TimingRecorder' object has no attribute 'span'
```
```text
KeyError: 'sampled_tokens'
```
Both local to our harness; fixed and rerun.

```text
chz.blueprint._entrypoint.InvalidBlueprintArg: Could not interpret NoRobotsBuilder(common_config=ChatDatasetBuilderCommonConfig(model_name_for_tokenizer='Qwen/Qwen3.5-9B-Base', renderer_name='role_colon', max_length=32768, batch_size=128, train_on_what=<TrainOnWhat.ALL_ASSISTANT_MESSAGES: 'all_assistant_messages'>)) provided for param 'dataset_builder' as a value, since subparameters were provided (e.g. 'dataset_builder.common_config.batch_size')
```
Tinker's `sl_basic.py` materializes its `dataset_builder` inside `build_config_blueprint`, so chz
refuses CLI sub-parameter overrides such as `dataset_builder.common_config.batch_size=8`. To shrink
that recipe for a smoke run you must fork it and rebuild the builder — you cannot do it from argv.

```text
WARNING: Using train_on_what=ALL_ASSISTANT_MESSAGES with a renderer that does not satisfy the extension property (has_extension_property=False). This means earlier assistant messages in the conversation see a different token prefix than what build_generation_prompt would produce at that turn. You should instead create separate conversations for each assistant message and call build_supervised_example with train_on_what=LAST_ASSISTANT_MESSAGE for each one.
```
Emitted by the Tinker renderer on every multi-assistant conversation. **Directly relevant to us**:
it is the same masking constraint that blocks our multi-turn tool-call fixtures (Delta 3 in §6).

```text
{"code": 7, "details": [], "message": ""}
```
`GET /v1/accounts/fireworks/trainingShapes` — permission denied for our API key.

Also recorded as a capability gap, not an error: the Fireworks `FiretitanSamplingClient` exposes
completed sample futures only — there is **no streaming or first-token event** on the documented SDK
surface. Every "inference latency" number above is completed-sample wall clock, not TTFT.

## 5b. Budget and teardown proof

| Lane | Spend |
|---|---:|
| A — Fireworks dedicated (4 attempts, GPU-hour) | ≈$24.00 |
| B — Fireworks serverless (3 runs + 2 retries, token-metered) | <$0.08 |
| C — Tinker (2 runs, token-metered) | ≈$0.02 |
| **Total** | **≈$24.10** of the $150 budget |

Lane A is the only lane that created deletable resources. Both were deleted explicitly (not merely
scaled to zero), with `cleanup_trainer_on_close=True` and `cleanup_deployment_on_close="delete"` as
a backstop, and I independently re-verified after the sidekick's run:

```text
GET /v1/accounts/understudy-dev/deployments      -> lane-a-1785625731            ABSENT
GET /v1/accounts/understudy-dev/rlorTrainerJobs  -> training-api-service-e2ee2f67 ABSENT
GET /v1/accounts/understudy-dev/models           -> no lane-a-* adapter artifact
```

Verbatim listings are preserved in `runs/lane-a-qwen3p5-9b-v4/teardown.json`. Note that
`GET /v1/accounts/understudy-dev/batchJobs` does not exist on this account and returns
`{"code":5,"details":[],"message":"Not Found"}`.

**Unrelated finding worth acting on.** The account listing is *not* empty — it holds 40
pre-existing deployments from earlier work, none of them ours. Thirty-six sit at 0 replicas
(scale-to-zero, no GPU charge), but **four are currently running replicas**:

| Deployment | Base model | GPUs | Created |
|---|---|---|---|
| `bij-ab-g26ba4b-probe` | `understudy-dev/models/ab-gemma4-26ba4b-oracle-sft-r16-e3` | 4 × B200 | 2026-08-01 22:53Z |
| `ab-g26ba4b-arm` | `fireworks/models/gemma-4-26b-a4b-it` | 2 × H100 | 2026-08-01 21:40Z |
| `abo-g26-bf16-lora` | `fireworks/models/gemma-4-26b-a4b-it` | 1 × H200 | 2026-08-01 23:10Z |
| `ob7h73qd` | `fireworks/models/nemotron-nano-3-30b-a3b` | 1 × H200 | 2026-08-01 22:17Z |

That is ~$61/hour of live on-demand GPU (4×$10 + 2×$7 + $7 + $7). They belong to concurrent work,
so I have not touched them — but if those sessions have finished, they are burning money now.

## 6. Cookbook tasks vs our AutomationBench / sanitized synthetic tasks

*(fixture characterization sourced from `understudylabs/understudy-agent-tools`, branch
`devin/178561-cookbook-audit-and-benchmark-repair` @ `2278a77`)*

### Task shape

| | Fireworks cookbook SFT (`text2sql`) | Fireworks cookbook RL (`countdown`) | Tinker `sl_basic` (NoRobots) | AutomationBench | Sanitized synthetic |
|---|---|---|---|---|---|
| Rows | 100 (50 for `food_reasoning`) | 32 | 9,500 train / 500 test | **72** (48/12/12) | **9** (5/2/2) |
| Turns | single turn | single turn + scored completion | single/multi-turn chat | **multi-turn agentic, up to 12 steps** | multi-turn agentic |
| Tools | none | none | none | 2 (`api_search`, `api_fetch`), prose descriptions, no JSON Schema | same 2 tools |
| Gold assistant output | **yes** (the SQL string) | no — reward function | **yes** | **no** | **no** |
| Supervision signal | cross-entropy on the gold completion | `composite_reward` on the text | cross-entropy | terminal **outcome contract** (`equals`/`exists`/`absent` on final world state) | same |
| Grader | none needed | pure function, local | none needed | in-memory `WorldState` diff + forbidden-write zeroing + partial credit | same |
| Tokens/example | ~150–250 | ~120 prompt + ≤1024 sampled | ~380 | ~60–125 visible input; ~200–750 for a full replayed episode | ~75–165 input; ~375–1,500 per episode |

### The three concrete deltas

**Delta 1 — no gold completions (blocking for every SFT path).** Both fixtures store
`{taskId, split, prompt, initialState, assertions, allowedWrites, oracle}`. The `oracle` is a
grader-side script of `{name, arguments}` tool actions, deliberately excluded from what the
candidate sees. Nothing in either fixture is an assistant target. To produce a single Fireworks SFT
JSONL row or a single Tinker `Datum`, we must first **replay the oracle** against the environment
and synthesize the assistant `tool_calls` messages and the resulting `tool` observation messages.
That is privileged teacher supervision we are manufacturing, not data we already have. Our own
`src/training-plan/index.ts:105-127` already enforces "chat rows must end in an assistant target",
so the repo will reject these fixtures today.

**Delta 2 — dataset size is 2–3 orders of magnitude too small.** The cookbook's smallest real
example is 32 rows and its SFT example is 100; Tinker's `sl_basic` default is 9,500 rows at batch
128. AutomationBench yields at most **48 train rows** (60 including dev), sanitized synthetic **5**.
Neither is a viable SFT corpus. They are eval/RL fixtures. This matches our own prior negative
result that ~1K examples was already too few for variable-length tool-call generation.

**Delta 3 — outcome-contract grading has no SFT analogue; it maps onto the RL lane.** The natural
provider path for our fixtures is **not** the SFT cookbook but the RL cookbook: the
`serverless_rl/countdown_rl.py` loop is structurally the right shape — sample a group, score with a
local reward function, compute group-relative advantages, `forward_backward(..., "importance_
sampling")`. Our `partialCredit` scorer drops in exactly where `composite_reward` sits. The gaps
that remain are mechanical rather than conceptual:

1. **Multi-turn rollouts.** `countdown_rl.py` samples one completion per prompt and scores the
   text. Our tasks need an agent loop of up to 12 tool-call/observation turns per episode, with the
   `WorldState` mutating in between, before a terminal score exists. Both providers' *serverless*
   sampling surfaces are single-shot `sample()` calls; the turn loop and KV-cache session affinity
   are ours to write.
2. **Tool schemas.** Both fixtures describe the two tools in prose, not JSON Schema. A provider
   tool-calling render path needs real function schemas.
3. **Loss masking over tool calls.** Our existing Tinker runtime masks
   `TrainOnWhat.LAST_ASSISTANT_MESSAGE` (`src/tinker-sft/index.ts:51-72`), which cannot express
   "train on every assistant tool-call turn, not on the tool observations". A new renderer and mask
   are required on both vendors.
4. **Holdout discipline.** Our fixtures fail closed behind a split hash; the cookbook loops have no
   split concept at all and will happily wrap around the dataset (`_next_batch` reuses rows
   modulo dataset length).

### What would have to change to run our tasks through each lane

| Lane | Work required |
|---|---|
|---|---|
| Fireworks serverless RL | Write a multi-turn rollout driver around `sample()`; expose `partialCredit` as the reward fn; emit importance-sampling datums per assistant turn. Environment stays local — **no data leaves our process except rendered prompts and sampled tokens.** Lowest-friction path. |
| Fireworks serverless SFT | Requires Delta 1 (oracle replay → synthetic gold) and Delta 2 (more episodes). Verified working surface: `forward_backward(datums, "cross_entropy")` is accepted. |
| Fireworks dedicated / managed | Same data problem as above, plus provisioning latency and GPU-hour billing (see §4). Only worth it for full-parameter work or an unsupported base model. |
| Tinker | Identical to the Fireworks serverless story — same primitives, same prices, same masking gap. `verifiers_rl` recipe is the closer analogue for outcome-contract grading than `sl_basic`. |

---

## 7. Recommendation

1. **Do not use the dedicated Training API for our fixtures.** Our tasks are 72 and 9 episodes.
   At that scale the dedicated lane is 604 s and ~$5.64 of provisioning to do ~50 s of work; the
   serverless lane does the same for half a cent with a 1.1 s attach. Reserve dedicated for
   full-parameter runs or base models with no serverless shape.
2. **Treat Fireworks serverless training and Tinker as interchangeable.** Same primitives, same
   models, same prices, same latencies within noise. Write one runtime against the Tinker-shaped
   protocol and point it at either vendor — our `src/training-backends/index.ts` abstraction is
   already the right shape for this.
3. **Target the RL/verifier lane, not SFT, for AutomationBench and the sanitized synthetic fixtures.** The blocking issue is
   not throughput, it is that we have no assistant targets (§6, Delta 1) and 48 train rows
   (Delta 2). `serverless_rl/countdown_rl.py` is the structurally correct template; the work is a
   multi-turn rollout driver, JSON-Schema tool definitions, and a per-assistant-turn loss mask.
4. **If we do want an SFT lane, the cost is oracle replay.** Replaying the grader-side oracle to
   synthesize assistant tool-call turns is a real data-generation project, and the resulting
   corpus is still ~50 episodes. Expect to need synthetic task expansion before SFT is meaningful.
5. **Measure TTFT elsewhere.** Neither training SDK exposes a first-token event. If time-to-first-
   token matters for our agent loop, instrument the inference API directly.
