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
  "local_models": [],                       // [{id, runtime, quant, size_gb, pulled_at}]
  "history": []                             // [{workload, decision, route, at}]
}
```

Write it with the smallest correct change: merge new fields, append to `history`
and `local_models`, bump `updated_at`. If a value is unknown, leave it null
rather than guessing.

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

## First local model — pick small, American, cached

Default first pull is the smallest model that still feels real, biased to the
American open families (see
[`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md)):

- **Apple Silicon, any RAM** — Gemma 4 E4B (~4.5B eff.) or Nemotron 3 Nano 4B
  via Ollama or MLX. Fast, tiny download, runs everywhere.
- **32 GB+** — can step up to Nemotron 3 Nano 30B-A3B (MoE, ~4B active speed) or
  Gemma 4 12B once the tiny one proves the loop.

Acquisition, caching, disk locations, and the larger ladder live in
[`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md).
