---
name: diagnose-tool-traces
description: Use when a tool-calling or API-workflow agent failed and you need to diagnose whether the model lacked evidence, failed to retrieve visible evidence, trusted the wrong source, acted too early, or preserved the wrong output format. Trace forensics for environment-backed agent failures.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Diagnose Tool Traces

Use this worker when an agentic or API-workflow eval failed and the next
question is not "what score did it get?" but **why did the model make that
choice from the information path it actually saw?**

The key diagnostic separation is:

```text
environment evidence != model-visible evidence != evidence used before mutation
```

This skill reads local traces, request prompts, tool-call transcripts, simulator
state, scorer assertions, and optional logprob sidecars. It does not run models
by default. If a counterfactual A/B is useful, run it only after the user approves
any provider spend or live benchmark cost.

When executing, read [`reference.md`](reference.md) for the full checklist,
failure taxonomy, and report template.

## Safety Gates

- **Local-first, no upload.** Tool traces often contain prompts, completions,
  tool responses, seeded business data, and final state. Keep analysis artifacts
  under `.understudy/`; do not paste raw traces or private paths into hosted
  systems.
- **Separate debug state from model context.** Simulator `initial_state`,
  database fixtures, and scorer state may be visible to the harness but not to
  the model. Never claim the model "saw" evidence unless it appears in
  `request.prompt`, tool responses, or other provider-visible messages.
- **Treat writes as evidence.** Identify writes, posts, sends, deletes, updates,
  and execute calls. Mark any mutation that happened before required reads as a
  likely failure, even if the final text sounded reasonable.
- **Do not optimize on holdout.** Use holdout traces for diagnosis and reporting,
  not prompt repair, GEPA feedback, or training selection.
- **No private examples in public output.** Redact or summarize entity names,
  record IDs, channels, emails, and payloads unless the developer explicitly
  approves showing them in the current thread.

## When To Use

Use this skill when any of these are true:

- a model failed an environment-backed or tool-calling task and the user asks
  "why did it fail?";
- a scorer-required fact exists in fixtures or initial state but may not have
  been retrieved by the model;
- the model used a plausible but wrong format, channel, record, policy, or
  authority source;
- a candidate prompt or policy improved reward and you need to explain what
  changed in the trace;
- you need to decide whether the fix is retrieval, authority precedence,
  formatting, ID resolution, verifier design, route fallback, or training.

If the user only needs scalar model quality/cost/latency, use
[`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md). If the user
needs behavioral deltas between two complete runs, use
[`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md). If the
focus is token-level uncertainty on the same row, use
[`../compare-logprob-trajectories/SKILL.md`](../compare-logprob-trajectories/SKILL.md).

## Flow

1. **Load the trace surface.** Identify the eval/run directory, scorer output,
   trajectory messages, provider request events, tool transcripts, final state,
   and optional debug state. Record which files exist and which are missing.

2. **Prove visibility.** Search separately for scorer-required facts in:
   model-visible prompt/messages, tool responses, debug/environment state, and
   final state. Classify each fact as `visible_before_action`,
   `environment_only`, `never_available`, or `available_after_wrong_action`.

3. **Reconstruct the information path.** Build a turn-by-turn table of reads,
   writes, tool responses, and final mutations. Mark the first write and list
   exactly which required facts were still unresolved at that point.

4. **Classify authority choices.** Compare explicit user instruction, formal
   policy, recent canonical examples, source-record notes, external advice, and
   model intuition. Flag wrong precedence or unsupported precedence rules.

5. **Classify the failure.** Assign one or more labels:
   `missing_environment_evidence`, `evidence_not_model_visible`,
   `retrieval_planning_failure`, `authority_precedence_failure`,
   `exact_format_preservation_failure`, `id_resolution_failure`,
   `mutation_before_observation`, `verification_failure`,
   `tool_schema_or_parser_failure`, or `scorer_harness_issue`.

6. **Recommend the cheapest fix.** Prefer read-only exploration policy, endpoint
   retrieval changes, authority-precedence prompt repair, ID-resolution rules,
   parser/schema repair, verifier changes, or route fallback before training.
   Training is appropriate only when the trace shows the model had the needed
   evidence and still failed a learnable decision repeatedly.

7. **Optionally run a counterfactual.** If approved, compare baseline vs
   diagnostic policy on the same task/model/budget. Report reward, retrieved
   evidence, first write timing, final payload, failed assertions, and residual
   risk.

## Output Standard

End with:

- run/eval paths analyzed and whether any required trace files were missing;
- visibility table for scorer-required facts;
- first-write point and unresolved facts at that moment;
- authority-precedence verdict;
- failure labels with one sentence of evidence for each;
- recommended fix and whether it is retrieval, prompt/policy, parser, harness,
  route, verifier, or training shaped;
- optional counterfactual A/B result path and score delta.

