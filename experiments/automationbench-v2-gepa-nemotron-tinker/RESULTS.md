# GEPA prompt optimization results (Nemotron on Tinker)

Prompt-only optimization of `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` on the
synthetic `automationbench-simple-api-offline-v2` fixture. No weights changed.
Both arms use the same model, harness, token budget, temperature, and scoring.
The only difference is the system prompt.

Candidate `c4`, `d3ec6e2b4f34097b99e114a940017cbb096efe612de49d174f301c1eaac728b8`,
frozen before the holdout was read.

## Headline

| Split | n | Base | GEPA | Delta | Paired 95% CI |
|---|---:|---:|---:|---:|---|
| Train subset (selection) | 36 | 0.4931 | 0.8519 | +0.3588 | — |
| Dev | 36 | 0.5929 | 0.8750 | +0.2821 | [0.1200, 0.4487] |
| **Holdout (sealed)** | 60 | 0.6698 | **0.9083** | **+0.2385** | [0.1282, 0.3484] |

The arm intervals do not overlap on either split and the paired delta interval
excludes zero, so this is a win rather than an optimization lead. The null floor
— a policy that finishes immediately — scores 0.0000, so the comparison is not
being carried by tasks that are already satisfied at reset.

## Per band, holdout

| Band | Base | GEPA | Delta |
|---|---:|---:|---:|
| multi-write | 0.5417 | 1.0000 | +0.4583 |
| long-chain | 0.4405 | 0.8750 | +0.4345 |
| cascade | 0.5625 | 0.9375 | +0.3750 |
| multi-hop | 0.6250 | 1.0000 | +0.3750 |
| discovery | 0.7500 | 1.0000 | +0.2500 |
| single-write | 0.7500 | 1.0000 | +0.2500 |
| conditional | 0.8125 | 0.8750 | +0.0625 |
| cross-record | 0.7917 | 0.8333 | +0.0417 |
| aggregation | 0.7500 | 0.7500 | 0.0000 |

The gain is concentrated exactly where the base model was weakest. Long-chain
went 0.107 → 0.750 on dev and 0.441 → 0.875 on holdout; multi-hop went 0.250 →
1.000 on dev and 0.625 → 1.000 on holdout. Bands the base model already handled
moved little, and aggregation did not move at all — on dev it *regressed*,
1.0000 → 0.7500, on four tasks. With n=4 per split that is one task flipping,
not a trend, but it is the one band where the evolved prompt is not an
improvement.

## Per band, dev

| Band | Base | GEPA | Delta |
|---|---:|---:|---:|
| multi-hop | 0.2500 | 1.0000 | +0.7500 |
| long-chain | 0.1071 | 0.7500 | +0.6429 |
| cascade | 0.4375 | 0.7500 | +0.3125 |
| conditional | 0.5000 | 0.7500 | +0.2500 |
| cross-record | 0.5833 | 0.8333 | +0.2500 |
| single-write | 0.7500 | 1.0000 | +0.2500 |
| multi-write | 0.9167 | 1.0000 | +0.0833 |
| discovery | 1.0000 | 1.0000 | 0.0000 |
| aggregation | 1.0000 | 0.7500 | −0.2500 |

## Secondary metrics

| Metric | Dev base | Dev GEPA | Holdout base | Holdout GEPA |
|---|---:|---:|---:|---:|
| exact-1 rate | 0.5278 | 0.8333 | 0.5500 | 0.8500 |
| zero rate | 0.3333 | 0.0833 | 0.2000 | 0.0500 |
| forbidden-effect rate | 0.0278 | 0.0000 | 0.0000 | 0.0167 |
| malformed rate | 0.9167 | 0.7500 | 0.8833 | 0.9000 |
| mean steps/rollout | 4.67 | 4.44 | 4.95 | 4.97 |
| completion tokens/rollout | 2787 | 2036 | 2891 | 2341 |

Two things worth reading carefully:

**The malformed rate barely moved.** The evolved prompt spends four separate
paragraphs demanding raw JSON and no prose, and on holdout the malformed rate
still went *up* slightly, 0.883 → 0.900. Nearly every episode still emits at
least one unparseable reply. What changed is that the model recovers from them:
completion tokens per rollout fell ~20% and the zero rate collapsed, so the
prompt is buying better recovery and better targeting, not cleaner formatting.
The three-strike malformed tolerance is doing real work in both arms, and a
harness with zero tolerance would report much lower absolute numbers for both.

**One new forbidden write appeared on holdout.** Base wrote out of bounds zero
times on holdout; the evolved arm did once (0.0167), zeroing that episode. The
evolved prompt makes the model more willing to act, and that cuts both ways.

