# Quantization for serving — Nemotron-3-Nano at BF16 vs FP8 vs NVFP4

Goal: quantify what cheaper serving precision costs in task quality, so a serving
precision can be chosen against a bar that was set before the numbers arrived.

**Status: the quality half is NOT measured.** Mid-session the arm was redirected to
"executors: contract + TESTS ONLY, no provider calls" and "do NOT run or enable
HOLDOUT". So this directory ships the measurement contract, the executor adapter, and
the two harness scripts — plus the serving facts that were observed before the
redirect — and states plainly that no quant-vs-quality table exists yet. The table is
one authorized run away; every number in it is produced by the scripts here.

Deliverable shape for the unified Workflow: **verifier/contract + executor**.

| Piece | Kind | Interface |
| --- | --- | --- |
| `modal-quant-executor.mjs` | executor | `submit` / `inspect` / `cancel` / `reconcileUsage` over `understudy.executor-submit.v1`; idempotency key = sha256(executor, experiment_id, candidate_id, attempt) |
| `quant-cost-report.mjs` | artifact contract | emits `understudy.quant_serving_report.v1` from finished run artifacts |
| `throughput-probe.mjs` | artifact contract | emits `understudy.serving_throughput.v1` from a served endpoint |
| `modal_serve_quant.py` | executor lane definition | three vLLM web endpoints, one per precision, scale-to-zero |

The executor owns no queue, no poller and no state database. Run state belongs to the
Workflow; this adapter is a translation layer over an injected Modal driver, which is
why its tests need no provider.

## Predeclared quality tolerance

Declared before any scoring run, and encoded as `TOLERANCE` in `quant-cost-report.mjs`
so it cannot be loosened after the fact without showing up in a diff. A cheaper
precision is recommendable only if, against BF16 on the same frozen splits:

| Bar | Threshold |
| --- | --- |
| dev mean score drop | ≤ 0.02 |
| sealed-holdout mean score drop | ≤ 0.03 |
| any difficulty band mean drop | ≤ 0.05 |
| increase in forbidden writes | 0 |

Among the lanes that clear all four, the recommendation is simply the cheapest per
million output tokens. The band bar exists because a mean can hide a precision that
has stopped being able to do the hard tasks; the forbidden-write bar exists because
writing to a record the task did not ask about is a safety failure, not a score.

## Protocol parity

Everything except weight precision is held fixed, otherwise a score delta is not
attributable to quantization: same fixture (`automationbench-simple-api-offline-v2`,
216 tasks, dev 36 / holdout 60), same verifier (`src/automationbench-offline.ts`,
terminal-state partial credit), same system prompt and strict one-JSON-object action
protocol, same renderer and chat template, same `nano_v3` reasoning parser and
`qwen3_coder` tool-call parser, same sampling (temperature 0), same
`--max-model-len 32768` / `--max-num-seqs 16`, same GPU class.

One deliberate asymmetry: the NVFP4 lane runs `--kv-cache-dtype fp8`, which is the
published NVIDIA recipe for that checkpoint. That makes the NVFP4 lane a
*deployable configuration* rather than a clean single-variable comparison, so any
NVFP4 quality gap needs a control run with `--kv-cache-dtype auto` before it is
blamed on the weights. That control is the first follow-up run.

## Serving support — what was actually observed

Measured on Modal B200 with vLLM 0.26.0 before the redirect. Weight sizes are the
published repository sizes; the load figures come from a real NVFP4 engine start.

| Precision | HF repo size | vLLM support | Observed on B200 |
| --- | --- | --- | --- |
| BF16 | 63.2 GB | vLLM ≥ 0.12.0 | not started (no B200 capacity before redirect) |
| FP8 | 32.7 GB | vLLM ≥ 0.12.0, `VLLM_USE_FLASHINFER_MOE_FP8=1` | not started |
| NVFP4 | 19.4 GB | vLLM ≥ 0.12.0 on Blackwell only, `VLLM_USE_FLASHINFER_MOE_FP4=1` | weights loaded in 11.85 s; engine reported **19.39 GiB** and 61.98 s for model loading; torch.compile dynamo 5.64 s |

