# Synthetic workflow fixtures

Status: synthetic, offline, public-safe fixture set.

This document describes the sibling module
`src/synthetic-workflow-offline.ts` and its nine invented workflow tasks. It
contains no customer data, private traces, provider credentials, or live
service references.

## 1. Purpose and publication boundary

The fixtures preserve generic workflow shape: read-only discovery, stateful
API calls, partial failures, final-state assertions, and preservation through
allowed-write enforcement. They do not reproduce raw prompts, raw request or
response bodies, identities, or private URLs.

All records, addresses, paths, summaries, and timestamps are invented. Email
addresses use `.invalid`; no network or provider is contacted.

## 2. Contract

### 2.1 Sibling architecture

`src/automationbench-offline.ts` already exists on this branch and is pinned by
its 32-test suite to 72 tasks, 12 families, 48/12/12 splits, and 60 packaged
non-holdout tasks. This fixture set is therefore a sibling rather than an edit.

The sibling reuses that module's contract verbatim:

- `api_search` and `api_fetch` tool-call shapes;
- `equals`, `exists`, and `absent` assertions;
- dotted `allowedWrites` prefixes and `forbiddenEffects`;
- terminal `partialCredit`;
- deterministic pinned-seed reset;
- frozen-holdout refusal;
- `understudy.eval_result.v1` rows;
- `understudy.benchmark.v1` manifests.

Only the closed business state and endpoint surface are wider.

### 2.2 State and tools

The state contains:

```ts
{
  conversations,
  documents,
  records,
  drafts,
  meetings,
  agentState,
  summaries,
  analysis,
  sequence,
}
```

The endpoint surface uses `GET` for reads and `POST`/`PATCH` for mutations:

```text
/conversations
/documents
/records
/drafts
/meetings
/agent-state/{id}
/summaries
/analysis
```

`/agent-state/{id}` returns status `409` with
`agent state overview not configured` for the deliberately unconfigured
document task and performs no write.

The environment has no model, provider, network, filesystem, clock, or random
number generator. IDs are derived only from the reset-local `sequence`
counter. The only accepted seed is `7`.

### 2.3 Assertions and scoring

Only three assertion kinds are used:

```ts
{ kind: "equals", path: string, equals: unknown }
{ kind: "exists", collection: string, match: Record<string, unknown> }
{ kind: "absent", collection: string, match: Record<string, unknown> }
```

- `equals` compares a dotted state path using canonical JSON.
- `exists` matches all fields against one collection entry.
- `absent` passes when no collection entry matches.

`partialCredit` is terminal-only:

1. Any `forbiddenEffects` makes the score `0`.
2. Assertions already true in the initial state are removed from the
   denominator.
3. The score is the fraction of remaining assertions true in the final state.
4. A zero denominator scores `0`.

Intermediate rewards are always `0`. A write outside the task's dotted
`allowedWrites` prefixes still mutates state, but its exact path is appended to
`forbiddenEffects` and therefore zeroes terminal reward.

There is no answer channel and no bare-JSON-vs-markdown contract axis. Correctness
is entirely final-state based.

### 2.4 Observation and leakage

Observations contain only task ID, seed, step, messages, and the two global tool
schemas. They never contain assertions, gold state, allowed writes, or oracle
actions.

`auditObservationLeakage()` checks candidate-readable messages for grader
metadata and assertion/write paths. Prompt overlap is benign because the
prompt is the candidate's input.

### 2.5 Test gates

`tests/synthetic-workflow-offline.test.mjs` covers:

- subset pin and 9-task / 6-family / 5-2-2 split counts;
- unique IDs and no all-pre-satisfied task;
- oracle reachability for IDs, paths, recipients, subjects, attendees, and slots;
- byte-identical reset, no ISO timestamps, state isolation, and frozen-fixture
  immutability;
- refusal of non-default seeds;
- zero intermediate reward and terminal partial credit;
- zero score for do-nothing, wrong-value, and out-of-scope-write policies;
- expected `forbiddenEffects`;
- oracle score `1.0` with no forbidden effects, including holdout with its hash;
- observation leakage and no-live-effect static scans;
- double-decoded and nested tool-call parser compatibility;
- frozen-holdout refusal and split disjointness;
- eval-row validation and fixture/split hash provenance;
- benchmark manifest validation;
- identity, credential-prefix, and domain denylist checks.

## 3. Generic tool shape

The runtime exposes only:

| Tool | Purpose |
| --- | --- |
| `api_search` | Read-only endpoint discovery |
| `api_fetch` | One routed API call with `{ method, url, body? }` |

Unknown tools return an error object. Unknown URLs return status `404`;
unsupported methods return status `405`. Errors are observations, not throws.

## 4. Synthetic tasks and family mapping

Nine tasks are built by six family-style builders. The task data is invented;
the table describes only generic workflow shapes.

| Task | Shape | Generic source family | Basis |
| --- | --- | --- | --- |
| `saw-email-001` | Read context, create one draft | event-driven email orchestration | inferred |
| `saw-email-002` | Read context, create one allowed draft, avoid a forbidden recipient | event-driven email orchestration | inferred |
| `saw-meeting-001` | Read context, schedule attendee/slot/duration | event-driven meeting orchestration | inferred |
| `saw-record-001` | Update stage and observations | single-record update | inferred |
| `saw-orch-001` | Update record, read overview, persist summary | multi-tool orchestration | inferred |
| `saw-doc-001` | Read, move, preserve/update document, synchronize state, summarize | document-context automation | observed shape |
| `saw-doc-002` | Same chain with unavailable agent-state configuration | document-context partial failure | observed shape |
| `saw-analysis-001` | Read systems and persist one analysis finding | read-only analysis | inferred |
| `saw-analysis-002` | Read systems with a distractor write target | read-only analysis adversarial variant | authored |

Several additional route labels in the source corpus have no call ordering or
terminal-state contract behind them and are deliberately not modelled.

### 4.1 Family builders

Each family supplies:

```ts
{
  slug,
  band: "single-write" | "discovery" | "multi-write",
  label,
  instances,
  build(instance),
}
```

`buildTasks()` assigns each generated task a split, family, band, prompt,
initial state, assertions, allowed writes, and oracle. The resulting split is:

```text
train: 5
dev: 2
holdout: 2
```

## 5. Hashes and holdout boundary

`fixtureSha256()` hashes the generated tasks, global tool catalog, endpoint
catalog, and subset pin. `splitSha256(split)` hashes task IDs and assertions
for that split.

The expected holdout hash is computed from the current fixture. `taskPool`,
`evaluateSplit`, and holdout imports refuse access unless the caller supplies
the exact current `frozenHoldoutSha256`.

Changing a task changes the fixture hash and the affected split hash. Callers
and any external artifact carrying the old hash must be updated deliberately.

## 6. Exported artifacts

The sibling emits:

- `understudy.eval_result.v1` rows with score, route, cost, split, fixture hash,
  and provenance;
- an `understudy.benchmark.v1` manifest with task metadata, environment
  descriptor, verifier contract, split counts/hashes, and contamination status;
- a non-executable `verifiers.v1` descriptor pointing to the local terminal
  scorer.

The descriptor excludes holdout tasks. It is documentation for compatibility,
not a hosted trainer package.

## 7. Files

```text
src/synthetic-workflow-offline.ts
src/fixtures/synthetic-workflow-shapes.ts
tests/synthetic-workflow-offline.test.mjs
docs/synthetic-workflow-fixtures.md
```
