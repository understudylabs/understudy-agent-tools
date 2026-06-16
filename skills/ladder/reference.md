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

## Deep links (URL state)

The viewer keeps the live view in the query string and reads it back on load, so
any task/model/mode is shareable — handy when an agent wants to point a user at a
specific run or embed a precise view.

| param | meaning |
|---|---|
| `?task=<id>` | task to open: a classify id (`sort-email`, `match-search`) or any tool-task id from the fixtures (e.g. `hard.sla_route`) |
| `?model=<id>` | model lane for the single pane / VS pane A (`gemma-4-e2b` or `glm-5.1`) |
| `?vs=1` | open in compare-two (VS) mode |
| `?modelB=<id>` | VS pane B's model (only meaningful with `vs=1`) |

On load, `applyQuery()` runs twice — once before the first render (model/VS) and
again after `/tasks` hydrates (so tool-task ids resolve). As the user moves
(next task, model pick, VS toggle), `syncQuery()` rewrites the URL with
`history.replaceState`, so the address bar always reflects the live view (no
history spam). An agent adding a task or lane just uses its id in the URL — no
extra wiring. (Both helpers live in the viewer's `<script>`.)

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
- Negative + anti-shotgun checkers (`mail_not_sent_to`, `no_extra_writes`) are
  wired into every shipped hard task, so a model that does the right work but also
  shotguns (extra emails, or touching a decoy like the `sla_route` P2 ticket
  `T-556`) loses `strict`. The numeric `body_contains` match is digit-bounded, so
  a required figure like `3808` isn't satisfied by `38080`.

## Extending the ladder (adding tasks)

Three layers, easiest first.

### A new HARD tool-calling task — pure data, no code

Append one JSON object (one line) to `fixtures/hard/tool_tasks.jsonl`. It is
discovered by `load_tasks()`, listed by `GET /tasks` (kind `tool`), flattened
into the viewer's task list (cycled by "next task" like the classify rungs — no
separate picker), and scored by the same agent loop — no server code. Restart
the server to pick up a new/edited row (the task list is cached at startup).

Row shape:

| field | meaning |
|---|---|
| `task_id` | unique id, e.g. `hard.my_task` (the picker shows it) |
| `tier` | `"hard"` |
| `prompt` | the task the model must complete |
| `toolset` | informational label (e.g. `"standard"`) |
| `allowed_tools` | the tools exposed to the model for this task — a subset of the registry, always ending in `finish` |
| `initial_state` | seeds a fresh `WorldState` (deep-copied per run): `{crm:{accounts,subscriptions,tickets}, mail:{inbox:[…]}, tables:{<name>:[rows]}, invoices:{…}}`. `mail.sent` starts empty; tools append to it and assertions read it back |
| `assertions` | the scorecard (below) |
| `gold_notes` | free-text notes (decoys to leave alone, etc.) — informational |

Tools `allowed_tools` may pick from: `crm_find_accounts`, `crm_get_account`,
`crm_get_subscriptions`, `crm_update_subscription`, `crm_list_tickets`,
`crm_update_ticket`, `tables_get_rows`, `update_invoice`, `mail_find`,
`mail_get`, `mail_send`, `finish`.

Each assertion is `{id, type, weight, human:{label, expected?, plain?}, …type-params}`:

| type | params | polarity |
|---|---|---|
| `sub_field_equals` | `sub_id, field, value` | positive |
| `account_field_equals` | `acct_id, field, value` | positive |
| `invoice_field_equals` | `invoice_id, field, value` | positive |
| `ticket_field_equals` | `ticket_id, field, value` | positive |
| `mail_sent_to_body_contains` | `to, substrings:[…]` — a sent message to `to` whose subject+body contains every substring | positive |
| `mail_not_sent_to` | `to` — no message to that address | **negative** |
| `no_extra_writes` | `allowed:[…]` mutation keys (`sub:ID`, `account:ID`, `ticket:ID`, `invoice:ID`, `mail:addr`) | **negative** |

Scoring (`score_assertions`): `strict` = 1.0 iff **every** assertion passes;
`dense` = sum of passed positive `weight`s, plus passed negative weights **only if
all positives passed** (so a do-nothing run can't farm negatives). Keep positive
weights summing to ≈1.0. Negatives + `no_extra_writes` turn the task's decoys into
point-losers. The `human` block is display-only (label/expected/plain shown in the
scorecard) and never affects pass/fail.

### A new EASY/MEDIUM classify task — small edit

Classify rungs are not fully data-driven (the viewer holds the classify seeds in
order; tool tasks are appended automatically on hydrate). Add the task in two
places:

1. `serve.py` `TASKS`: `"my-task": ("title", "system prompt", "user prompt", "gold label")`.
2. `viewer/ladder.climb.html`: add the id to `TASK_IDS` and a matching seed entry
   `{ id: "my-task", … }` to the `TASKS` array at the same index — `hydrate()`
   overwrites classify content from `/tasks` by aligned index. (Tool tasks need
   no viewer edit: each is appended as its own flat entry on hydrate, cycled by
   "next task" alongside the classify rungs.)

Correctness is the substring check in `classify_run()`: the gold's first token must
appear (case-insensitively) in the model's response, so keep gold labels short and
single-token.

### A new tool / a new model lane — code

- **New tool:** add `fn(state, **args) -> dict` in `world.py`, register it in
  `TOOLS`, and add an OpenAI-shaped entry to `TOOL_SCHEMAS`; then list it in a
  task's `allowed_tools`. Errors must be recoverable — return `{"error": …}`,
  never throw.
- **New model lane:** add to `serve.py` `MODELS` (`id -> (lane, path, label,
  sampling)`) and the viewer's `LIVE_MODELS`. A genuinely new tool-call dialect
  needs a parser + a `LANE_ADAPT` row; an OpenAI-compatible gateway model is just
  a `gateway` entry.

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
