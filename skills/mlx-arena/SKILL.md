---
name: mlx-arena
description: Use to run a frontier model against an opinionated local Understudy on Apple Silicon, blind, then hill-climb the local model toward it — "compare a local model to Opus/GPT", "is a local model good enough for this", "blind model vibe-check", "frontier vs local head-to-head", "hill-climb my local model". Starts with verified Gemma 4 E2B via mlx-vlm; the frontier is one swappable, provider-agnostic config. Apple Silicon only.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# MLX Arena — meet the local model, optionally compare it

Open a **small local model** on an **M-series Mac** so the user can see and talk
to their first Understudy. A frontier head-to-head is available, but it is an
optional calibration surface, not the primary evidence loop. The main path is:
prove local inference exists, then understand the user's real workload, profile
its traces/data/code path, and run the local model against that frozen task.
When a visible quality gap helps, put a **frontier model** head-to-head against
the local model, blind. The local side runs on **Apple MLX** ($0, private, no
cloud); the frontier is a single **swappable, provider-agnostic** config (Opus,
GPT, GLM, …) — never a per-provider code path.

The runnable core is the blind game [`blind_arena.ts`](blind_arena.ts) (TypeScript,
run by Node ≥22.6 — no Python in the repo); the local
model is served by `mlx_vlm.server` for the verified Gemma 4 rung or
`mlx_lm.server` for compatible MLX repos, and [`arena.sh`](arena.sh) is the
launcher. MLX does inference, the game is the surface; the scripts stay thin.

This is the interactive sibling of
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md): the lab
*scores* a model against a frozen eval; the arena lets you *feel* the local model
and, optionally, the frontier↔local gap by hand. Do not treat a stock duel as a
substitute for understanding traces, prompts, datasets, and validators. (Two
local models can also be run side-by-side via `arena.sh up` when picking between
local candidates.)

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
- **Local-first, no upload.** The verified first rung downloads from signed
  Understudy snapshot sessions into `~/.understudy/models`; prompts and outputs
  stay on the machine. No token is required for the signed snapshots. If you
  intentionally use a public Hugging Face repo, a `HF_TOKEN` only raises rate
  limits unless the model is gated.
- **One model per port.** Each `mlx_lm.server` loads one model and holds it in
  unified memory. Two 4-bit ~4B models fit comfortably on 16 GB+; check free RAM
  before adding a third.
- **Tear down when done** (`arena.sh down`) to free memory. If a terminal window
  flashed and disappeared, or old generators are still listening, run
  `arena.sh cleanup --dry-run` first and then `arena.sh cleanup --force`.

## Flow

### First out-of-box run

For a new user, start with the verified first rung. If it is not already cached,
route to [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md),
ask approval for the ~3.3 GB snapshot, and run this skill helper from the
`manage-local-models` skill directory:

```bash
node scripts/pull-understudy-snapshot.mjs --model gemma-4-e2b-it-mlx-vlm-4bit
```

Then open it in Pi:

```bash
skills/mlx-arena/arena.sh first
```

This starts a branded tmux loading screen, serves the Understudy-verified
`google/gemma-4-e2b-it` 4-bit MLX-VLM snapshot with `mlx_vlm.server`, then
replaces the loader with Pi so the user sees: **their first local Understudy is
ready**. It also creates/updates the local Pi provider entry in
`~/.pi/agent/models.json`. Prefer coaching the user to open their own terminal
and attach to the tmux session over auto-opening iTerm/Ghostty/Terminal from the
installer. If they explicitly ask the coding agent to open a new window, use
`first-window` / `play-window` and always report the follow-along command
(`tmux attach -t mlx-arena-first` or `tmux attach -t mlx-arena-play`) so the
user can watch the same session while the agent sends prompts.

Verified snapshot locations:

- 4-bit first rung:
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit`
  (R2 source:
  `r2://understudy-model-snapshots/models/google/gemma-4-e2b-it/mlx-vlm-0.6.2/quant-4bit/`)
