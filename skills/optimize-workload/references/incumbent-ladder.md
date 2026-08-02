# Incumbent ladder verifier and evidence notes

The incumbent ladder is a verifier/contract surface for comparing a native
incumbent with candidate policy arms. It is intentionally not an orchestration
controller: no queue, poller, state store, or background process belongs in
this layer.

## Split and claim discipline

Keep train and dev artifacts hash-bound, and keep holdout structurally absent
from submit payloads until a candidate is frozen for a separate gate. A
dev-only result is an optimization lead, not a production replacement claim.
Evidence must state the incumbent's native serving contract, candidate base
model and renderer, rung, adapter settings, split hashes, parser revision,
latency/token basis, and priced versus unpriced spend.

## Shared verifier semantics

The normalizer accepts native provider `tool_calls` and text-rendered
`<tool_call>...</tool_call>` blocks, including blocks after a reasoning
preamble. Primary tool-set correctness is order-insensitive multiset equality.
Ordered agreement is a separate diagnostic subscore. Only outcome-changing
arguments declared by the evaluation contract affect argument score; optional
arguments must not turn a correct call into a failure.

Every report carries both a parser revision and its SHA-256. Never compare
candidate arms scored by different parser revisions. Report malformed rate,
calls-emitted distribution, latency, input/output tokens, and cost status in
addition to mean score and exact match.

## Failure mode: terminal-call repetition

Prompt-into-weights SFT on variable-length tool-call generation can learn the
right tool identity without learning sequence-length control. A smaller-base
study saw terminal-summary repetition to the call ceiling, single-call
collapse, and very few correct-length sequences; this ladder reproduced the
same signature on a 30B base at LoRA rank 32. A larger base alone is therefore
not a sufficient fix. Treat full-sequence correctness as the gate, and
consider more data, higher rank, constrained decoding, or an explicit
length/structure reward before promoting such an arm.

## Submit and promotion artifacts

Submit payloads carry references and SHA-256 hashes only. They must not carry
prompts, labels, weights, credentials, traces, or holdout material. The
idempotency key is deterministic over `(experiment_id, candidate_id, attempt)`;
retries of the same tuple therefore identify the same paid request.

The evidence row uses `understudy.ladder_evidence.v1`, while a route decision
uses the existing `understudy.route_decision_packet.v1` shape. Unpriced
provider usage is represented as `unpriced` with a null dollar amount, never
as `$0`.
