---
name: workload-takeover
description: DRAFT PROPOSAL — not yet installed. Use when a developer hands you a captured trace or dataset of an expensive frontier-model workload and asks "can a smaller / local model take this over, and what would the harness have to change?" The umbrella loop that ties understand-workload, mlx-arena, run-local-model-lab, capture-evidence, and optimize-api-workflow into one decision — decompose the workload, vibe-check small-vs-frontier on grounded questions, reconstruct the full agent task loop from captures, test the harness swaps that let a small model reach parity (tool-subsetting, recorded-replay, recursive decomposition), and emit a trust scorecard with a route recommendation. Triggers — "can a small model do this", "should we take this off Opus", "what would it cost to move this workload local", "is this frontier spend necessary", or a handoff from understand-workload / mlx-arena once the workload is understood.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    status: proposed-draft
    cli_required: false
---

> **DRAFT PROPOSAL — for review, not yet installed.** This skill is parked under
> `skills/_proposed/` and is **not wired into the plugin**. It codifies a workflow
> built this session from real production captures. Review the flow and the data
> boundary before promoting it into `skills/` and registering it.

# Workload Takeover — can a smaller/local model do this job?

The orchestrator for one question a developer keeps asking: *"This workload runs
on a frontier model and it's expensive — can a smaller or local model take it
over, and what would the harness have to change to make that work?"*

Single-shot vibe-checks under-sell small models on real agentic workloads,
because the real workload is **not one prompt** — it's a multi-turn loop with a
large fixed tool surface re-sent every turn, where context compounds. A fair
takeover decision has to look at the *whole loop* and at *harness changes*, not
just swap the model and watch it lose. This skill runs that full investigation
and ends with a defensible route recommendation.

It is an **umbrella skill**: it sequences the existing workers and references
them, it does not duplicate them. Each phase hands off to a real skill.

## Safety Gates

- **Data boundary — captures stay local; synthetic before commit.** Production
  captures are customer data (transcripts, PII, business records). Keep every
  capture, replay log, and decomposition note under `.understudy/` on the local
  machine. Show **structure and aggregates** — token counts, tool catalogs,
  turn counts, sizes, scores — never raw message bodies or tool payloads.
  Anything that leaves the machine or gets committed (questions, fixtures,
  scorecards) must be **synthetic or redacted first**. Follow
  [`../../../docs/privacy-and-data-boundaries.md`](../../../docs/privacy-and-data-boundaries.md).
- **No weight downloads or provider spend without approval + a cap.** Name the
  exact MLX repo, quantization, and GB before any pull; get explicit approval
  before any hosted/frontier run, replay against a paid model, or live API call.
- **No takeover claim without a measured before/after.** Every parity, cost, or
  latency number comes from a frozen eval and a recorded baseline, not from
  memory. A route recommendation is a *measured* claim with its sample size,
  split, and caveats — or it's not made.
- **Recorded-replay must not re-fire side effects.** When you replay captured
  inputs against another model, the tool *results* are recorded and replayed too;
  the loop must never actually re-execute a state-mutating tool against a live
  system.

## When To Use

Use this when **all** of these hold:

- there is a captured trace or dataset from a real workload (an Understudy
  capture envelope, or raw Anthropic/OpenAI request JSON);
- the workload runs on an expensive frontier model and someone is questioning
  the spend, or needs a local-only route for compliance;
- the workload is agentic or multi-step (tool-calling loop, sub-agents, RAG),
  not a single one-shot completion — that's where harness changes pay off.

If you only need to *understand* one prompt, stop at
[`../../understand-workload/SKILL.md`](../../understand-workload/SKILL.md). If
you just want a live feel of two models, use
[`../../mlx-arena/SKILL.md`](../../mlx-arena/SKILL.md). If a model is already
chosen and you only need to score it on a frozen eval, use
[`../../run-local-model-lab/SKILL.md`](../../run-local-model-lab/SKILL.md).

## Flow

The five phases. Run them in order; each can short-circuit the decision (e.g. if
the small model wins the vibe-check one-shot, you may not need the harness work).

### 1. Understand the workload

Hand the representative capture(s) to
[`../../understand-workload/SKILL.md`](../../understand-workload/SKILL.md):
decompose → six-facet plain-language explanation → mermaid flow → interactive
Q&A → **agreed success criteria beyond cost/speed** (final-state correctness,
extraction recall/precision, policy compliance, no bad writes, schema validity).
You cannot judge a takeover without knowing what "success" means for *this*
workload. Output of this phase is the shared mental model + the grounded
questions for phase 2.

### 2. Vibe-check small vs frontier (grounded)

Turn the success criteria into grounded questions and run the **blind
head-to-head** in [`../../mlx-arena/SKILL.md`](../../mlx-arena/SKILL.md): frontier
(Claude Opus 4.8 high-reasoning, or `gpt-5.1` via the gateway) vs a small local
MLX model, randomized Left/Right, two questions per round — *which do you PREFER*
and *which do you think is the FRONTIER* (the second measures identification
accuracy: if users can't reliably pick the frontier, the small model is already
good enough on that class). Reveal cost/speed only at the end. This produces the
first trust signal: on which task classes is the small model indistinguishable,
and on which is there a real gap that needs harness work.

### 3. Reconstruct the full task loop from captures

The honest part. A full task is **not one request** — it's a multi-turn agent
loop. From the dataset, reconstruct and report (redaction-safe, aggregates only):

- **Turns per task** and the call stack — one tool call per turn, plus any
  **sub-agent** invocations.
- **Per-request token breakdown**, split into **fixed tool-definition overhead**
  (the tool catalog re-sent every turn) vs **per-call content**. On real
  Agent-SDK workloads this session, the fixed tool surface was the dominant cost
  — the large majority of a ~24k-token prompt was generic tool definitions
  re-sent every turn, with only a minority being the actual per-call content.
