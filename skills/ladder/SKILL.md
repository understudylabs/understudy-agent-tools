---
name: ladder
description: Use to give a developer an immediate local-vs-frontier model comparison before they have their own traces — "what can a local model do", "is a small model good enough", "compare a local model to a frontier model", "the onboarding climb". For comparing many models on a user's own eval, use compare-model-sweep; to serve a local model, use run-local-model-lab.
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

**Prerequisites** (otherwise-silent assumptions):

- Apple Silicon (arm64) Mac with **`uv`** on `PATH` — the local lane needs a
  current mlx stack (system `mlx_lm` is often too old to load the model).
- The local model cached at `~/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy` —
  the `gemma-4-e2b` id resolves to **that** directory, not a dir literally named
  `gemma-4-e2b`. If it's missing, pull it with the `manage-local-models` skill
  (`understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy`); the server
  prints an actionable error if it's absent.
- **Frontier lane only:** run `understudy login` once so `understudy run` can
  inject the gateway key. Without it the frontier lane returns the literal notice
  `[gateway not configured …]` rather than erroring — don't mistake that for a
  real run.

Run from the repo root (the path below is relative):

```sh
understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py
```

First invocation builds the mlx stack from PyPI (network, a few minutes) and the
model cold-loads (~60s) — that pause is normal, not a hang. Then open
<http://localhost:8011/ladder.climb.html>, or drive it headlessly (below).

This is a developer-run demo/onboarding tool, **not** a headless production
service — though the SSE endpoint is browserless-friendly for an agent.

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

## What you can actually run ($0 vs billed)

- **$0, fully local — the "climb".** Run `gemma-4-e2b` across all three rungs and
  watch where it breaks: it passes the easy/medium classify tasks and typically
  fails the hard tool-calling task. That difficulty climb is the free demo and a
  real signal on its own, entirely on your machine.
- **A side-by-side model-vs-model comparison costs money.** The only frontier
  lane, `glm-5.1`, is billed, and the "compare two" (VS) button pairs the local
  model against it by default — so triggering VS bills a gateway run. No *second*
  free model ships enabled (the local LFM lane is coded but commented out in
  `serve.py`). So "$0" and "two models side by side" are not both available out
  of the box: take the free climb, or accept the gateway cost for the race.

## Drive it headlessly

No browser required — the page is just a client of one SSE endpoint:

```sh
curl -N 'http://localhost:8011/run?task=sort-email&model=gemma-4-e2b'
```

The stream ends with a `done` event carrying the result (`correct`, `response`,
`tok_s` for the classify rungs; `strict` / `dense` / `passes` for the hard rung).
`GET /tasks` lists task ids (`sort-email`, `match-search`, `hard.sla_route`); `GET
/models` lists the lanes.

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

## What's here

Four stdlib, self-contained files: `serve.py` (HTTP + SSE server + the agent
loop), `env/world.py` (the synthetic Larkfield world + scoring),
`fixtures/hard/tool_tasks.jsonl` (the hard tasks as data — add a row and it's
live and scored), and `viewer/ladder.climb.html` (the UI).

See [`reference.md`](reference.md) for the architecture, the model lanes +
tool-call dialects, the Larkfield world + scoring contract, **how to add your own
tasks** (a new hard tool task is a single JSONL row — schema, assertion types, and
tool list are documented there), and the running gotchas (uv-vs-system mlx, the
one-GPU thread funnel, `UNDERSTUDY_MODEL_HOME`).
