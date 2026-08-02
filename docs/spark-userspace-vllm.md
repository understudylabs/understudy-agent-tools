# Userspace vLLM on a DGX Spark (no sudo, no Docker)

The container recipe in [`spark-serving-lane.md`](spark-serving-lane.md) assumes
Docker with GPU access. A non-privileged automation account does not have that:
on our Sparks the `devin` account gets `permission denied` on
`/var/run/docker.sock` and `sudo -n` answers `a password is required`. This
document records the userspace path that works instead, and what it cannot do.

Everything below was executed as the unprivileged `devin` account on Alpha
(`aarch64`, NVIDIA GB10, driver `580.159.03`, CUDA 13.0, 121 GiB unified
memory).

## Install

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv venv --python /usr/bin/python3.12 "$HOME/vllm-venv"
uv pip install --python "$HOME/vllm-venv/bin/python" vllm
```

This resolves `vllm==0.26.0` with `torch==2.11.0+cu130` and prebuilt aarch64
wheels — no source build, no root. Verified from inside the venv:

```text
torch.cuda.is_available() = True
torch.cuda.get_device_capability() = (12, 1)
torch.cuda.get_arch_list() = ['sm_80', 'sm_90', 'sm_100', 'sm_110', 'sm_120']
```

### Python headers without root

vLLM's Triton path JIT-compiles small C shims at import and at request time,
and the generated `gcc` command line hard-codes `-I/usr/include/python3.12`. If
the system `python3.12-dev` package is absent, that compile fails with:

```text
fatal error: Python.h: No such file or directory
```

Fetch and unpack the headers into the account's own tree instead of installing
a system package:

```bash
cd "$HOME/.local" && mkdir -p python-dev && cd python-dev
apt-get download python3.12-dev libpython3.12-dev
for deb in *.deb; do dpkg-deb -x "$deb" .; done
export CPATH="$HOME/.local/python-dev/usr/include/python3.12:$HOME/.local/python-dev/usr/include/aarch64-linux-gnu/python3.12"
export C_INCLUDE_PATH="$CPATH" CPLUS_INCLUDE_PATH="$CPATH"
```

Two things matter here. The environment must be exported into the **server
process**, because the failing compile happens inside the engine core at
request time, not only during installation. And `ninja` must be on `PATH`
(`$HOME/vllm-venv/bin`) or the Triton/FlashInfer build raises
`FileNotFoundError: 'ninja'`.

Do not point `TRITON_CACHE_DIR` at a fresh empty directory unless you have to:
the default `~/.triton/cache` retains the modules compiled by earlier runs, and
emptying it forces a rebuild of `cuda_utils.c` inside the engine process.

## Base weights

```bash
HF_HUB_OFFLINE=0 hf download nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --local-dir "$HOME/models/nemotron3-nano-30b-a3b-bf16"
```

Pinned revision `2d59de1cbd51c0adf384eb906b766d1aee0e0517`, 58.82 GiB on disk.
BF16 rather than the NVFP4 build documented in the container recipe, because
the adapter work needs the same dtype the adapters were trained against.

## Serve

Bind to the node's own tailnet address — never `0.0.0.0` — and keep the API key
out of `argv`, which is world-readable through `ps` on a shared machine. Pass
it in the environment:

```bash
export VLLM_API_KEY="$(cat "$HOME/.vllm-key")"   # mode 0600, never committed
"$HOME/vllm-venv/bin/vllm" serve "$HOME/models/nemotron3-nano-30b-a3b-bf16" \
  --host 100.109.118.78 --port 5153 \
  --served-model-name nemotron3-nano-base \
  --gpu-memory-utilization 0.70 \
  --max-model-len 16384 \
  --enforce-eager
```

`nvidia-smi` reports GPU memory as `Not Supported` on GB10, so `free -g` is the
only usable headroom measurement. Treat the Spark as a **shared** machine: at
`--gpu-memory-utilization 0.80` with a 32k context this 30B BF16 model consumed
120 of 121 GiB and drove the one-minute load average above 200, which is
disruptive to anything else running on the node. `0.70` with a 16k context
peaked around 71 GiB and left the box responsive. Do not instantiate a second
copy of the model for inspection while a server is live.

Reach it from an enrolled box that uses userspace networking through the SOCKS5
proxy, not a direct route:

```bash
curl --socks5-hostname 127.0.0.1:1055 \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  http://100.109.118.78:5153/v1/models
```

## What still requires an administrator

Nothing in the list below was attempted; these are the only remaining reasons
to involve someone with root on the node:

```bash
sudo apt-get install -y python3.12-dev    # removes the header workaround
sudo usermod -aG docker devin             # only if the container recipe is wanted
```

The userspace path does not need either one for base-model serving.
