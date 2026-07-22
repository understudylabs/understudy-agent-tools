# Resumable environment-generation goal

An autonomous coding agent can grind through trace batches when deterministic
state makes the work resumable without chat history.

Persist a machine-readable goal state and append-only event log beneath
`.understudy/benchmarks/<run>/`. Each event records input hashes, attempted
action, outputs, validation, blockers, and next action.

`understudy traces build-benchmark --batch-size 10` owns these artifacts as
`capture-ledger.jsonl`, `goal-events.jsonl`, and `goal-state.json`. Resume by
running the same command against the same output directory; do not infer
progress from chat history or rewrite the ledger.

The goal owns these work packages:

1. discover fresh local captures and update the immutable ledger;
2. normalize envelopes and assemble executions;
3. reconstruct and validate source DAGs;
4. compile or extend capability/world semantics;
5. generate tasks, contracts, reset, tools, and sentinels;
6. build the benchmark and local viewer;
7. import final human judgments and rerun regressions;
8. stop at diminishing returns or a genuine evidence/privacy blocker;
9. prepare, but do not execute, multi-model replay plans.

Deterministic code owns hashes, DAG validation, schemas, split assignment,
review application, regressions, and promotion. The LLM owns proposals and
classification. The user adjudicates close calls and final promotion.

Provider calls, uploads, untrusted generated-code execution, hosted evaluation,
and training remain separate explicit approval gates. The terminal condition is
a locally executable environment with passing oracle/sentinels/regressions, or a
specific external blocker recorded in goal state.
