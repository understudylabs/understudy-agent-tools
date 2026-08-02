# Spark serving lane

This is the paused, ready-to-run recipe for the self-hosted NVIDIA DGX Spark
lane. Enrollment is intentionally not performed by this repository today:
the operator must provide `TAILSCALE_AUTH_KEY` as an organization secret before
running the bootstrap command.

## Ground truth and prerequisites

The current node table is maintained in the Spark lab `RUNBOOK.md` and
`ROADMAP.md`:

| Node | Tailscale address | Serving port |
|---|---|---:|
| Alpha (`understudy-alpha`) | `100.109.118.78` | `5153` |
| Bravo (`understudy-bravo`) | `100.100.181.10` | `5153` |

The ACL scope for this lane allows ports 22, 443, and 5153 on those nodes.
Bind the serving endpoint to port 5153; do not invent another port.

`DEVIN_SPARK_ACCESS.md` does not exist in the Spark lab yet. Until it lands,
`RUNBOOK.md` and `ROADMAP.md` are the source of truth. Re-check this recipe
against `DEVIN_SPARK_ACCESS.md` when that document is added.

The operator needs:

- Docker with GPU access on the Spark.
- The pinned NVIDIA container `nvcr.io/nvidia/vllm:26.05.post1-py3`.
- The pinned model revision and reasoning-parser file from
  `serve_nemotron3_nano.sh`.
- A public/synthetic smoke prompt only; do not use private traces or sealed
  holdouts during setup.
- A Tailscale organization secret exported at runtime as
  `TAILSCALE_AUTH_KEY`. Never put the value in a file or command history.

## Spark-side account and key preparation

Run these commands manually on each Spark as a human administrator. This is
the only documented `sudo` section; the Devin-side bootstrap does not use sudo.

```bash
sudo useradd --create-home --shell /bin/bash devin
sudo install -d -m 700 -o devin -g devin /home/devin/.ssh
```

On the Devin box, generate a dedicated key that is not a human login key:

```bash
ssh-keygen -t ed25519 -C devin@understudy \
  -f ~/.ssh/id_ed25519_devin_spark
```

Install only the generated public key on each Spark:

```bash
sudo tee -a /home/devin/.ssh/authorized_keys < ~/.ssh/id_ed25519_devin_spark.pub
sudo chown devin:devin /home/devin/.ssh/authorized_keys
sudo chmod 600 /home/devin/.ssh/authorized_keys
```

Verify the key and account with a human administrator before handing the
connection to an automation agent:

```bash
ssh -i ~/.ssh/id_ed25519_devin_spark devin@100.109.118.78 true
ssh -i ~/.ssh/id_ed25519_devin_spark devin@100.100.181.10 true
```

## Enroll this box and smoke-test

Enrollment remains paused until the organization secret exists. Once it does,
run one command from this repository:

```bash
export TAILSCALE_AUTH_KEY='provided-by-the-organization-secret-store'
bash scripts/spark-lane-bootstrap.sh
```

The script uses a userspace Tailscale daemon and is idempotent. It does not
echo the key, use sudo, enable Tailscale SSH, or accept routes. Without the
secret it exits 2 with an actionable message and does not contact the
Tailscale control plane.

The re-runnable probe can be run independently:

```bash
node scripts/spark-reachability-probe.mjs
```

It reports JSON on stdout and a short summary on stderr. The default probe
checks peer presence/online state, TCP 22, and
`GET http://<spark-ip>:5153/v1/models`.

## Multi-LoRA launch

The verified single-model recipe uses:

- `nvcr.io/nvidia/vllm:26.05.post1-py3`
- `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4`
- revision `ce1b118ae66ec705d02c241525192832eb045fd3`
- `--quantization modelopt_fp4`
- `--kv-cache-dtype fp8`
- `--moe-backend marlin`
- pinned `nano_v3_reasoning_parser.py`
- `--gpu-memory-utilization 0.55`
- `--max-model-len 65536 --max-num-seqs 4`
- `--enable-auto-tool-choice --tool-call-parser qwen3_coder`

The following extends that recipe for a static multi-LoRA deployment. Replace
`<TAILSCALE_IP>`, `N`, `R`, `M`, and adapter paths with values approved for the
specific node:

