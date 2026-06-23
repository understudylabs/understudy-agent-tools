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
- **`fixtures/`** — every task as *data*, one JSONL row per task:
  `classify_tasks.jsonl` (single-shot classify rungs: title/system/user/gold) and
  `hard/tool_tasks.jsonl` (tool-calling rungs: prompt, allowed tools, initial
  state, assertions). Add a row to either and it is immediately live, listed, and
  scored — no per-task server or viewer code.
- **`viewer/ladder.climb.html`** — the self-contained UI. It builds its task list
  *entirely* from `/tasks` (the server is the single source of truth). One renderer
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
| `?model=<id>` | model lane for the single pane / VS pane A (`gemma-4-e2b` or any `/models` remote id such as `glm-5.2`) |
| `?vs=1` | open in compare-two (VS) mode |
| `?modelB=<id>` | VS pane B's model (only meaningful with `vs=1`) |

On load, `applyQuery()` runs twice — once before the first render (model/VS) and
again after `/tasks` hydrates (so tool-task ids resolve). As the user moves
(next task, model pick, VS toggle), `syncQuery()` rewrites the URL with
`history.replaceState`, so the address bar always reflects the live view (no
history spam). An agent adding a task or lane just uses its id in the URL — no
extra wiring. (Both helpers live in the viewer's `<script>`.)

## Model lanes & tool-call dialects

The local lane is fixed; remote lanes are gateway-backed and discovered at server
start. If `understudy run` injects `UNDERSTUDY_ORG_ID`, `/models` tries the live
org catalog first. Without live catalog access it falls back to the checked-in
public remote ids. For a specific existing remote model that is not in the
fallback list, launch with:

```sh
UNDERSTUDY_LADDER_REMOTE_MODELS=glm-5.2 understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py
```

Active local lane plus default fallback remotes:

| id | lane | where |
|---|---|---|
| `gemma-4-e2b` | `mlx_vlm` | local default, **$0** |
| `glm-5.2` | `gateway` | Understudy gateway, **billed** |
| `minimax-m3` | `gateway` | Understudy gateway, **billed** |
| `glm-5.1` | `gateway` | Understudy gateway, **billed**; Lilac deprecates 2026-06-29 |
| `gemma-4-31b-it` | `gateway` | Understudy gateway, **billed**; Lilac deprecates 2026-06-29 |
| `kimi-k2.6` | `gateway` | Understudy gateway, **billed**; Lilac deprecates 2026-06-29 |
| `minimax-m2.7` | `gateway` | Understudy gateway, **billed** |
| `nemotron-3-nano` | `gateway` | Understudy gateway, **billed** |
| `nemotron-3-super` | `gateway` | Understudy gateway, **billed** |
| `nemotron-3-ultra` | `gateway` | Understudy gateway, **billed** |
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

Every task is *data* now — classify rungs and tool rungs alike. Append one JSON
object (one line) to the right fixture and it is immediately live: discovered on
the next server start, listed by `GET /tasks`, flattened into the viewer's rung
rail (the server is the single source of truth — no per-task viewer edit), and
run/scored with no per-task code on either side. Restart the server to pick up a
new/edited row; both task lists are cached at first use.

### TaskSpec — the one row schema (both kinds)

Both fixtures share one row shape; `tier` is the discriminator. Common fields:
`task_id` (unique) and `tier`; everything else is kind-specific.

| field | classify row (`fixtures/classify_tasks.jsonl`) | tool row (`fixtures/hard/tool_tasks.jsonl`) |
|---|---|---|
| `task_id` | unique id, e.g. `sort-email` | unique id, e.g. `hard.my_task` (the rail shows it) |
| `tier` | `"classify"` | `"hard"` |
| `title` | the task line shown in the UI | — |
| `system` | the system prompt sent to the model | — (the agent system prompt is the server-side `AGENT_SYSTEM` constant) |
| `user` | the user prompt sent to the model | — |
| `gold` | expected label (first token, substring match) | — |
| `prompt` | — | the task to complete — drives both the UI line and the user message |
| `toolset` | — | informational label, e.g. `"standard"` |
| `allowed_tools` | — | subset of the registry, always ending in `finish` |
| `initial_state` | — | seeds a fresh `WorldState` (deep-copied per run): `{crm:{accounts,subscriptions,tickets}, mail:{inbox:[…]}, tables:{<name>:[rows]}, invoices:{…}}`. `mail.sent` starts empty; tools append to it and assertions read it back |
| `assertions` | — | the scorecard (below) |

### A new classify task — one fixture row

Append one line to `fixtures/classify_tasks.jsonl`:

```json
{"task_id":"my-task","tier":"classify","title":"…","system":"…","user":"…","gold":"label"}
```

It is loaded by `classify_tasks()`, listed by `GET /tasks` (kind `classify`),
and run by `classify_run()`. Correctness is the substring check in
`classify_run()`: the gold's first token must appear (case-insensitively) in the
model's response, so keep gold labels short and single-token.

### A new tool-calling task — one fixture row

Append one JSON object (one line) to `fixtures/hard/tool_tasks.jsonl`. It is
discovered by `world.load_tasks()`, listed by `GET /tasks` (kind `tool`), and
scored by the same agent loop — no server code.

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

### TASKS_VERSION — bump when tasks, assertions, or run semantics change

`serve.py` stamps the catalog with `TASKS_VERSION` (top-level `tasks_version` on
`GET /tasks`). Bump it whenever a task row, assertion, scorer, or execution
config changes so run results taken against different versions stay comparable —
the same discipline as the world's scoring contract. The viewer notes the stamp
but is otherwise indifferent to it.

### A new tool / a new model lane — code

- **New tool:** add `fn(state, **args) -> dict` in `world.py`, register it in
  `TOOLS`, and add an OpenAI-shaped entry to `TOOL_SCHEMAS`; then list it in a
  task's `allowed_tools`. Errors must be recoverable — return `{"error": …}`,
  never throw.
- **New model lane:** add a local lane to `serve.py` `LOCAL_MODELS` (`id ->
  (lane, path, label, sampling)`). Remote OpenAI-compatible gateway models do not
  need viewer edits: add them to the hosted catalog, the fallback list, or
  `UNDERSTUDY_LADDER_REMOTE_MODELS`. A genuinely new local tool-call dialect
  needs a parser + a `LANE_ADAPT` row.

## Swapping the world (replacing Larkfield with your own domain)

Larkfield (CRM / mail / tables / invoices) is one instance of a small contract.
`env/world.py` is split so the **harness is generic over the domain**: the agent
loop, the scorer, and the task loader all dispatch over two registries (`TOOLS`,
`ASSERTIONS`) plus a `WorldState`. To run a different tool-using domain — a
shopping cart, a doc tool, a coding REPL — implement that contract; the demo
loop, the viewer, and the fixture format keep working unchanged.

**Generic (leave as-is):** `call_tool`, `score_assertions`, `fresh_state`,
`run_trajectory`, `evaluate_trajectory`, `load_tasks` — they operate over the
registries and the state, not over Larkfield specifically.

**Domain-specific (replace):** `WorldState`, the `TOOLS` registry, `TOOL_SCHEMAS`,
the `ASSERTIONS` registry, and the `_a_*` checkers.

The contract a new world implements:

1. **`WorldState`** — a class holding mutable state, deep-copyable per run. The
   harness snapshots it as `baseline` before a trajectory so the anti-shotgun
   check can diff mutations.
2. **`TOOLS = {name: fn}`** — each `fn(state, **args) -> dict`. **Every error is
   recoverable**: return `{"error": …}` (see `_err`), never raise — unknown tool,
   bad args, and missing records all return errors so the model can react. Include
   a `finish` sentinel so the agent can end the turn.
3. **`TOOL_SCHEMAS = {name: schema}`** — an OpenAI tool-shaped schema per tool
   (the `_fn(name, description, properties, required)` factory is reusable);
   `tool_schemas(allowed)` returns the subset a task exposes.
4. **`ASSERTIONS = {type: checker}`** — each `checker(state, **params) ->
   {passed: bool, expected: str, actual: str}`. Ship at least one **positive**
   type (the loader rejects tasks with only negatives), and optionally
   **negatives** (forbid an outcome) and an **anti-shotgun** check that diffs
   `baseline`→state against an allowlist of mutation keys.
5. **Task fixtures** — rows whose `initial_state` seeds your `WorldState` and whose
   `assertions` reference your assertion types.

The scoring contract is unchanged: `score_assertions` returns `strict` (1.0 iff
every assertion passes) and `dense` (weighted positives, plus negative weights
only if all positives pass — a do-nothing run cannot farm negatives).

**Honest scope.** This makes the ladder reusable for a new *tool-using* domain
without touching the viewer, the server, or the agent loop. It does not turn it
into a generic eval harness for non-tool tasks (the classify lane is separate and
simpler), and it stays a local demo — the path to actual RL is the export in
[`verifiers-export.md`](verifiers-export.md).

## Running notes & gotchas

- **Use `uv`, not system python.** The local lanes need a current mlx stack; a
  stale system `mlx_lm` can't load some models:
  `understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py`.
- **Model cache.** Local weights load from `~/.understudy/models/<dir>` (override
  the root with `UNDERSTUDY_MODEL_HOME`) — the `gemma-4-e2b` id resolves to the
  `gemma-4-e2b-it-qat-mlx-vlm-understudy` directory, not one named for the id. Missing
  weights raise a clear "pull it with manage-local-models" error instead of a
  cryptic mlx load failure.
- **One GPU.** Local-vs-local VS serializes on the inference thread;
  local-vs-gateway runs concurrently (the gateway lane is network, not GPU).
- **Reasoning is off by default** in the raw output and switched on per lane
  (gemma `enable_thinking=True`; LFM `<think>`); the server splits the reasoning
  channel from the response before streaming.
- **Gateway is billed.** Every `gateway` lane costs money; the picker marks it
  and every run is disclosed.

## Path to RL: exporting to a Verifiers environment

The ladder is a demo; actual RL training is Verifiers infra. Don't bake
`verifiers` into the demo — instead **export on demand** when a workload earns
RL. The concept + contract for that bridge lives in
[`verifiers-export.md`](verifiers-export.md) (decision-gate → map world +
assertions to a `StatefulToolEnv` + `Rubric` → feed `prepare-verifier-handoff`
stage 2). Concept only; no adapter is built.

## Fuller prototype

This directory is the **slimmed comparison UI**. The fuller exploration it grew
from — a CLI eval harness (`run_eval` / `oracle` / `sentinels`), a task-anatomy
"dissector" view, the easy-email generator, earlier viewers, the scoping/design
docs, and a lab note synthesizing the findings (the gemma < lfm < glm capability
gradient; gemma's front-loaded-reasoning ceiling that prompts can't fix; the
`mlx_vlm` one-thread GPU-stream gotcha; uv-vs-system mlx; off-by-default
reasoning) — is archived internally for reimplementation.
