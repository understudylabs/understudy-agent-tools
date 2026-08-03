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
