# Synthetic workload WL-chat — grounded-answer DPO lane

This lane evaluates a single-shot grounded assistant answer over a synthetic
workspace. It has no tool loop. The scorer rewards required-fact coverage,
zeroes any answer that asserts a forbidden distractor, and includes an
unanswerable/refusal band.

## Pins

| Pin | Value |
| --- | --- |
| fixture | `grounded-chat-offline-v1` |
| rubric version | `1.1` |
| tasks | 100 |
| splits | train 60 / dev 20 / holdout 20 |
| fixture SHA-256 | `e0953bd8487e0665729921ecb71ec3eb106016c21243bc4b8d64cb5d4c62c12e` |
| train SHA-256 | `3560630887f4d432cd460422cca83e2c3251c37d3b3cfddef343f503d655bd0f` |
| dev SHA-256 | `1c670bb1fe990552f5b2ba21144b5fbf49db6bbbd27e4e20074e92b7959f77c0` |
| holdout SHA-256 | `b1a7f5a49f7d90a0cca13a4ec5357fc1cc3eed839299453317ad192663a02850` |
| splits SHA-256 | `1ba08287e0d93446bc72c6f0f4858ac672854ffd1249ee8bafa779819b1390f7` |
| base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| renderer | `nemotron3` |

All records, names, domains, and workspace content are invented test data.

## Gates and reproduction

Run the fixture gates before any model call:

```sh
npm run build
node scripts/grounded-chat-freeze.mjs
node --test tests/grounded-chat-offline.test.mjs
```

The freeze gate checks:

- scripted oracle score `1.0` on every task;
- null/empty answer score `0.0`;
- required-fact reachability and question leakage;
- unanswerable information absent from context;
- deterministic reset;
- disjoint split IDs;
- fail-closed holdout loading;
- pinned fixture and split hashes.

Run a model against the dev split:

```sh
node scripts/grounded-chat-zeroshot.mjs \
  --model <model> \
  --base-url <openai-compatible-url> \
  --split dev \
  --temperature 0 \
  --samples-per-task 1 \
  --out outputs/wl-chat/<model>-dev.json
```

Holdout is read only at the end of an arm and requires the exact frozen hash:

```sh
node scripts/grounded-chat-zeroshot.mjs \
  --model <model> \
  --base-url <openai-compatible-url> \
  --split holdout \
  --temperature 0 \
  --samples-per-task 1 \
  --frozen-holdout b1a7f5a49f7d90a0cca13a4ec5357fc1cc3eed839299453317ad192663a02850 \
  --out outputs/wl-chat/<model>-holdout.json
```

Compare a base and candidate run:

```sh
node scripts/grounded-chat-band-report.mjs \
  --base outputs/wl-chat/base-dev.json \
  --candidate outputs/wl-chat/candidate-dev.json \
  --out outputs/wl-chat/band-report-dev.json
```

The regression guard is **fabrication episode count per band**, reported beside
mean score, pass rate, and over-budget episode count. A candidate must not trade
grounding safety for fact recall.

This v1.1 rubric-validity fix keeps the same fixture id but rescored the stored
answers offline so the base holdout evidence is compared on the corrected rubric
without resampling.

## DPO input validation

Validate pairs against this fixture's train split before training:

```sh
node scripts/dpo-pairs-validate.mjs \
  --fixture grounded-chat-offline-v1 \
  --pairs <dpo_pairs.jsonl> \
  --manifest <manifest.json> \
  --out outputs/wl-chat/dpo-pairs.normalized.jsonl \
  --report outputs/wl-chat/dpo-pairs.validation.json
```

The validator requires byte-exact pair-file hashing, a synthetic source,
train-only task IDs, a matching train split hash, and a real chosen/rejected
preference signal. It refuses dev/holdout IDs and private-looking identifiers.

The training and local serving commands follow the existing Nemotron lane:

```sh
TINKER_API_KEY=… python scripts/tinker-dpo-train.py \
  --pairs outputs/wl-chat/dpo-pairs.normalized.jsonl \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 \
  --lora-rank 32 \
  --beta 0.1 \
  --epochs 3 \
  --out outputs/wl-chat/train-receipt.json

TINKER_API_KEY=… python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --renderer nemotron3 \
  --model-path "$(jq -r .checkpoint outputs/wl-chat/train-receipt.json)" \
  --port 8099
```

## Scope limitation

The synthetic contexts are scaled down to roughly 1–3K tokens, versus roughly
66K provider-equivalent production context. Long-context fidelity is out of
scope for this slice and is explicitly untested. The fixture is
template-generated with bounded entity pools, so it measures format and
grounding discipline rather than knowledge breadth; long-context fidelity
remains untested. It tests grounded fact selection, fabrication resistance,
bounded output, and refusal behavior.
