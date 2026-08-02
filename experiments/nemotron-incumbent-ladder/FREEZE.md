# Hardened synthetic mirror freeze

The public repository contains the generator and only a 12-row smoke fixture.
The 480-row mirror used for the ladder remains local; these are its immutable
hashes and freeze procedure.

## Generator and freeze procedure

Run the generator into a fresh directory, then verify row counts, category
mix, split disjointness, and SHA-256 hashes before any model or provider call:

```sh
node generate-mirror.mjs --out /tmp/incumbent-ladder-mirror
sha256sum /tmp/incumbent-ladder-mirror/{tasks,train,dev,holdout}.jsonl
```

The generator fixes the seed, emits 480 rows, assigns the 25/40/35
shortcut/playbook/judgment mix, creates 240/120/120 train/dev/holdout
partitions, and writes a freeze manifest. Holdout must remain unexecuted.

## Current local ladder fixture (v4)

| file | rows | sha256 |
|---|---:|---|
| tasks.jsonl | 480 | e2cc35762ae7e2a8d6a63efa6123982885df00b217fd33df5791a8a00699b6cb |
| train.jsonl | 240 | 21ed482c37ce664c67e7f60b421e78d209d1f5e1531d1454c12f45cd56d5cde2 |
| dev.jsonl | 120 | c2ffe33600065a20f869910d687e0f7f4725dccf400769ae58cf02d6d64386f1 |
| holdout.jsonl | 120 | 34a8cd481fe693ca56b6420c05db61a1bee76e38b77afe669720e5feb0472ad6 |

Category counts are 120 shortcut, 192 playbook, and 168 judgment, with 56
multi-call labels.

## Superseded fixture hashes

These immutable versions were superseded by generator repairs. Holdout was
regenerated locally each time but never sent to a provider, model, renderer,
sampler, or training job.

| version | tasks | train | dev | holdout |
|---|---|---|---|---|
| v1 | 079c0d5aaa85123c00d61a8404c0d15a141ee32fb4e23a1de39cbe4c51fba839 | ac544572359fbe14348106722a5c2244381e71481f7af87a9d90625891615905 | 567d68f5bacacfb23aed0d4c795e1e3566d03ee3792da53e60dac0255d94dbae | 048fc8819db26a83c9e9670c521437d754e1c5c5ec3411894c34c1c77628e35f |
| v2 | 0c697cf6e5275ed3b832ee6dde3c336505af6512f0ab51d82551e1b0b5647d1c | 6f7d501b227cab90de7b6208767501ab985dddee8914ef3e1229dd99d3013e17 | b643b29c12bc087cc1fec745fef96f5efeea168b0ebecef97646daa9199c94b4 | 0696644d9cf5fef8895dec502dc85716fb94b3abe4b21fd33f0fa908910a0381 |
| v3 | 0039b58827e44e58154a74299ba59c4b602812858a779b93f16fb949bb5ea66b | 8ba51e9976796a8f0221f353830f4549073de7a34ab98e60f56bf0a3bd55eb8a | 4900f819e45be925c0533152d7b7e2937e6e3c230c2bb326c4638d53fd8b2343 | d6ab166a5651aebc1942fa4c8b034fde2d133e51c805a066ac8bcb6b41990375 |

Repair notes:

- v2 made single-turn output, terminal-summary, and action conventions explicit.
- v3 aligned multi-call labels with rendered second actions.
- v4 removed optional non-outcome arguments and explicitly forbids summary
  calls for significant events.

## Public smoke fixture

The committed 12-row smoke fixture has its own hashes in the generated smoke
record. It is not a substitute for the hardened 480-row generator above.
