#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/vllm-venv/bin:$HOME/.local/bin:$PATH"
DEV="$HOME/.local/python-dev/usr/include"
export CPATH="$DEV:$DEV/python3.12:$DEV/aarch64-linux-gnu/python3.12:$DEV/aarch64-linux-gnu"
export C_INCLUDE_PATH="$CPATH"
export CPLUS_INCLUDE_PATH="$CPATH"
unset TRITON_CACHE_DIR
export VLLM_API_KEY="$(cat "$HOME/.vllm-key")"

exec vllm serve \
  "$HOME/models/nemotron3-nano-30b-a3b-bf16" \
  --host 100.109.118.78 \
  --port 5153 \
  --served-model-name nemotron3-nano-base \
  --gpu-memory-utilization 0.70 \
  --max-model-len 16384 \
  --enforce-eager \
  --enable-lora \
  --max-loras 2 \
  --max-lora-rank 32 \
  --lora-modules \
    adapter-a-vllm-partial="$HOME/adapters/adapter-a-vllm-partial" \
    adapter-b-vllm-partial="$HOME/adapters/adapter-b-vllm-partial"
