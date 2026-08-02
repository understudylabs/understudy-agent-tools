# Spark executor contract

The self-hosted Spark lane is an **executor**, not a controller. The unified
experiment Workflow owns the run lifecycle, retries, budget enforcement and
state; this repository contributes an idempotent adapter that the Workflow
calls from a durable step.

This document is the contract. The implementation is
[`src/spark-experiment-executor.ts`](../src/spark-experiment-executor.ts) and
the tests are [`tests/spark-experiment-executor.test.mjs`](../tests/spark-experiment-executor.test.mjs).
The tests exercise the contract only — they make no provider call and touch no
GPU.

## What this lane deliberately does not contain

- No controller, poller, queue, inbox or decision database.
- No second source of run state. The executor keeps an in-process map of
  already-submitted idempotency keys as a fast path only; the backend remains
  the authority on job identity, so a cold start cannot double-submit.
- No inference of truth from liveness. A job is `succeeded` because the backend
  says so, never because a server answers on port 5153.

## Interface

```ts
interface ExperimentExecutor {
  submit(request: unknown): Promise<ExecutorJobRef>;
  inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus>;
  cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt>;
  reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt>;
}
```

`submit` validates the payload, derives the idempotency key, hands the request
to the backend and returns a job reference. It never waits for the GPU job.

## Payload: `understudy.executor-submit.v1`

The vendored canonical schemas live in [`../schemas`](../schemas):

| File | Purpose |
|---|---|
| `understudy.executor-submit.v1.schema.json` | submit payload |
| `understudy.executor-job-ref.v1.schema.json` | job reference returned by submit |
| `understudy.executor-job-status.v1.schema.json` | inspect result |
| `understudy.executor-cancellation-receipt.v1.schema.json` | cancel receipt |
| `understudy.executor-usage-receipt.v1.schema.json` | usage reconciliation |

The zod schemas in `src/spark-experiment-executor.ts` mirror them field for
field, and the test suite validates every emitted object against the vendored
JSON Schema, so a divergence fails in CI rather than at submit time.

How the Spark lane fills the payload:

| Contract field | Spark meaning |
|---|---|
| `candidate.executor` | `"spark"`; a payload addressed to another executor is rejected |
| `candidate.model` | base model id, e.g. `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| `candidate.model_revision` | pinned Hugging Face revision of the base weights |
| `candidate.policy_ref` / `policy_sha256` | adapter artifact reference and hash — never the weights themselves |
| `workload.verifier_environment` / `verifier_revision` | the offline environment identity that scores the rollouts |
| `workload.dataset_manifest_ref` / `_sha256` | hash-bound fixture manifest |
| `splits.train_manifest_ref` / `dev_manifest_ref` | the only two splits an executor may see |
| `limits` | budget, concurrency and rollout ceilings the lane must respect |

**Holdout is structurally absent.** The contract has no field for it, the zod
mirror is `.strict()`, and a test asserts that a payload carrying
`holdout_manifest_ref` is rejected. The same strictness blocks raw prompts,
traces, labels or credentials from riding along: only refs and hashes cross the
boundary.

## Idempotency

```text
idempotency_key = "spark:" + sha256([schema_version, experiment_id, candidate_id, attempt])
```

The key depends on `(experiment_id, candidate_id, attempt)` and nothing else,
so a Workflow retry of the same attempt recomputes the same key and gets the
existing job back. A new attempt is a new key and therefore a new job. Backends
must honour the key as the job identity — that is what makes a retry safe when
the executor process itself is new.

## Cancellation

`cancel` reaches the backend and always produces a receipt recording the
disposition (`cancelled`, `already_terminal`, `not_found`) with the job
reference and observation time. Cancellation is never assumed to have worked.

## Usage and evidence scope

`reconcileUsage` reports `evidence_scope` from the adapter rather than
hardcoding it. This matters for a self-hosted node: a Spark shared with other
workloads can only honestly claim `account_window`, and an adapter with no
metering support reports `unknown` with null counters. Budget, estimate and
upper bound stay distinguishable from an actual charge — a null `actual_usd` is
reported as null rather than being softened into a number.
