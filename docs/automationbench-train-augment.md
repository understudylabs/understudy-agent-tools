# AutomationBench synthetic TRAIN augmentation

`src/automationbench-train-augment.ts` deterministically expands the frozen
synthetic v1 `simple/api` TRAIN pool without reading or emitting dev/holdout
task content. It coexists with the harder v2 fixture
([`automationbench-v2-hard-split.md`](automationbench-v2-hard-split.md)) but
does not add v2 families to this artifact. It authors cases through the v1
family builders, registers them only in the shared in-memory runtime registry,
validates each case and oracle trajectory, and emits a hash-stamped TRAIN-only
artifact.

This is synthetic data for local evaluator and training experiments. It is not
an upstream AutomationBench result.

## Current artifact

The committed v1 artifact is under
`experiments/automationbench-train-augment/v1/`:

| Item | Count |
| --- | ---: |
| Frozen TRAIN tasks | 48 |
| Accepted augmented tasks | 288 |
| Total TRAIN tasks | 336 |
| Trajectories | 1,008 |
| Trajectories per task | 3 |

Every family contributes 24 accepted variants:

| Family | Band | Accepted |
| --- | --- | ---: |
| `crm-close` | single-write | 24 |
| `crm-lost` | single-write | 24 |
| `crm-owner` | single-write | 24 |
| `crm-rename` | single-write | 24 |
| `mail-draft` | discovery | 24 |
| `mail-revise` | discovery | 24 |
| `mail-discard` | discovery | 24 |
| `mail-send` | discovery | 24 |
| `crm-bulk-owner` | multi-write | 24 |
| `crm-disambiguate` | multi-write | 24 |
| `crm-mail-churn` | multi-write | 24 |
| `mail-send-and-close` | multi-write | 24 |

## Deterministic grid and deduplication

The generator uses reset seed `7`, no RNG, clock, network, or filesystem I/O
from `src/`. For cycle `0..23`:

```text
instance = cycle % 4
offsetIndex = floor(cycle / 4)
offset = (familyIndex * 7 + instance * 5 + (offsetIndex + 1) * RESET_SEED) % PERSONA_COUNT
```

Only the four frozen TRAIN phrasings (`instance` 0–3) are authored. Dev and
holdout phrasings (instances 4–5) are never generated. The 24-persona table
rotation changes the seeded entities and parameters while retaining the
family's original prompt exactly.

Candidates are rejected on task-id collision, content-hash collision, or an
exact prompt match with a frozen dev/holdout task. A prompt matching a frozen
TRAIN task is allowed when the canonical task content hash differs; this is
needed for families whose instruction depends only on the instance while the
seeded world varies.

The content hash is SHA-256 over canonical:
`{prompt, initialState, assertions, allowedWrites, oracle}`.

## Artifact encoding

`tasks.jsonl` contains one complete TRAIN task per line. It includes the 48
frozen TRAIN tasks followed by the accepted augmented tasks. No dev or holdout
task content is included.

`trajectories.jsonl` contains three oracle-consistent trajectories per task:

1. `variant: 0` — the recorded oracle;
2. `variant: 1` — one extra read-only `api_search` before the oracle;
3. `variant: 2` — one extra read-only `GET /mail/drafts` before the first
   write.

Each trajectory starts with the reset system/user messages and alternates
assistant/tool-result turns. Assistant `tool_calls` entries are JSON strings,
and each entry's `arguments` is also a JSON string, matching the on-disk
AutomationBench encoding accepted by `parseToolCalls()`. Consumers can replay
the parsed calls through `reset()` and `step()`, then take the terminal reward.

`manifest.json` records counts, per-family accepted counts, both v1 and v2
frozen split hashes, per-task `{task_id, content_sha256}` entries, generator
parameters, provenance, and `augmented_train_sha256`.
`contamination-report.json` repeats the headline counts and records explicit
empty id/content-hash intersections with both v1 and v2 dev/holdout pools,
plus both frozen holdout hash equality proofs.

## Gates

Every augmented task is hard-failed unless all gates pass:

- oracle rollout reward is exactly `1.0`;
- oracle rollout has zero forbidden effects;
- sentinel policy reward is `0`;
- every gold record id and string body literal is prompt/read-only reachable;
- reset observation leakage audit is empty;
- at least one assertion is unsatisfied at reset;
- guard contact `c-0` is absent from `allowedWrites`;
- every emitted trajectory replays to exactly `1.0` with zero forbidden effects;
- task IDs and canonical content hashes are disjoint from frozen v1 and v2
  dev/holdout pools;
- both frozen v1 and v2 holdout split hashes equal their pinned values.

The contamination report's intersections are:

```json
{
  "train_vs_dev_ids": [],
  "train_vs_holdout_ids": [],
  "train_vs_dev_content_hashes": [],
  "train_vs_holdout_content_hashes": [],
  "train_vs_v2_dev_ids": [],
  "train_vs_v2_holdout_ids": [],
  "train_vs_v2_dev_content_hashes": [],
  "train_vs_v2_holdout_content_hashes": [],
  "holdout_hash_equal": true,
  "v2_holdout_hash_equal": true
}
```

The report explicitly states that artifacts are TRAIN-only and contain no
dev/holdout task content, hashes only.

## Frozen and generated hashes

| Hash | Value |
| --- | --- |
| `fixtureSha256()` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `splitSha256("train")` | `783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89` |
| `splitSha256("dev")` | `5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc` |
| `splitSha256("holdout")` | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` |
| `v2FixtureSha256()` | `918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22` |
| `v2SplitSha256("train")` | `71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b` |
| `v2SplitSha256("dev")` | `f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135` |
| `v2SplitSha256("holdout")` | `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9` |
| `augmented_train_sha256` | `6dd05e7b2280070df9b220fb144e0f61517b43463f7a07cf78b23b2ede7551c3` |

## Regeneration

```sh
npm run build
node scripts/automationbench-train-augment.mjs
node scripts/automationbench-train-augment.mjs --check
node --test tests/automationbench-train-augment.test.mjs
```

`--check` regenerates in memory and fails if any committed artifact differs.

## Limitations

- Synthetic data only; this is not an upstream AutomationBench number.
- The artifact remains v1-family TRAIN-only; v2 hard families are not added.
- Family-stratified: dev and holdout share task families with TRAIN.
- Augmentation uses the four TRAIN phrasings by construction; templated
  phrasings therefore remain shared across splits.
- The fixture is ranking-sized rather than leaderboard-sized.
- Trajectories are scripted oracle demonstrations; no model inference occurs.
