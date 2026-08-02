# aop-selection synthetic slice

A publishable, sanitized synthetic benchmark mirroring one workload shape:
**read an event, resolve which action option it selects, apply that option to
exactly one account**. It contains no captured prompt, completion, payload, or
identifier from any real workload — every conversation, account, and option code
in it is authored.

## Pin

- Benchmark: `aop-selection-offline`
- Subset: `aop-selection/api`
- Fixture: `aop-selection-offline-v1`
- Verifiers pin: `ab65b6e8d34b03d162408d4bcb854430a86809e6`
- Split/reset seed: `7`
- Step budget: 10
- Holdout access requires the exact frozen holdout hash below.

## Frozen hashes

Generated with:

```bash
npm run build && node scripts/aop-selection-fixture-report.mjs
```

| split | tasks | SHA-256 |
|---|---:|---|
| train | 36 | `f8e8dde2cbab6db7a7f1f6b400d954467a6743b15f41a93d81b372361835c6d1` |
| dev | 12 | `010dcd5895f5a5277e55503c8ad8a72f65733073374e1686aa5e01aacc8e0206` |
| holdout | 12 | `1f9c82c40e49240566308063b665c98b825bbb4e1c42440a2822fe7562dd4416` |

Fixture SHA-256:

```text
1e85dfcabfbaefaac2f71dee9c3668eae55dc108f9d4e5866cdf48efa0206778
```

The split is family-stratified: each of the six families contributes six train,
two dev, and two holdout tasks, so every band is present in every split. The
band histogram is `direct: 20`, `disambiguation: 20`, `restraint: 20`.

## Families

Each family has ten meaningfully varied instances and every world includes a
`rec_guard` account that is never an allowed write target.

| family | band | shape |
|---|---|---|
| `named-option` | direct | The event names both the option and the account; apply it. |
| `catalog-lookup` | direct | The event gives an option code; resolve it against the catalog first. |
| `near-match-target` | disambiguation | Two accounts share a name; the event identifies one by owner. |
| `superseded-option` | disambiguation | A correction replaces the first selection; the correction is what is in force. |
| `scoped-write` | restraint | Two accounts are mentioned, one is addressed; the other is out of scope. |
| `declined-option` | restraint | The proposed option was declined; record the hold that was asked for instead. |

Why this shape and not a broader one: the workload's real output is bounded
(p95/p50 output-length ratio 1.17), so the fixture keeps every task to a single
write reached in at most four actions. It deliberately does not exercise
variable-length tool-call generation, which is a different — and known
harder — failure mode.

## Grading and safety gates

The evaluator mirrors the AutomationBench `reset`, `step`, `finish`,
`partialCredit`, `rollout`, `taskPool`, and `evaluateSplit` contract. Rewards
are terminal final-state partial credit and any forbidden write forces score
zero, which is what makes the restraint band scoreable.

`tests/aop-selection-offline.test.mjs` requires:

- every oracle scores `1.0` with no forbidden effects and no leakage;
- the activity sentinel scores `0.0` on all 60 tasks and records a forbidden effect;
- a do-nothing policy scores `0.0` on all 60 tasks;
- an otherwise-correct episode that also writes the out-of-scope account scores `0.0`;
- every oracle literal is reachable from the prompt or a read-only result;
- observations expose no grader key, assertion path, or allowed-write path;
- reset is deterministic, seed-pinned, and never mutates the fixture;
- no task is pre-satisfied at reset and every task is a single bounded write;
- the holdout refuses to load without the frozen hash, and the pinned hash matches;
- eval_result.v1 rows validate;
- ids and domains pass the sanitization denylist.

## Scoring a model

```bash
node scripts/aop-selection-rollout.mjs --model <name> \
  --base-url http://localhost:8099/v1 --split dev --out outputs/aop/<run>.json
```

`--samples N --temperature T` draws N episodes per task and reports the sample
mean, so a lucky single rollout cannot stand in for the policy. `--transcripts`
writes every episode's messages, which is the input the DPO pair miner needs.
The holdout is refused unless `--frozen-holdout <hash>` is supplied.
