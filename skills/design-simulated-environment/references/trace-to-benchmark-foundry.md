# Trace-to-benchmark foundry

Turn local traces into stateful, human-adjudicated tasks without making the
incumbent trajectory the oracle.

Execute this process through `understudy traces build-benchmark`,
`import-reviews`, `plan-replays`, and `run-replays`. Their contracts are in
[`../../ingest-traces/references/trace-foundry-cli.md`](../../ingest-traces/references/trace-foundry-cli.md).
Do not implement a parallel compiler inside a customer repository.

Keep two graphs separate: the source-history DAG owns grouping, retries,
branches, mutations, errors, and provenance; every fresh model evaluation owns
a new native Verifiers trace through the approved task, tools, runtime, and
rubric. Never splice the historical future into a fresh rollout.

## Machine-first compiler loop

1. discover unprocessed local objects and update an immutable ledger;
2. normalize envelopes and reconstruct source DAGs;
3. choose the earliest defensible candidate boundary;
4. label claims `observed`, `inferred`, or `specified` with confidence;
5. fit against a capability catalog and inherit matching approved semantics;
6. propose novel state, tools, transitions, outcome and preservation contracts,
   forbidden effects, and sentinels;
7. classify as `new_instance`, `environment_extension`, `task_variant`,
   `new_capability`, `contradiction`, or `blocked`;
8. run deterministic schema, split, DAG, sentinel, and regression gates;
9. send close calls, contradictions, and novel semantics to human judgment.

The machine makes its strongest proposal immediately but never approves its own
inferred or specified claims. Human decisions are `accept`, `restrict`,
`needs_more`, and `reject`, persisted with time, evidence hashes, restrictions,
and decision hash.

## Artifacts and viewer

Keep captures, normalized rows, DAG, tasks, benchmark, lazy per-capture viewer
data, and exported reviews below `.understudy/`. The viewer shows task/source
hashes, vertical lineage, selected round, parsed/raw request and response,
machine world/outcome proposals, claim classes, sentinels, split, contamination
warnings, and final review actions.

Promotion requires deterministic reset, stateful tools rather than historical
lookup tables, independent final-state contracts, intended/no-op/wrong/
destructive sentinels, regression of prior tasks, split validation, and human
final judgment. Exact incumbent replay is a regression, never the only success
definition.

Freeze construction, fit, and held-out splits before model comparison. Related
traces stay together when leakage is plausible. Held-out traces never author
semantics.

After initial construction, process batches of ten. Move to maintenance only
after two consecutive batches have at least 90% clean reuse, fewer than 5% new
semantic rules, no unresolved high-impact contradictions, and passing prior
regressions.

Once rewards are trustworthy, baseline first, run train/dev-only GEPA, select
on validation, evaluate once on sealed held-out, then consider context policy,
SFT, RLM, or RL. GEPA cannot repair false tool semantics or leaked rewards.
