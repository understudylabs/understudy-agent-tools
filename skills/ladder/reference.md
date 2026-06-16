# Ladder — reference

The deep notes behind the model-comparison "climb". [`SKILL.md`](SKILL.md) is the
activation surface + flow + safety gates; this file is the architecture, the
model lanes, the Larkfield world + scoring, and the running gotchas.

## Architecture

One stdlib process, no web framework:

- **`serve.py`** — a `ThreadingHTTPServer` that serves `viewer/` statically and
  two live SSE lanes: `classify_run()` (the easy/medium single-shot tasks) and
  `run_agent()` (the hard tool-calling agent loop: model → `tool_call` →
  `world.call_tool` → `tool_result` → … → `finish` → `score_assertions`). All MLX
  load + generation is funneled onto **one** dedicated worker thread
  (`_Inference`): mlx binds GPU streams to the thread that built the model, so
  generating from a per-request thread raises *"no Stream(gpu, N) in current
  thread"*. Request handlers stay concurrent for static files and the gateway
  (urllib) lane.
- **`env/world.py`** — the synthetic "Larkfield" world: `WorldState` (crm / mail
  / tables / invoices), a 12-tool recoverable registry, `call_tool`, and
  `score_assertions`. Standard library only.
- **`fixtures/hard/tool_tasks.jsonl`** — the hard tasks as *data*: one JSONL row
  per task (prompt, allowed tools, initial state, assertions). Add a row and it
  is immediately live and scored — no per-task server code.
- **`viewer/ladder.climb.html`** — the self-contained UI. One renderer
  (`streamInto`) drives the single-attempt pane, the hard-tier trace + scorecard,
  and both VS panes from the same `/run` SSE stream, adapting to classify vs hard
  by the events it actually sees.

## Model lanes & tool-call dialects

Two lanes are active; a third is coded but its model line is commented out:

| id | lane | where |
|---|---|---|
| `gemma-4-e2b` | `mlx_vlm` | local default, **$0** |
| `glm-5.1` | `gateway` | Understudy gateway, **billed** |
| `lfm2.5-8b-a1b` | `mlx_lm` | coded but commented out (uncomment in `serve.py`) |

Each lane speaks its own tool-call dialect against the **one** world + scorer:

- **gateway** — OpenAI function-calling JSON; `function.arguments` is a JSON
  string and real `chatcmpl-tool-…` ids are matched across turns.
- **gemma (`mlx_vlm`)** — native `<|tool_call>call:fn{key:<|"|>val<|"|>}<tool_call|>`,
  parsed by a small hand-rolled parser; reasoning on (`enable_thinking=True`).
- **LFM (`mlx_lm`)** — native `<|tool_call_start|>[fn(arg='v')]<|tool_call_end|>`,
  parsed with `ast` (never `eval`).

A `LANE_ADAPT` table in `serve.py` captures the *only* per-lane differences —
whether the message carries tool-call ids, and whether `arguments` is a JSON
string or a dict. The rest of `run_agent` is lane-agnostic.

## The Larkfield world & scoring

- Invented brands/domains (`*.larkfield.example`) — synthetic, no real data.
- Tools are **recoverable**: every failure returns a structured `{error: …}` the
  model can react to, rather than throwing.
- `score_assertions` returns **strict** (1.0 iff every positive *and* negative
  assertion passes, else 0.0) and **dense** (weighted positives, plus weighted
  negatives only if all positives passed — so a model that does nothing cannot
  farm "didn't email X" for free points).
- Negative + anti-shotgun checkers exist (`mail_not_sent_to`, `no_extra_writes`).
  See the PR's follow-ups for wiring `no_extra_writes` into the shipped fixtures.

## Running notes & gotchas

- **Use `uv`, not system python.** The local lanes need a current mlx stack; a
  stale system `mlx_lm` can't load some models:
  `understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py`.
- **Model cache.** Local weights load from `~/.understudy/models/<dir>` (override
  the root with `UNDERSTUDY_MODEL_HOME`) — the `gemma-4-e2b` id resolves to the
  `gemma-4-e2b-it-mlx-vlm-4bit` directory, not one named for the id. Missing
  weights raise a clear "pull it with manage-local-models" error instead of a
  cryptic mlx load failure.
- **One GPU.** Local-vs-local VS serializes on the inference thread;
  local-vs-gateway runs concurrently (the gateway lane is network, not GPU).
- **Reasoning is off by default** in the raw output and switched on per lane
  (gemma `enable_thinking=True`; LFM `<think>`); the server splits the reasoning
  channel from the response before streaming.
- **Gateway is billed.** Only the `glm-5.1` lane costs money; the picker marks it
  and every run is disclosed.

## Fuller prototype

This directory is the **slimmed comparison UI**. The fuller exploration it grew
from — a CLI eval harness (`run_eval` / `oracle` / `sentinels`), a task-anatomy
"dissector" view, the easy-email generator, earlier viewers, the scoping/design
docs, and a lab note synthesizing the findings (the gemma < lfm < glm capability
gradient; gemma's front-loaded-reasoning ceiling that prompts can't fix; the
`mlx_vlm` one-thread GPU-stream gotcha; uv-vs-system mlx; off-by-default
reasoning) — is archived internally for reimplementation.