- **Context compounding** — tool_results get appended and re-sent on every
  subsequent turn, so one large tool result is re-billed several times across
  the loop. Quantify the multiplier and the total input tokens / cost for a
  representative full task.
- **Tool declarations vs tool responses** — separate the cost of *describing*
  tools from the cost of their *outputs*; they need different harness fixes.

This phase tells you *which lever matters*: a huge fixed tool surface points at
tool-subsetting; heavy context compounding points at replay + decomposition.

### 4. Harness-swap analyses

Test the changes that let a small model reach parity. Pick the levers phase 3
flagged; you rarely need all three.

- **(a) Tool-subsetting — cut the fixed overhead.** When most of every prompt is
  a generic tool catalog re-sent each turn, the win is shrinking the *tool
  surface*, not chunking the transcript. Per step, expose only the tools that
  step can actually use (the call stack from phase 3 shows which are ever used at
  each point). Measure the token/cost reduction and confirm the loop still
  reaches the same final state. This is often the single biggest lever and
  doesn't even require changing the model.
- **(b) Recorded-replay environment.** Re-run the **same captured inputs** with
  the **recorded tool_results replayed** (no live tool execution) against other /
  smaller models, and score against the phase-1 success criteria. This is the
  fair, deterministic, side-effect-free way to ask "would model X have produced
  an acceptable turn here?" — same inputs, same observations, different brain.
  (Builds on a **recorded replay-queue** concept: a queue that drives captured
  inputs + recorded results through candidate models.) Keep
  replay logs local; synthesize fixtures before any commit.
- **(c) Recursive-language-model (RLM) / decomposition.** For steps a small model
  can't one-shot, give it a different harness: a small model driving **multiple
  bounded passes in a REPL/loop** — plan → retrieve the slice it needs → do one
  bounded sub-task → verify → repeat, carrying state in a scratchpad/file instead
  of the context window. Measure the **decomposition factor**: how many bounded
  passes the small model needs to match the teacher's recall/precision/policy on
  that step. Factor 1 = parity one-shot; factor 4 = four bounded steps equal one
  frontier call. This anchors on the real signal from this session — a small open
  model that was strong on precision but weak on single-shot recall needs several
  passes to match the teacher, and that count is the metric. See
  [`../../mlx-arena/ROADMAP.md`](../../mlx-arena/ROADMAP.md) Phases 3–4.

Freeze the eval, metric, and splits for these runs via
[`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md); for
multi-step REST/state-mutating workloads use
[`../../optimize-api-workflow/SKILL.md`](../../optimize-api-workflow/SKILL.md) so
reset/seed state, allowed endpoints, request logs, and final-state validators are
part of the harness. Score candidates with
[`../../run-local-model-lab/SKILL.md`](../../run-local-model-lab/SKILL.md).

### 5. Trust scorecard + route recommendation

Collapse everything into a number the developer can act on:

- **Coverage at parity** — % of the workload's task classes the small model
  handles at parity (one-shot, or via the harness swaps), keyed to the phase-1
  success criteria — plus the blind-test identification accuracy from phase 2.
- **Decomposition-factor distribution** — median and tail of how many bounded
  passes parity costs across the task set (i.e. how much harness work the
  takeover actually requires).
- **Measured cost/latency savings** — frontier vs the chosen local/harness path
  on the tasks where they tie, *measured not asserted*, including the
  tool-subsetting overhead reduction and the replay/decomposition compute.
- **Route recommendation** — the cut line: ship local for these task classes,
  route the hard tail to frontier (hybrid/cascade), or stay remote where the
  decomposition factor isn't worth it. Feed it into
  [`../../run-local-model-lab/SKILL.md`](../../run-local-model-lab/SKILL.md) and
  [`../../use-understudy-gateway/SKILL.md`](../../use-understudy-gateway/SKILL.md).

## Output Standard

End with: the representative capture(s) and their sizes; the agreed success
criteria; the blind head-to-head result (preference + identification accuracy by
category); the reconstructed task loop (turns, fixed-vs-content token split,
context-compounding multiplier, full-task cost); the harness-swap results that
were run (tool-subsetting reduction, replay parity by model, decomposition factor
per step); and the **trust scorecard with a route recommendation** — coverage at
parity, decomposition-factor distribution, measured savings, and the cut line.
Keep all captures, replay logs, and decomposition notes local; only synthetic or
redacted artifacts leave the machine. Fold the verdict into the Understudy Agent
Improvement Report ([`../../understudy/reference.md`](../../understudy/reference.md)).

## References

- [`../../understand-workload/SKILL.md`](../../understand-workload/SKILL.md) — phase 1: decompose, explain, mermaid, success criteria.
- [`../../mlx-arena/SKILL.md`](../../mlx-arena/SKILL.md) — phase 2: blind small-vs-frontier head-to-head.
- [`../../mlx-arena/ROADMAP.md`](../../mlx-arena/ROADMAP.md) — harness-swap, decomposition factor, and trust scorecard plan (Phases 3–4).
- [`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md) — freeze harness/metric/splits/baseline for the harness-swap runs.
- [`../../optimize-api-workflow/SKILL.md`](../../optimize-api-workflow/SKILL.md) — state-mutating multi-step API workflows (reset/seed, validators).
- [`../../run-local-model-lab/SKILL.md`](../../run-local-model-lab/SKILL.md) — score a candidate on the frozen eval; produce the route decision.
- [`../../use-understudy-gateway/SKILL.md`](../../use-understudy-gateway/SKILL.md) — the remote/hybrid side of the route.
