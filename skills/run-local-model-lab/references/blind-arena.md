# Blind arena + hill-climb protocol (MLX, Apple Silicon)

The interactive sibling of the lab: where [`SKILL.md`](../SKILL.md) *scores* a
model against a frozen eval, the arena lets the user *feel* a local model — and
optionally a frontier↔local gap — by hand, then hill-climb the local model
toward the frontier. Apple Silicon + MLX only; the frontier side is a single
swappable, provider-agnostic config (Opus, GPT, GLM, …), never a per-provider
code path. Two local models can also run side-by-side via `arena.sh up` when
picking between local candidates.

The runnable core is [`../scripts/blind_arena.ts`](../scripts/blind_arena.ts)
(TypeScript, run by Node ≥22.6 via native type-stripping; no Python in the
repo); the local model is served by `mlx_vlm.server` (verified Gemma 4 rung) or
`mlx_lm.server` (compatible MLX repos), and
[`../scripts/arena.sh`](../scripts/arena.sh) is the launcher
(`first|first-window|play|up|ask|left|right|capture|logs|status|down|cleanup|attach`).
MLX does inference, the game is the surface; the scripts stay thin.

Do not treat a stock duel as a substitute for understanding traces, prompts,
datasets, and validators — it is hypothesis generation and calibration only.

## Safety gates (arena-specific)

- **No weight download without approval + a size cap.** Name the exact MLX
  repo, quantization, and GB first. Default to the smallest model *reasonable
  for the task*, not blindly the smallest in the family.
- **Local-first, no upload.** The verified first rung downloads from signed
  Understudy snapshot sessions into `~/.understudy/models`; prompts and outputs
  stay on the machine. No token is required for the signed snapshots.
- **One model per port.** Each server loads one model into unified memory. Two
  4-bit ~4B models fit comfortably on 16 GB+; check free RAM before a third.
- **Tear down when done** (`arena.sh down`). If a terminal window flashed and
  disappeared or old generators are still listening, run
  `arena.sh cleanup --dry-run` then `arena.sh cleanup --force`.

## First out-of-box run

For a new user, start with the verified first rung. If it is not cached, route
to [`../../manage-local-models/SKILL.md`](../../manage-local-models/SKILL.md),
ask approval for the ~3.3 GB snapshot, and run (from the `manage-local-models`
skill directory):

```bash
node scripts/pull-understudy-snapshot.mjs --model gemma-4-e2b-it-mlx-vlm-4bit
```

Then open it in Pi:

```bash
skills/run-local-model-lab/scripts/arena.sh first
```

This starts a tmux loading screen, serves the Understudy-verified
`google/gemma-4-e2b-it` 4-bit MLX-VLM snapshot with `mlx_vlm.server`, then
replaces the loader with Pi, and creates/updates the local Pi provider entry in
`~/.pi/agent/models.json`. Prefer coaching the user to attach to the tmux
session in their own terminal over auto-opening iTerm/Ghostty/Terminal. If they
ask the agent to open a window, use `first-window` / `play-window` and always
report the follow-along command (`tmux attach -t mlx-arena-first` or
`tmux attach -t mlx-arena-play`).

The 4-bit E2B snapshot is ~3.3 GB, used ~3.6 GB peak memory in local testing,
and serves OpenAI-compatible chat completions with `logprobs`/`top_logprobs`.
The climb rungs (E2B/E4B/12B 4-bit + BF16 diagnostics, 26B A4B and 31B
high-memory) all come from stable
`models.understudylabs.com/session?model=<id>` snapshot sessions — the full
rung list with disk sizes, provenance, and the known-good `mlx_vlm.server`
smoke test lives in
[`../../manage-local-models/reference.md`](../../manage-local-models/reference.md).
Use the 26B/31B rungs only after the workload profile shows the smaller rung is
genuinely capacity-limited.

If the verified Gemma 4 snapshot is unreachable, fall back to
`FIRST_REPO=mlx-community/gemma-3-1b-it-4bit FIRST_LOADER=mlx_lm arena.sh first`.

After the first local prompt or two, move to workload understanding
(`/understudy:understand-workload`); use the head-to-head only when it helps
the user calibrate taste, demonstrate the gap, or generate hypotheses tied to a
real task (`arena.sh play`).

## Arena flow

1. **Inventory + pick the first local rung.** Confirm Apple Silicon, free
   RAM/disk, and the MLX venv. Classify the task (routing/classification,
   extraction, coding, tool-use/API workflow, long-context, stateful policy)
   and pick the smallest model plausibly reasonable for it (see
   [`../../../docs/open-model-spotlight.md`](../../../docs/open-model-spotlight.md)
   and "Finding MLX models" below). State exact repos + GB, get a quick yes.
2. **Set up the MLX runtime** (once):
   ```bash
   uv venv .understudy/venvs/mlx --python 3.12
   uv pip install --python .understudy/venvs/mlx/bin/python 'mlx-lm>=0.31' 'mlx-vlm>=0.6' 'huggingface_hub>=0.27'
   ```
