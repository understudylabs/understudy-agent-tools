# WL-AU arm as Workflow steps and artifacts

This arm ships **no controller**. It is a `{verifier/contract}` plus a
`{candidate-method}`, expressed as idempotent steps over immutable artifacts so
the unified Workflow run controller owns all durability, retries, and progress.

| Piece | Classification |
| --- | --- |
| Frozen v2 fixture + gate result (`gate-validation.json`) | verifier/contract |
| Near-hit pair file + manifest (`dpo_pairs.jsonl`, `pairs.validation.json`) | verifier/contract (immutable input artifact) |
| Near-hit DPO on Nemotron via Tinker | candidate-method |
| Tinker (sampling + training) | executor — never a source of truth |
| Band tables / lift report | UI-artifact |

## Step interface

Every step is a pure function of `(spec, artifactRefs)` that writes a new
content-addressed artifact and returns its ref. None of them polls, queues, or
keeps state. The idempotency key is `(experimentId, candidateId, attempt)`; a
retry with the same key must return the existing artifact or the existing
provider job, never start a second paid one.

| Step | Input refs | Output artifact | Idempotent because |
| --- | --- | --- | --- |
| `gateFixture` | fixture id | `gate-validation.json` (oracle/sentinel/leakage/refusal + split hashes) | fixture construction is pure and index-driven; the hashes are the identity |
| `mineNearHitPairs` | fixture id, sampler ref, `samples`, `temperature`, `maxTokens` | `dpo_pairs.jsonl` + manifest (`pairs_sha256`) | keyed on the sampler ref and the sampling params; re-running under the same key returns the stored `pairs_sha256` rather than resampling |
| `validatePairs` | `pairs_sha256` | `pairs.validation.json` (`verdict`), normalized pairs | pure over the exact bytes named by the hash |
| `submitDpoTrain` | normalized-pairs ref, base model, `beta`, `epochs`, `loraRank` | **job reference** (returned immediately) | key `(experimentId, candidateId, attempt)` maps to one Tinker run; a retry re-attaches, never re-trains |
| `inspectDpoTrain` | job ref | `train-receipt.json` (checkpoint ref, `pairs_sha256`, hyperparameters) | read-only |
| `scoreSplit` | checkpoint ref (or base), split id + frozen hash | `scores-<split>.json` | split identity is its frozen hash; the holdout step refuses without it, so it cannot be replayed into a selection surface |
| `bandReport` | two score refs | `band-report-*.json` | pure over its inputs |

`cancelDpoTrain` and `reconcileUsage` hang off the same job reference: usage is
read back from the executor, never inferred from process liveness.

## What crosses Workflow state

Refs and hashes only:

```json
{
  "fixture": "automationbench-simple-api-offline-v2",
  "splits": { "train": "71a58657…", "dev": "f125ee00…", "holdout": "2f8d0fa9…" },
  "pairs_sha256": "…",
  "checkpoint": "tinker://…",
  "scores": { "dev": "sha256:…", "holdout": "sha256:…" }
}
```

Never: rollouts, prompts, completions, labels, credentials, or weights. The
holdout hash travels as a *capability* — a step that does not carry it cannot
read the split at all, which is what keeps holdout isolation a property of the
contract rather than of operator discipline.

## Events

Small redacted events, emitted by the steps and consumed by the run controller:
`run.started`, `candidate.registered`, `rollout.progress {done,total}`,
`score.recorded {split, mean, band}`, `usage.reported {job, tokens, usd}`,
`error {step, class}`. Counts and identifiers of artifacts — no payloads.

## Approval gates and budgets

Two boundaries are contract-level, not operator-level: `validatePairs` must
return `verdict: "pass"` before `submitDpoTrain` may be reached (the trainer
refuses raw pair files by construction), and the holdout `scoreSplit` runs once
per candidate at the end of the arm. Any ambiguous or unbounded provider charge
stops the run instead of proceeding.
