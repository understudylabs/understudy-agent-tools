# WL-07 executor-submit mapping

This arm exposes a verifier contract and candidate method for a single unified
Vercel Workflow controller. It is not a controller, queue, poller, inbox, or
second state database, and the contract surface makes no provider calls.

The payload follows `understudy.executor-submit.v1`, using the platform
contracts repo @ 585d8e1 as the canonical schema source. Only artifact
references and hashes cross the contract boundary.

| Schema field | WL-07 value |
| --- | --- |
| `schema_version` | Fixed `understudy.executor-submit.v1`. |
| `experiment_id` | Caller-provided experiment identifier. |
| `candidate.candidate_id` | Caller-provided candidate identifier for the Nemotron DPO arm. |
| `candidate.executor` | Required caller argument. The schema enum does not include Tinker, so this arm does not choose a substitute. |
| `candidate.model` | Exact Nemotron base model identifier. |
| `candidate.model_revision` | Optional renderer or revision label. |
| `candidate.policy_ref` / `policy_sha256` | Reference and digest for the scored policy receipt or checkpoint artifact. |
| `workload.id` | `on-event-email-orchestrator`. |
| `workload.dataset_manifest_ref` / `dataset_manifest_sha256` | WL-07 fixture manifest reference and digest. |
| `workload.verifier_environment` / `verifier_revision` | Offline verifier environment and WL-07 fixture revision. |
| `splits.train_manifest_ref` | Training-pair manifest reference. |
| `splits.dev_manifest_ref` | Dev evaluation manifest reference. |
| `limits.*` | Caller-provided budget, concurrency, rollout, and runtime limits. |
| `attempt` | Non-negative retry attempt number. |

Holdout is intentionally absent from both the schema payload and this arm's
submit contract. The frozen holdout hash remains a verifier-side sealed
artifact, not a controller submission field.

The intended step interface is `submit`, `inspect`, `cancel`, and
`reconcileUsage`. Cancellation records a receipt. Usage reconciliation receives
an `evidence_scope` from the controller and never hardcodes one. The pure
module exports only payload construction and deterministic idempotency-key
derivation; it does not implement those steps or call a provider.