- BF16 E2B diagnostic rung:
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-bf16`
- 4-bit E4B climb rung:
  `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit`
- BF16 E4B diagnostic rung:
  `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-bf16`
- 4-bit 12B climb rung:
  `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit`
- BF16 12B profiling rung:
  `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16`
- 4-bit 26B A4B and 31B local high-memory rungs:
  `https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-4bit`
  and
  `https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-4bit`
- Public HTTPS delivery publishes stable session endpoints from
  `models.understudylabs.com`. Each session response contains short-lived signed
  per-file URLs; the same R2 prefix is the durable object source.

The 4-bit snapshot is about 3.3 GB, generated `I am ready as your local
understudy.` in local testing, used about 3.6 GB peak memory, and served
OpenAI-compatible chat completions with `logprobs` / `top_logprobs`. The E2B
BF16 diagnostic rung is about 9.5 GB, and the E4B BF16 diagnostic rung is about
15 GB; both were converted directly from official Google checkpoints with
`mlx-vlm 0.6.2`, packaged with `SHA256SUMS`, and smoke-tested through
OpenAI-compatible chat. The E4B
snapshot is about 4.8 GB, is the first signed quality climb, and has been
checksum-verified, loaded with `mlx_vlm.server`, and smoke-tested through
OpenAI-compatible chat. The verified 12B
4-bit snapshot is about 6.3 GB on disk, the 12B BF16 profile is about 22 GB, the
26B A4B 4-bit snapshot is about 14 GB, and the 31B 4-bit snapshot is about 17 GB.
The 26B and 31B high-memory snapshots were converted directly from the official
Google Gemma 4 checkpoints with `mlx-vlm 0.6.2`; the known-good functional smoke
is `mlx_vlm.server` plus `/v1/chat/completions` asking "Answer in exactly three
words: what is local inference?", expecting a short answer such as `Running
models locally.` or `AI runs locally.` with `finish_reason: "stop"`. Use these
only after the workload profile shows the smaller rung is genuinely
capacity-limited. Official BF16 26B A4B and 31B source directories also load
directly with `mlx_vlm.server` on 128 GB Apple Silicon, but those are separate
large gated downloads, not the default signed 4-bit arena path. If the verified
Gemma 4 snapshot is not reachable, use
`FIRST_REPO=mlx-community/gemma-3-1b-it-4bit FIRST_LOADER=mlx_lm
skills/mlx-arena/arena.sh first` only as a fallback.

After the first local prompt or two, prefer moving to workload understanding:

```bash
# route the coding agent to:
/understudy:understand-workload
```

Use the frontier head-to-head only when it helps the user calibrate taste,
demonstrate the quality gap, or generate hypotheses tied to a real task:

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
   cd skills/manage-local-models
   node scripts/pull-understudy-snapshot.mjs --model gemma-4-e2b-it-mlx-vlm-4bit
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
6. **Move from local proof to real work.** After the user sees local inference,
   ask for a real problem or let the agent find data in the current repo: eval
   files, prompts, traces, fixtures, tickets, transcripts, golden outputs,
   failing tests, request logs, API/tool logs, or app routes. Route to
   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) to
   profile the data and trace the request/response path before freezing evals.
   If a stock duel was run, treat it as hypothesis generation only.

7. **Route the task-specific hill climb.** If the slice is answer-only, promote
   it to [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) for
   scored frontier-vs-local evaluation. If the task is a workflow with tool
   state, build a
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md).
   If the prompt/harness is weak, route to
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md). If the small
   model needs bounded substeps behind the same external call, use
   [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md).
   If quality is simply too low, climb the model ladder or route remote/hybrid via
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

## Cleanup and Debug Mode

Use cleanup before retesting a failed installer or after any crashy terminal
handoff:

```bash
LAB=~/.understudy/agent-tools skills/mlx-arena/arena.sh cleanup --dry-run
LAB=~/.understudy/agent-tools skills/mlx-arena/arena.sh cleanup --force
```

Cleanup kills tmux sessions matching the current `SESSION` prefix and the default
`mlx-arena` prefix, plus MLX listeners on the configured arena ports. Override
with `UNDERSTUDY_CLEANUP_PREFIXES="mlx-arena mlx-e2e"` or
`UNDERSTUDY_CLEANUP_PORTS="8081 8082"` when debugging another install.

When iTerm/Ghostty/Terminal opens and immediately exits, rerun in debug mode:

```bash
UNDERSTUDY_DEBUG=1 UNDERSTUDY_WINDOW_HOLD=1 LAB=~/.understudy/agent-tools \
  skills/mlx-arena/arena.sh first-window
