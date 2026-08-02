---
title: Spark self-host serving access, runtime, and multi-LoRA attempt
status: executed
scope: private Spark access preflight, userspace runtime, base serving, multi-LoRA attempt
---

# Objective and scope

This note records the read-only preflight for a `tag:devin` userspace access
lane. The permitted destinations are only ports 22, 443, and 5153 on the two
Spark nodes.

# Relationship to the canonical lane

The canonical entrypoint is `scripts/spark-lane-bootstrap.sh`. This directory
holds only evidence artifacts not covered by that entrypoint: SSH and
ProxyCommand setup, the two-node permission smoke test, the denied-destination
scope probe, and the prepared-but-unlaunched multi-LoRA serving variant.

The canonical bootstrap now uses separate userspace proxy ports:
SOCKS5 defaults to `localhost:1055` and the outbound HTTP proxy defaults to
`localhost:1056`; using 1055 for both collides. Tag advertisement is opt-in
through `SPARK_ADVERTISE_TAGS`; the bootstrap always asserts that
`Self.Tags` contains `tag:devin` after enrollment. In the verified enrollment,
the ephemeral auth key supplied the tag and no `--advertise-tags` flag was
passed.

The canonical reachability probe routes TCP and `/v1/models` checks through
the local SOCKS5 proxy. Direct dials to the 100.x addresses fail under
userspace networking because there is no TUN interface. Endpoint registration,
when the runtime is unblocked, goes through `src/serving-registry.ts` as
specified by `docs/unified-serving-router.md`; it was **NOT** performed.

# Enrollment and identity

- Tailscale mode: userspace `tailscaled`, no sudo.
- Self node: `devin-spark-session`, `100.71.134.53`.
- Self tags: `["tag:devin"]`.
- Auth key: ephemeral; observed expiry `2026-08-08`.
- Alpha: `spark-246e`, `100.109.118.78`.
- Bravo: `spark-74c4`, `100.100.181.10`.
- The Alpha and Bravo identities match the identities table in the Spark Lab
  `RUNBOOK.md`.

# Denied-destination proof

The SOCKS5 probe distinguishes an ACL drop from an in-scope address with no
listener. A dropped destination stalls for about five seconds because the ACL
silently discards it. An in-scope destination with no listener returns an
immediate connection refusal. This timing distinction is useful because both
outcomes are unreachable to an application, but only the former proves the
destination was outside the permitted ACL.

```text
ALLOWED  spark-246e:22    -> OPEN  SSH-2.0-OpenSSH_9.6p1     (0.1s)
ALLOWED  spark-246e:443   -> OPEN (TLS, no banner)           (12.1s)
ALLOWED  spark-246e:5153  -> refused instantly, no listener  (0.1s)
ALLOWED  spark-74c4:22    -> OPEN  SSH-2.0-OpenSSH_9.6p1     (0.1s)
ALLOWED  spark-74c4:443   -> OPEN (TLS, no banner)           (12.1s)
ALLOWED  spark-74c4:5153  -> OPEN                            (12.1s)
DENIED   spark-246e:8080 (openshell-gateway)  -> dropped     (5.0s)
DENIED   spark-246e:3000                      -> dropped     (5.0s)
DENIED   spark-74c4:8080 (openshell-gateway)  -> dropped     (5.0s)
DENIED   non-Spark tailnet host A:22          -> dropped     (5.0s)
DENIED   non-Spark tailnet host B:22          -> dropped     (5.0s)
DENIED   non-Spark tailnet host C:22          -> dropped     (5.0s)
```

# Permission proof

Both nodes reported:

- `uid=1001(devin) gid=1001(devin) groups=1001(devin)`.
- No sudo group membership.
- `sudo -n` returned `a password is required`.
- `~/.ssh` mode `0700`.
- `~/.ssh/authorized_keys` mode `0600`.
- `/home/understudy` mode and ownership:
  `drwxr-x--- understudy understudy`.
- Listing or reading protected content, including the environment file, was
  denied with `Permission denied`.

# Runtime blockers (superseded — see "Runtime, resolved" below)

The first four items below were recorded during the read-only preflight and
have since been cleared by building a userspace runtime. They are kept because
they describe the starting state, not the current one.

