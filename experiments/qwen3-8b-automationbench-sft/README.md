# Qwen3-8B LoRA SFT on the offline AutomationBench `simple/api` fixture

Arm: cheap/fast same-fixture reference. Base `accounts/fireworks/models/qwen3-8b`,
LoRA SFT rank 16, 3 epochs, trained on oracle trajectories from the **48 train
tasks only**. Authoritative evaluator is `src/automationbench-offline.ts`
(offline, deterministic, terminal final-state `partial_credit` — not tool-name
accuracy).

## Result

| run | train (48) | dev (12) | holdout (12) |
| --- | --- | --- | --- |
| base (untuned) | 0.4410 | 0.5000 | 0.4444 |
| LoRA SFT r16 e3 | 0.4896 | **0.5833** | **0.4583** |

Selection used **dev only** (single checkpoint, +0.083 over base). The holdout
split was run once per model at the end, gated on the frozen hash
`a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`, and
influenced nothing. On 12 holdout tasks the +0.014 gap is inside noise: the
honest read is **no demonstrated holdout gain**.

Pre-flight gates: oracle policy scored 1.0000 and the reward-hacking sentinel
scored 0.0000 over train+dev before any model ran. No malformed tool calls were
emitted by either model in any run.

### Where the tuning moved, and where it hurt

Per difficulty band (train / dev):

| band | base | tuned |
| --- | --- | --- |
| single-write | 0.688 / 1.000 | 0.625 / 0.750 |
| discovery | 0.000 / 0.000 | 0.312 / 0.500 |
| multi-write | 0.635 / 0.500 | 0.531 / 0.500 |

SFT bought the whole gain on the **discovery** band, which the untuned model
scored a flat zero on — it never learned to list before writing. The cost was a
regression on the easy single-write band plus a new failure mode: mean episode
length went 3.3 → 8.2 steps (train), many episodes ran to the 12-step ceiling,
and forbidden out-of-scope writes went 0 → 5 (train) and 1 → 2 (dev). Any
forbidden write zeroes the task reward, so over-acting directly cancels part of
what discovery gained. This matches the known small-base failure mode: SFT
teaches which tools to call long before it teaches when to stop.

The likely first-order cause is dataset size, not method: 48 examples over 3
epochs is **6 optimizer steps** (loss 2.20 → 0.227). More train tasks, or
explicit stop/length supervision, is the next lever — not a bigger rank.

## Serving path (this is the portability finding)

`qwen3-8b` has `supportsServerless: false` on Fireworks, which is the source of
the previously observed serverless tool-calling 404. It must be served from a
dedicated deployment. Constraints found the hard way:

- `--enable-addons` is rejected with FP8/FP4 precision, and the model's default
  draft model is FP8 — so addon-style LoRA serving needs
  `--precision BF16 --disable-speculative-decoding --enable-addons`.
- That BF16+addons shape then failed to start (`INTERNAL`) on A100 (twice) and
  H200. Only the two published shapes work: `qwen3-8b-minimal`
  (1x H200, FP8) and `rft-qwen3-8b` (1x B200, FP8).
- H100/H200/B200 quota was fully consumed by sibling arms, so both deployments
  ran as an explicit 1x `NVIDIA_B300_288GB` FP8 shape.
- The working pattern is therefore **not** base+addon on one deployment but two
  identical FP8 deployments: one of the base model, one of the PEFT addon model
  (`firectl deployment create accounts/<acct>/models/<sft-model>`), which
  Fireworks serves directly. Both accept native OpenAI `tools`.

## Receipts

| | |
| --- | --- |
| provider | fireworks |
| base model | `accounts/fireworks/models/qwen3-8b` |
| checkpoint | `accounts/understudy-dev/models/qwen3-8b-abo-simpleapi-sft-r16e3` (HF_PEFT_ADDON, r=16) |
| SFT job | `qwen3-8b-abo-sft-r16e3`, 6 optimizer steps, 92,490 trained tokens, 6 min |
| deployments | `qwen3-8b-abo-base3`, `qwen3-8b-abo-tuned` (1x B300 FP8) — both deleted |
| cost | $0.046 training + $1.76 serving (527 accelerator-seconds @ $12/GPU-hr) = **$1.81** |
| latency | ~0.4 s mean per tool-calling request |

## Reproducing

```sh
npm ci && npm run build
node experiments/qwen3-8b-automationbench-sft/sanity-check.mjs
node experiments/qwen3-8b-automationbench-sft/build-sft-dataset.mjs
node experiments/qwen3-8b-automationbench-sft/run-eval.mjs \
  --split dev --model <model#deployment> \
  --base-url https://api.fireworks.ai/inference/v1 \
  --out results/tuned-dev.json
```

`run-eval.mjs` refuses the holdout split unless `--frozen-holdout-sha256`
matches. Raw per-task rows for every run in this note are under `results/`.
