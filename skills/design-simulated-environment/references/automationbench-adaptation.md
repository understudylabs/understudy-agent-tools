# AutomationBench and reference-environment adaptation

AutomationBench is a useful public control for business-tool state mutation.
Reuse seeded deterministic state, tools that execute rather than replay,
final-state and preservation grading, scripted oracle, adversarial sentinels,
task/harness/rubric separation, and a frozen return-eval.

Trace-derived environments additionally require versioned envelope/SSE
normalization, message/tool fingerprints, source-history DAGs, evidence ledgers,
capability fit and inheritance, machine proposals with human final judgment,
task-to-source provenance, freshness, privacy, contradiction, and diminishing-
return gates.

Do not copy a canonical environment blindly. Audit its current schemas,
runtime, task objects, trace representation, parser/renderer seam, rubric API,
and dependency pin before adapting it. Record the audited Verifiers release or
commit in benchmark artifacts.

For replay, every model receives the same approved system, messages, tools, and
state. Context-rot experiments hold task and reward fixed while varying minimal
context, authentic history, longer history, distractors, errors/conflicts, and
practical saturation. Score outcome, preservation, forbidden effects, failures,
retries, context size, cost, and latency.
