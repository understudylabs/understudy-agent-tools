# Onboarding — reference

Deep detail for [`SKILL.md`](SKILL.md): the user profile, the interview, tooling
detection, and how the profile drives tone. All of it is local; none of it
uploads.

## The user profile (`~/.understudy/profile.json`)

User-level (home dir), not repo-level — it follows the user across projects. It
is the durable memory of *who you are working with and what they have done*. Read
it at the start of every session; create it during onboarding; append to its
`history` as workloads and decisions accumulate. Never put secrets, keys, tokens,
prompts, or customer data in it.

The profile is the **skills' interview artifact** — written only by skills,
during onboarding and later interviews. The desktop app must never write it
(live runtime facts belong in the agent card below). It is also *not* the
index of the local model library: the models directory
(`~/.understudy/models/`) plus each snapshot's catalog/serving manifest is
the source of truth for what is installed. `local_models` entries are
interview-time notes (what was pulled, when, with which serving settings),
not an inventory to keep in sync.

```jsonc
{
  "schema_version": "understudy.profile.v1",
  "created_at": "2026-06-06T18:00:00Z",     // shell: date -u +%FT%TZ
  "updated_at": "2026-06-06T18:00:00Z",
  "experience": {
    "tier": "first-timer",                  // first-timer | familiar | practitioner
    "signals": [],                          // detected tooling that informed the guess
    "self_reported": true                   // did the user confirm it?
  },
  "machine": {
    "os": "darwin",
    "chip": "Apple M4",
    "accelerator": "apple-silicon",         // apple-silicon | cuda | cpu
    "memory_gb": 32,
    "vram_gb": null,                        // discrete-GPU VRAM if CUDA
    "disk_free_gb": 210
  },
  "tooling": {
    "runtimes": [],                         // ollama, llama.cpp, mlx, lm-studio, vllm
    "python_ml": [],                        // torch, transformers, trl, peft, datasets
    "hf_cli": false,
    "cuda": false
  },
  "goals": { "primary": "cost", "notes": "" },  // cost | latency | quality | learning | compliance
  "constraints": [],                            // zdr, local-only, approved-providers, region, budget
  "preferences": {
    "vocabulary": "plain",                  // plain | mixed | technical
    "coaching": "high",                     // high | medium | low
    "opinion_strength": "prescriptive"      // prescriptive | balanced | options-only
  },
  "local_models": [],                       // interview notes [{id, runtime, quant, size_gb, pulled_at}] — NOT the library index; ~/.understudy/models/ is
  "history": []                             // [{workload, decision, route, at}]
}
```

Write it with the smallest correct change: merge new fields, append to `history`
and `local_models`, bump `updated_at`. If a value is unknown, leave it null
rather than guessing. To answer "what models do I have?", list the models
directory and read the catalogs — never trust `local_models` as current.

## The agent runtime card (`~/.understudy/agent-card.json`)

Agent-level, not user-interview memory. This is the single file a fresh coding
agent reads when the user asks, "is my Understudy active?" or "talk to my
Understudy." It captures live local runtime facts that do not belong in the
profile. Never put secrets, prompts, outputs, or customer data in it.

**Ownership: the Understudy desktop app is the canonical local daemon and the
canonical writer of this card.** While the app runs, it maintains the card
programmatically (`apps/homescreen/src-tauri/src/agent_card.rs`): it writes
the `app` block when its local API server starts, refreshes the warm-model
list on every residency change (warm/cool/assign), and marks itself stopped
on graceful shutdown. All app writes are atomic (temp file + rename), purely
additive to the schema below, and secret-free — the local server's bearer
token appears only as a `token_present` boolean, never the token itself.

Skills write this card only as a **fallback when the desktop app is not
installed or not running** (the step-5 refresh during onboarding, the ladder
server, `serve-understudy-snapshot.mjs`). When the app is running, read the
card and trust its `app` block instead of re-deriving runtime facts — and if
you do write, add fields rather than rename, and leave the `app` block to the
app.

```jsonc
{
  "schema_version": "understudy.agent_card.v1",
  "created_at": "2026-06-06T18:00:00Z",
  "updated_at": "2026-06-06T18:05:00Z",
  "understudy": {
    "model": "/Users/me/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy",
    "name": "Gemma 4 E2B",
    "endpoint": "http://127.0.0.1:8011",
    "health_url": "http://127.0.0.1:8011/tasks",
    "healthy": true,
    "served_by": "skills/ladder/serve.py",
    "runtime": "mlx_vlm via ladder",
    "provider": "ladder-local-gemma4-e2b",
    "tmux_session": null,
    "logs": null,
    "how_to_talk": "curl -N 'http://localhost:8011/run?task=sort-email&model=gemma-4-e2b'",
    "follow_along_url": "http://localhost:8011/ladder.climb.html?task=sort-email&model=gemma-4-e2b"
  },
  "companion": {
    "alive": false,
    "pid": null,
    "stale_pid": 84470,
    "path": "/Users/me/Documents/understudy-cli/companion/rust/target/debug/us-companion",
    "state_file": "~/.understudy/companion.json"
  },
  "project": {
    "cwd": "/Users/me/my-app",
    "slug": "my-app"
  },
  "org": {
    "id": "org_..."
  },
  "app": {                                  // written by the desktop app ONLY
    "name": "understudy-desktop",
    "version": "0.2.2",
    "pid": 12345,
    "running": true,                        // false after graceful shutdown
    "started_at": "2026-06-06T18:00:00Z",
    "stopped_at": null,
    "base_url": "http://127.0.0.1:17790",   // local API server (HTTP + MCP + A2A)
    "port": 17790,
    "token_present": true,                  // a bearer token exists in the app DB; NEVER the token itself
    "warm_models": [                        // live residency: which models are loaded
      {
        "id": "gemma-4-e2b-it-qat-mlx-vlm-understudy",
        "port": 8089,
        "model_path": "/Users/me/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy"
      }
    ]
  }
}
```

