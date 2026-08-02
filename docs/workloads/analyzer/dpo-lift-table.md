# Analyzer dev DPO lift table

This is a dev-only result. The dev split has 18 tasks total, with 6 tasks per
band. A mean change over 18 tasks is two or three tasks changing answer: it is
directionally encouraging, but it is not a significant result. The per-band
changes below are anecdotes at `n=6` per band, not stable estimates.

## Dev lift

| Band | Side | n | Mean | Exact-1 | Zero | Over-claim | Hallucinated citation | Invalid output | Strict-format rate | Request errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Overall | Base | 18 | 0.4583333333333333 | 4 | 7 | 6 | 0 | 1 | 1 | 0 |
| Overall | DPO | 18 | 0.5833333333333334 | 6 | 5 | 5 | 0 | 0 | 0.9444444444444444 | 0 |
| conflicting-signals | Base | 6 | 0.3333333333333333 | 0 | 3 | 3 | 0 | 0 | 1 | 0 |
| conflicting-signals | DPO | 6 | 0.4583333333333333 | 0 | 2 | 2 | 0 | 0 | 1 | 0 |
| insufficient-evidence | Base | 6 | 0.625 | 3 | 2 | 1 | 0 | 1 | 1 | 0 |
| insufficient-evidence | DPO | 6 | 0.7916666666666666 | 4 | 1 | 1 | 0 | 0 | 1 | 0 |
| single-signal | Base | 6 | 0.4166666666666667 | 1 | 2 | 2 | 0 | 0 | 1 | 0 |
| single-signal | DPO | 6 | 0.5 | 2 | 2 | 2 | 0 | 0 | 0.8333333333333334 | 0 |

Overall delta:

```text
mean:                +0.12500000000000006
exact-1 count:       +2
zero count:          -2
over-claim episodes: -1
hallucinated cites:  0
invalid outputs:     -1
strict-format rate:  -0.05555555555555558
request errors:      0
```

The format regression is a real cost, not a footnote: strict-format
compliance fell from `1` to `0.9444444444444444` overall and to
`0.8333333333333334` in the single-signal band. A likely mechanism is the
pair mix: `43 / 63` mined rejections were over-claim rejections, so the
preference signal was weighted toward citation discipline rather than output
form.

The band report is
[`dpo-band-report-dev.json`](dpo-band-report-dev.json).

## Pair-mining provenance

The train rollout artifact had 54 tasks and 6 samples per task. Only 24/54
tasks produced at least one exact-1 rollout, below the approximately half-split
threshold. The exact-1-only miner was therefore not sufficient. Mining used
the explicit `--allow-relative-gap` deviation: for tasks without a passing
rollout, chosen was strictly higher-scoring than rejected by a minimum gap of
`0.5`.

```text
raw pair count:                 63
validated pair count:           63
relative-gap fallback pairs:    30
fallback used:                  true
minimum relative gap:          0.5
```

Raw rejection mix:

```text
near_hit_0.75:          18
over_claim:             43
near_hit_0.5:            2
near_hit_0.25:           7
invalid_output:          4
hallucinated_citation:   3
```

Raw band mix:

```text
insufficient-evidence: 32
single-signal:         27
conflicting-signals:   18
```

The normalized pair validation verdict was `pass`, with zero rejected rows.
The pair manifest and validation report are
[`dpo-pairs-manifest.json`](dpo-pairs-manifest.json) and
[`dpo-pairs-validation.json`](dpo-pairs-validation.json). The normalized
pair-set SHA-256 used by training is:

```text
32eaa7795fb1af6204494c42d581dcf920ed0f93dc076cacc70a2ab0863d9f03
```

## Training receipt and budget reconciliation

```text
backend:       tinker
base model:    nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
renderer:      nemotron3
pairs:         63
lora rank:     32
dpo beta:      0.1
learning rate: 0.00001
epochs:        3
batch size:    8
max length:    8192
max steps:     null
wall clock:    241.0 s
```

Tinker returned no cost field. Actual spend is therefore unreconciled; no
dollar figure is estimated here. The available usage evidence is 21 training
steps and 523082 metric tokens. The receipt is
[`dpo-train-receipt.json`](dpo-train-receipt.json); its checkpoint URI is
redacted in the committed evidence because the service job identifier is not
needed to reproduce the contract evidence.

## Holdout

The holdout was clean and **not executed by directive**. Its frozen hash is
`ee29b364f28f35a1f74f8b0f3e162360a07d9e250723f7b0ed76e288b87077c2`; no
holdout run or holdout band report is part of this result.

## Orchestration mapping

This arm is a verifier/contract plus a candidate-method, not a controller. The
artifact contract is the hash-pinned synthetic fixture and the
`understudy.executor-submit.v1` payload. The executor payload is emitted by
`analyzer-executor-submit.mjs` and validated against the upstream schema at
source commit `c299ca4`; the candidate executor is currently the schema's
`fixture` placeholder because the closed enum has no `tinker` member.

The known orchestration gap is that the Tinker training call is a blocking
in-process invocation. It returns no job reference or idempotency key, so
retry-safety and usage reconciliation are not yet satisfied. This dev result
must not be presented as a production-ready training orchestration path.