```

Debug mode writes an action trace to
`~/.understudy/agent-tools/.understudy/local-model-lab/arena/logs/actions.log`.
Every launched terminal command also writes two files in the same directory:
`window-launch-YYYYMMDDTHHMMSSZ.log` from the parent process before iTerm opens,
and `window-YYYYMMDDTHHMMSSZ.log` from inside the spawned terminal. The launch
log records cwd, LAB, tmux sessions, listeners, AppleScript output, and a
redacted command fingerprint. `UNDERSTUDY_WINDOW_HOLD=1` keeps the terminal open
even when the command exits with status 0.

For a quick post-failure snapshot:

```bash
LAB=~/.understudy/agent-tools skills/mlx-arena/arena.sh diagnose
```

## Blind-vote mode — the Efficient-Intelligence game

[`blind_arena.ts`](blind_arena.ts) is the interactive, blind A/B version of the
arena: a **frontier** model vs a **small local MLX model**, randomly assigned to
Left/Right each round. It tries to use a true frontier route first: an existing
OpenAI key, an existing Anthropic key, or an existing OpenAI-compatible AI
gateway. If those are absent or fail, it falls back to `glm-5.1` through the
authenticated Understudy gateway. The user watches both answer the same everyday
question, votes which they prefer ("hot or not"), and only at the end are
identities + the cost×speed×intelligence trade-off revealed. The point is
*efficient intelligence*: on most everyday questions the free local model is
faster and good enough, and you only pay for the frontier on the genuinely hard
tasks.

### Frontier route resolution

Before launching the duel, prefer frontier quality without making first-run
fragile:

1. Use an existing OpenAI-compatible AI gateway if `FRONTIER_BASE_URL`,
   `AI_GATEWAY_BASE_URL`, or `OPENAI_BASE_URL` is set. Use
   `FRONTIER_API_KEY`, `AI_GATEWAY_API_KEY`, or `OPENAI_API_KEY` as available.
2. Else use an existing `OPENAI_API_KEY` with `gpt-5.5` unless
   `FRONTIER_MODEL`/`OPENAI_MODEL` overrides it.
3. Else use an existing `ANTHROPIC_LOCAL_KEY` or `ANTHROPIC_API_KEY` with
   `claude-opus-4-8` unless `FRONTIER_MODEL`/`ANTHROPIC_MODEL` overrides it.
4. If the user explicitly wants to create a new OpenAI key, use the official
   OpenAI Platform key setup flow and confirm the local env-file destination
   before writing anything. Do not ask the user to paste keys into chat and do
   not commit env files.
5. If the frontier route fails or is unavailable, fall back to
   `UNDERSTUDY_FALLBACK_MODEL=glm-5.1` through `understudy login`.

Disable fallback only for debugging with `FRONTIER_FALLBACK=0`.

Before a first-run duel, route through
[`../choose-frontier-keys/SKILL.md`](../choose-frontier-keys/SKILL.md). The user
chooses BYO `.env` keys, the Understudy ZDR gateway route, or local-only skip.
For Understudy ZDR, the installer clears local provider-key env vars and sets
`UNDERSTUDY_FALLBACK_MODEL=gpt-5.5` by default.

Easiest bring-up after the model is cached (serves the local model, then
optionally launches the branded game in tmux):

```bash
skills/mlx-arena/arena.sh first    # first verified local model in Pi
skills/mlx-arena/arena.sh play
# then:  tmux attach -t mlx-arena-play
```

Or run it directly (Node ≥22.6 runs the `.ts` via native type-stripping):

```bash
LOCAL_BASE=http://127.0.0.1:8081/v1 LOCAL_MODEL=~/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit \
CATEGORY=coding FRONTIER_MODEL=gpt-5.5 FRONTIER_REASONING_EFFORT=none FRONTIER_MAX_COMPLETION_TOKENS=768 \
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
running free-vs-cloud tally) without ever naming a side. Provider keys and
gateway credentials stay local env vars or `~/.understudy/credentials.json`.
Cost is computed from real usage and shown only on reveal. If fallback happens,
the final reveal names the actual route used.

For real workloads, ground the questions in a captured trace
([`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)). Treat Pi as
the quick local-proof and optional gap-finding surface. To test whether the local model can
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

End with: task class if known; the local rung and why it is the smallest
reasonable choice; model repo, quant, GB, port, and RAM headroom; the tmux
session name and how to attach/drive it; whether any head-to-head was run; and
the recommended next workload-understanding or evidence action (profile traces,
score in run-local-model-lab, build a real/simulated env, run GEPA, try RLM,
climb models, or route hybrid/remote).

## References

- [`arena.sh`](arena.sh) — the launcher/controller (`first|first-window|play|up|ask|left|right|capture|logs|status|down|cleanup|attach`).
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — score a model on a frozen eval.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) — Gemma & Nemotron variants and hardware fit.
- [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md) — acquiring/curating local weights.
