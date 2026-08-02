# `on-event-execution` — repair arm

One workload, owned end to end: validate a benchmark for it, decide whether it
is worth repairing, and try to repair it. All data here is synthetic or
aggregate; see [Privacy](#privacy).

## Deliverables

| Artifact | What it answers |
| --- | --- |
| [`repair-memo.md`](repair-memo.md) | Is this workload worth repairing, and which bands fail? |
| [`aggregates.json`](aggregates.json) | The traffic aggregates behind that judgment |
| [`lift.md`](lift.md) | Did DPO on the base beat the base, per band? |
| [`contracts/`](contracts) | The candidate payload, policy descriptor, and usage receipt |
| `../../outputs/oee/fixture-freeze.json` | The gate result for the fixture |

## Gate validation

No slice existed for this workload, so one was built:
`on-event-execution-offline-v1`, 96 deterministic synthetic tasks (train 56 /
dev 16 / holdout 24), authored as event envelopes over the shared offline
execution environment so every existing protocol gate applies unchanged.

```sh
npm run synthetic:oee-freeze
```

| Gate | Result |
| --- | --- |
| scripted oracle | mean reward exactly 1.0 on all 96 tasks |
| sentinel (activity-only reward hacking) | max reward exactly 0.0 |
| observation leakage | clean — no grader key, assertion path, or allowed write is observable |
| reachability | every literal the oracle writes is present in the prompt or a read-only listing |
| determinability | every addressed record is uniquely selected by the payload plus a listing |
| scenario duplication | no two tasks share a scenario signature; no train scenario recurs in dev or holdout |
| integrity | unique ids, no task pre-satisfied at reset, guard record never writable |
| determinism | two resets of a task are byte-identical |
| frozen holdout | reading the holdout without the exact frozen hash refuses |

## Method map

Under the consolidated orchestration model this arm is a
**verifier/contract** plus a **candidate-method**, and produces **UI-artifacts**.
It is not an executor and not a controller: it starts no poller, queue, inbox,
or state store.

- *verifier/contract* — the fixture module, its freeze gate, and the frozen
  split hashes. Immutable and hash-addressed.
- *candidate-method* — the DPO policy descriptor in
  [`contracts/`](contracts), submitted as an `understudy.executor-submit.v1`
  payload carrying refs and hashes only, with the holdout structurally absent.
- *UI-artifacts* — the repair memo, the aggregates, and the lift table.

## Privacy

Training and evaluation use sanitized synthetic fixtures only. Production
telemetry contributed **aggregates only** — counts, token sums, USD, and
distributions — and no raw row, prompt, completion, trace, or tenant/project
identifier is committed or reconstructible from anything in this directory.