3. **Download the first model** from the signed snapshot session (above).
4. **Wire Pi.** `arena.sh first` creates the first `mlx-gemma4` provider
   automatically. For later side-by-side local arenas, add one provider per
   model in `~/.pi/agent/models.json`
   (`baseUrl: http://127.0.0.1:<port>/v1`, `api: openai-completions`,
   `apiKey: "mlx"`, `compat.supportsDeveloperRole:false`,
   `compat.supportsReasoningEffort:false`); the model `id` must equal the
   served repo id. Verify with `pi --list-models | grep mlx`.
5. **Launch and drive:**
   ```bash
   skills/run-local-model-lab/scripts/arena.sh up        # servers + two-pane tmux
   skills/run-local-model-lab/scripts/arena.sh ask "..." # send to BOTH panes
   skills/run-local-model-lab/scripts/arena.sh capture   # snapshot both panes
   tmux attach -t mlx-arena                              # watch/drive
   skills/run-local-model-lab/scripts/arena.sh down      # stop everything
   ```
   For the first Pi meeting session, use tmux paste-buffer rather than raw key
   injection (`tmux set-buffer '...' && tmux paste-buffer -t mlx-arena-first
   && tmux send-keys -t mlx-arena-first Enter`).
6. **Move from local proof to real work.** Ask for a real problem or find data
   in the repo (evals, prompts, traces, fixtures, tickets, golden outputs,
   failing tests, request logs). Route to
   [`../../understand-workload/SKILL.md`](../../understand-workload/SKILL.md)
   before freezing evals.

## Blind-vote mode

`blind_arena.ts` runs the blind A/B: a frontier model vs the small local MLX
model, randomly assigned Left/Right each round. The user watches both answer
the same question, votes, and only at the end are identities and the
cost×speed×quality trade-off revealed. The point is *efficient intelligence*:
on most everyday questions the free local model is faster and good enough; you
pay for the frontier only on the genuinely hard tasks.

```bash
skills/run-local-model-lab/scripts/arena.sh play
# then: tmux attach -t mlx-arena-play
```

Or directly:

```bash
LOCAL_BASE=http://127.0.0.1:8081/v1 LOCAL_MODEL=~/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit \
CATEGORY=coding FRONTIER_MODEL=gpt-5.5 FRONTIER_REASONING_EFFORT=none FRONTIER_MAX_COMPLETION_TOKENS=768 \
node --experimental-strip-types skills/run-local-model-lab/scripts/blind_arena.ts
```

Pick a question set at launch
(`CATEGORY=everyday|coding|llm|automation|mixed`), or bring your own with
`DATASET=/path/to/file_or_dir` — `.txt` (one per line), `.json` (array of
strings or `{question|prompt|text}`), `.jsonl`/`.md`, or a directory. The file
is read locally at runtime and never committed or sent anywhere but the models
under test — keep customer data out of any set that would reach a non-ZDR
provider. Blind by default; type `reveal` at any prompt to peek, again to
re-hide.

**Design rules (so the blind test stays honest):** while blind, both panels
show only the answer — no latency/token/cost footer, no thinking trace, no
model names (all tells). Hints escalate without naming a side. Provider keys
and gateway credentials stay local env vars or
`~/.understudy/credentials.json`. Cost is computed from real usage and shown
only on reveal; if fallback happened, the reveal names the actual route used.

### Frontier route resolution

1. Use an existing OpenAI-compatible gateway if `FRONTIER_BASE_URL`,
   `AI_GATEWAY_BASE_URL`, or `OPENAI_BASE_URL` is set (key from
   `FRONTIER_API_KEY` / `AI_GATEWAY_API_KEY` / `OPENAI_API_KEY`).
2. Else an existing `OPENAI_API_KEY` with `gpt-5.5`
   (`FRONTIER_MODEL`/`OPENAI_MODEL` override).
3. Else an existing `ANTHROPIC_LOCAL_KEY`/`ANTHROPIC_API_KEY` with
   `claude-opus-4-8` (`FRONTIER_MODEL`/`ANTHROPIC_MODEL` override).
4. If the user wants a new OpenAI key, use the official key setup flow and
   confirm the local env-file destination before writing anything. Never ask
   for keys in chat; never commit env files.
5. If the frontier route fails or is absent, fall back to
   `UNDERSTUDY_FALLBACK_MODEL=glm-5.1` through `understudy login`
   (`FRONTIER_FALLBACK=0` disables, for debugging only).

Before a first-run duel, route through the frontier-keys decision in
[`../../use-understudy-gateway/references/frontier-keys.md`](../../use-understudy-gateway/references/frontier-keys.md):
the Understudy managed catalog, BYO `.env` keys, or local-only skip.

## Hill-climb routing

After a gap is visible, route the climb by what the gap *is*:

