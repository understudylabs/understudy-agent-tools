# Analyzer slice gate validation

## Fixture pins

| Pin | Value |
| --- | --- |
| Fixture ID | `analyzer-verdict-offline-v1` |
| Train count | 54 |
| Dev count | 18 |
| Holdout count | 36 |
| Fixture SHA-256 | `866dc4256dd13441a5c6cf723ed59ee7a9afa4e3fb916cf08d560fb0d584597f` |
| Train SHA-256 | `6a07ce41907d85457a697eab6eb79b7802a4caf8d0e759508e7bb861acd6e4db` |
| Dev SHA-256 | `24f35c42ef96cb05d19e43cae5da0d701aa8c3d129c3334f6f6ff441a7b1992a` |
| Holdout SHA-256 | `ee29b364f28f35a1f74f8b0f3e162360a07d9e250723f7b0ed76e288b87077c2` |

## Observed gate checks

The freeze gate checks all 108 tasks and reports no failures.

| Check | Observed value |
| --- | --- |
| Oracle mean | `1` |
| Oracle exact-1 rate | `1` |
| Sentinel maximum | `0` |
| Null maximum | `0` |
| Most-common-field constant mean / exact-1 rate | `0.03935185185185185` / `0` |
| All-insufficient-evidence empty-citation mean / exact-1 rate | `0.3055555555555556` / `0` |
| Upper-half citation coverage | `71 / 108` tasks |
| Dominant gold triple rate | `0.3333333333333333` |
| Duplicate task IDs | none |
| Cross-split evidence reuse | none |
| Gold citation reachability | all reachable |
| Prompt identity after workstream normalization | one instruction |
| Bounded gold verdicts | all under 400 characters |

Holdout access is fail-closed: omitting the frozen hash throws, supplying a
wrong hash throws, and supplying the pinned holdout hash returns exactly 36
tasks. Rebuilding the deterministic pool reproduces the pinned split hashes.

## Reproduction

From the repository root:

```bash
npm run build
npx tsc --noEmit
node --test tests/analyzer-*.test.mjs
node scripts/analyzer-slice-freeze.mjs --json
node scripts/validate-public-skills.mjs --repo
git diff --check
```

The machine-readable freeze output is
[`freeze-report.json`](freeze-report.json).

## Why this slice has this shape

The slice mirrors the target workload as a single-turn bounded-output analysis
job: a long evidence bundle enters, and one small structured verdict comes
out. The grader treats over-claiming as a zero, so citing unsupported evidence
cannot earn partial credit merely by sounding plausible. This is deliberately
not the REST-automation fixture: that environment models a tool-calling loop,
whereas this workload tests retrieval and judgment over context followed by a
compact JSON response.