- No importable vLLM package or `vllm` executable was available to `devin` on
  either node.
- No conda, venv, or uv environment was found under `~devin`.
- Docker access returned permission denied on the Docker socket, and podman
  was absent. The container-based repository serve scripts are therefore not
  usable as `devin`.
- No Nemotron weights readable by `devin` were found in `~devin`, `/models`,
  `/srv`, `/opt`, or the inspected Hugging Face cache directories. The
  repository scripts require `HF_HUB_OFFLINE=1`.
- Bravo's GPU was held by a root-owned `VLLM::EngineCore` using `101,586 MiB`,
  serving Qwen3.6-27B on port 8000. Bravo had about 13 GiB available out of
  121 GiB.
- Alpha was idle at about 1 GiB GPU memory listed in use and about 114 GiB
  available unified memory.
- Bravo had all three permitted ports occupied. Port 5153 served an unrelated
  `gepa_viz` application under user `understudy`.
- Alpha port 5153 was free. Its
  `ip_unprivileged_port_start` was `1024`, so `devin` could bind that port.

# Fit and quantization note

Both nodes are `aarch64` systems with NVIDIA GB10 GPUs, NVIDIA driver
`580.159.03`, CUDA `13.0`, and 121 GiB unified memory. The pinned NVFP4
30B-A3B configuration with FP8 KV cache, GPU memory utilization `0.55`, and
maximum model length `65536` fits comfortably on Alpha based on its observed
headroom. `nvidia-smi` reports GPU memory as `Not Supported` on GB10; `free -g`
is the usable headroom measurement for this preflight.

# Runtime, resolved

The "no runtime" and "no weights" blockers were self-inflicted by assuming the
container path. As the unprivileged `devin` account on Alpha, with no sudo and
no Docker:

- `uv` installs `vllm==0.26.0` with `torch==2.11.0+cu130` from prebuilt aarch64
  wheels into `~devin/vllm-venv`. CUDA is available, device capability `(12, 1)`,
  and a GPU matmul succeeds.
- `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` (revision
  `2d59de1cbd51c0adf384eb906b766d1aee0e0517`, 58.82 GiB) downloads to
  `~devin/models` against ~2.4 TB of free disk.
- The base model serves on the Alpha tailnet address, port 5153, and answers
  `/v1/models` and `/v1/chat/completions`.

The full recipe, including the non-obvious parts (Python headers without root,
`ninja` on `PATH`, and leaving `TRITON_CACHE_DIR` alone), is in
[`docs/spark-userspace-vllm.md`](../../docs/spark-userspace-vllm.md). Only the
container path still needs an administrator, and nothing here needs it.

# Multi-LoRA outcome

Two separate results, and they must not be conflated.

**The serving path works.** One base plus two LoRA adapters serve concurrently
from a single loaded model on Alpha, launched by
[`serve-nemotron-multilora.sh`](serve-nemotron-multilora.sh):

```text
MoE model detected. Using fused MoE LoRA implementation.
Model loading took 62.35 GiB memory and 329.474158 seconds
Loaded new LoRA adapter: name 'adapter-a-vllm-partial'
Loaded new LoRA adapter: name 'adapter-b-vllm-partial'
Starting vLLM server on http://100.109.118.78:5153
```

`/v1/models` lists `nemotron3-nano-base`, `adapter-a-vllm-partial` and
`adapter-b-vllm-partial`. An interleaved round-robin over four prompts at
temperature 0 completed 12/12 requests, and three parallel requests — one per
model id — all returned in ~7.35 s, confirming the adapters are served against
the same resident base rather than swapped in and out. Each adapter's output
differed from the base on all four prompts, so the loaded weights are doing
something. Raw evidence:
[`artifacts/interleaved-multi-adapter.json`](artifacts/interleaved-multi-adapter.json).

**The adapters being served are not the trained adapters.** The PR #408 Tinker
adapters cannot be served faithfully on vLLM 0.26.0: trained with
`target_modules: "all-linear"`, they carry Mamba `gate_proj`/`x_proj` factors
and stacked routed-expert tensors with no representation in vLLM's Nemotron-H
LoRA surface. Loading them unmodified fails with a target-module `ValueError`.
[`convert_nemotron_lora_to_vllm.py`](convert_nemotron_lora_to_vllm.py) maps only
the supported subset and records what it drops
([`artifacts/adapter-a-conversion_report.json`](artifacts/adapter-a-conversion_report.json),
[`artifacts/adapter-b-conversion_report.json`](artifacts/adapter-b-conversion_report.json)):

