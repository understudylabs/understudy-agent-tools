---
name: understand-workload
description: Use to decompose and explain a captured prompt/trace before comparing models or writing vibe-check questions — "explain this prompt/trace", "decompose this workload", "what is this prompt trying to do", "help me understand this dataset before testing models", "walk me through this prompt", or any handoff from mlx-arena / capture-evidence where the workload isn't understood yet.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Understand the workload (decompose & explain a prompt)

The intermediate step before you compare models. **You cannot fairly vibe-check
two models on a workload you don't understand**, and seeing generated questions in
isolation is useless if the user has never seen what the real prompt does. This
skill turns one captured prompt into a *shared mental model* — purpose, inputs,
outputs, steps, tool-call flow, and success criteria — built **with** the user
through Q&A, and only then derives the comparison questions.

Every prompt is different, so this is a skill, not a script: the decomposer
extracts the structure; you supply the meaning and confirm it with the user.

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

## Inputs it handles

- **Understudy capture envelopes** (`.jsonl` with a `customer_request_body`).
- **Raw request JSON** (Anthropic/OpenAI shape: `model`, `system`, `messages`, `tools`).
- A **folder** of captures — pick one or two representative ones (e.g. median and
  largest token count) rather than all of them.

## Flow

1. **Locate + pick a representative trace.** If given a dataset, list the captures
   with sizes and pick the median + the largest (size drives the harness story).
   Understudy captures are envelopes with a `customer_request_body`; parse that to
   get the request (`model`, `system`, `messages`, `tools`, params).

2. **Decompose the structure, redaction-safe** — extract and report only:
   model + params, token size, the **system-prompt outline** (its `#` headings, not
   the body), the **messages** (roles + char sizes — never content), the **tool
   catalog grouped by action class** (read / transform / write / search /
   orchestrate / notify / exec, with each tool's token cost), and the output schema.
   Crucially, split the token cost into **fixed overhead (system + tool definitions,
   re-sent every turn) vs per-call content** — the fixed share is usually the
   surprise and drives the harness story.

3. **Explain it back in plain language** — six facets, each one or two sentences:
   - **Purpose** — what is this prompt trying to accomplish?
   - **Inputs** — what goes in (and roughly how big)?
   - **Outputs** — what should come out, in what shape?
   - **Steps** — how many, and what is each step doing?
   - **Tools/actions** — what can it touch, and which calls *mutate state*?
   - **How we judge success** — the task-level criteria (correct records written,
     right observations extracted, policy followed) — **not just cost and speed.**

4. **Show the flow as a mermaid diagram.** Draw the agent loop and tool classes so
   the user can *see* the shape: inputs → system → loop → {read / transform / write}
   → final state. For a multi-turn case, also reconstruct the loop turn-by-turn from
   the (history-carrying) captures — per-request token growth and how context
   compounds as tool results are appended — and render that too.

5. **Q&A discovery — build the understanding WITH the user.** Use `AskUserQuestion`
   to confirm and fill gaps you can't infer from structure alone, e.g.:
   - "Is the goal *extraction* (read→structured output) or *orchestration*
     (read→decide→write)? I inferred X from the tools — right?"
   - "Which step is the one that actually matters for success?"
   - "What counts as a correct outcome here — and what's an unacceptable failure
     (e.g. a wrong write vs a missed item)?"
   - "Where does the big token cost come from — fixed context or per-item input?"
   Iterate until the user says the picture is right.

6. **Write the success criteria** — the rubric axes for *this* workload, beyond
   cost/latency: final-state correctness, extraction recall/precision, policy
   compliance, no-bad-writes, schema validity. These become the metric the arena /
   `capture-evidence` use.

7. **Use the shared understanding to test models.** Two paths: derive grounded
   vibe-check questions (each mapping to a real step/criterion) for the frontier-vs-
   local head-to-head ([`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md)); and, for a
   whole-case test a small model can't one-shot, build a
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   and run the [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md)
   decomposition harness to measure what's reachable. Freeze the metric/splits with
   [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).

## Output Standard

End with: the representative trace(s) chosen and their size; the six-facet
explanation; the mermaid flow; the success criteria agreed with the user; and the
list of grounded questions to take into the arena — each tied to a step or
criterion. Keep the decomposition doc local; only the synthetic questions leave.

## References

- [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) — frontier-vs-local head-to-head the questions feed.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md) — turn the understood workload into a scorable env.
- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) — decompose so a small model can take the whole case.
- [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — freeze the metric/splits.
- [`../optimize-api-workflow/SKILL.md`](../optimize-api-workflow/SKILL.md) — the API-workflow metric axes.
