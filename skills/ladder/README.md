# ladder — model comparison UI

A small, self-contained web UI for **watching and comparing models on the same
task** — local (mlx) and frontier (via the Understudy gateway) — with live
thinking + tool-call streaming, strict scoring, and a side-by-side **VS** mode.

## Run

```sh
understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py
```

Then open <http://localhost:8011/ladder.climb.html>.

Use **`uv`**, not system python — the local models need the current mlx stack
(system `mlx_lm` is too old to load some models). `understudy run` injects the
gateway key for the frontier model; nothing else is needed.

## What's here (the core, 4 files)

| File | Role |
|---|---|
| `serve.py` | stdlib HTTP + SSE server. The `run_agent` loop (model → tool_call → `world.call_tool` → tool_result → `finish` → score) and the SSE event stream. Easy/medium classify tasks are inline; the model list is here too. |
| `env/world.py` | the synthetic "Larkfield" task world: `WorldState`, ~12 recoverable tools, `call_tool`, and `score_assertions` (strict + dense, with the anti-shotgun rule for negatives). Stdlib only. |
| `fixtures/hard/tool_tasks.jsonl` | the hard tool-calling tasks (renewal save-play / AP approval / SLA route). |
| `viewer/ladder.climb.html` | the UI itself (the "climb" viewer + VS panes). Self-contained HTML/JS. |

Three model lanes are wired in `serve.py`, each speaking its own tool-call
dialect against the one world + scorer: the gateway (OpenAI JSON), and two local
mlx lanes (gemma-4 default; the LFM2.5 lane is present but its model line is
commented out).

## Reference / fuller prototype

This directory is the **slimmed comparison UI**. The fuller exploration it grew
from — the CLI eval harness (`run_eval` / `oracle` / `sentinels`), the
task-anatomy "dissector" view, the easy-email generator, earlier viewers, the
scoping/design docs, and a **lab note synthesizing the findings** (the
gemma < lfm < glm capability gradient; gemma's front-loaded-reasoning ceiling
that prompts can't fix; the `mlx_vlm` one-thread GPU-stream gotcha; uv-vs-system
mlx; off-by-default reasoning formats) — is archived for reimplementation in
the **`understudy-knowledge`** repo:

```
experiments/2026-06-15-onboarding-difficulty-ladder/
├── lab-note.md     # findings synthesis
├── prototype/      # full prototype snapshot (this UI + the harness + viewers)
└── scoping/        # design docs (two-door onboarding, ladder scope, storyboard, task anatomy)
```