```text
source tensors 418 -> mapped 188, dropped 230
dropped_parameter_fraction 0.9419029027329825
```

**94.2% of the trained low-rank parameters are discarded**, so the `*-vllm-partial`
artifacts exercise the serving path and say nothing about the behaviour of the
adapters PR #408 measured. No score was computed from them, because any such
number would have to be disclaimed into meaninglessness. The reasoning is in
[`docs/nemotron-h-lora-vllm-compatibility.md`](../../docs/nemotron-h-lora-vllm-compatibility.md);
this is a property of the adapters' target-module choice, not of the Spark, the
userspace runtime, or the account's privileges.

# DPO'd adapter: not delivered

No DPO-derived adapter was served, and none exists to serve. PR #408's two
adapters are RLVR/GRPO (A) and SFT-LoRA (B); neither is DPO. Training one
through the repository's sanitized synthetic lane
([`docs/synthetic-offline-dpo-nemotron.md`](../../docs/synthetic-offline-dpo-nemotron.md))
would produce another `all-linear` Tinker adapter and therefore hit exactly the
incompatibility above. The prerequisite is a DPO run whose `target_modules` are
constrained to vLLM-servable projections at training time; until that exists,
the DPO arm belongs on Tinker's own sampling path.

# Operating the node responsibly

Alpha is shared. Two mistakes made during this work, both recorded so they are
not repeated:

- Serving at `--gpu-memory-utilization 0.80` with a 32k context, and then
  instantiating a second copy of the model for inspection while that server was
  live, consumed 120 of 121 GiB and pushed the one-minute load average above
  230. Use `0.70` with a 16k context, and never build a second model instance
  alongside a running server.
- The first launch passed the API key as `--api-key`, which is visible to every
  account on the host through `ps`. That key was rotated; the replacement lives
  only in `~devin/.vllm-key` (mode `0600`) and is passed via `VLLM_API_KEY`.

# NOT EXECUTED — pre-staging commands for the admin

Nothing in this section was run during the preflight. These are the exact
commands reserved for an administrator who later supplies the required
runtime access and weights:

Neither command is required for the userspace path above; they remain relevant
only to the container recipe.

```bash
export MODEL='nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4'
export REVISION='ce1b118ae66ec705d02c241525192832eb045fd3'
export CACHE_DIR="$HOME/.cache/huggingface"
mkdir -p "$CACHE_DIR"
HF_HUB_OFFLINE=0 huggingface-cli download "$MODEL" \
  --revision "$REVISION" \
  --local-dir "$CACHE_DIR/hub/models--nvidia--NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4/snapshots/$REVISION"

# Grant a runtime identity permission to execute the approved container path.
# Note for the administrator: docker group membership is root-equivalent on
# this host and would widen the constrained `devin` account well beyond the
# serving lane. A rootless container runtime, or a systemd unit owned by an
# existing privileged account that the lane triggers, is the safer grant.
sudo setfacl -Rm u:devin:rX "$CACHE_DIR"
sudo usermod -aG docker devin

PORT=5153 \
GPU_MEMORY_UTILIZATION=0.55 \
LORA_MODULES='adapter-a=/approved/adapters/adapter-a,adapter-b=/approved/adapters/adapter-b' \
./experiments/spark-selfhost-serving/serve_nemotron3_nano_lora.sh
```

# Not done / open questions

- No runbook document named `DEVIN_SPARK_ACCESS.md` exists in the Spark Lab
  repository on any branch inspected.
- The canonical lane files now provide the shared Spark/Modal registry and
  bootstrap path. No endpoint registration was performed because the runtime
  remained paused.
- The serve variant publishes the container port with `-p "$PORT:$PORT"`,
  which binds every host interface rather than only the tailnet address. The
  ACL constrains tailnet reachability but not any other host interface, so
  the publish address should be narrowed before the lane is launched.
