# `domain-identification` repair arm (WL-DI)

Owns one workload end to end: validate a sanitized synthetic benchmark slice for
it, size the repair from telemetry aggregates, and measure whether DPO on an
open base model closes the failing bands.

| Deliverable | Where |
| --- | --- |
| Repair-target memo (aggregates only) | [`REPAIR-MEMO.md`](REPAIR-MEMO.md), [`aggregates.json`](aggregates.json) |
| Gate-validation result | [`outputs/gate-validation.json`](outputs/gate-validation.json) |
| Base vs DPO lift, per band | [`RESULTS.md`](RESULTS.md), `outputs/lift-*.json` |
| The slice itself | [`../../src/domain-identification-slice.ts`](../../src/domain-identification-slice.ts), gated by [`../../tests/domain-identification-slice.test.mjs`](../../tests/domain-identification-slice.test.mjs) |

Nothing here is a controller. Each script is a pure step: it reads immutable
inputs, writes one immutable JSON artifact, and prints it. There is no queue, no
poller, and no state of its own — re-running a step with the same inputs
reproduces the same artifact.

## Artifact contract

Every artifact carries a `schema_version` and the fixture hashes it was produced
against, so a consumer can verify identity without reading any payload. No
prompt, completion, trace, tenant id, or credential appears in any of them.

| Step | Idempotency key | Emits |
| --- | --- | --- |
| `gate-check.mjs` | `fixture_sha256` | `understudy.slice_gate_validation.v1` |
| `rollout.mjs` | (`fixture_sha256`, `split_sha256`, `model`, `temperature`, `samples`) | `understudy.slice_rollout.v1` |
| `mine-pairs.mjs` | (`train_split_sha256`, rollout artifact) | `understudy.dpo_pairs_manifest.v1` + `pairs_sha256` |
| `validate-pairs.mjs` | `pairs_sha256` | `understudy.dpo_pairs_validation.v1` (fail-closed) |
| `band-report.mjs` | (`split_sha256`, base artifact, candidate artifact) | `understudy.slice_lift.v1` |

This arm is a **candidate-method + verifier/contract** surface, not an executor.
`submit-payload.mjs` emits its candidate as an `understudy.executor-submit.v1`
payload ([`outputs/executor-submit.json`](outputs/executor-submit.json)),
validated against [`../../schemas/understudy.executor-submit.v1.schema.json`](../../schemas/understudy.executor-submit.v1.schema.json)
and asserted with tests only — no provider calls. It is byte-identical for the
same (`experiment_id`, `candidate_id`, `attempt`), so a retry resolves to the
existing job rather than opening a second paid one, and the sealed holdout is
structurally absent from it.

The one paid step — DPO training on Tinker via
[`../../scripts/tinker-dpo-train.py`](../../scripts/tinker-dpo-train.py) — is
keyed on (`pairs_sha256`, base model, beta, epochs) and returns a checkpoint ref
(`tinker://…`). Scoring consumes that ref through the same OpenAI-compatible
shim the base is scored through, so base and candidate differ only in weights.

## Frozen splits

```
fixture   domain-identification-offline-v1   e6b660733b03d97076035f980488642c32701beb25142b9b0a1c4a12ed88b402
train  24 b358c36f429303d64bb9309a685f78ddfd03bd1602cbf415e8dd1e977ac93017
dev     8 3934011a2182ac6d4b32e7016b705cb908e21c2c1ae469f3b0e116ed7bc345a2
holdout 16 ec9154535b1105f696b6ff9efd72d8457c14e1ed4ff65be043f68188bc9fac2b
```

The holdout fails closed: `domainIdTaskPool({ split: "holdout" })` throws unless
the exact frozen hash is passed. It is read once per arm, after dev has already
chosen the configuration.

## Running it

```sh
npm run build

node experiments/domain-identification-repair/gate-check.mjs \
  --out experiments/domain-identification-repair/outputs/gate-validation.json

# serve the base through the Tinker shim (train+serve lane for Nemotron)
TINKER_API_KEY=... python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 --port 8099

node experiments/domain-identification-repair/rollout.mjs \
  --model nemotron-3-nano-base --base-url http://localhost:8099/v1 \
  --split dev --out .../outputs/base-dev.json
```

Pair mining, validation, training, and the lift table follow the same shape; see
[`RESULTS.md`](RESULTS.md) for the exact commands the reported numbers came from.
