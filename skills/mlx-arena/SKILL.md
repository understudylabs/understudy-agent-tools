---
name: mlx-arena
description: Use to run a frontier model against an opinionated local Understudy on Apple Silicon, blind, then hill-climb the local model toward it — "compare a local model to Opus/GPT", "is a local model good enough for this", "blind model vibe-check", "frontier vs local head-to-head", "hill-climb my local model". Starts with verified Gemma 4 E2B via mlx-vlm; the frontier is one swappable, provider-agnostic config. Apple Silicon only.
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

The runnable core is the blind game [`blind_arena.ts`](blind_arena.ts) (TypeScript,
run by Node ≥22.6 — no Python in the repo); the local
model is served by `mlx_vlm.server` for the verified Gemma 4 rung or
`mlx_lm.server` for compatible MLX repos, and [`arena.sh`](arena.sh) is the
launcher. MLX does inference, the game is the surface; the scripts stay thin.

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

`mlx_vlm.server` and `mlx_lm.server` expose **OpenAI-compatible** endpoints per
model (`/v1/chat/completions`), one model per process/port. Pi adds each as a
custom provider in `~/.pi/agent/models.json` (`api: openai-completions`).

## Safety Gates

- **No weight download without approval + a size cap.** Name the exact MLX repo,
  quantization, and GB first. Default to the **smallest model that is reasonable
  for the task**, not blindly to the smallest model in the family.
- **Local-first, no upload.** Weights download from Hugging Face; prompts and
  outputs stay on the machine. No token is required for public `mlx-community`
  repos (a `HF_TOKEN` only raises rate limits).
- **One model per port.** Each `mlx_lm.server` loads one model and holds it in
  unified memory. Two 4-bit ~4B models fit comfortably on 16 GB+; check free RAM
  before adding a third.
- **Tear down when done** (`arena.sh down`) to free memory.

## Flow

### First out-of-box run

For a new user, start with the verified first rung and open it in Pi immediately:

```bash
skills/mlx-arena/arena.sh first
# or, on macOS, open the first Understudy in a distinct Terminal.app window:
skills/mlx-arena/arena.sh first-window
```

This starts a branded tmux loading screen, serves the Understudy-verified
`google/gemma-4-e2b-it` 4-bit MLX-VLM snapshot with `mlx_vlm.server`, then
replaces the loader with Pi so the user sees: **their first local Understudy is
ready**. It also creates/updates the local Pi provider entry in
`~/.pi/agent/models.json`. `first-window` does the same work but opens a
separate macOS Terminal window attached to the first-run tmux session, so the
user sees the local Understudy load and then lands in Pi without staying in the
agent's shell. When a coding agent invokes this, prefer `first-window` and
`play-window`; always report the follow-along command (`tmux attach -t
mlx-arena-first` or `tmux attach -t mlx-arena-play`) so the user can watch the
same session while the agent sends prompts.

Verified snapshot locations:

- 4-bit first rung:
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit`
  (R2 source:
  `r2://understudy-model-snapshots/models/google/gemma-4-e2b-it/mlx-vlm-0.6.2/quant-4bit/`)
- 4-bit E4B climb rung:
  `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit`
- Public HTTPS delivery publishes stable session endpoints from
  `models.understudylabs.com`. Each session response contains short-lived signed
  per-file URLs; the same R2 prefix is the durable object source.

The 4-bit snapshot is about 3.3 GB, generated `I am ready as your local
understudy.` in local testing, used about 3.6 GB peak memory, and served
OpenAI-compatible chat completions with `logprobs` / `top_logprobs`. The E4B
snapshot is about 4.8 GB and is the first signed quality climb. If the verified
Gemma 4 snapshot is not reachable, use
`FIRST_REPO=mlx-community/gemma-3-1b-it-4bit FIRST_LOADER=mlx_lm
skills/mlx-arena/arena.sh first` only as a fallback.

After the first local prompt or two, move to the frontier head-to-head:

```bash
skills/mlx-arena/arena.sh play
```

1. **Inventory + pick the first local rung.** Confirm Apple Silicon, free RAM/disk,
   and the MLX venv. Classify the task before picking a model: routing /
   classification, extraction, coding, tool-use/API workflow, long-context
   reasoning, or stateful policy. Pick the **smallest model that is plausibly
   reasonable for that task** (see
   [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) and
   "Finding MLX models" below). State exact repos + GB, get a quick yes. For a
   two-local comparison, pick a second rung only after the first local-vs-frontier
   gap is visible.
2. **Set up the MLX runtime** (once):
   ```bash
   uv venv .understudy/venvs/mlx --python 3.12
   uv pip install --python .understudy/venvs/mlx/bin/python 'mlx-lm>=0.31' 'mlx-vlm>=0.6' 'huggingface_hub>=0.27'
   ```
