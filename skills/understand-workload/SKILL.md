---
name: understand-workload
description: Use to decompose and explain a captured prompt/trace before comparing models or writing vibe-check questions — "explain this prompt/trace", "decompose this workload", "what is this prompt trying to do", "help me understand this dataset before testing models", "walk me through this prompt", or any handoff from mlx-arena / capture-evidence where the workload isn't understood yet.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Understand the workload (profile traces, data, prompts, and code path)

The intermediate step before you compare, optimize, or route models. **You
cannot improve an AI workload you cannot explain.** Seeing generated questions
or a side-by-side duel in isolation is secondary; first help the user understand
what their workload is meant to accomplish, what data it represents, and how a
request moves through the app. This skill turns traces, prompt files, datasets,
and code paths into a *shared mental model* — purpose, inputs, outputs, steps,
tool-call flow, data shape, failure modes, and success criteria — built **with**
the user through Q&A.

Every workload is different, so this is a skill, not a script: the agent
extracts structure from traces and code; the user confirms the task meaning.

## Safety Gates

- **Redact customer content.** Captured prompts often contain real customer data
  (transcripts, PII, business records). Show **structure** — system-prompt
  outline, message roles + sizes, tool catalog, output schema — never raw message
  bodies. Build the decomposer to redact by construction (sizes and headings, not content).
- **Local-first.** The decomposition/understanding doc stays local; do not commit
  it or paste customer payloads into external services. The *generated questions*
  must be synthetic (no customer data) before they can be committed or sent to a
  model.
- Make cost/latency/model claims from the capture itself, not memory.
- **No premature duel.** Do not route to a frontier-vs-local head-to-head until
  the workload purpose, data shape, and success criteria are clear enough that
  the comparison questions map to real task behavior.

## Inputs it handles

- **Understudy capture envelopes** (`.jsonl` with a `customer_request_body`).
- **Raw request JSON** (Anthropic/OpenAI shape: `model`, `system`, `messages`, `tools`).
- **Prompt/config files** embedded in an app (`prompts/`, route handlers, agent
  policy files, YAML/JSON configs, eval manifests).
- **Code paths** that assemble the request, call the provider, parse responses,
  invoke tools, retry, stream, or write state.
- **Datasets and eval rows** (`.jsonl`, fixtures, golden outputs, trace exports,
  benchmark tasks, request logs).
- A **folder** of captures — pick one or two representative ones (e.g. median and
  largest token count) rather than all of them.

## Flow

1. **Locate the workload surface.** Start from what the user named: codebase,
   app route, prompt file, dataset, eval suite, trace export, benchmark fixture,
   request log, or existing runner. List candidate surfaces and identify which
   one appears to be the actual production or benchmark workload. If given a
   dataset or trace folder, list row/count/file sizes and pick the median +
   largest representative cases (size drives the harness story). Understudy
   captures are envelopes with a `customer_request_body`; parse that to get the
   request (`model`, `system`, `messages`, `tools`, params).

2. **Trace the request/response path in situ.** Follow the code from user input
   or eval row to prompt assembly, model/provider call, tool loop, response
   parsing, retries, streaming, and any writes. Name the files/functions/routes
   involved, the env var names used for providers, and where logs or traces are
   emitted. Do not stop at "there is a prompt"; show the whole path the request
   takes and where the candidate model can safely be swapped in.

