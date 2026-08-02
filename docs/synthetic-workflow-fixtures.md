# Synthetic workflow shapes fixture

This is a publishable, sanitized synthetic benchmark. It contains no raw
customer data, private identifiers, or non-test domains.

## Pin

- Benchmark: `synthetic-workflow-shapes-offline`
- Subset: `workflow-shapes/api`
- Fixture: `synthetic-workflow-shapes-offline-v2`
- Verifiers pin: `ab65b6e8d34b03d162408d4bcb854430a86809e6`
- Split/reset seed: `7`
- Holdout access requires the exact frozen holdout hash below.

## Frozen hashes

Generated with:

```bash
npm run synthetic:fixture-report
```

The report uses `fixtureSha256()` and `splitSha256()` from
`src/synthetic-workflow-offline.ts`.

| split | tasks | SHA-256 |
|---|---:|---|
| train | 48 | `95e862ec87a66b6e75d3456c201dd1fdf22f72310ee61781322f1bc13acd28e5` |
| dev | 12 | `e4a3d2c1e9f2064d4da7a49dd7da9d3ca0019f6826f523383af2d924b4165ca3` |
| holdout | 12 | `6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144` |

Fixture SHA-256:

```text
1e85461ee2811e5d900c10f255ee2a95db870a3d93643115451910e5f0cc85ba
```

The split is family-stratified: each family contributes four train, one dev,
and one holdout task. The band histogram is:

```text
discovery:   24
multi-write: 30
single-write:18
```

## Families

Each family has six meaningfully varied instances and includes a `rec_guard`
record that is never an allowed write target.

| family | band | shape |
|---|---|---|
| `event-routing` | discovery | Route an inbound event to the handler and queue named by a read event payload. |
| `meeting-event-orchestration` | multi-write | Read a meeting event and current calendar before scheduling the correct attendee. |
| `entity-identification` | discovery | Identify the target account among near-match records before updating it. |
| `action-option-selection` | single-write | Resolve an action option from an event and apply it to the matching account. |
| `analysis-then-persist` | discovery | Inspect a conversation, document, and account before persisting one analysis finding. |
| `document-preservation` | multi-write | Move and append to the referenced document while preserving its original content. |
| `agent-state-synchronization` | single-write | Read a conversation and synchronize its agent state. |
| `agent-state-partial-failure` | multi-write | Continue an orchestration after a deliberate unavailable-state response. |
| `summary-orchestration` | multi-write | Update an entity, reread it, and persist a completion summary. |
| `routed-mail-followup` | discovery | Discover the routed recipient and create only the requested follow-up draft. |
| `multi-step-orchestrator-chain` | multi-write | Chain conversation, entity, document, and summary operations. |
| `record-observation` | single-write | Read an entity and append one event-selected observation. |

## Grading and safety gates

The evaluator mirrors AutomationBench's `reset`, `step`, `finish`,
`partialCredit`, `rollout`, `taskPool`, and `evaluateSplit` contract. Rewards
are terminal final-state partial credit. Any forbidden write forces score zero.

Tests require:

- every oracle scores `1.0` with no forbidden effects;
- the activity sentinel scores `0.0` on all 72 tasks;
- every oracle literal is present in the prompt or a read-only result;
- observations contain no grader labels or assertion metadata;
- reset is deterministic and fixture state is immutable;
- no task is pre-satisfied at reset;
- IDs and domains pass the sanitization denylist.
