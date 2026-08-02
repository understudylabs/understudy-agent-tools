# On-event-execution candidate contract

This directory contains the immutable submit-contract artifacts for the
synthetic candidate-method arm.

## Vendored schema

- Schema id: `understudy.executor-submit.v1`
- Provenance: experiment-orchestrator contract, pinned at commit `c299ca4`
- Shared file: `schemas/understudy.executor-submit.v1.schema.json`
- The shared bytes are copied byte-for-byte from the pinned source artifact.

The submit payload is intentionally limited to refs and hashes. It contains no
weights, raw preference pairs, prompts, completions, traces, or provider
credentials.

## Candidate mapping

- `candidate.executor` is `fixture`. The enum has no value naming the provider
  that produced the tuned policy, while scoring is performed in-process against
  the offline verifier.
- The tuned checkpoint is carried as `candidate.model_revision`. It is a
  `tinker://` job reference, never model weights or checkpoint contents.
- `candidate.policy_ref` points to `dpo-policy.json`; `candidate.policy_sha256`
  is the SHA-256 of its canonical JSON representation.
- The workload verifier revision is the frozen synthetic fixture SHA-256.
- Dataset and split refs point to the committed fixture-freeze receipt, with
  file and split hashes recorded separately.
- The payload has train and dev split entries only. The sealed split is
  structurally absent from the payload.

## Declared arm limits

The payload declares the limits used for this candidate arm:

- Budget: `$100.00` declared arm envelope
- Concurrent candidates: `1`
- Concurrent requests per candidate: `4`
- Maximum rollouts: `240`
- Maximum runtime: `7,200` seconds

These are declared contract limits, not a provider billing claim.

## Idempotency

`idempotency-receipt.json` records the deterministic SHA-256 over
`experiment_id`, `candidate_id`, and `attempt`. The key is kept outside the
submit payload because the canonical schema rejects additional properties.

## Evidence boundary

The usage receipt records actual local measurements for the synthetic base,
training, and dev runs. It does not claim a production win and does not include
raw workload material.