3. **Decompose the request structure, redaction-safe** — extract and report only:
   model + params, token size, the **system-prompt outline** (its `#` headings, not
   the body), the **messages** (roles + char sizes — never content), the **tool
   catalog grouped by action class** (read / transform / write / search /
   orchestrate / notify / exec, with each tool's token cost), and the output schema.
   Crucially, split the token cost into **fixed overhead (system + tool definitions,
   re-sent every turn) vs per-call content** — the fixed share is usually the
   surprise and drives the harness story.

4. **Profile the data or traces.** Before model comparison, describe what the
   dataset represents: row count, split/source if known, task categories, input
   size distribution, output shapes, labels/golden fields, tool-call/request-log
   counts, common failure classes, and outliers. Use metadata, schemas, counts,
   hashes, and redacted examples. If raw examples are needed, ask for explicit
   approval and show the smallest safe excerpt.

5. **Explain it back in plain language** — seven facets, each one or two sentences:
   - **Purpose** — what is this prompt trying to accomplish?
   - **Inputs** — what goes in (and roughly how big)?
   - **Data represented** — what rows/traces/users/tasks does this dataset stand for?
   - **Outputs** — what should come out, in what shape?
   - **Steps** — how many, and what is each step doing?
   - **Tools/actions** — what can it touch, and which calls *mutate state*?
   - **Code path** — where the request is assembled, called, parsed, and logged.
   - **How we judge success** — the task-level criteria (correct records written,
     right observations extracted, policy followed) — **not just cost and speed.**

6. **Show the flow as a mermaid diagram.** Draw the agent loop and tool classes so
   the user can *see* the shape: inputs → system → loop → {read / transform / write}
   → final state. For a multi-turn case, also reconstruct the loop turn-by-turn from
   the (history-carrying) captures — per-request token growth and how context
   compounds as tool results are appended — and render that too.

7. **Q&A discovery — build the understanding WITH the user.** Use `AskUserQuestion`
   to confirm and fill gaps you can't infer from structure alone, e.g.:
   - "Is the goal *extraction* (read→structured output) or *orchestration*
     (read→decide→write)? I inferred X from the tools — right?"
   - "Which step is the one that actually matters for success?"
   - "What counts as a correct outcome here — and what's an unacceptable failure
     (e.g. a wrong write vs a missed item)?"
   - "Where does the big token cost come from — fixed context or per-item input?"
   Iterate until the user says the picture is right.

8. **Write the success criteria** — the rubric axes for *this* workload, beyond
   cost/latency: final-state correctness, extraction recall/precision, policy
   compliance, no-bad-writes, schema validity. These become the metric the arena /
   `capture-evidence` use.

9. **Use the shared understanding to test or improve models.** Primary path:
   freeze a workload contract with [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
   and run the local model against the real task via
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) or the
   appropriate optimizer skill. Optional side quest: derive grounded vibe-check
   questions for [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md), each mapped to
   a real step/criterion, when the user needs a visible local-vs-frontier feel
   check. For a whole-case test a small model cannot one-shot, build a simulated
   environment only when no real resettable workload exists.

## Output Standard

End with: workload surface inspected; representative trace(s)/dataset rows
chosen and their size; the request/response code path; data/trace profile; the
seven-facet explanation; the mermaid flow; success criteria agreed with the
user; artifact paths for the local workload brief; and the next evidence action.
If you include arena questions, mark them optional and tie each to a real step
or criterion. Keep the decomposition doc local; only synthetic questions leave.

## Single-run tool-failure forensics

When one environment-backed or tool-calling run failed and the question is
"why did the model make that choice from what it actually saw?", use
[`references/tool-trace-forensics.md`](references/tool-trace-forensics.md). It
separates environment evidence from model-visible evidence, reconstructs
reads/writes before the first mutation, classifies the failure (retrieval,
authority precedence, format, ID resolution, parser, harness), and recommends
the cheapest fix before training.

## References

- [`../profile-captures/SKILL.md`](../profile-captures/SKILL.md) — the fleet sibling: profile a whole capture dir into a cost + call-type taxonomy first, then aim this skill at the cluster worth decomposing.
- [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) — frontier-vs-local head-to-head the questions feed.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md) — turn the understood workload into a scorable env.
- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) — decompose so a small model can take the whole case.
- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — freeze the metric/splits.
- [`../optimize-api-workflow/SKILL.md`](../optimize-api-workflow/SKILL.md) — the API-workflow metric axes.
