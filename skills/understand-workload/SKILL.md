---
name: understand-workload
description: Use when a developer wants a captured prompt, trace, or dataset explained before changing anything — "explain this prompt", "what is this trace actually doing", "decompose this workload", "help me understand this dataset before testing models". Builds a shared mental model (purpose, inputs, tools, success criteria) with the user through Q&A.
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
the user through inference-first, targeted Q&A.

Every workload is different, so this is a skill, not a script: the agent
acts as the conversational frontend, extracts structure and a proposed task
meaning from traces and code, and asks the user only about material uncertainty.
When this understanding feeds a hosted eval and the owner is unavailable,
preserve uncertainty explicitly and continue to a provisional local draft
rather than blocking useful analysis.

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
   compounds as tool results are appended — and render that too. When the user
   wants to inspect the underlying calls interactively, build the private local
   viewer from
   [`../ingest-traces/references/trace-viewer.md`](../ingest-traces/references/trace-viewer.md)
   and keep its payload-bearing output under `.understudy/`.

7. **Targeted Q&A — infer first, then ask only about consequential gaps.** Show
   the proposed purpose, success criteria, execution modes, and failure taxonomy
   with the local evidence behind each inference. Do not ask the user to restate
   information already present in the repository or traces. Use
   `AskUserQuestion` only for gaps whose answers would materially change the
   metric, environment, or case selection, e.g.:
   - "Is the goal *extraction* (read→structured output) or *orchestration*
     (read→decide→write)? I inferred X from the tools — right?"
   - "Which step is the one that actually matters for success?"
   - "What counts as a correct outcome here — and what's an unacceptable failure
     (e.g. a wrong write vs a missed item)?"
   - "Where does the big token cost come from — fixed context or per-item input?"
   Incorporate answers when available. If the person at the keyboard is not the
   workload owner or cannot answer, label the affected statements provisional,
   and list the smallest owner decisions still needed. When this feeds the
   hosted-eval path, continue authoring the local eval draft; otherwise finish
   the provisional workload brief. Never turn an unanswered question into a
   fabricated owner confirmation.

8. **Write the proposed success criteria** — the rubric axes for *this*
   workload, beyond cost/latency: final-state correctness, extraction
   recall/precision, policy compliance, no-bad-writes, schema validity. These
   become the metric `capture-evidence` and downstream local/optimizer runs use.
   Mark them provisional until a workload owner or delegated domain expert
   confirms them; trace outputs are observations, never correctness authority.

9. **Use the shared understanding to test or improve models.** Primary path:
   freeze a workload contract with [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)
   and run the local model against the real task via
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) or the
   appropriate optimizer skill. Optional side quest: derive grounded vibe-check
   questions for [`../ladder/SKILL.md`](../ladder/SKILL.md), each mapped to a
   real step/criterion, when the user needs a visible
   local-vs-frontier feel check. For a whole-case test a small model cannot one-shot, build a simulated
   environment only when no real resettable workload exists.

For a workload hosted by Understudy, follow the draft-first branch in
[`../capture-evidence/references/hosted-workload-eval.md`](../capture-evidence/references/hosted-workload-eval.md).
Use the exact one-day raw source and repository to create the local draft, then
run `understudy evals check --draft`. The CLI defaults to the rolling 24 hours
ending when export starts; `--date YYYY-MM-DD` selects a completed UTC day.
Keep raw traces local. Strict checking, final approval, and publication remain
separate owner-confirmed release steps.

## Output Standard

End with: workload surface inspected; representative trace(s)/dataset rows
chosen and their size; the request/response code path; data/trace profile; the
seven-facet explanation; the mermaid flow; success criteria agreed with the
user or explicitly marked provisional; unresolved assumptions and the smallest
owner decisions still needed; artifact paths for the local workload brief; and
the next evidence action.
If you include ladder vibe-check questions, mark them optional and tie each to a
real step or criterion. Keep the decomposition doc local; only synthetic
questions leave.

## Single-run tool-failure forensics

When one environment-backed or tool-calling run failed and the question is
"why did the model make that choice from what it actually saw?", use
[`references/tool-trace-forensics.md`](references/tool-trace-forensics.md). It
separates environment evidence from model-visible evidence, reconstructs
reads/writes before the first mutation, classifies the failure (retrieval,
authority precedence, format, ID resolution, parser, harness), and recommends
the highest-leverage fix supported by the failure evidence before training.

## References

- [`../ingest-traces/references/profile-captures.md`](../ingest-traces/references/profile-captures.md) — the fleet sibling: profile a whole capture dir into a cost + call-type taxonomy first, then aim this skill at the cluster worth decomposing.
- [`../ladder/SKILL.md`](../ladder/SKILL.md) — no-data local-vs-frontier feel check the questions can feed.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md) — turn the understood workload into a scorable env.
- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) — decompose so a small model can take the whole case.
- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — freeze the metric/splits.
- [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md) — the agentic-workload metric axes.
