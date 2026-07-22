# Deterministic trace-foundry helpers

Use these helpers instead of rewriting normalization, DAG construction,
benchmark manifests, review application, environment packages, or replay loops.

## Compile or resume

```sh
understudy traces build-benchmark \
  --source .understudy/captures \
  --output .understudy/benchmarks/automation \
  --workload automation \
  --max-age-days 3 \
  --batch-size 10
```

The command owns versioned normalization, customer-versus-upstream request
preservation, SSE reconstruction, unique capture keys, scoped fingerprints,
source-DAG relations and validation, capability fitting, frozen splits, the
canonical `understudy.benchmark.v1` manifest, the Verifiers v1 package, oracle
and sentinel checks, the capture ledger, resumable goal state, and the local
viewer. Do not hand-edit generated artifacts. Fix the helper or import a review.
The same canonical manifest is consumable by the Benchmark Hub; do not emit a
foundry-only parallel benchmark shape.

Serve the viewer instead of opening its file URL directly, so lazy capture
loading works:

```sh
understudy traces serve --benchmark .understudy/benchmarks/automation --port 3003
```

## Apply final judgments

Export JSONL from the viewer, then run:

```sh
understudy traces import-reviews \
  --benchmark .understudy/benchmarks/automation \
  --reviews ~/Downloads/benchmark-reviews.jsonl
```

This validates task IDs and decisions, binds each decision to the current task
hash, preserves non-human promotion blockers, and rewrites the canonical
benchmark status deterministically.

## Plan and run replays

```sh
understudy traces plan-replays \
  --benchmark .understudy/benchmarks/automation \
  --model incumbent-model candidate-model
```

The plan contains the baseline matrix, long-horizon context-rot variants, metric
contract, and the GEPA-before-training ladder. It performs no provider calls.

Run a bounded approved slice only when the user authorizes those model calls:

```sh
understudy traces run-replays \
  --benchmark .understudy/benchmarks/automation \
  --model incumbent-model candidate-model \
  --variant authentic_history errors_and_retries saturation \
  --max-examples 5 \
  --yes
```

Each model/variant invocation runs through the generated Verifiers v1 package;
the helper retains its output under `replays/`. Never substitute historical
responses for a candidate rollout.

## Promotion contract

Treat `benchmark.json.promotion_blockers` as authoritative. A scripted oracle
must score 1, sentinels must be rejected, the source DAG must validate, novel
held-out semantics must be resolved without using held-out data to author the
rule, and human judgments must be imported before promotion.
