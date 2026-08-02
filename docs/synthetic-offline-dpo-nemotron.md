# DPO on Nemotron over the synthetic offline fixture

The lane for turning **near-hit preference pairs** into a tuned Nemotron policy
and proving — outcome-first, per band — whether it beat its own base.

## Why this shape

| Decision | Reason |
| --- | --- |
| Train **and** serve on Tinker | Tinker is the only clean train+serve lane for Nemotron: the managed Fireworks path reports `supportsLora=false` for this family, so a tuned Nemotron cannot be served there. Scoring the tuned model anywhere else would compare two different runtimes. |
| Score through `scripts/tinker-openai-shim.py` | Tinker's `tools=` path raises `NotImplementedError`, so tool calls go through plain sampling with the `nemotron3` renderer. Base and tuned runs use the **same** shim and the same sampling parameters, so the only difference between the two runs is the weights. |
| Outcome-first metric | The fixture scores terminal final state (`partialCredit`), not the argument text. A large strict-sequence argument diff is usually cosmetic; only outcome-changing effects count. |
| Sealed holdout | `v2TaskPool({split: "holdout"})` refuses to load without the frozen hash. Run it **once** per arm, after dev has already picked the configuration. |
| Synthetic data only | Every pair must trace to a task id in the offline fixture. No raw customer traces, no tenant identifiers. |

## Fixture pins

| Pin | Value |
| --- | --- |
| fixture id | `automationbench-simple-api-offline-v2` |
| splits | train 120 / dev 36 / holdout 60 |
| dev hash | `f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135` |
| holdout hash | `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9` |
| base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` (Tinker) |
| renderer | `nemotron3` |

## Pair contract

The data-foundry arm emits `dpo_pairs.jsonl` plus a manifest. One JSON object
per line:

```json
{
  "task_id": "hard-api-ticket-owner-route-03",
  "prompt": "…the task prompt, or prompt_conversation: [{role, content}]…",
  "chosen":   "…the near-hit rollout that reached the required final state…",
  "rejected": "…the sibling rollout that missed it…"
}
```

`chosen`/`rejected` may be a string or a `[{role, content}]` list. The manifest
must carry `source` (naming synthetic/public data), `split: "train"`, and
`pairs_sha256` over the exact bytes of the JSONL.

## Run it

```sh
npm run build

# 1. Gate the pairs. Fails closed on a hash mismatch, a dev/holdout task id,
#    a non-synthetic source, a tenant identifier, or a no-signal pair.
node scripts/dpo-pairs-validate.mjs \
  --pairs <dpo_pairs.jsonl> --manifest <manifest.json> \
  --out outputs/dpo/pairs.normalized.jsonl \
  --report outputs/dpo/pairs.validation.json

# 2. Train. The trainer refuses raw pair files — only the validator's output.
TINKER_API_KEY=… python scripts/tinker-dpo-train.py \
  --pairs outputs/dpo/pairs.normalized.jsonl \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 --lora-rank 32 --beta 0.1 --epochs 2 \
  --out outputs/dpo/train-receipt.json

# 3. Serve the checkpoint from the receipt and score it exactly like the base.
TINKER_API_KEY=… python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 --model-path "$(jq -r .checkpoint outputs/dpo/train-receipt.json)" \
  --port 8099 &

node scripts/automationbench-v2-zeroshot.mjs --model nemotron-3-nano-dpo \
  --base-url http://localhost:8099/v1 --split dev --max-tokens 2048 \
  --out outputs/dpo/dpo-dev.json

# 4. Holdout — once, with the frozen hash, after dev has settled.
node scripts/automationbench-v2-zeroshot.mjs --model nemotron-3-nano-dpo \
  --base-url http://localhost:8099/v1 --split holdout \
  --frozen-holdout 2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9 \
  --out outputs/dpo/dpo-holdout.json

# 5. Per-band base-vs-candidate table, including the over-action counts.
node scripts/automationbench-v2-band-report.mjs \
  --base outputs/dpo/base-dev.json --candidate outputs/dpo/dpo-dev.json \
  --out outputs/dpo/band-report-dev.json
```

Kill the shim when the runs finish. Tinker sampler weights expire on their own,
but nothing should be left holding them.

## Sampling budget is load-bearing

Both arms must run at the **same** `--max-tokens`, and it has to be large enough
for this base to finish reasoning before it emits. The same base weights on the
same dev split:

| `--max-tokens` | dev mean | malformed episodes |
| --- | --- | --- |
| 2048 | 0.842 | 8% |
| 512 | 0.581 | 81% |

Nothing about the policy changed between those rows — the 512 run simply gets
cut off mid-reasoning and the emission is rejected unparsed. A DPO arm scored
at 512 against a base scored at 2048 (or the reverse) measures the budget, not
the tuning.

## Where this fits in the orchestrator

This lane is a **verifier/contract plus a candidate-method**, not a controller.
It owns no queue, no poller, and no state of its own; every stage is a pure
function from artifact refs to a hashed artifact:

| Stage | Interface | Emits |
| --- | --- | --- |
| pairs gate | `validate(pairs_ref, manifest_ref) -> normalized_ref` | `understudy.dpo_pairs_validation.v1` |
| candidate-method | `submit(pairs_ref, base_model, hyperparams) -> checkpoint_ref` | `understudy.tinker_dpo.receipt.v1` |
| verifier | `score(checkpoint_ref, split, split_sha256) -> run_ref` | the run artifact |
| contract | `report(base_ref, candidate_ref) -> report_ref` | `understudy.automationbench_band_report.v1` |

Everything crossing a stage boundary is a ref plus a sha256 — never raw pairs,
prompts, or weights. The training receipt carries `pairs_sha256` and a
`tinker://` checkpoint ref for exactly this reason, so a durable run controller
can wrap `tinker-dpo-train.py` in a submit/inspect step keyed on
`(experimentId, candidateId, attempt)` and have a retry return the existing
Tinker run rather than pay for a second one.

## The regression this guards against

A tuned policy can raise its mean score while quietly learning to **over-act** —
writing records the request never addressed. `allowedWrites` is exactly the
addressed set, so any write outside it zeroes that episode; on a small dev split
that shows up as a rounding blip rather than a red flag. The band report
therefore prints `over_acting_episodes` and `forbidden_writes` as raw counts per
band alongside the score, and a candidate that adds forbidden writes is not a
win regardless of its mean.

If `TINKER_DISABLE_PYQWEST=1` is set, the Tinker client uses httpx's system trust
store instead of pyqwest's bundled root store — needed on hosts where pyqwest
rejects otherwise-valid certificates.
