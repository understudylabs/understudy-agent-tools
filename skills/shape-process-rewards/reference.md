# Process reward reference

## Catalog placement decision

This is a top-level skill rather than a `reference.md` under another skill.

It was checked against:

- `prepare-verifier-handoff`: owns the decision and packaging path for hosted
  stateful policy training, but does not author or calibrate dense rewards.
- `design-simulated-environment`: owns deterministic seeded environments and
  terminal validators, but process shaping is a distinct reward-design
  intervention after the environment exists.
- `optimize-agentic-workload`: owns model, route, and prompt comparisons, not
  reward construction for policy training.
- `curate-trajectories`: owns provenance and split contamination gates, not
  verifier reward semantics.

The distinct user-intent trigger is a request to shape intermediate rewards
while preserving terminal verifier semantics. That intent is not claimed by
the four existing skills, so a new top-level skill clears the catalog-growth
bar. This reference contains the exact implementation contract for that
skill.

## Exact default configuration

| Field | Default | Meaning |
| --- | ---: | --- |
| `bands` | `undefined` | Optional reporting-band allowlist; structural gating is used by default |
| `minOracleSteps` | `2` | Minimum oracle length for process shaping |
| `kappa` | `0.5` | Symmetric episode process-reward clip |
| `progressWeight` | `0.3` | Positive scale on potential progress |
| `betaDiscovery` | `0.02` | Bonus for each response revealing new identifiers |
| `lambdaForbidden` | `0.25` | Penalty for a step adding forbidden effects |
| `stepCost` | `0.005` | Cost for each enabled step |
| `lambdaRedundant` | `0.02` | Penalty for duplicate or unchanged writes |
| `betaStop` | `0.03` | Bonus for explicit completion at potential one |
| `lambdaTruncated` | `0.05` | Penalty for step-ceiling truncation |
| `lambdaEarlyStop` | `0.0` | Optional penalty for explicit incomplete finish |

Structural gating enables shaping when `oracle.length >= minOracleSteps`.
`bands` can explicitly exclude a named band. The process magnitude target is
approximately `0.33` for legitimate trajectories versus terminal success `1.0`.

## Reward equations

```text
Phi(s) = fraction of required assertions not satisfied initially
         that are satisfied in state s

r_progress = progressWeight * (Phi(after) - Phi(before))

process_raw = sum(step components + stop/truncation components)
process_total = clamp(process_raw, -kappa, +kappa)
combined = terminal_reward + process_total
```

Potential progress must telescope:

```text
sum(r_progress)
  = progressWeight * (Phi(final) - Phi(initial))
```

For online service use, each `/step` returns the incremental clipped delta.
The finish reward closes the stream:

```text
sum(step rewards) + reward(/finish)
  = terminal_reward + process_total
  = combined
```

## Service protocol

### `POST /reset`

Existing request fields remain valid. Process mode is opt-in:

```json
{
  "task_id": "…",
  "reward_mode": "terminal+process",
  "process_config": {
    "progressWeight": 0.3,
    "kappa": 0.5
  }
}
```

`reward_mode` values:

```text
terminal
terminal+process
```

The default is `terminal`. In process mode, the response additionally contains:

```json
{
  "reward_mode": "terminal+process",
  "process_config": {},
  "process_config_sha256": "…"
}
```

### `POST /step`

Terminal-only response remains unchanged:

```json
{
  "observation": "…",
  "step": 1,
  "done": false
}
```

Process mode adds:

```json
{
  "observation": "…",
  "step": 1,
  "done": false,
  "reward": 0.04,
  "process_reward": {
    "stepIndex": 0,
    "progress": 0.03,
    "discovery": 0.02,
    "forbidden": 0,
    "stepCost": -0.005,
    "redundant": 0,
    "stop": 0,
    "truncated": 0,
    "earlyStop": 0,
    "total": 0.045,
    "onlineReward": 0.04,
    "discoveryIdentifiers": [],
    "forbiddenEffects": [],
    "duplicateAction": false,
    "unchangedWrite": false
  }
}
```

`reward` is the incrementally clipped transition reward, not the raw
component sum.

### `POST /finish`

Terminal-only response remains:

```json
{
  "reward": 1,
  "steps": 4,
  "forbidden_effects": []
}
```

Process mode response:

```json
{
  "reward": 1.27,
  "terminal_reward": 1,
  "process_total": 0.27,
  "combined": 1.27,
  "steps": 4,
  "forbidden_effects": [],
  "process_breakdown": []
}
```

In process mode, `reward` is the residual stream reward that makes the
transition-reward sum equal `combined`. `terminal_reward` and `process_total`
are the separately auditable components.

Callers should pass `explicit_finished: true` only when the policy explicitly
issued its finish action. Silent turn exhaustion must use
`explicit_finished: false`; set `truncated: true` when the ceiling caused the
finish.

### `GET /protocol`

The response retains the existing action protocol and exposes:

```json
{
  "process_reward": {
    "default_mode": "terminal",
    "config": {},
    "config_sha256": "…"
  }
}
```

## Probe report

Run:

```sh
npm run build
node scripts/process-reward-probe.mjs --out /tmp/process-reward-probe.json
```

The report schema is:

```text
understudy.process_reward_probe.v1
```

Each band reports oracle, no-op, search-spam, and write-everything raw and
clipped process totals, combined totals, `max_achievable_process_reward`, and
`clip_bound`. `clip_bound` must be `false` for every oracle band. The report
verdict is `FAIL` if any oracle reaches the clip or any anti-hacking invariant
fails.