## What the evolved prompt actually learned

Diffing it against the seed, the accepted mutations are:

1. Much heavier anti-prose framing — repeated, in three places.
2. An explicit read-before-write workflow with a "don't invent filter params"
   rule (the base model kept issuing `?name=...` queries the API ignores).
3. Concrete multi-step recipes for the fixture's API surface: draft-then-send
   for mail, the PATCH shapes for contact status / merge / draft discard, and
   how to resolve a sent message back to a CRM contact.

Item 3 is the honest caveat of this whole result. Those recipes are
*discoverable* — every one of them can be learned from read-only `api_search`
and `GET` calls, and the hygiene guard rejected any candidate containing an
observed record id, task id, or email — so no grader-side information reached
the prompt. But they are still specific to this fixture's API surface. The
holdout gain shows the prompt transfers across unseen *tasks* on the same
synthetic API; it says nothing about transfer to a different workload. Read
this as "the cheap rung recovers most of the gap on this workload", not as a
general-purpose agent prompt.

## Search receipts

16 iterations, 162 episodes, 16 reflection calls, 3 accepted candidates.

| Iteration | Parent mean | Child mean | Outcome |
|---:|---:|---:|---|
| 0–8 | 0.454–0.565 | — | all rejected: 4× no single `text` fence, 5× hygiene guard (observed record id) |
| 9 | 0.4537 | 0.7685 | accepted → c1 |
| 10 | 0.5000 | 0.7222 | accepted → c2 |
| 11–12 | 0.454–0.565 | — | rejected (guard, fence) |
| 13 | 0.7685 | 0.7222 | rejected: no minibatch improvement |
| 14 | 0.6852 | 0.9444 | accepted → c4 (selected) |
| 15 | 0.8519 | 0.5741 | rejected: no minibatch improvement |

Candidate train-subset means: c0 0.4931, c1 0.7894, c2 0.7083, **c4 0.8519**.

The first nine iterations produced nothing usable. Six of sixteen reflection
calls were wasted on responses the extractor or the hygiene guard threw away —
a real cost of running the guard strictly, and the reason the loop needs the
rejection reason in its receipts rather than just an acceptance count.

## Cost and usage

| Arm | Episodes | Prompt tokens | Completion tokens | Wall clock |
|---|---:|---:|---:|---:|
| Base dev | 36 | 463,379 | 100,330 | 565 s |
| GEPA search (train) | 162 | 2,434,461 | 415,436 | not recorded |
| GEPA dev | 36 | 438,242 | 73,286 | 588 s |
| Base holdout | 60 | 875,825 | 173,462 | 793 s |
| GEPA holdout | 60 | 973,241 | 140,468 | 669 s |
| **Total** | **354** | **2,750,687** | **487,546** | 2,615 s measured |

**No dollar figure is reported, deliberately.** The Tinker billing endpoint
(`GET /api/v1/billing/usage/events`) returns account-window usage with no
amounts, and the shim does not tag requests with a per-run identifier, so
nothing here can be attributed exclusively to this experiment. The terminal
result artifact records `evidence_scope: "unknown"` and
`request_isolation_proven: false` for that reason. Reconstructing spend needs a
per-run tag on the sampling requests; that is the fix, not a guessed price.

Reflection spend is 16 Claude calls; the client did not persist the returned
token usage, which is a gap in our receipts.

## Artifacts

| Path | Contents |
|---|---|
| `evolved-prompt.txt` | the selected prompt, verbatim |
| `outputs/gepa-run/candidate.json` | frozen candidate: hashes, parent chain, config, train ids |
| `outputs/gepa-run/experiment-result.json` | `understudy.experiment-result.v1` terminal contract |
| `outputs/gepa-run/candidate-submit.json` | `understudy.executor-submit.v1` payload for this candidate |
| `outputs/gepa-run/report-dev/`, `report-holdout/` | eval rows, comparison JSON, comparison markdown |
| `outputs/gepa-run/optimize/` | iteration receipts, episode transcripts, candidate pool |
| `outputs/gepa-run/cleanup.json` | shim teardown evidence and usage receipts |

## Claim boundary

Synthetic fixture only. Prompt-only change, no weights touched, no deployment
created. The holdout was read exactly once per arm after the candidate was
frozen and was never used for selection. The result supports "GEPA prompt
optimization recovers a large, statistically clear share of this model's gap on
this synthetic workload" and does not support any claim about customer
workloads, model replacement, or transfer to a different API surface.
