# Tool-Trace Forensics

A single-run diagnostic lens for [`../SKILL.md`](../SKILL.md). Use it when an
agentic or API-workflow run failed and the next question is not "what score did
it get?" but **why did the model make that choice from the information path it
actually saw?** It reads local traces, request prompts, tool-call transcripts,
simulator state, and scorer assertions; it does not run models. If a
counterfactual A/B would help, run it only after the user approves any provider
spend.

The key diagnostic separation:

```text
environment evidence != model-visible evidence != evidence used before mutation
```

Simulator `initial_state`, database fixtures, and scorer state may be visible
to the harness but not to the model. Never claim the model "saw" evidence
unless it appears in the model-visible prompt, tool responses, or other
provider-visible messages. A model cannot use evidence that only exists in
debug-only state — but if the evidence existed in the environment and the model
had tools to retrieve it, the failure is retrieval/planning, not hidden ground
truth.

## Safety Gates

- **Local-first, no upload.** Tool traces contain prompts, completions, tool
  responses, seeded business data, and final state. Keep analysis artifacts
  under `.understudy/`; do not paste raw traces or private paths into hosted
  systems.
- **Treat writes as evidence.** Identify writes, posts, sends, deletes,
  updates, and execute calls. Mark any mutation that happened before required
  reads as a likely failure, even if the final text sounded reasonable.
- **Do not optimize on holdout.** Use holdout traces for diagnosis and
  reporting, not prompt repair, GEPA feedback, or training selection.
- **No private examples in public output.** Redact or summarize entity names,
  record IDs, channels, emails, and payloads unless the developer explicitly
  approves showing them.

## Minimal Artifact Checklist

Names vary by harness; use this as a shape, not a strict contract:

```text
trajectories.jsonl              # role messages, tool calls, tool responses
model-call-events.jsonl         # provider-visible prompt, tools, kwargs/state
official-results.json           # scorer assertions and task score
checkpoint-results.json         # partial scorer output
result.json                     # run metadata and spend estimate
training-events.jsonl           # optional advantage / failure normalization
final-state.json                # optional simulated end state
```

If both a model-visible prompt and a simulator `initial_state` exist, treat
them as different evidence surfaces.

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

## Information-Path Table

```text
turn | role/action | read/write | target | evidence gained | unresolved facts
```

Mark writes broadly: POST messages, PATCH records, send emails, create/delete
objects, execute actions, final-answer claims that imply side effects, and any
"status" message posted during exploration. Useful derived checks:

- Did the first write happen before policy/source/examples were read?
- Did the model read only endpoint docs but not business data?
- Did it read business records but not referenced owner/user/account records?
- Did it read one recent example and mistake it for a canonical norm?
- Did it receive `{}` or a 204-like response and repeat the same mutation?
- Did it verify the exact target state after mutation?

## Authority Ladder

Default precedence unless the harness defines a stricter one:

1. Explicit user target and task requirements.
2. Formal internal policy / standard operating procedure.
3. Recent repeated canonical examples in the target system.
4. Source records for the specific entity.
5. Internal informal notes.
6. External advice.
7. Model intuition or generic conventions.

Do not treat a source-record preference as an override for an explicit user
target unless a formal policy grants it override authority. Do not treat a
single decorative recent example as canonical if older repeated examples show
a structured norm.

## Failure Taxonomy

- `missing_environment_evidence` — the scorer expects a fact absent from
  prompt, tools, state, and final records. Suspect benchmark or harness issue.
- `evidence_not_model_visible` — the fact exists in debug/initial state but was
  never returned to the model. Usually retrieval/planning or tool affordance.
- `retrieval_planning_failure` — the right read endpoint/source existed, but
  the model did not call it, used too narrow a query, or stopped before enough
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
- `tool_schema_or_parser_failure` — arguments were malformed, stringified in
  the wrong shape, or rejected by the harness.
- `scorer_harness_issue` — the scorer assertion conflicts with visible task
  requirements or hides an impossible dependency.

## Recommend the Cheapest Fix

Prefer read-only exploration policy, endpoint retrieval changes,
authority-precedence prompt repair, ID-resolution rules, parser/schema repair,
verifier changes, or route fallback before training. Training is appropriate
only when the trace shows the model had the needed evidence and still failed a
learnable decision repeatedly.

When the diagnosis is retrieval/planning, test a small prompt/policy repair
before training:

```text
Read-only first.
Find policy/process sources.
Inspect enough recent examples to identify repeated norms.
Resolve IDs to names before user-facing writes.
Only then mutate and verify exact target state.
```

Compare baseline and counterfactual on the same task, model, toolset, max
steps, temperature, and budget. Report not only reward, but whether the trace
changed in the expected way: more reads before the first write, correct
authority source, exact payload preservation, successful verification.

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

## Adjacent Lenses

- Scalar model quality/cost/latency →
  [`../../compare-model-sweep/SKILL.md`](../../compare-model-sweep/SKILL.md).
- Behavioral deltas between two complete runs →
  [`../../compare-trajectories/SKILL.md`](../../compare-trajectories/SKILL.md);
  token-level confidence on the same row → its `references/logprob-lens.md`.
