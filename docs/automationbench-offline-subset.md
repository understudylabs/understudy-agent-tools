# AutomationBench `simple`/`api` — offline synthetic evaluator + importer

`src/automationbench-offline.ts` is the smallest local, synthetic, **offline**
evaluator and importer for one reachable AutomationBench subset. It runs
in-process with no provider credentials, no network, and no spend, and it is
the executable reference for the safety gates the verifier-handoff stages
describe in prose.

## Why `simple`/`api`

The subset is chosen from repo evidence, not preference:
[`skills/prepare-verifier-handoff/references/stage-1-author-env.md`](../skills/prepare-verifier-handoff/references/stage-1-author-env.md)
carries a **verified** integration map for AutomationBench `simple`/`api` —
`WorldState(**info["initial_state"])` as per-task state, `api_search` as
read-only discovery, `api_fetch` as the single-step state mutator, and
`partial_credit(state)` as the terminal fractional reward. No comparable
verified map exists in this repo for a finance subset, so `simple`/`api` is the
only subset with enough evidence to model faithfully.

The tasks, apps, and records here are **synthetic**. This is not the upstream
Zapier dataset and must never be reported as an upstream AutomationBench score.

## Pins

| Pin | Value |
| --- | --- |
| subset | `simple/api` |
| benchmark id | `automationbench-simple-api-offline` |
| fixture id | `automationbench-simple-api-offline-v1` |
| reset / split seed | `7` |
| splits | train 4 / dev 1 / holdout 1 |
| verifiers pin | `ab65b6e8d34b03d162408d4bcb854430a86809e6` (`verifiers.v1`) |
| fixture hash | `fixtureSha256()` — canonical-JSON sha256 over tasks + tool catalog + endpoint catalog |

## Verifiers v1 packaging concepts

`verifiersPackageDescriptor()` emits the current public Prime Intellect
Verifiers v1 shape as a **descriptor**: a `Taskset` of `Task`s, each with a
seeded setup and a single terminal `@vf.reward` pinned to the local scorer
(`partialCredit`), so `remote_reward == local_reward` by construction. The
holdout task never enters the packaged pool, and the descriptor is stamped
`executable: false` — this repo does not install, upload to, or run a hosted
trainer.

## Safety gates (each has a test)

1. **Deterministic reset** — `reset(task_id, 7)` is byte-identical per call; no
   wall clock, no RNG, no generated ids outside the pinned initial state. The
   verified upstream nondeterminism (a construction-time `gmail.internal_date`)
   is designed out rather than tolerated. An unpinned seed is refused.
2. **Terminal `partial_credit` reward** — every non-final `step()` returns `0`;
   the terminal reward is the fraction of satisfied final-state assertions.
   Anti-free-credit: assertions already true at reset are excluded from both
   numerator and denominator, so a do-nothing policy scores `0`.
3. **No label leakage** — `auditObservationLeakage()` fails an observation that
   exposes assertions, gold, allowed-write paths, or the oracle script.
4. **No live effects** — the env mutates in-memory synthetic state only. A test
   asserts the module's entire import list is `node:crypto` + `./benchmark.js`
   and that it references no HTTP/provider client and no filesystem write.
5. **Scripted oracle** — each task carries a recorded gold action sequence that
   must score exactly `1.0` with zero forbidden effects.
6. **Reward-hacking sentinel** — an activity-only policy (search spam plus an
   out-of-scope write) must score `0` on every task. Writes outside the task's
   allowed paths zero the reward, so completing the task while clobbering
   unrelated state still scores `0` (preservation outranks completion).
7. **Schema / hash checks** — the emitted manifest validates against
   `understudy.benchmark.v1` via the repo validator, rows validate against the
   `understudy.eval_result.v1` required fields and score range, and every row is
   stamped with `harness_sha256` (fixture hash) and `split_sha256`.
8. **Parser compatibility** — `parseToolCalls()` handles the real on-disk
   AutomationBench encoding where each `tool_calls` entry is a JSON **string**
   and its `arguments` is itself a JSON string (double-decode), plus the
   OpenAI-style nested `function` shape and plain objects. Malformed calls throw
   rather than silently scoring. A replay test round-trips a recorded trajectory
   through `reset`/`step` and hard-asserts the reproduced reward.
9. **Frozen-holdout refusal** — `taskPool`, `evaluateSplit`, and `importSubset`
   all refuse holdout access unless the caller passes `frozenHoldoutSha256`
   equal to `splitSha256("holdout")`. A drifted holdout fails closed.

## Commands

```sh
npm run build
node --test tests/automationbench-offline.test.mjs
npm run check        # build + typecheck + full test suite + skills + package smoke
```

Programmatic use (scripted policies only — the env never calls a model):

```js
import { evaluateSplit, oraclePolicy, importSubset } from "./dist/automationbench-offline.js";

const rows = evaluateSplit({ split: "train", runId: "run-1", policy: oraclePolicy });
const { manifest, rows: imported } = importSubset({ runId: "run-1", nativeExport });
```

## Limitations

- **Synthetic, not upstream.** Two apps, three endpoints, six tasks. Results are
  a harness self-check, never an AutomationBench leaderboard number.
- **Sample size is tiny** (train 4 / dev 1 / holdout 1) — deliberately, so the
  gates stay readable. It cannot separate models.
- **Scripted policies only.** There is no model runner here by design; wiring a
  policy to a model is the caller's job, outside this module's no-live-effects
  boundary.
- **Descriptor, not a runnable partner package.** No `.py` module is emitted,
  no verifiers install is performed, and conformance against a real trainer is
  unverified.
- **`AUTOMATIONBENCH_STRICT_ASSERTIONS` semantics** from the upstream harness
  are not modelled; assertion evaluation here cannot throw.
