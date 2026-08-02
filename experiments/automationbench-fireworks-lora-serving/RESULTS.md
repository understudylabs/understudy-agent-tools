# Fireworks LoRA serving results

Measured against the frozen synthetic `automationbench-simple-api-offline`
fixture. Every comparison uses the same runner and scoring harness.

## Gemma-26B-A4B tuned live-merge result

The adapter `ab-gemma4-26ba4b-oracle-sft-r16-e3` is servable via live merge.
It served real completions on a temporary 4xB200 deployment using the
`accounts/fireworks/deploymentShapes/rft-gemma-4-26b-a4b-it` shape, with
`enable_addons: false`. We did not create that deployment.

| Split | n | Tuned score | Protocol | Transport errors |
|---|---:|---:|---|---:|
| Dev | 12 | **0.1667** | `json-text`, `max_tokens=2000`, temperature 0 | 0 |

All 12 dev tasks received model responses. The adapter emitted clean fenced
JSON, for example:

````text
```json
{"tool":"api_search","arguments":{"query":"Evelyn Boyd"}}
```
````

The parser extracted these calls correctly. There is no base Gemma-26B
counterpart, so `0.1667` is a standalone tuned result, not a delta. It must
not be compared with the Qwen3-8B results below: those use a different model
and the `native` protocol.

Gemma-26B train and holdout were **not captured**. The owner deleted the
temporary deployment during the attempts; every request returned
`Model not found, inaccessible, and/or not deployed`. Those are transport
failures, not zero scores. The invalid artifacts were removed. Critically,
the sealed holdout remains **unused for Gemma-26B**: zero model outputs were
obtained, so no holdout information was consumed.

## Model pair

| Arm | Model |
|---|---|
| Base | `accounts/fireworks/models/qwen3-8b` |
| Tuned | `accounts/understudy-dev/models/qwen3-8b-abo-simpleapi-sft-r16e3` |

The tuned adapter is dense LoRA rank 16, 3 epochs (`r16e3`).

## Scores

| Split | n | Base | Tuned | Delta (tuned - base) |
|---|---:|---:|---:|---:|
| Train | 48 | 0.5625 | 0.4583 | **-0.1042** |
| Dev | 12 | 0.4583 | 0.5833 | **+0.1250** |
| Holdout | 12 | 0.3333 | 0.5000 | **+0.1667** |

The tuned arm regressed on train. Dev and holdout deltas are directional, not
statistically significant: each has only 12 tasks. Holdout was run exactly
once per model, so this is evidence of the observed result, not a repeated
sampling estimate.

## Provenance

Both holdout artifacts record the exact frozen holdout hash:

```text
a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

Both artifacts also record the same harness hash:

```text
0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
```

| Artifact | Split | Rows | Split SHA-256 | Harness SHA-256 |
|---|---|---:|---|---|
| `outputs/base-q38b-train.json` | train | 48 | `783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `outputs/tuned-q38b-train.json` | train | 48 | `783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `outputs/base-q38b-dev.json` | dev | 12 | `5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `outputs/tuned-q38b-dev.json` | dev | 12 | `5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `outputs/base-q38b-holdout.json` | holdout | 12 | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| `outputs/tuned-q38b-holdout.json` | holdout | 12 | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |

Each JSON artifact has a matching `.transcripts.jsonl` file. Holdout was not
rerun during this write-up.

## Root cause and capability finding

Fireworks supports only a fixed LoRA target-module allowlist for runtime
multi-LoRA. The Nemotron adapter is dead: the base reports
`supportsLora=False` and `tunable=False`, the addon reports
`supportsLora=False`, and our addon, live-merge, and grouped-RFT attempts were
rejected. The Gemma-26B-A4B adapter contains `experts`/`base_layer`, so
multi-LoRA inference 404s even after control-plane `DEPLOYED`; live merge
served real completions. Our inference is that live merge bakes the adapter
into the weights ahead of time, making the runtime allowlist irrelevant. This
explains the evidence but is not documented by Fireworks.

The Gemma-26B-A4B live-merge path requires the 4xB200 RFT shape
`accounts/fireworks/deploymentShapes/rft-gemma-4-26b-a4b-it` at approximately
$60/hour. We did not create one. The dense Gemma-31B adapter is supported in
principle but could not be scheduled because the account had only two H200 and
three B200 GPUs free while the required shape requested four H200:

```text
global--h200-count for account understudy-dev, in use: 14, quota: 16, requesting: 4
```

The Qwen3-8B adapter uses supported dense projection modules and was therefore
the measured base/tuned pair. Its results show a train regression alongside
directional dev/holdout improvements; no broad superiority claim is warranted
from n=12 dev/holdout.

## Cost and receipts

Approximate dedicated deployment cost:

```text
1xH200: approximately $7/hour
Measured deployment time: approximately 1.9 H200-hours
Approximate total: $13
```

Deployments and approximate lifetimes:

```text
abo-g26-h200-tuned       22:20–23:09
abo-g26-bf16-lora        23:09–23:27
abo-q38b-dense-lora      failed, approximately 6 minutes
abo-q38b-dense-lora2     failed, approximately 6 minutes
abo-q38b-livemerge       23:43–00:04
abo-q38b-base            23:53–00:04
```

All six deployments created by this experiment are confirmed `State: DELETED`.
No 4xB200 deployment was created by this experiment. Total spend on created
deployments was approximately 1.9 H200-hours, or approximately $13.

Separately, probing a pre-existing unrelated 4xH200 deployment with
`min-replica-count 0` triggered an unintended scale-up. It auto-scales back to
zero after the one-hour idle window; worst-case account exposure is
approximately $28. This deployment was not created by this experiment and
could not be deleted.

For the record only: Fireworks is offering a serverless training private
preview with $500 credits, Qwen 3.5 9B and Qwen 3.6 27B launch models (LoRA up
to 65K context), and MiniMax M3 is now trainable. No action was taken on that
offer.
