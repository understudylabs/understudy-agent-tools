#!/usr/bin/env bash
set -euo pipefail

# PREPARED BUT UNLAUNCHED. Derived from the Spark Lab script; upstream this
# variant to that repository before using it as a production serving recipe.

MODEL="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4"
REVISION="${REVISION:-ce1b118ae66ec705d02c241525192832eb045fd3}"
CACHE_DIR="${CACHE_DIR:-$HOME/.cache/huggingface}"
PORT="${PORT:-5153}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-65536}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.55}"
MAX_LORAS="${MAX_LORAS:-4}"
MAX_LORA_RANK="${MAX_LORA_RANK:-64}"
PARSER="$CACHE_DIR/hub/models--nvidia--NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4/snapshots/$REVISION/nano_v3_reasoning_parser.py"

[[ -f "$PARSER" ]] || {
  echo "Missing pinned Nemotron reasoning parser: $PARSER" >&2
  exit 2
}

vllm_args=(
  serve "$MODEL"
  --revision "$REVISION"
  --served-model-name nvidia/nemotron-3-nano
  --host 0.0.0.0
  --port "$PORT"
  --trust-remote-code
  --dtype auto
  --quantization modelopt_fp4
  --kv-cache-dtype fp8
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --max-model-len "$MAX_MODEL_LEN"
  --max-num-seqs 4
  --enable-chunked-prefill
  --enable-prefix-caching
  --async-scheduling
  --moe-backend marlin
  --mamba-ssm-cache-dtype float16
  --reasoning-parser-plugin /app/nano_v3_reasoning_parser.py
  --reasoning-parser nano_v3
  --enable-auto-tool-choice
  --tool-call-parser qwen3_coder
)

if [[ -n "${LORA_MODULES:-}" ]]; then
  IFS=',' read -r -a lora_modules <<<"$LORA_MODULES"
  valid_lora_modules=()
  for module in "${lora_modules[@]}"; do
    [[ -n "$module" ]] && valid_lora_modules+=("$module")
  done
  if ((${#valid_lora_modules[@]} > 0)); then
    vllm_args+=(
      --enable-lora
      --max-loras "$MAX_LORAS"
      --max-lora-rank "$MAX_LORA_RANK"
      --lora-modules
      "${valid_lora_modules[@]}"
    )
  fi
fi

exec docker run --rm --name nemotron3-nano-lora \
  --gpus all --ipc=host --shm-size=16g \
  --ulimit memlock=-1 --ulimit stack=67108864 \
  -e HF_HUB_OFFLINE=1 \
  -e VLLM_NVFP4_GEMM_BACKEND=marlin \
  -v "$CACHE_DIR:/root/.cache/huggingface" \
  -v "$PARSER:/app/nano_v3_reasoning_parser.py:ro" \
  -p "$PORT:$PORT" \
  nvcr.io/nvidia/vllm:26.05.post1-py3 \
  "${vllm_args[@]}"
