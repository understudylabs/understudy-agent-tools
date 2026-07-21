# Source-history DAG contract

The longest captured request is a candidate tip, not proof of perfect history.
Reconstruct executions from stable fingerprints and time evidence before deriving tasks.

Hash every message and ordered block; tool calls by stable ID, name, and arguments;
tool results by call/result ID, status, content, and error shape; ordered message
prefixes; and the raw source representation. Semantic normalization may bridge
encoding differences, but raw hashes must expose changed content.

Every non-root invocation receives one defensible relation:

- `prefix_append`: the full parent history is preserved and events append;
- `folded_continuation`: prior events were intentionally summarized, with a
  ledger of contributing fingerprints;
- `retry`: the same model boundary was attempted again after an error, timeout,
  empty response, or invalid call;
- `branch`: a shared prefix produced a different continuation;
- `same_depth_mutation`: history length stayed fixed but prior content changed;
- `destructive_mutation`: earlier history disappeared or was rewritten without
  defensible fold evidence.

Do not call every mutation a retry. Persistence, redaction, summarization,
concurrency, framework memory, and runtime behavior can all rewrite context.

Failed calls and responses are first-class evidence. Link retries only when
boundary and tool identity support it. Deduplicate cumulative results by stable
IDs plus content hashes, never similar text.

Fail closed when parentage is ambiguous, results match multiple calls,
timestamps contradict an edge, a fold lacks contributing fingerprints, or a
source pointer/hash cannot reproduce a node. Historical source DAGs never
replace the native trace created by a fresh candidate rollout.
