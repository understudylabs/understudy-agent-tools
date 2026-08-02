# WL-OR benchmark validation — gate run on the orchestrator slice

The benchmark this arm repairs against is a **named slice of an already
published, sanitized synthetic fixture**, not a new dataset. Nothing is
generated from customer traffic; the slice only selects families, so every
frozen fixture hash still holds.

## Pin

| Pin | Value |
| --- | --- |
| slice id | `wl-or-orchestrator-v1` (`WL-OR`) |
| fixture | `synthetic-workflow-shapes-offline-v2` |
| families | `multi-step-orchestrator-chain`, `summary-orchestration`, `agent-state-synchronization`, `agent-state-partial-failure`, `document-preservation` |
| tasks | 30 (train 20 / dev 5 / holdout 5) |
| bands | multi-write 24, single-write 6 |
| slice sha256 | `49e2f5615bf1b2614ed9a7ce5dc8f43fe4134c8a941b3d233b0f2275f6b0ab6d` |
| train split sha256 | `30448f43a2c6d4487b2bfd94e408d31823874b193aa37263db1885936b4cf51f` |
| dev split sha256 | `026b432843e809da47f96df3e593d058e4b3f1994a40d895486812a48607edae` |
| holdout split sha256 | `a5337d711cf29117c2b7b5d3075f823e17f214102825dfc874d26066808f760d` |
| fixture frozen-holdout hash | `6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144` |

Splits are **inherited** from the fixture, never re-drawn: a task that is dev or
holdout in the fixture is dev or holdout in the slice, so the slice cannot
launder a held-out task into training.

## Why these families are the orchestrator's task shape

The workload is a controller that reads conversation state, updates the
addressed entity or agent state, edits the referenced document, and persists a
completion summary. The five selected families are exactly the fixture's
chained read→update→persist shapes, including the partial-failure variant where
one dependency answers unavailable and the chain must continue anyway. The
other seven fixture families (routing, identification, option selection,
analysis, mail follow-up, single observation) belong to sibling workloads and
are excluded.

## Gate run

```sh
npm run build
node experiments/workload-orchestrator/slice-gates.mjs \
  --out experiments/workload-orchestrator/artifacts/slice-gates.json
node --test tests/workload-orchestrator-slice.test.mjs
```

Result — [`artifacts/slice-gates.json`](artifacts/slice-gates.json), verdict
**pass**:

| Gate | Result |
| --- | --- |
| oracle reward (min over 30 tasks) | **1.0** |
| activity sentinel (max over 30 tasks) | **0.0** |
| free credit (task satisfied at reset) | clean |
| label leakage (grader keys / assertion paths in observations) | clean |
| reachability (every oracle write literal readable) | clean |
| frozen-holdout refusal | enforced — the holdout pool throws without the hash |
| deterministic reset, unique ids | clean |

The same contract is re-asserted in CI by
[`tests/workload-orchestrator-slice.test.mjs`](../../tests/workload-orchestrator-slice.test.mjs),
which also pins the three split hashes, so a fixture edit that silently moves a
task out of this slice fails the build.

## Base difficulty (headroom check)

Scored through the Tinker sampling shim, temperature 0, one attempt per task,
malformed emissions rejected rather than repaired
([`artifacts/base-dev.json`](artifacts/base-dev.json)):

| Base | dev mean | exact-1 | zero | over-acting episodes | episodes with a rejected emission |
| --- | --- | --- | --- | --- | --- |
| Nemotron-3-Nano-30B-A3B (Tinker, `nemotron3`) | **0.050** | 0.00 | 0.80 | 2 / 5 | 5 / 5 |

The slice is far from saturated for this base — it can rank a repair, which is
what a benchmark has to do to be worth training against.
