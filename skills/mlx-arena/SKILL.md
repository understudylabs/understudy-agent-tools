---
name: mlx-arena
description: Use to run a frontier model against a small local model on Apple Silicon, blind, then hill-climb the local model toward it — "compare a local model to Opus/GPT", "is a local model good enough for this", "blind model vibe-check", "frontier vs local head-to-head", "hill-climb my local model". Serves the local model with Apple MLX (mlx_lm.server); the frontier is one swappable, provider-agnostic config. Apple Silicon only.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# MLX Arena — frontier vs. local, then hill-climb the local

Put a **frontier model** head-to-head against a **small local model** on an
**M-series Mac**, blind, and use the gap to **hill-climb the local model** until it
is good enough to take over. The local side runs on **Apple MLX** ($0, private, no
cloud); the frontier is a single **swappable, provider-agnostic** config (Opus,
GPT, GLM, …) — never a per-provider code path. The aim is *efficient intelligence*:
prove how much of the work the free local model can do, and pay for the frontier
only on the genuinely hard tail.

The runnable core is the blind game [`blind_arena.py`](blind_arena.py); the local
model is served by `mlx_lm.server` and [`arena.sh`](arena.sh) is the launcher. MLX
does inference, the game is the surface; the scripts stay thin.

This is the interactive sibling of
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md): the lab
*scores* a model against a frozen eval; the arena lets you *feel* the frontier↔local
gap by hand, then iterate on the local model. (Two local models can also be run
side-by-side via `arena.sh up` when picking between local candidates.)

## Why MLX (and Apple Silicon only)

On Macs, MLX is the native path: it runs quantized local models against unified
memory at the best tokens/sec, with no GPU drivers or build step. This skill is
**MLX-exclusive** — no Ollama, no llama.cpp. If you are not on Apple Silicon, this
skill does not apply. (Local models need not be open-weight — any model you can
serve with `mlx_lm.server` works.)

`mlx_lm.server` exposes an **OpenAI-compatible** endpoint per model
(`/v1/chat/completions`), one model per process/port. Pi adds each as a custom
provider in `~/.pi/agent/models.json` (`api: openai-completions`).

## Safety Gates

- **No weight download without approval + a size cap.** Name the exact MLX repo,
  quantization, and GB first. Default to the **smallest** model in each family.
- **Local-first, no upload.** Weights download from Hugging Face; prompts and
  outputs stay on the machine. No token is required for public `mlx-community`
  repos (a `HF_TOKEN` only raises rate limits).
- **One model per port.** Each `mlx_lm.server` loads one model and holds it in
  unified memory. Two 4-bit ~4B models fit comfortably on 16 GB+; check free RAM
  before adding a third.
- **Tear down when done** (`arena.sh down`) to free memory.

## Flow

1. **Inventory + pick two models.** Confirm Apple Silicon, free RAM/disk, and the
   MLX venv. Pick the **smallest** model from each family to compare (see
   [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) and
   "Finding MLX models" below). State exact repos + GB, get a quick yes.
2. **Set up the MLX runtime** (once):
   ```bash
   uv venv .understudy/venvs/mlx --python 3.12
   uv pip install --python .understudy/venvs/mlx/bin/python 'mlx-lm>=0.31' 'huggingface_hub[cli]>=0.27'
   ```
3. **Download the two models** (backgrounded, announce ETA):
   ```bash
   .understudy/venvs/mlx/bin/hf download mlx-community/gemma-3-1b-it-4bit
   .understudy/venvs/mlx/bin/hf download mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit
   ```
4. **Wire Pi** — add one provider per model in `~/.pi/agent/models.json`
   (`baseUrl: http://127.0.0.1:<port>/v1`, `api: openai-completions`,
   `apiKey: "mlx"`, `compat.supportsDeveloperRole:false`,
   `compat.supportsReasoningEffort:false`). The model `id` must equal the served
   repo id. Verify with `pi --list-models | grep mlx`.
5. **Launch the arena** and drive it:
   ```bash
   skills/mlx-arena/arena.sh up                 # start servers + two-pane tmux
   skills/mlx-arena/arena.sh ask "your prompt"  # send to BOTH panes (lockstep)
   skills/mlx-arena/arena.sh capture            # snapshot both panes
   tmux attach -t mlx-arena                      # watch/drive interactively
   skills/mlx-arena/arena.sh down               # stop servers + session
   ```
   An agent drives it headlessly with `ask` + `capture`; a human attaches.
6. **Decide.** Compare answers, latency, tone, and reasoning behavior. Promote the
   winner to [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
   for a scored, frozen-eval verdict, and graduate to a larger same-family model
   via [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
   when you need more quality.

## Blind-vote mode — the Efficient-Intelligence game

[`blind_arena.py`](blind_arena.py) is the interactive, blind A/B version of the
arena: a **frontier** model (Claude Opus 4.8 at high reasoning, or `gpt-5.1` via
the Understudy gateway when no Anthropic key is present) vs a **small local MLX
model**, randomly assigned to Left/Right each round. The user watches both answer
the same everyday question, votes which they prefer ("hot or not"), and only at
the end are identities + the cost×speed×intelligence trade-off revealed. The point
is *efficient intelligence*: on most everyday questions the free local model is
faster and good enough, and you only pay for the frontier on the genuinely hard
tasks.

Easiest bring-up (downloads the default model if missing, serves it, launches the
branded game in tmux):

```bash
skills/mlx-arena/arena.sh play
# then:  tmux attach -t mlx-arena-play
```

Or run it directly:

```bash
LOCAL_BASE=http://127.0.0.1:8081/v1 LOCAL_MODEL=mlx-community/gemma-3-1b-it-4bit \
CATEGORY=coding .understudy/venvs/mlx/bin/python skills/mlx-arena/blind_arena.py
```

It is branded as the **Understudy Labs · Local-vs-Frontier Model Testing
Environment**. Pick a **question set** at launch (or `CATEGORY=everyday|coding|llm|mixed`):
everyday assistant questions, coding Q&A + debugging, or how-LLMs-work knowledge.
Blind by default; **type `reveal` at any prompt** to peek at identities + cost/speed,
again to re-hide.

Design rules (so the blind test stays honest): while blind, **both panels show
only the answer** — no latency/token/cost footer, no thinking trace, no model
names (those are all tells). Hints escalate (speed tease → halfway confession →
running free-vs-cloud tally) without ever naming a side. The frontier key is read
from `ANTHROPIC_LOCAL_KEY`/`ANTHROPIC_API_KEY`; cost is computed from real usage
(Opus 4.8 $5/$25 per 1M in/out) and shown only on reveal.

For real workloads, ground the questions in a captured trace
([`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)); and to test
whether the local model can take over the *whole* task (not just answer questions),
build a [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
and hill-climb it with the
[`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) harness.

## Known model-compat gotchas

Hard-won MLX loading gotchas (Gemma 4 E2B won't load on mlx_lm 0.31.3, reasoning-model
token headroom, stop-token fixes, `--trust-remote-code`) and how to find MLX models are
in [`reference.md`](reference.md).

## Output Standard

End with: the two models (repo, quant, GB, port); RAM headroom used; the tmux
session name and how to attach/drive it; a first lockstep comparison (both
answers, rough latency, any reasoning-trace difference); and the recommended next
step (score the winner in run-local-model-lab, or swap a corner and re-run).

## References

- [`arena.sh`](arena.sh) — the launcher/controller (`up|ask|left|right|capture|logs|status|down|attach`).
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — score a model on a frozen eval.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) — Gemma & Nemotron variants and hardware fit.
- [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md) — acquiring/curating local weights.
