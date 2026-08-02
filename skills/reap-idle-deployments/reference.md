# Reap Idle Deployments — reference

Deep notes for the fleet scoreboard and the deployment reaper. The playbook is
in [`SKILL.md`](SKILL.md).

## Module API (`src/fleet/`)

TypeScript owns the shapes, the cost model, and both planners; the `.mjs`
scripts are argument parsing and printing only. Import from `dist/fleet/`
after `npm run build` to reuse any of it inside another harness.

| export | file | purpose |
| --- | --- | --- |
| `buildDeploymentTags`, `parseDeploymentTags`, `isReapable`, `expiryIso` | `tags.ts` | the owner/TTL convention, in both directions |
| `normalizeDeployment(s)`, `readDeploymentList`, `usdPerHour` | `deployments.ts` | provider records → one costed row shape |
| `buildScoreboard`, `formatScoreboard` | `scoreboard.ts` | join verifier scores onto costed rows |
| `planReap`, `formatReapPlan` | `reaper.ts` | pure decision planner, no side effects |
| `listDeployments`, `scaleDeploymentToZero`, `deleteDeployment` | `provider.ts` | the only code that talks to the control plane |

`planReap` and `buildScoreboard` both accept an injected `now`, so policy
behavior is testable without waiting for a TTL to elapse. `ProviderConfig`
accepts `fetchImpl` and `baseUrl` for the same reason.

## Cost model

`usdPerHr = desiredReplicaCount × acceleratorCount × rate(acceleratorType)`,
with per-GPU-hour rates in `RATE_USD_PER_GPU_HR` and an `8.0` fallback for
unrecognized accelerators. These are on-demand estimates for relative ranking —
they do not reconcile against an invoice, and committed-capacity or discounted
accounts will differ. A deployment at zero replicas costs `0` in this model even
though storage and the model artifact still exist; that is why the reaper
deletes as a second stage rather than treating scale-to-zero as done.

## Reaper decision table

Evaluated per deployment, in order. `overdue = now − expiry`, where expiry is
`understudy.expires-at`, else `createTime + understudy.ttl-hours`.

| condition | action |
| --- | --- |
| owner/arm/name in `--protect` | `keep` (protected) |
| no owner tag, or no TTL/expiry signal | `review` — never touched |
| `overdue < graceHours` (default 0.5) | `keep` (within TTL) |
| overdue, `replicas > 0` | `scale-to-zero` |
| overdue, `replicas == 0`, `overdue ≥ deleteAfterHours` (default 24) | `delete` |
| overdue, `replicas == 0`, inside delete window | `keep` (already at zero) |

`savingsUsdPerHr` counts only `scale-to-zero` rows, because those are the ones
where money stops flowing on this pass.

Deployments an arm still needs stay alive by keeping their tags current. The
failure this design accepts is the opposite one: an untagged deployment burns
until a human works the `review` list. That is deliberate — automated deletion
of an unattributable deployment can kill a running experiment, and the review
row plus the `untagged $/hr` total makes the leak loud instead of silent.

## JSON output

`fleet-scoreboard.mjs --json` emits `{ account, generatedAt, rows, totals }`.
Useful fields per row: `score`, `usdPerHr`, `scorePerUsdHr`, `owner`, `tagged`,
`expiresAt`, `flags` (`burn-without-score`, `untagged`, `expired`,
`scaled-to-zero`, `no-deployment`).

`fleet-reaper.mjs --json` emits `{ account, mode, generatedAt, policy,
decisions, savingsUsdPerHr, counts, applied }`. `mode` is `dry-run` unless both
`--apply` and `--yes` were passed; `applied` lists what actually executed.

Monitoring suggestions: page on `counts.review > 0` for longer than a shift,
alert on `totals.unscoredBurnUsdPerHr` above a threshold you pick per sweep, and
record `savingsUsdPerHr` per run so the reaper's value is measurable.

## Offline fixture workflow

Both scripts accept `--deployments <file.json>` holding either an array or
`{ "deployments": [...] }` of provider-shaped records. That path needs no
credentials and no network, which is how the smoke test in
`tests/fleet-scoreboard-reaper.test.mjs` runs. `--apply` is refused with
`--deployments` so a fixture can never turn into a live mutation.

A minimal record:

```json
{
  "name": "accounts/demo/deployments/arm-a",
  "baseModel": "accounts/demo/models/base-8b",
  "createTime": "2026-01-01T18:00:00.000Z",
  "acceleratorType": "NVIDIA_H100_80GB",
  "acceleratorCount": 2,
  "desiredReplicaCount": 1,
  "annotations": {
    "understudy.owner": "arm-a-runner",
    "understudy.ttl-hours": "4",
    "understudy.arm": "arm-a"
  }
}
```

## Provider calls

Scale-to-zero patches `desiredReplicaCount` to `0`; deletion issues `DELETE` on
the deployment. Both go through `src/fleet/provider.ts`, so pointing the harness
at a different control plane means changing one file. Non-2xx responses throw
with the status and body, and the script exits nonzero without attempting the
remaining actions — a partial pass is safer than one that plows through errors.
