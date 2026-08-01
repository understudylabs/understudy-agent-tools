# AutomationBench zero-shot baselines

This experiment measures zero-shot (no training) baselines for open-weight
models on the 72-task offline AutomationBench fixture in
[`src/automationbench-offline.ts`](../../src/automationbench-offline.ts).
The authoritative offline evaluator scores terminal final state with
`partialCredit`, including terminal reward and forbidden-write zeroing.

The evaluated pool is train (48) plus dev (12). The 12-task holdout is sealed:
it was never read, and the runner refuses `--split holdout` by construction.
These results are a benchmark baseline, not a production replacement claim.

## Frozen integrity

All final artifacts bind to the same fixture and split hashes:

```text
fixture_sha256: 0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train split_sha256: 783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev split_sha256:   5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
```

The runner imports the evaluator directly from `dist`, calls
`reset`/`step`/`finish`, and never passes a frozen holdout hash.

## Integrity gates

Before model calls, the runner exercised both a single-write and a multi-write
family. The oracle had to score `1.0`; the reward-hacking sentinel had to score
`0.0`:

```text
[
  {
    "task": "simple-api-crm-close-01",
    "policy": "oracle",
    "reward": 1,
    "steps": 3,
    "forbidden_effects": []
  },
  {
    "task": "simple-api-crm-close-01",
    "policy": "sentinel",
    "reward": 0,
    "steps": 4,
    "forbidden_effects": [
      "crm.contacts.c-0"
    ]
  },
  {
    "task": "simple-api-crm-bulk-owner-01",
    "policy": "oracle",
    "reward": 1,
    "steps": 3,
    "forbidden_effects": []
  },
  {
    "task": "simple-api-crm-bulk-owner-01",
    "policy": "sentinel",
    "reward": 0,
    "steps": 4,
    "forbidden_effects": [
      "crm.contacts.c-0"
    ]
  }
]
```

## Methodology

All five final leaderboard rows use the same run contract:

```text
--mode json
--temperature 0
--max-tokens 4096
--max-turns 12
concurrency: 8
```

Each episode also obeys the environment's own 12-step cap. Every model was
run against one dedicated deployment, with the same synthetic task pool,
prompt, parser, evaluator, and train/dev split. The five rows are therefore
directly comparable. No holdout task was read or scored.

The JSON protocol permits reasoning text but requires the response to end with
one tool object per turn. Native tool calls were not used for the leaderboard
because they were not available uniformly across the deployments.

## Serving-path findings

Every requested model ID 404ed when addressed as a Fireworks serverless model:

```text
Model not found, inaccessible, and/or not deployed
```

The base models were served through dedicated deployments in the
`accounts/understudy-dev` account, addressed as:

```text
<base-model>#accounts/understudy-dev/deployments/<deployment-id>
```

Native vLLM tool calling was not available on most deployments. Deployments
without it returned HTTP 400:

