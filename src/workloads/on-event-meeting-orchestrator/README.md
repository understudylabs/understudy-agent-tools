# Event meeting orchestrator offline fixture

This workload-scoped fixture is synthetic and offline. It contains eight
families with twelve varied instances each:

```text
train: 48
dev: 16
holdout: 32
total: 96
```

Pin:

```text
benchmark_id: meeting-orchestrator-shapes-offline
subset: meeting-orchestrator/api
fixture_id: meeting-orchestrator-shapes-offline-v1
split_seed: 7
```

Frozen hashes:

```text
fixture: a33a00404a9d271662228ab330c116b3cc1722d13d3cb67df58a979da6f12e61
train:   edfa0f4ec6419df5ca836da0601dc10ef43b732383064f0893e84619619676ff
dev:     10b1b065d0aa86d87c2ff21150ebfc560a9eeb5fa662f5a10c0c6f3b9a170c21
holdout: b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae
```

Band counts:

```text
single-write: 12
discovery:    12
conditional:  24
multi-write:  24
no-op-guard:  12
long-chain:  12
```

The environment uses terminal-only partial credit, excludes assertions already
true at reset, gives an empty remaining-assertion set a terminal score of one,
rejects forbidden writes, pins reset seed 7, and refuses holdout access unless
the exact frozen holdout hash is supplied. The no-op guard remains
discriminative because any attempted calendar write is forbidden.
