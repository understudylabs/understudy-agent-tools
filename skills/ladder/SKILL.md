---
name: ladder
description: Use to give a developer an immediate local-vs-frontier model comparison before they have their own traces — "what can a local model do", "is a small model good enough", "the onboarding climb". Launches a local web UI streaming live thinking + tool-call traces for the same task across a local mlx model and a frontier gateway model, scored against a synthetic world, with a VS mode. To compare many models on a user's own eval, use compare-model-sweep; to serve a local model, use run-local-model-lab.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Ladder — the onboarding "climb"

A small, self-contained **local** web UI for watching and comparing LLMs on the
same task. It is the no-data front door: a developer launches it and watches a
small local model and a frontier model attempt the same task side by side —
live reasoning, real tool calls, strict scoring — without needing any of their
own traces first. As the task gets harder, the small local model keeps pace and
then drops off where the frontier model carries on. That contrast is the hook
into the rest of the improvement loop.

## When to use

- A new user asks "what can a local model actually do?" / "is a small model good
  enough?" / "show me local vs frontier."
- During or right after `onboard`, to make the local-vs-frontier difference
  concrete before steering them toward their own workload.
- Any time a visceral, zero-setup-data demo of agentic behavior + scoring helps.

For the user's **own** eval across **many** candidate models, hand off to
`compare-model-sweep`. To serve a local model against the user's **real**
workload, hand off to `run-local-model-lab`.

## Run it

```sh
understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py
```

Then open <http://localhost:8011/ladder.climb.html>.

- Use **`uv`**, not system python — the local models need the current mlx stack
  (a stale system `mlx_lm` can't load some models).
- `understudy run` injects the gateway key so the frontier lane works; the local
  lane needs nothing and is **$0**. Local runs upload nothing.
- The local model is loaded from `~/.understudy/models/<id>` (override with
  `UNDERSTUDY_MODEL_HOME`). If it isn't there, pull it with the
  `manage-local-models` skill — the server will say so explicitly.

This is a developer-run demo/onboarding tool, **not** a headless production
service.

## What you see

- **Easy / medium rungs** — single-shot classify tasks; watch the model think,
  answer, and get a Pass/Fail against the gold label.
- **Hard rung** — a real tool-calling agent loop against the synthetic Larkfield
  world (find the account, read the policy, apply the latest discount, update the
  plan, email the right teams, `finish`), scored by final state.
- **VS mode** — two models race the same task side by side. Local-vs-local
  serializes on the one GPU; local-vs-gateway runs concurrently.

Frontier (`glm-5.1`) runs go through the Understudy gateway and are **billed** —
the picker marks that lane and every such run is disclosed.

## Safety Gates

- **Local-first, $0 on the local lane.** The mlx model runs on the developer's
  machine, the server binds `127.0.0.1` only, and nothing is uploaded.
- **Gateway runs are billed.** The frontier lane (`glm-5.1`) goes through the
  Understudy gateway and costs money. The picker marks it and every such run is
  disclosed in the UI — do not route to it without the developer understanding
  it bills.
- **Synthetic data only.** The "Larkfield" world is invented; no real customer or
  workload data is involved.
- **No silent downloads.** The server only *loads* a cached local model from
  `~/.understudy/models`; if it is missing it says so — pull it with
  `manage-local-models`, never auto-download weights.

## What's here (the core, 4 files)

| File | Role |
|---|---|
| `serve.py` | stdlib HTTP + SSE server: the `run_agent` loop (model → tool_call → `world.call_tool` → tool_result → `finish` → score) and the live event stream. Easy/medium classify tasks + the model catalog are inline. |
| `env/world.py` | the synthetic "Larkfield" world: `WorldState`, the recoverable tool registry, `call_tool`, and `score_assertions` (strict + dense, with the anti-shotgun rule for negatives). Stdlib only. |
| `fixtures/hard/tool_tasks.jsonl` | the hard tool-calling tasks (renewal save-play / AP approval / SLA route) — data, not code: add a row and it's live and scored. |
| `viewer/ladder.climb.html` | the UI (the "climb" viewer + VS panes). Self-contained HTML/JS. |

See [`README.md`](README.md) for the model lanes and how this slimmed UI relates
to the fuller prototype it grew from.