3. **Download the first model** from the signed Understudy snapshot session:
   ```bash
   curl -fsSL 'https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit' -o /tmp/understudy-model-session.json
   # install.sh performs the manifest download + signed file sync automatically.
   ```
4. **Wire Pi** — `arena.sh first` creates the first `mlx-gemma4` provider
   automatically. For later side-by-side local arenas, add one provider per model
   in `~/.pi/agent/models.json` (`baseUrl: http://127.0.0.1:<port>/v1`,
   `api: openai-completions`, `apiKey: "mlx"`,
   `compat.supportsDeveloperRole:false`,
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
   For the first Pi meeting session, use tmux paste-buffer rather than raw
   literal key injection:
   ```bash
   tmux set-buffer 'Say exactly: local Understudy is online.'
   tmux paste-buffer -t mlx-arena-first
   tmux send-keys -t mlx-arena-first Enter
   ```
6. **Decide the next intervention.** Compare answers, latency, tone, and reasoning
   behavior. If the model is already good enough, promote it to
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) for a
   scored, frozen-eval verdict. If it fails because the prompt/harness is weak,
   route to [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md). If
   the task is a workflow with tool state, build a
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
   If the small model needs bounded substeps behind the same external call, use
   [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md).
   If quality is simply too low, climb the model ladder or route remote/hybrid via
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

## Blind-vote mode — the Efficient-Intelligence game

[`blind_arena.ts`](blind_arena.ts) is the interactive, blind A/B version of the
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
skills/mlx-arena/arena.sh first    # first verified local model in Pi
skills/mlx-arena/arena.sh play
# then:  tmux attach -t mlx-arena-play
```

Or run it directly (Node ≥22.6 runs the `.ts` via native type-stripping):

```bash
LOCAL_BASE=http://127.0.0.1:8081/v1 LOCAL_MODEL=.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit \
CATEGORY=coding FRONTIER_MODEL=claude-opus-4-8 \
node --experimental-strip-types skills/mlx-arena/blind_arena.ts
```

It is branded as the **Understudy Labs · Local-vs-Frontier Model Testing
Environment**. Pick a **question set** at launch (or `CATEGORY=everyday|coding|llm|automation|mixed`):
everyday assistant questions, coding Q&A + debugging, how-LLMs-work knowledge, or
AutomationBench-style automation tasks. Blind by default; **type `reveal` at any
prompt** to peek at identities + cost/speed, again to re-hide.

**Include your own dataset** with `DATASET=/path/to/file_or_dir` — questions from a
local `.txt` (one per line), `.json` (array of strings or `{question|prompt|text}`),
or `.jsonl`/`.md`; a directory loads every matching file. It shows up in the picker
as a **dataset** set. The file is read locally at runtime and **never committed or
sent anywhere but the models you're testing** — keep customer data out of any set
that would reach a non-ZDR provider.

```bash
DATASET=~/my-eval/questions.jsonl skills/mlx-arena/arena.sh play
```

Design rules (so the blind test stays honest): while blind, **both panels show
only the answer** — no latency/token/cost footer, no thinking trace, no model
names (those are all tells). Hints escalate (speed tease → halfway confession →
running free-vs-cloud tally) without ever naming a side. The frontier key is read
from `ANTHROPIC_LOCAL_KEY`/`ANTHROPIC_API_KEY`; cost is computed from real usage
(Opus 4.8 $5/$25 per 1M in/out) and shown only on reveal.

For real workloads, ground the questions in a captured trace
([`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)). Treat Pi as
the quick local-proof and gap-finding surface. To test whether the local model can
take over the *whole* task (not just answer questions), build a
[`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md),
then hill-climb it with the
[`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md)
harness or prompt optimization through
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).

## Known model-compat gotchas

Hard-won MLX loading gotchas (Gemma 4 E2B won't load on mlx_lm 0.31.3, reasoning-model
token headroom, stop-token fixes, `--trust-remote-code`) and how to find MLX models are
in [`reference.md`](reference.md).

## Output Standard

End with: task class; the first local rung and why it is the smallest reasonable
choice; model repo, quant, GB, port, and RAM headroom; the tmux session name and
how to attach/drive it; the first head-to-head comparison; and the recommended
next intervention (score in run-local-model-lab, build simulated env, run GEPA,
try RLM, climb models, or route hybrid/remote).

## References

- [`arena.sh`](arena.sh) — the launcher/controller (`first|first-window|play|up|ask|left|right|capture|logs|status|down|attach`).
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — score a model on a frozen eval.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) — Gemma & Nemotron variants and hardware fit.
- [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md) — acquiring/curating local weights.
