---
name: verify-serving-parity
description: Verify identical weights across serving lanes using observed render fingerprints, paired samples, and explicit evidence status.
---

# Verify serving parity

Use `src/serving-parity` as a pure, offline verifier. Every lane must provide an
observed render fingerprint, contract fingerprint, parser evidence, and an
artifact reference plus SHA-256. Outputs contain references and hashes only;
never place prompts, responses, traces, labels, credentials, or weights in a
parity artifact.

Declare a meaningful minimum paired sample before scoring (default: 20). A
failed preflight refuses comparison. `observed`, `weak`, `deviation`, and
`failed` evidence status must remain visible, and the output includes
`understudy.promotion_receipt.v1` compatibility metadata for downstream gates.

Run only against synthetic or already-approved local artifacts; this verifier
makes no provider calls and does not access holdout data.