When the desktop app is running it keeps this card fresh on its own — check
`app.running` and `app.pid` first. Skill-side refreshes (during onboarding,
whenever the ladder server or `serve-understudy-snapshot.mjs` serves a model,
and whenever a companion process starts) are the fallback path for machines
without the app. If `~/.understudy/companion.json`
contains a dead pid, clear that pid in the companion state file and record it as
`stale_pid` in the card. A later agent should be able to answer the user's
runtime question from this card first, using health checks only to refresh stale
facts.

## Tooling detection → experience signal

Run these read-only checks while the model downloads. Each hit is a signal; the
*set* informs the experience tier (confirm, don't assume).

| Check | Command | Signals |
|---|---|---|
| Model runtimes | `which ollama llama-server mlx_lm.generate lms` | can run models locally |
| PyTorch | `python -c "import torch"` 2>/dev/null | active ML practitioner |
| vLLM / TGI | `python -c "import vllm"` / `which vllm` | serves models at scale |
| Transformers / datasets | `python -c "import transformers, datasets"` | trains/evaluates models |
| TRL / PEFT | `python -c "import trl, peft"` | does fine-tuning / RL |
| MLX | `python -c "import mlx"` / `which mlx_lm.generate` | Apple-silicon ML |
| HF CLI | `which huggingface-cli hf` | pulls weights from the Hub |
| NVIDIA GPU | `nvidia-smi` | CUDA box, bigger models in play |

Rough mapping: **none** of these ⇒ likely *first-timer*; a runtime + the HF CLI
⇒ *familiar*; PyTorch/vLLM/Transformers/TRL present ⇒ *practitioner*. Always
confirm with the user — detection is a starting guess, not a verdict.

## Interview bank (batch into one AskUserQuestion)

Pre-fill each from detection; phrase as confirmation. Ask only what you can't
infer.

1. **Experience** — "First time running models locally, or are you already deep
   in this?" → `first-timer | familiar | practitioner`.
2. **Primary goal** — "What are you here to do?" → cut cost / cut latency / raise
   quality / learn how this works / meet a compliance constraint.
3. **Constraints** — "Anything that must hold?" → ZDR / data stays local /
   approved providers only / region / budget / none.
4. **Coaching depth** — "How much should I explain as we go?" → walk me through
   it / balanced / just do it and keep it terse.

## Experience → tone dials (defaults)

Set `preferences` from the tier, then let the coaching answer override.

| Tier | vocabulary | coaching | opinion_strength | In practice |
|---|---|---|---|---|
| first-timer | plain | high | prescriptive | Expand every term. Give one clear recommended path. Show the win before the theory. |
| familiar | mixed | medium | balanced | Use common terms freely. Offer the main option plus one alternative. |
| practitioner | technical | low | options-only | Assume fluency. Lay out trade-offs and let them choose. Skip the hand-holding. |

These dials are read by every skill (via
[`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md)),
so the whole experience adapts to the one profile.

## First local model — opinionated first rung

Default first pull is the smallest verified Gemma 4 MLX chat model, served
through MLX on Apple Silicon (see
[`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md)):

- **Apple Silicon first rung** — Understudy-verified QAT-derived
  `gemma-4-e2b-it-qat-mlx-vlm-understudy` (`google/gemma-4-E2B-it` QAT weights,
  MLX 4-bit at `group_size=32`), served with `mlx_vlm.server`. Snapshot:
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy`
  (R2 source:
  `r2://understudy-model-snapshots/models/google/gemma-4-e2b-it/mlx-vlm-0.6.2/qat-understudy-4bit-g32/`).
  It is about 3.6 GB on disk, ~3.9 GB peak memory in testing, generated
  locally at about 218 tok/s, and exposes logprobs/top-logprobs through the
  OpenAI-compatible server.
- **Publication status (check before promising a pull).** The official ladder
  is the QAT-derived `-understudy` snapshots — they are what Understudy trains,
  certifies, and stands behind. If
  `https://models.understudylabs.com/session?model=<id>` answers
  `{"error":"unknown model"}` for an `-understudy` id, that rung has not been
  published to the snapshot service yet: fall back to the matching vanilla
  4-bit snapshot as the *interim* rung, tell the user it is a stand-in, and
  retry the official rung later. Never let onboarding dead-end on a 404.
- **Gemma 4 E4B climb rung** — official target:
  `gemma-4-e4b-it-qat-mlx-vlm-understudy` (QAT weights, MLX 4-bit
  `group_size=32`, about 5.3 GB), the first quality climb when E2B understands
  the task but lacks enough capability. Until that snapshot is published and
  certified, the pullable interim rung is the Understudy-verified vanilla
  conversion
  `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit`
  (about 4.8 GB, `mlx-vlm 0.6.2`, served with `mlx_vlm.server`) — provenance
  and smoke-test details:
  [`../manage-local-models/reference.md`](../manage-local-models/reference.md).
- **Small BF16 diagnostic rung** — an Understudy-verified BF16 conversion of
  `google/gemma-4-e2b-it`, served with `mlx_vlm.server`. Use
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-bf16`
  when quantization may be hurting a small-model workload. It is about
  9.5 GB on disk.
- **Delivery shape** — publish the stable
  `models.understudylabs.com/session?model=...` endpoint. It returns a manifest
  with short-lived signed URLs for the actual model files; do not publish the
  expiring per-object URLs directly.
- **12B local climb rungs** — official target:
  `gemma-4-12b-it-qat-mlx-vlm-understudy` (publication and certification
  pending). Until it lands, use the Understudy-verified vanilla conversion
  `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit`
  first on high-RAM Apple Silicon; it is about 6.3 GB on disk and verified with
  local generation plus OpenAI-compatible logprobs/top-logprobs. Use
  `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16`
  only for larger-memory quality/perf profiling; it is about 22 GB on disk.
- **Larger local Gemma rungs** — the official MoE-style climb is the
  **certified** `gemma-4-26b-a4b-it-qat-mlx-vlm-understudy` (QAT MLX 4-bit
  `group_size=32` + 8-bit routers, about 16 GB; certified generation,
  logprobs/top-logprobs, and tool calls). If its session URL is not yet
  published, the interim rung is `gemma-4-26b-a4b-it-mlx-vlm-4bit` (about
  14 GB). `gemma-4-31b-it-mlx-vlm-4bit` is the dense high-memory local rung at
  about 17 GB. All use stable
  `https://models.understudylabs.com/session?model=<id>` endpoints; see
  [`../manage-local-models/reference.md`](../manage-local-models/reference.md)
  for the canonical provenance statement and the known-good chat smoke.
- **DiffusionGemma rungs (specialty, not an onboarding default)** —
  `diffusiongemma-26b-a4b-it-mlx-vlm-4bit` (about 16 GB) and
  `diffusiongemma-26b-a4b-it-mlx-vlm-bf16` (about 52 GB), converted from
  `google/diffusiongemma-26B-A4B-it` with `mlx-vlm 0.6.3` and served with
  `mlx_vlm.server` (requires mlx-vlm ≥ 0.6.3 for the `diffusion_gemma`
  architecture). Block-diffusion decoding: pick it to explore whole-block
  drafting/infilling behavior, not for speed — on Apple Silicon the
  autoregressive 26B-A4B rung decodes faster (see the DiffusionGemma note in
  [`../manage-local-models/reference.md`](../manage-local-models/reference.md)).
- **Full-precision high end** — Understudy-verified BF16 snapshots
  `gemma-4-26b-a4b-it-mlx-vlm-bf16` (about 52 GB) and
  `gemma-4-31b-it-mlx-vlm-bf16` (about 62 GB), converted with `mlx-vlm 0.6.3`
  and served with `mlx_vlm.server`. They are not the default onboarding pull:
  they are large downloads that require explicit approval plus a disk/RAM
  check.
- **First-rung fallback order** — if the official
  `gemma-4-e2b-it-qat-mlx-vlm-understudy` session URL is unavailable, fall back
  first to the published vanilla
  `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit`
  (about 3.3 GB, same family and serving stack — the aha moment survives), and
  only then to the tiny `mlx-community/gemma-3-1b-it-4bit` (`mlx_lm.server`,
  about 772 MB, loads on `mlx-lm 0.31.3`) when disk/RAM is severely
  constrained.
- **Stock Gemma 4 MLX caveat** — `mlx-community/Gemma4-E2B-IT-Text-int4` and
  `mlx-community/gemma-4-e2b-it-4bit` failed on the tested stack with a Gemma 4
  shared-KV weight/config mismatch. The Understudy snapshot exists to give users
  a known-good first rung instead of sending them into loader debugging.
- **Do not use `*-assistant` Gemma 4 repos as the first model.** They are MTP
  draft models for speculative decoding, not standalone chat models.
- **Next rungs** — Gemma 4 12B, Nemotron 3 Nano 4B, Nemotron 3
  Nano 30B-A3B, then remote/hybrid Gemma/Nemotron routes after the first
  local-vs-frontier gap is visible.

Acquisition, caching, disk locations, and the larger ladder live in
[`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md).