```text
"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

Native tool calling worked on the pre-existing `gemma-4-31b-it` deployment
`vr590ywn`, but returned HTTP 400 on the `gemma-4-26b-a4b-it` deployment.
Consequently, the final leaderboard uses the one format that worked
everywhere: `--mode json`, a single JSON tool object per turn.

This protocol imposes a substantial malformed-call rate on every model. A
native-tool-calling run would likely score higher across the board; these
scores should not be interpreted as each model's capability ceiling.

## Ranked results

Scores are means over each split. `overall` is the mean over all 60 evaluated
tasks. Exact and zero rates are overall. Band values are overall means for
single-write, discovery, and multi-write respectively. Token counts are
provider-reported totals from the train+dev run.

| Model | Train | Dev | Overall | Exact 1.0 | Zero | Mean turns | Malformed | Malformed rate | Truncated tasks | Prompt tokens | Completion tokens | By band |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `accounts/fireworks/models/gemma-4-31b-it` | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 | 7.183 | 179 | 0.415 | 0 | 257,401 | 110,715 | 1.000 / 1.000 / 1.000 |
| `accounts/fireworks/models/nemotron-3-ultra-nvfp4` | 0.979 | 1.000 | 0.983 | 0.983 | 0.017 | 8.200 | 202 | 0.411 | 0 | 361,487 | 120,378 | 1.000 / 1.000 / 0.950 |
| `accounts/fireworks/models/gemma-4-26b-a4b-it` | 0.708 | 0.750 | 0.717 | 0.717 | 0.283 | 8.583 | 179 | 0.348 | 14 | 1,302,902 | 326,869 | 0.700 / 0.800 / 0.650 |
| `accounts/fireworks/models/nemotron-nano-3-30b-a3b` | 0.583 | 0.708 | 0.608 | 0.583 | 0.367 | 9.583 | 171 | 0.297 | 1 | 2,124,188 | 413,365 | 0.700 / 0.500 / 0.625 |
| `accounts/fireworks/models/qwen3-8b` | 0.240 | 0.083 | 0.208 | 0.200 | 0.783 | 9.900 | 127 | 0.214 | 27 | 1,500,922 | 821,386 | 0.200 / 0.300 / 0.125 |

Band columns are ordered: `single-write / discovery / multi-write`.

Deployment IDs and complete per-task scores are preserved in the raw JSON
artifacts under [`results/`](results/). The adjacent `*.json.rows.jsonl`
files are the `understudy.eval_result.v1` row projections.

## `max_tokens` sensitivity

The old `gemma-4-31b-it.maxtok1536.json` artifact is preserved as a control.
Increasing the cap from 1536 to 4096 did not behave monotonically:

| Model | Overall at 1536 | Overall at 4096 | Truncated tasks at 1536 | Truncated tasks at 4096 |
|---|---:|---:|---:|---:|
| `gemma-4-31b-it` | 1.000 | 1.000 | 0 | 0 |
| `nemotron-nano-3-30b-a3b` | 0.547 | 0.608 | 9 | 1 |
| `gemma-4-26b-a4b-it` | 0.825 | 0.717 | 8 | 14 |
| `qwen3-8b` | 0.175 | 0.208 | 17 | 27 |

Gemma 4 31B was unaffected because it never truncated at either cap. The
smaller Nemotron improved, but Gemma 4 26B got worse and its truncation count
increased; Qwen's truncation count also increased. For the weaker models,
truncation is a symptom of runaway reasoning verbosity rather than simply a
cap set too low. More output budget let those models talk themselves out of
the correct final state. This is not a monotonic max-token win.

## Cost and serving lifecycle

Fireworks on-demand pricing for the relevant GPU classes is:

```text
H100-80GB:  $7/GPU-hour
H200-141GB: $7/GPU-hour
B200-180GB: $10/GPU-hour
```

Every dedicated deployment created for this run was deleted afterward,
including the `abo-zs-*` and `abo-zs2-*` deployments. `vr590ywn` was a
pre-existing deployment owned by another workstream; it was reused and left
in place. It self-scales to zero.

The account's H100/H200 quota ceiling was 16/16 in use, which serialized part
of the sweep. Nemotron Super and Llama-3.x-8B were not present on this account,
so `nemotron-3-ultra-nvfp4` (serverless) served as the reference anchor
instead.

## Caveats

- This is zero-shot inference only; no training, fine-tuning, or prompt
  optimization was performed.
- The malformed rate is primarily a property of the single-JSON-object text
  protocol, not of the offline fixture.
- Truncated-task counts are an output-length confound, and the final table
  should be interpreted together with the sensitivity section rather than as
  evidence that a larger output cap is inherently better.
- The fixture is synthetic and offline. These results measure final-state
  behavior in this environment, not production API reliability or deployment
  economics.

## Artifacts

The `results/` directory contains the final JSON artifacts, their
`understudy.eval_result.v1` JSONL sidecars, and the preserved 1536-token
Gemma control:

```text
results/
  gemma-4-26b-a4b-it.json
  gemma-4-26b-a4b-it.json.rows.jsonl
  gemma-4-31b-it.json
  gemma-4-31b-it.json.rows.jsonl
  gemma-4-31b-it.maxtok1536.json
  nemotron-3-ultra-nvfp4.json
  nemotron-3-ultra-nvfp4.json.rows.jsonl
  nemotron-nano-3-30b-a3b.json
  nemotron-nano-3-30b-a3b.json.rows.jsonl
  qwen3-8b.json
  qwen3-8b.json.rows.jsonl
```
