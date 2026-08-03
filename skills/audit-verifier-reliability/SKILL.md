---
name: audit-verifier-reliability
description: Use when deciding whether a verifier reward is trustworthy for optimization.
---
# Audit verifier reliability

Trust requires two independent, offline arms: deterministic adversarial probes
and replayed natural trajectories. The receipt is trusted only when both meet
the predeclared gate and carries source, verifier, and fixture SHA-256 bindings.

Never read holdout data, call providers, upload traces, include customer data,
or spend money in this audit. Natural evidence cannot override an adversarial
failure; missing natural coverage is `insufficient-evidence`.

Use `evaluateTrustGate` from `src/verifier-trust/`. Keep raw trajectories out of
receipts and retain the resulting hash-bound receipt with the calibration
artifact (`understudy.verifier_calibration.v1`).

## Safety Gates

- Operate only on already-approved local calibration summaries; never read a
  holdout, call a provider, upload trajectories, or include customer content.
- Require valid source-binding, verifier, and fixture SHA-256 values plus both
  natural and adversarial arms. Missing evidence is never trusted.
- Treat the receipt as verifier-calibration evidence, not model-quality or
  promotion evidence.

## Resolve CLI

No CLI command is required. Build the package and call `evaluateTrustGate` from
`dist/verifier-trust/index.js` in an offline script or test. Preserve only the
hash-bound receipt; keep raw probes in their approved local evidence store.
