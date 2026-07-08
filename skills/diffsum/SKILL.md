---
name: diffsum
description: Use when a developer wants a git diff or commit summarized by a tiny local model — "summarize this diff locally", "one-line my commit", "what changed in this patch", "per-file change summaries without sending code anywhere". A dependency-light llama.cpp micro-model demo of local-first inference doing a real daily job. To score local models on a workload, use run-local-model-lab.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Diffsum — one-sentence diff summaries from a micro model

A single bash script ([`diffsum.sh`](diffsum.sh)) that summarizes a patch diff
as one concise sentence using a ~0.8B GGUF model running locally via llama.cpp.
No gateway, no API key, no Python stack — `brew install llama.cpp` (plus
`jq` for per-file mode) is the whole setup. Nothing leaves the machine after
the one-time model download.

Adapted from [Eric Tramel's gist](https://gist.github.com/eric-tramel/2f61e38f2892311e9cfd257b05bc3705).

Beyond being useful day-to-day, this is the smallest honest demo of the
Understudy thesis: a micro model, well-prompted and well-harnessed, does a real
job a developer would otherwise burn frontier tokens on. Show it when a user
asks "what can a tiny local model actually do?" and the [`ladder`](../ladder/SKILL.md)
feels too heavy.

## Safety Gates

- **No download without explicit approval.** The first run pulls ~810 MB of
  model weights from Hugging Face; state the size and get a yes first. After
  that the script is fully offline and local.
- **Diff content stays local.** The diff is only ever sent to a llama.cpp
  process on 127.0.0.1; never route it to a hosted model without asking.

## Run it

```sh
skills/diffsum/diffsum.sh                 # summarize uncommitted changes
git show HEAD | skills/diffsum/diffsum.sh # summarize a piped patch
skills/diffsum/diffsum.sh <git-sha>       # summarize a commit
skills/diffsum/diffsum.sh -f              # one summary line per edited file
```

First run downloads the model (~810 MB) from Hugging Face into
`~/.cache/huggingface/hub` — **state the size and get approval before the
first run**, per the manage-local-models download gate. Later runs are
offline.

Per-file mode (`-f`) spins up an ephemeral local `llama-server` with parallel
slots so file summaries overlap; it dies with the script.

## Knobs

| Env var | Default | Meaning |
| --- | --- | --- |
| `DIFFSUM_MODEL` | `unsloth/Qwen3.5-0.8B-GGUF:Q8_0` | any HF GGUF repo/quant |
| `DIFFSUM_CTX` | `8192` | context tokens per summary |
| `DIFFSUM_SLOTS` | `4` | parallel summaries in `-f` mode |
| `DIFFSUM_STREAM` | tty-detect | force live typewriter view on/off |

The default model is Qwen3.5-0.8B because nothing American is competitive at
this size in GGUF today; if the user prefers an American family
([`manage-local-models`](../manage-local-models/SKILL.md)), point
`DIFFSUM_MODEL` at a small Gemma GGUF and expect slower load at larger sizes.

## What it teaches (talking points)

- **Prompt prefill as a control surface**: the script closes the model's
  `<think>` block in the prompt, so a reasoning model can't burn tokens
  thinking — cheaper and faster than asking nicely.
- **Post-processing beats prompt begging**: the model sometimes ignores "start
  with a verb"; a two-line awk fixes it deterministically.
- **One server, many slots**: per-file mode amortizes one model load across N
  parallel summaries — the same shape run-local-model-lab uses at eval scale.
