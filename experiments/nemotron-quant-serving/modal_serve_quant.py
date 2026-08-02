"""Serve the same Nemotron-3-Nano weights at BF16, FP8, and NVFP4 on one GPU class.

Isolated Modal glue for the quantization-for-serving arm. Three OpenAI-compatible
vLLM endpoints differing only in the weight precision of the checkpoint they load,
so a score delta measured through the AutomationBench v2 verifier is attributable
to precision and not to hardware, engine, renderer, or sampling.

Every endpoint runs on the same GPU class (Blackwell B200: the only Modal GPU that
executes BF16, FP8, and NVFP4 natively), the same pinned vLLM, the same context and
concurrency limits, and the same reasoning/tool-call parsers. Each scales to zero
after an idle window.

Deploy (public weights only, no private data ever reaches this app). The secret is
created per run and deleted at teardown, so the endpoints are never left reachable
with a long-lived key:

    modal secret create understudy-quant-serve-key \
      QUANT_SERVE_API_KEY=<fresh alphanumeric token> HF_TOKEN=<hf read token>
    modal deploy experiments/nemotron-quant-serving/modal_serve_quant.py

Endpoints:

    https://<workspace>--understudy-nemotron-quant-lab-serve-{bf16,fp8,nvfp4}.modal.run/v1
"""

import os
import subprocess

import modal

APP_NAME = "understudy-nemotron-quant-lab"
VLLM_VERSION = "0.26.0"
GPU = "B200"

# Same base weights, three published precisions. Revisions are pinned so a rerun
# scores the identical bytes.
VARIANTS = {
    "bf16": {
        "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        "revision": "2d59de1cbd51c0adf384eb906b766d1aee0e0517",
        "env": {},
        "extra_args": [],
    },
    "fp8": {
        "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8",
        "revision": "f8dc1c0afee92f44417695b4f5ddca9afc95ea58",
        "env": {"VLLM_USE_FLASHINFER_MOE_FP8": "1"},
        "extra_args": [],
    },
    "nvfp4": {
        "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4",
        "revision": "ce1b118ae66ec705d02c241525192832eb045fd3",
        "env": {"VLLM_USE_FLASHINFER_MOE_FP4": "1", "VLLM_FLASHINFER_MOE_BACKEND": "throughput"},
        # The NVFP4 checkpoint ships with an FP8 KV cache in its published recipe.
        "extra_args": ["--kv-cache-dtype", "fp8"],
    },
}

# Held identical across the three lanes; only the checkpoint precision varies.
MAX_MODEL_LEN = 32768
MAX_NUM_SEQS = 16
GPU_MEMORY_UTILIZATION = 0.90
SCALEDOWN_WINDOW = 120

vllm_image = (
    # A CUDA *devel* base, not slim: FlashInfer JIT-compiles its sampling and
    # FP4/FP8 MoE kernels at engine start and aborts without nvcc and CUDA headers.
    modal.Image.from_registry("nvidia/cuda:13.0.1-devel-ubuntu24.04", add_python="3.12")
    .pip_install(
        f"vllm=={VLLM_VERSION}",
        "huggingface_hub[hf_transfer]",
        "flashinfer-python",
    )
    .env(
        {
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_USE_V1": "1",
            "CUDA_HOME": "/usr/local/cuda",
            # JIT artifacts land on a Volume so only the first lane pays for them.
            "FLASHINFER_CACHE_DIR": "/root/.cache/flashinfer",
        }
    )
)

app = modal.App(APP_NAME)
hf_cache = modal.Volume.from_name("understudy-nemotron-weights", create_if_missing=True)
vllm_cache = modal.Volume.from_name("understudy-vllm-compile-cache", create_if_missing=True)
flashinfer_cache = modal.Volume.from_name("understudy-flashinfer-cache", create_if_missing=True)
# Holds HF_TOKEN (weight pulls) and QUANT_SERVE_API_KEY (endpoint auth).
serve_secret = modal.Secret.from_name("understudy-quant-serve-key")


def _launch(variant: str) -> None:
    """Start `vllm serve` for one precision and let Modal proxy port 8000."""
    spec = VARIANTS[variant]
    os.environ.update(spec["env"])

    command = [
        "vllm",
        "serve",
        spec["model"],
        "--revision",
        spec["revision"],
        "--served-model-name",
        f"nemotron-3-nano-{variant}",
        "--host",
        "0.0.0.0",
        "--port",
        "8000",
        "--trust-remote-code",
        "--tensor-parallel-size",
        "1",
        "--max-model-len",
        str(MAX_MODEL_LEN),
        "--max-num-seqs",
        str(MAX_NUM_SEQS),
        "--gpu-memory-utilization",
        str(GPU_MEMORY_UTILIZATION),
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "qwen3_coder",
        "--reasoning-parser",
        "nano_v3",
        *spec["extra_args"],
    ]

    parser = _fetch_reasoning_parser(spec["model"], spec["revision"])
    if parser:
        command += ["--reasoning-parser-plugin", parser]

    api_key = os.environ.get("QUANT_SERVE_API_KEY", "").strip()
    # One token, never a bare flag: a value beginning with "-" is otherwise parsed
    # as another option and the server crash-loops before it reaches the GPU.
    if api_key:
        command.append(f"--api-key={api_key}")

    # argv form, no shell: the key stays a single token and is never re-parsed.
    subprocess.Popen(command)


def _fetch_reasoning_parser(model: str, revision: str) -> str | None:
    """The nano_v3 reasoning parser ships inside the model repo, not inside vLLM."""
    from huggingface_hub import hf_hub_download

    try:
        return hf_hub_download(model, "nano_v3_reasoning_parser.py", revision=revision)
    except Exception:
        return None


SERVE_OPTIONS = dict(
    image=vllm_image,
    gpu=GPU,
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
        "/root/.cache/flashinfer": flashinfer_cache,
    },
    secrets=[serve_secret],
    timeout=60 * 60,
    scaledown_window=SCALEDOWN_WINDOW,
    max_containers=1,
)


@app.function(**SERVE_OPTIONS)
@modal.concurrent(max_inputs=MAX_NUM_SEQS)
@modal.web_server(port=8000, startup_timeout=60 * 25)
def serve_bf16() -> None:
    _launch("bf16")


@app.function(**SERVE_OPTIONS)
@modal.concurrent(max_inputs=MAX_NUM_SEQS)
@modal.web_server(port=8000, startup_timeout=60 * 25)
def serve_fp8() -> None:
    _launch("fp8")


@app.function(**SERVE_OPTIONS)
@modal.concurrent(max_inputs=MAX_NUM_SEQS)
@modal.web_server(port=8000, startup_timeout=60 * 25)
def serve_nvfp4() -> None:
    _launch("nvfp4")