Modal GPU list price at the time of writing: H100 $3.9492/hr, H200 $4.5396/hr,
B200 $6.2496/hr. NVFP4 needs Blackwell, so an all-precision comparison has to run on
B200 for every lane — comparing an NVFP4 B200 lane against a BF16 H200 lane measures
the GPU, not the quantization.

Three findings worth carrying forward:

1. **A slim image cannot serve these checkpoints.** FlashInfer JIT-compiles its
   sampling and FP4/FP8 MoE kernels at engine start; on `debian_slim` it aborts with
   `Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist` after
   the weights are already resident. The lane uses a CUDA *devel* base image.
2. **NVFP4 pays a shape tax on this architecture.** vLLM padded the hidden size from
   2688 to 2816 and the intermediate size from 1856 to 1920 for TRTLLM NVFP4 MoE
   weights, warning that the resulting runtime activation slicing "may cause
   performance degradation" — so the NVFP4 throughput win here will be smaller than
   the 3.3× weight-size reduction suggests.
3. **The FP8 KV cache in the NVFP4 recipe is uncalibrated.** The checkpoint ships no
   q/prob scaling factors, and vLLM falls back to 1.0 with an explicit accuracy
   warning. This is the concrete mechanism by which the NVFP4 lane could lose quality
   for reasons that have nothing to do with 4-bit weights.

## Not measured

No dev scores, no holdout scores, no tokens/s, no $/1M tokens. Holdout status is
`sealed_not_run` and the claim boundary is `none` — **the holdout was never read**: it
stays clean, hash `2f8d0fa9…a889c9`, and the submit contract has no field that could
carry it. Nothing in this directory reports a quality number, and
`quant-cost-report.mjs` returns `recommended_precision: null` rather than guessing
when a lane has no measured price.

Two independent obstacles also stood in the way and would need resolving before an
authorized run: B200 capacity was unavailable for ~30 minutes (containers stuck
`Pending`), and the lab app was stopped three times mid-cold-start by something
outside this session ("user stopped from CLI"), each time killing an in-flight engine
init after several GPU-minutes.

## Running it, once authorized

```bash
modal deploy experiments/nemotron-quant-serving/modal_serve_quant.py

# Per precision: dev first, throughput second, holdout last and exactly once.
node scripts/automationbench-v2-zeroshot.mjs \
  --model nemotron-3-nano-fp8 --split dev --temperature 0 --max-tokens 1536 \
  --base-url "$LANE_URL/v1" --out outputs/quant-fp8-dev.json

node experiments/nemotron-quant-serving/throughput-probe.mjs \
  --base-url "$LANE_URL/v1" --model nemotron-3-nano-fp8 \
  --gpu B200 --gpu-usd-per-hour 6.2496 --out outputs/throughput-fp8.json

node experiments/nemotron-quant-serving/quant-cost-report.mjs --reference bf16 \
  --lane bf16:outputs/quant-bf16-dev.json:outputs/quant-bf16-holdout.json:outputs/throughput-bf16.json \
  --lane fp8:outputs/quant-fp8-dev.json:outputs/quant-fp8-holdout.json:outputs/throughput-fp8.json \
  --lane nvfp4:outputs/quant-nvfp4-dev.json:outputs/quant-nvfp4-holdout.json:outputs/throughput-nvfp4.json \
  --out outputs/quant-serving-report.json
```

Verify `/v1/models` reports the expected `nemotron-3-nano-<precision>` name and that
tool calls parse, on every lane, before comparing any scores: a lane that silently
served a different checkpoint or dropped its tool parser produces a quality "delta"
that is really a configuration bug. Run outputs stay local; only the sanitized report
is committed.

## Receipts

- Modal app `understudy-nemotron-quant-lab` stopped; 0 containers running.
- Endpoint API-key secret `understudy-quant-serve-key` deleted, local copy removed.
- Weight/compile-cache Volumes kept — they hold public weights only, and they are
  what makes the next cold start cheap.
- Holdout: `sealed_not_run` (never read, never constructed).
