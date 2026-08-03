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

## Safety Gates

- Compare at least two uniquely named lanes using the same artifact hash,
  observed render fingerprint, contract fingerprint, protocol, sampling, stop
  sequences, parser contract, and frozen task IDs.
- Predeclare a paired-sample floor and equivalence band. Missing pairs,
  duplicate task IDs, deviations, weak evidence, or invalid hashes fail closed.
- Keep prompts, responses, labels, traces, credentials, and weights out of the
  parity artifact. A passing parity receipt is necessary but not sufficient for
  promotion.

## Resolve CLI

There is no public CLI yet. Build the package and call
`preflightServingParity` followed by `scoreServingParity` from
`dist/serving-parity/index.js` in an offline script. Do not score when preflight
refuses the evidence.
