---
name: understudy
description: Use when a developer asks to use Understudy, reduce AI cost or latency, evaluate or optimize an AI workload, prepare training data, run local/open models, set up capture or proxying, inspect model options, or run a first demo. Route to the narrow specialist skill before running commands.
metadata:
  understudy:
    mode: automatic
    safety: value-first
    cli_required: false
---

# Understudy

Use this as the public entrypoint for Understudy. The job is to help the
developer reach measured value quickly: lower cost, lower latency, equal or
better quality, cleaner evals, or a credible next experiment.

Local-first means start from the user's machine and artifacts. It does not mean
"only run cost-free checks." If value is likely, guide the developer toward the
fastest reasonable path: reuse existing provider keys, use an Understudy API key,
download a public model, run a local MLX/Ollama smoke, or route through a local
proxy. Ask for approval only at the boundary where spend, upload, or hosted
execution begins.

Do not use this skill as a full runbook. Route to the narrow specialist skill,
then follow that skill's CLI, value, and safety instructions.

## Resolve CLI

Do not resolve the CLI in this router unless setup status is the user's actual
request.

When a routed specialist skill requires the CLI, open and read
[`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md), then define
the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, route to
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md). Do not
stop at "CLI unavailable" if a local install or bootstrap path can move the user
forward.

## Operating Posture

Optimize for useful evidence, not ritual caution.

- Prefer the user's real workload over synthetic demos when they have one.
- Prefer an existing eval suite, trace store, prompt set, dataset, or app route
  over creating a toy benchmark.
- Prefer local replay and local models when they can answer the economic
  question quickly.
- Prefer existing API keys when the user already has them and approves a capped
  run.
- Prefer Understudy inference when it saves integration time, provides better
  routing evidence, or avoids bespoke provider glue.
- Prefer public open models such as Gemma/Qwen/Llama-class candidates when a
  download or local smoke can expose a real cost or latency opportunity.

Be concrete about value:

- current route, model, latency, cost/request, and failure rate;
- candidate route or model;
- expected savings or speedup hypothesis;
- quality gate and sample size;
- next command and approval boundary.

## Safety Gates

Default storage is local. Never upload source files, prompts, traces, outputs,
datasets, repo paths, private notes, provider keys, or secrets unless the
developer explicitly approves that exact action in the current thread.

Provider keys and Understudy API keys are useful tools, not automatic
permission. Before live calls, hosted jobs, model downloads, uploads, benchmark
submission, or training, require:

- named provider, model, registry, or hosted surface;
- estimated or capped spend, or estimated download size;
- exact artifact or data class being sent or downloaded;
- reviewed dry-run, preview, or local plan when available;
- visible output path under `.understudy/`.

Do not ask the user to paste secrets into chat. Inspect configured key presence
only through redacted local status checks.

Keep public examples synthetic or user-provided. Do not include customer names,
domains, private runbooks, raw prompts, raw completions, secrets, or internal
hosted-control details in public skill output.

## Intake

1. Identify the economic target: cost, latency, quality, reliability,
   portability, local privacy, or training handoff.
2. Identify the real workload source: app route, prompt, trace store, eval rows,
   logs, dataset, report, model comparison, or existing benchmark.
3. Identify current and candidate routes: incumbent model/provider, existing
   API keys, Understudy key, local runner, public model, or managed provider.
4. Ask at most one clarifying question when the next action is ambiguous.
5. Route to the smallest specialist skill that can create useful evidence.

## Flow

Route by value path:

- Find opportunities in a local repo, scan code for AI workloads, or choose
  what to evaluate first: read
  [`../understudy-workload-discovery/SKILL.md`](../understudy-workload-discovery/SKILL.md).
- "Show me quickly," first-run proof, or no workload yet: read
  [`../understudy-demo/SKILL.md`](../understudy-demo/SKILL.md).
- Existing prompts, traces, eval rows, reports, datasets, or candidate
  comparison: read
  [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).
- Reduce cost or latency after a measured baseline, or improve quality,
  parsing, routing, prompts, or reliability: read
  [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
- MLX, Apple Silicon, Ollama, llama.cpp, public local models, model downloads,
  quantization, memory fit, or local inference latency: read
  [`../understudy-local-models/SKILL.md`](../understudy-local-models/SKILL.md).
- Model availability, tokenizer/context/tool-call/logprob compatibility, or
  local-vs-remote candidate choice: read
  [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md).
- Local OpenAI-compatible proxy, app routing, trace capture, or replay through a
  local endpoint: read
  [`../understudy-local-proxy/SKILL.md`](../understudy-local-proxy/SKILL.md).
- Provider key, Understudy API key, redacted credential status, or spend-ready
  setup: read
  [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md).
- SFT, preference data, RL trajectories, adapters, LoRA, or hosted training
  handoff: read [`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).
- Multi-run research, hypotheses, budgets, experiment notes, or stop/go
  decisions: read [`../understudy-lab/SKILL.md`](../understudy-lab/SKILL.md).

If more than one route applies, use this order:

1. evaluate the real workload;
2. try local/public candidate evidence when plausible;
3. use existing or Understudy API keys for capped live evidence when needed;
4. optimize only after a baseline;
5. train only after simpler levers stop moving the measured gate.

## Output Standard

End with:

- economic target and current best next route;
- specialist skill used or recommended;
- what was inspected or run;
- artifact paths created or read;
- result type: demo, dry-run, local smoke, replay, validation, heldout, or live;
- spend/upload/download approval boundary, if any;
- one recommended command.
