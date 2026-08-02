# Qwen serverless verifier-RL lane

This lane is a Fireworks serverless executor for the reproducible
`base -> SFT(on tool-failures) -> GRPO` candidate method. It uses the
AutomationBench v2 offline verifier, frozen split manifests, and one shared
action protocol for training and scoring.

## Workflow boundary

Vercel Workflow 4.6.0 is the sole durable run controller. This directory does
not contain a controller, poller, queue, or second state database:

- **verifier/contract** — `src/automationbench-action-protocol.ts`,
  `serving-contract.qwen3p6-27b.json`, the offline verifier, and immutable
  dataset/artifact references.
- **executor** — `verifier_rl.py` and `serving_shim.py`, which perform
  Fireworks attach, sampling, training, usage accounting, and cleanup.
- **candidate-method** — the base/SFT/GRPO recipe implemented by the executor.
- **UI-artifact** — redacted JSONL progress events, receipts, and artifact
  manifests consumed by the Workflow/UI.

The executor interface is:

```text
--operation submit|inspect|cancel|reconcileUsage
```

The implementation conforms to the canonical TypeScript executor surface in
[`src/executor-contract.ts`](../../src/executor-contract.ts), including the
strict submit, job-reference, status, cancellation, and usage schemas. The
Python layer is isolated runtime glue; TypeScript owns the contract.

`submit` is keyed by the deterministic SHA-256 of
`(experimentId, candidateId, attempt)`. It returns an executor job reference
and persists the redacted mapping as a content-addressed artifact under
`artifacts/`. Repeating the same submission rebinds the existing reference
instead of opening another session. `inspect` is intentionally a direct
inspection operation; it does not poll. `reconcileUsage` reports
`evidence_scope: "run_exclusive"` with measured request/token fields and an
`upper_bound_usd`; the receipt note explains that this is a client-side ledger
with uncached-prefill pricing, not provider-authoritative billing. The executor
permits at most one live Fireworks training
session per process; final receipts record the observed concurrency-related
404 characterization.

Final receipts, reports, manifests, and redacted event streams belong under
`outputs/qwen-serverless-verifier-rl/` so they remain reviewable and
committable. The executor's intermediate job mapping remains transient under
the ignored `experiments/.../artifacts/` directory.

## Commands

Build the TypeScript protocol first:

```bash
npm run build
```

Export oracle trajectories:

```bash
node experiments/qwen-serverless-verifier-rl/oracle-export.mjs \
  --split train \
  --out outputs/qwen-serverless-verifier-rl/oracle.train.jsonl
```

SFT:

```bash
uv run --no-project --with "fireworks-ai[training]" --with transformers python \
  experiments/qwen-serverless-verifier-rl/verifier_rl.py \
  --phase sft \
  --oracle outputs/qwen-serverless-verifier-rl/oracle.train.jsonl \
  --receipt outputs/qwen-serverless-verifier-rl/sft.receipt.json \
  --events outputs/qwen-serverless-verifier-rl/sft.events.jsonl
```

GRPO:

```bash
uv run --no-project --with "fireworks-ai[training]" --with transformers python \
  experiments/qwen-serverless-verifier-rl/verifier_rl.py \
  --phase grpo \
  --receipt outputs/qwen-serverless-verifier-rl/grpo.receipt.json \
  --events outputs/qwen-serverless-verifier-rl/grpo.events.jsonl
```

The matching scorer command reads the same 14-turn protocol budget:

```bash
node scripts/automationbench-v2-zeroshot.mjs \
  --model accounts/fireworks/models/qwen3p6-27b \
  --base-url http://127.0.0.1:8099/v1 \
  --max-turns 14 \
  --malformed-tolerance 3 \
  --split train
```

CI-safe dry run:

```bash
python3 experiments/qwen-serverless-verifier-rl/verifier_rl.py \
  --phase grpo --dry-run \
  --receipt /tmp/verifier-rl-dry-run.json \
  --events /tmp/verifier-rl-dry-run.events.jsonl
```

Executor job reference:

```bash
uv run --no-project --with "fireworks-ai[training]" --with transformers python \
  experiments/qwen-serverless-verifier-rl/verifier_rl.py \
  --operation submit \
  --experiment-id exp-example \
  --candidate-id qwen3p6-base-sft-grpo \
  --attempt 0 \
  --events /tmp/verifier-rl.events.jsonl
```

The committed `.py` files are isolated `uv run --no-project` runtime glue.
They are not a Python package or project. TypeScript remains the owner of the
command/validation boundary, action protocol, parser, fixture, and verifier.

No holdout is reachable from the trainer. Holdout export requires the exact
frozen hash and is separate from training.