```bash
MODEL="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4"
REVISION="ce1b118ae66ec705d02c241525192832eb045fd3"
CACHE_DIR="$HOME/.cache/huggingface"
PARSER="$CACHE_DIR/hub/models--nvidia--NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4/snapshots/$REVISION/nano_v3_reasoning_parser.py"

docker run --rm --name nemotron3-nano \
  --gpus all --ipc=host --shm-size=16g \
  --ulimit memlock=-1 --ulimit stack=67108864 \
  -e HF_HUB_OFFLINE=1 \
  -e VLLM_NVFP4_GEMM_BACKEND=marlin \
  -v "$CACHE_DIR:/root/.cache/huggingface" \
  -v "$PARSER:/app/nano_v3_reasoning_parser.py:ro" \
  -p 5153:5153 \
  nvcr.io/nvidia/vllm:26.05.post1-py3 \
  vllm serve "$MODEL" \
  --revision "$REVISION" \
  --served-model-name nvidia/nemotron-3-nano \
  --host <TAILSCALE_IP> --port 5153 \
  --trust-remote-code \
  --dtype auto --quantization modelopt_fp4 --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.55 \
  --max-model-len 65536 --max-num-seqs 4 \
  --enable-chunked-prefill --enable-prefix-caching --async-scheduling \
  --moe-backend marlin --mamba-ssm-cache-dtype float16 \
  --enable-lora --max-loras N --max-lora-rank R --max-cpu-loras M \
  --lora-modules adapter-name=/models/adapter-name \
  --reasoning-parser-plugin /app/nano_v3_reasoning_parser.py \
  --reasoning-parser nano_v3 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder
```

Static `--lora-modules` is the simplest registry placement: the public
adapter name is mapped to the lane-local path in
`src/serving-registry.ts`. If the image and model support runtime updates, the
alternative is:

```bash
VLLM_ALLOW_RUNTIME_LORA_UPDATING=1
curl -X POST http://127.0.0.1:5153/v1/load_lora_adapter \
  -H 'content-type: application/json' \
  -d '{"lora_name":"adapter-name","lora_path":"/models/adapter-name"}'
```

Runtime loading must be validated on the exact image and model before use.
The endpoint is not a substitute for an artifact hash or registry entry.

## Memory fit and honest performance status

The Spark lab records 128 GB unified memory and a published local-memory
bandwidth figure of 273 GB/s in `ROADMAP.md`. The following is planning
arithmetic, not a measurement of this serving command:

- NVFP4 weights: `30B parameters × 0.5 bytes ≈ 15 GB` before runtime metadata,
  KV cache, CUDA allocations, and adapters.
- BF16 fallback weights: `30B × 2 bytes ≈ 60 GB`, leaving materially less
  headroom.
- At `65536` context and four sequences, KV-cache usage depends on the exact
  model architecture, dtype, scheduler, and prompt mix; it cannot be inferred
  honestly from parameter count alone.
- Each adapter adds its own weights and runtime bookkeeping. `N` and `M` must
  be chosen from an observed memory profile, not from this document.

Recommendation: try the pinned NVFP4 recipe first, but treat LoRA support on
top of `modelopt_fp4` weights with the Marlin MoE backend as **UNVERIFIED —
verify on hardware**. If it fails to load, produces incorrect output, or
cannot attach adapters, use BF16 as the fallback with a higher
`--gpu-memory-utilization` only after measuring available memory and with a
reduced `--max-model-len` (for example 32768) and fewer concurrent sequences.

It is also **UNVERIFIED — verify on hardware** whether the requested adapter
targets are supported: vLLM LoRA generally does not cover MoE expert weights,
so adapters should target attention/dense projections such as `q_proj`,
`k_proj`, `v_proj`, `o_proj`, and supported MLP projections.

No Nemotron-3-Nano GB10 tokens-per-second measurement was found in the checked
Spark lab result files or baseline documents. Therefore no measured serving
number is claimed here. A rough bandwidth-bound estimate would be:

```text
3B active parameters × 0.5 bytes/parameter ÷ 273 GB/s
≈ 5.5 ms/token ≈ 182 tokens/s
```

This is an **ESTIMATE**, not a benchmark: 273 GB/s is the published
specification cited by `ROADMAP.md`, and real generation includes routing,
kernel, KV-cache, synchronization, and software overhead. The active-parameter
assumption also does not predict total weight traffic for every implementation.

## Hardware verification checklist

Before registering an adapter as `ready`:

1. Confirm the exact container digest and model revision.
2. Start the base model and verify `GET /v1/models` on port 5153.
3. Load one synthetic adapter and verify the adapter appears in the response
   or in the model's documented runtime state.
4. Send a synthetic `/v1/chat/completions` request with the public adapter name
   rewritten to its lane-local id.
5. Check tool-call parsing with a synthetic tool schema.
6. Record peak unified memory, KV-cache allocation, prompt length, output
   tokens, first-token latency, and steady tokens/s.
7. Repeat with the intended `N`, `R`, `M`, context length, and concurrency.
8. Only then change the adapter status from `loading` to `ready`.
