# Diagnose Tool Traces Reference

## Minimal Artifact Checklist

Look for these files first. Names vary by harness, so use this as a shape, not a
strict contract:

```text
trajectories.jsonl              # role messages, tool calls, tool responses
model-call-events.jsonl         # provider-visible prompt, tools, kwargs/state
official-results.json           # scorer assertions and task score
checkpoint-results.json         # partial scorer output
result.json                     # run metadata and spend estimate
training-events.jsonl           # optional advantage / failure normalization
final-state.json                # optional simulated end state
```

If both `request.prompt` and `request.kwargs.state.initial_state` exist, treat
them as different evidence surfaces. `request.prompt` is model-visible;
`initial_state` is simulator/debug state unless it was returned through a tool.

## Visibility Procedure

For each scorer-required fact or failed assertion:

1. Search model-visible prompt/messages before the first relevant write.
2. Search tool responses before the first relevant write.
3. Search debug/environment state.
4. Search final state after writes.

Label the fact:

- `visible_before_action` — present in prompt/tool context before the mutation.
- `environment_only` — present in seeded state but never retrieved.
- `available_after_wrong_action` — retrieved only after the bad mutation.
- `never_available` — absent from prompt, tools, environment, and final state.

This prevents false blame. A model cannot use evidence that only exists in
debug-only state. But if evidence existed in the environment and the model had
tools to retrieve it, the failure is retrieval/planning rather than hidden
ground truth.

## Information-Path Table

Create a compact table:

```text
turn | role/action | read/write | target | evidence gained | unresolved facts
```

Mark writes broadly: POST messages, PATCH records, send emails, create/delete
objects, execute actions, final answer claims that imply side effects, and any
"status" message posted during exploration.

Useful derived checks:

- Did the first write happen before policy/source/examples were read?
- Did the model read only endpoint docs but not business data?
- Did it read business records but not referenced owner/user/account records?
- Did it read one recent example and mistake it for a canonical norm?
- Did it receive `{}` or a 204-like response and repeat the same mutation?
- Did it verify the exact target state after mutation?

## Authority Ladder

Use this default ladder unless the harness defines a stricter one:

1. Explicit user target and task requirements.
2. Formal internal policy / standard operating procedure.
3. Recent repeated canonical examples in the target system.
4. Source records for the specific entity.
5. Internal informal notes.
6. External advice.
7. Model intuition or generic conventions.

Do not treat a source-record preference as an override for an explicit user
target unless a formal policy says it has override authority. Do not treat a
single decorative recent example as canonical if older repeated examples show a
structured norm.

## Failure Taxonomy

- `missing_environment_evidence` — the scorer expects a fact absent from prompt,
  tools, state, and final records. Suspect benchmark or harness issue.
- `evidence_not_model_visible` — the fact exists in debug/initial state but was
  never returned to the model. Usually retrieval/planning or tool affordance.
- `retrieval_planning_failure` — the right read endpoint/source existed, but the
  model did not call it, used too narrow a query, or stopped before enough
  examples.
- `authority_precedence_failure` — the model found conflicting evidence but
  trusted the wrong source.
- `exact_format_preservation_failure` — the model paraphrased required labels,
  separators, capitalization, IDs, dates, names, or amounts.
- `id_resolution_failure` — the model used an ID, placeholder, or pending value
  instead of fetching a human-readable referenced record.
- `mutation_before_observation` — the model wrote before resolving policy,
  target, format, or required fields.
- `verification_failure` — the model did not read back the changed object or
  target channel, or ignored failed verification.
- `tool_schema_or_parser_failure` — arguments were malformed, stringified in the
  wrong shape, or rejected by the harness.
- `scorer_harness_issue` — the scorer assertion conflicts with visible task
  requirements or hides an impossible dependency.

## Counterfactual Policy Pattern

When the diagnosis is retrieval/planning, test a small prompt/policy repair
before training:

```text
Read-only first.
Find policy/process sources.
Inspect enough recent examples to identify repeated norms.
Resolve IDs to names before user-facing writes.
Only then mutate and verify exact target state.
```

Compare baseline and counterfactual on the same task, model, toolset, max steps,
temperature, and budget. Report not only reward, but whether the trace changed
in the expected way: more reads before the first write, correct authority source,
exact payload preservation, and successful verification.

## Report Template

```text
# Tool Trace Diagnosis

Run:
Harness/toolset:
Model:
Score:

## Visibility
fact | required by | prompt | tool before write | environment/debug | verdict

## Information Path
turn | action | read/write | target | evidence gained | unresolved before write

## Authority
explicit user target:
formal policy:
canonical examples:
source-record preference:
verdict:

## Failure Labels
- label: evidence

## Fix
cheapest fix:
why not training yet:
counterfactual result:
remaining risk:
```