- answer-only slice → promote to the lab ([`SKILL.md`](../SKILL.md)) for scored
  frontier-vs-local evaluation;
- workflow with tool state →
  [`../../design-simulated-environment/SKILL.md`](../../design-simulated-environment/SKILL.md);
- weak prompt/harness →
  [`../../optimize-workload/SKILL.md`](../../optimize-workload/SKILL.md);
- small model needs bounded substeps behind the same external call →
  [`../../recursive-language-model/SKILL.md`](../../recursive-language-model/SKILL.md);
- quality simply too low → climb the model ladder or route hybrid/remote via
  [`../../use-understudy-gateway/SKILL.md`](../../use-understudy-gateway/SKILL.md).

For real workloads, ground the questions in a captured trace
([`../../understand-workload/SKILL.md`](../../understand-workload/SKILL.md)).

## Cleanup and debug mode

```bash
LAB=~/.understudy/agent-tools skills/run-local-model-lab/scripts/arena.sh cleanup --dry-run
LAB=~/.understudy/agent-tools skills/run-local-model-lab/scripts/arena.sh cleanup --force
```

Cleanup kills tmux sessions matching the current `SESSION` prefix and the
default `mlx-arena` prefix, plus MLX listeners on the configured arena ports.
Override with `UNDERSTUDY_CLEANUP_PREFIXES="mlx-arena mlx-e2e"` or
`UNDERSTUDY_CLEANUP_PORTS="8081 8082"`.

When a terminal opens and immediately exits, rerun in debug mode:

```bash
UNDERSTUDY_DEBUG=1 UNDERSTUDY_WINDOW_HOLD=1 LAB=~/.understudy/agent-tools \
  skills/run-local-model-lab/scripts/arena.sh first-window
```

Debug mode writes an action trace to
`~/.understudy/agent-tools/.understudy/local-model-lab/arena/logs/actions.log`,
plus per-launch `window-launch-*.log` / `window-*.log` files (cwd, LAB, tmux
sessions, listeners, AppleScript output, redacted command fingerprint).
`UNDERSTUDY_WINDOW_HOLD=1` keeps the terminal open even on exit 0. Quick
post-failure snapshot: `arena.sh diagnose`.

## Finding MLX models

`mlx-community` on Hugging Face hosts MLX-converted, pre-quantized open
weights. Query the Hub API (no auth needed) and bias to the smallest 4-bit
text-instruct:

```bash
curl -s "https://huggingface.co/api/models?author=mlx-community&search=gemma&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
curl -s "https://huggingface.co/api/models?author=mlx-community&search=nemotron&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
```

Pick `*-it-*` (instruct), prefer `*-4bit`, and **avoid `*-assistant`** repos —
those are speculative-decoding drafters, not standalone models.

## Known model-compat gotchas (hard-won)

- **Gemma 4 E2B doesn't load on the tested MLX stack.**
  `mlx-community/Gemma4-E2B-IT-Text-int4` downloads at about 2.7 GB, but both
  `mlx_lm.generate` and `mlx_vlm.generate` fail on `mlx-lm 0.31.3` /
  `mlx-vlm 0.6.2`. Root cause: the config puts `num_kv_shared_layers: 20` under
  `text_config`, while `mlx_lm` reads top-level `ModelArgs` defaults; the loader
  then treats layers 15-34 as KV-shared and rejects their per-layer `k_proj` /
  `v_proj` weights (`ValueError: Received 140 parameters not in model`). Adding a
  top-level `num_kv_shared_layers: 0` makes K/V weights fit but breaks the
  double-wide MLP shapes on those layers, so this needs a loader/config fix, not
  a one-line runtime override. Keep `gemma-3-1b-it-4bit` as the smallest verified
  Google chat model until Gemma 4 E2B loads cleanly.
- **Reasoning models (e.g. Nemotron 3 Nano) need token headroom.** They emit a
  hidden/visible reasoning trace before the answer; with a tiny `max_tokens` the
  visible `content` comes back empty. Give ≥256 tokens. Expect higher latency than
  a same-size non-reasoning model — a real cost to weigh, not a bug.
- **Stop tokens.** Some quants ship an empty `generation_config.json` and a
  tokenizer whose `eos` is `<eos>` but whose chat turn ends with `<end_of_turn>`
  (id 106) — the model answers, then spews `<end_of_turn>`. Fix by writing
  `generation_config.json` with `{"eos_token_id": [1, 106]}` into the snapshot, or
  by passing `stop` in the request.
- **Custom architectures need `--trust-remote-code`** (Nemotron-H ships
  `modeling_nemotron_h.py`). The arena passes it by default.

## Output standard (arena sessions)

End an arena session with: task class if known; the local rung and why it is
the smallest reasonable choice; model repo, quant, GB, port, and RAM headroom;
the tmux session name and how to attach/drive it; whether any head-to-head was
run; and the recommended next workload-understanding or evidence action.
