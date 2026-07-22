# Benchmark & savings report — [partner] [partner] automation for [redacted-email]

Generated 2026-07-22T00:00:00.000Z from local benchmark artifacts only (no new runs, no network). Every number in this report is derived from persisted eval rows; the derivation is reproducible with `understudy benchmarks report`.

## Workload

Traces from [redacted-url] handled by [partner] Corp.

- Benchmark id: `pr-bench`
- Tasks: 5 (holdout: 4, train: 1)
- Provenance: derived-from-traces
- Pass threshold: 1
- Result scope: **sealed holdout rows only**

## Baselines and floors (read these first)

- **null_agent**: a do-nothing agent scores 0.0% (0/4 tasks) — results below are measured against that floor.
- **spam_agent**: never run — this trivial floor is unmeasured.
- **majority_class**: never run — this trivial floor is unmeasured.
- **Incumbent ceiling**: big-model (the model that produced the source traces) scores 100.0% [100.0–100.0%] on rerun.

## Headline results

Quality is the macro-average of per-task mean scores; the 95% CI is a seeded percentile bootstrap over per-task means (tasks are the resampling unit). **Cost per correct task** = total measured cost ÷ tasks passed at the threshold — the number to compare against what a correct task costs you today.

| Arm | Kind | Quality (mean) | 95% CI | Cost / correct task | Mean latency | Tasks (N) | Rows | Passed |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: |
| big-model (tie A) | incumbent | 100.0% | [100.0–100.0%] | $0.100 | 1000ms | 4 | 4 | 4 |
| small-model (tie A) | candidate | 75.0% | [25.0–100.0%] | $0.013 | 1000ms | 4 | 5 | 3 |
| null_agent | trivial | 0.0% | [0.0–0.0%] | n/a | 1000ms | 4 | 4 | 0 |
| zero-model | candidate | 0.0% | [0.0–0.0%] | n/a | 1000ms | 4 | 4 | 0 |

- null_agent: 0.0000 USD spent, zero tasks passed — cost-per-correct-task is undefined (division by zero), not zero
- zero-model: 0.0800 USD spent, zero tasks passed — cost-per-correct-task is undefined (division by zero), not zero

**No winner is claimed.** statistical tie at this N: big-model, small-model have overlapping 95% CIs — no winner is claimed.

## Projected savings

> **EXTRAPOLATED** — measured cost-per-correct-task × a stated monthly volume (1,000 tasks/month, from the --monthly-volume flag), not a measured bill delta.

| | Cost / correct task | × monthly volume |
| --- | ---: | ---: |
| Incumbent (big-model) | $0.100 | $100.00 |
| Candidate (small-model) | $0.013 | $13.33 |
| **Projected monthly savings** | | **$86.67** (86.7%) |

## Where the best candidate fails

Obligation kinds required by the tasks the best candidate fails (what kind of work is being missed):

- state_effect: 1 failing task(s)

## Rigor attestation

**3 PASS / 1 FLAG / 5 UNKNOWN across 9 rigor checks** (full detail in the benchmark's rigor-report.md).

- UNKNOWN: Oracle solver — not run
- PASS: Null-agent floor — 0.0% (0/5)
- UNKNOWN: Spam-agent floor — not run
- UNKNOWN: Incumbent calibration — not run
- FLAG: Rollout anomalies — 1 flags over 18 rows
- PASS: Split provenance — holdout: 4, train: 1
- PASS: Leakage / contamination audit — 0 verbatim / 0 fuzzy over 5 task(s)
- UNKNOWN: Guidance effectiveness — no journals
- UNKNOWN: Confidence intervals — not checked

## Holdout governance

Splits were frozen at benchmark build time (train/dev/holdout recorded per task in benchmark.json, hashed above). The 4-task holdout was never used for prompt evolution, model selection, or training — only for the final scores in this report.

- Holdout rows used for this report: 17
- benchmark.json sha256: `f67f2e27b5502e2cc877cb2a1fd777caca8ef8a4fd8a8fe98c5ae46dbf98503f`
- tasks.jsonl sha256: `5cf2e506970f4b938c46897da91a7dbc086022c3a5185e4c03774e868f9aeb96`

## Experiment lineage

- `exp-1` (concluded): small-model can replace big-model on [partner] [partner] → **shadow: tie on holdout**

## Limitations

- Small holdout: only 4 task(s) — confidence intervals are wide and single-task flips move the mean; treat differences as directional.
- 1 rollout row(s) carry structural anomaly flags and were excluded from every aggregate (marked, never dropped from counts).
- The spam_agent trivial floor was never run — the do-nothing/ritual baseline for this scope is unmeasured.
- The majority_class trivial floor was never run — the do-nothing/ritual baseline for this scope is unmeasured.
- Projected savings are an EXTRAPOLATION of measured cost-per-correct-task to a stated monthly volume — not a measured bill delta.
- statistical tie at this N: big-model, small-model have overlapping 95% CIs — no winner is claimed

---

Privacy: customer-identifying strings were scrubbed at generation time (5 name, 1 email, 1 URL, 0 domain replacement(s)). This report contains aggregate metrics and task/obligation identifiers only — no prompts, no completions, no traces.
