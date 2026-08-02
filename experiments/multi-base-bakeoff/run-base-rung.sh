#!/usr/bin/env bash
# Base rung of the bake-off: score every candidate base, in both of its
# thinking modes, on the dev split through the shared contract. The mode a base
# carries through the rest of the ladder is picked here, on dev — never on the
# sealed holdout.
#
# Assumes one `scripts/tinker-openai-shim.py` per (base, renderer) is already
# listening on the port named below.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-outputs/bakeoff}
CONC=${CONC:-6}

run() { # port model renderer label
  node experiments/multi-base-bakeoff/run-eval.mjs \
    --label "$4" --rung base --lane tinker --renderer "$3" \
    --base-url "http://127.0.0.1:$1/v1" --model "$2" \
    --split dev --concurrency "$CONC" \
    --out "$OUT/$4-dev.json" > "$OUT/$4-dev.summary.json"
  echo "done $4"
}

mkdir -p "$OUT"
run 8101 Qwen/Qwen3.5-9B  qwen3_5_disable_thinking qwen3.5-9b-base-nothink &
run 8103 Qwen/Qwen3.6-27B qwen3_5_disable_thinking qwen3.6-27b-base-nothink &
run 8105 nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 nemotron3 nemotron3-nano-base-think &
wait
run 8102 Qwen/Qwen3.5-9B  qwen3_5 qwen3.5-9b-base-think &
run 8104 Qwen/Qwen3.6-27B qwen3_5 qwen3.6-27b-base-think &
run 8106 nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 nemotron3_disable_thinking nemotron3-nano-base-nothink &
wait
