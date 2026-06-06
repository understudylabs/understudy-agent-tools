---
name: mlx-arena
description: Use to run two local open-weight models side by side on Apple Silicon and compare them live — "compare Gemma vs Nemotron locally", "which small model is better on my Mac", "set up a side-by-side model arena", "drive two local models at once". Serves both with Apple MLX (mlx_lm.server), binds each to the Pi coding agent as an OpenAI-compatible provider, and lays them out in a two-pane tmux session an agent can drive in lockstep. Apple Silicon only.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# MLX Arena — two local models, side by side

Stand up two local models on an **M-series Mac**, serve each with **Apple MLX**,
bind both to the **Pi** harness, and put them in a **two-pane tmux** session so you
(or an agent) can send the same prompt to both and compare answers, latency, and
style in real time. This is the fastest way to *feel* the quality gap between two
small open-weight models on your own hardware — $0, private, no cloud.

The runnable core is [`arena.sh`](arena.sh). MLX does inference, Pi is the harness,
tmux is the surface; the script is a thin, boring orchestrator.

This is the interactive sibling of
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md): the lab
*scores* a model against a frozen eval; the arena lets you *drive two at once* by
hand. Use the arena to pick the two finalists, then the lab to score the winner.

## Why MLX (and Apple Silicon only)

On Macs, MLX is the native path: it runs quantized open-weight models against
unified memory at the best tokens/sec, with no GPU drivers or build step. This
skill is **MLX-exclusive** — no Ollama, no llama.cpp. If you are not on Apple
Silicon, this skill does not apply.

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

## Finding MLX models

`mlx-community` on Hugging Face hosts MLX-converted, pre-quantized open weights.
Query the Hub API (no auth needed) and bias to the smallest 4-bit text-instruct:

```bash
curl -s "https://huggingface.co/api/models?author=mlx-community&search=gemma&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
curl -s "https://huggingface.co/api/models?author=mlx-community&search=nemotron&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
```

Pick `*-it-*` (instruct), prefer `*-4bit`, and **avoid `*-assistant`** repos —
those are speculative-decoding drafters, not standalone models.

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

Custom **domain questions** (point at your own repo/benchmark), the **harness-swap /
decomposition** story for large prompts, and the **trust scorecard** are planned —
see [`ROADMAP.md`](ROADMAP.md).

## Known model-compat gotchas (hard-won)

- **Gemma 4 E2B doesn't load on mlx_lm 0.31.3.** Its MLX quants store per-layer
  `k_proj`/`v_proj` for the 20 KV-shared layers, but the `gemma4_text` loader
  shares them → `ValueError: Received 140 parameters not in model`. Use
  `gemma-3-1b-it-4bit` as the smallest Google chat model that loads today; revisit
  Gemma 4 when mlx_lm updates. Multimodal Gemma repos (no `-text`) also fail under
  text-only `mlx_lm`.
- **Reasoning models (e.g. Nemotron 3 Nano) need token headroom.** They emit a
  hidden/visible reasoning trace before the answer; with a tiny `max_tokens` the
  visible `content` comes back empty. Give ≥256 tokens. Expect higher latency than
  a same-size non-reasoning model — that is a real cost to weigh, not a bug.
- **Stop tokens.** Some quants ship an empty `generation_config.json` and a
  tokenizer whose `eos` is `<eos>` but whose chat turn ends with `<end_of_turn>`
  (id 106) — the model answers, then spews `<end_of_turn>`. Fix by writing
  `generation_config.json` with `{"eos_token_id": [1, 106]}` into the snapshot, or
  by passing `stop` in the request.
- **Custom architectures need `--trust-remote-code`** (Nemotron-H ships
  `modeling_nemotron_h.py`). The arena passes it by default.

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
