# Repair-target memo — workload `on-event-meeting-orchestrator`

Aggregates only. Every number below is a count, a token sum, a dollar sum, or a
distribution computed over gateway outer spans; **no raw prompts, completions,
traces, or tenant identifiers were read into or written from this analysis**.
The benchmark work this memo justifies runs on sanitized synthetic fixtures only.

- Window: `2026-06-03` → `2026-08-02` (60 days)
- Scope: gateway outer spans for this workload in one pilot project
- Source: telemetry aggregates; raw rows are never committed

## 1. Volume, spend, and share

| metric | value |
|---|---|
| requests | 8,447 |
| share of project requests | 0.92 % |
| customer cost | $473.57 |
| upstream cost | $472.43 |
| share of project spend | 1.51 % |
| cost per request | $0.0561 |
| cost per 1K output tokens | $0.1422 |
| streaming requests | 0 % |

Token totals (provider-equivalent):

| token class | tokens |
|---|---:|
| uncached input | 54,571,736 |
| cache-read input | 186,867,589 |
| cache-creation input | 64,878,607 |
| **input total** | **306,317,932** |
| output (incl. reasoning) | 3,331,010 |
| reasoning output | 0 |

Cache-read share of input is **61.0 %** — a large, stable system/tool prefix is
already being amortised by prompt caching. Distinct `payload_hash` is 8,447 /
8,447 (100 %), so there is no exact-duplicate request to dedupe; the repeatability
here is *task-shape* repeatability, not payload repeatability.

## 2. Served models

| provider | served model | requests | out p50 | out p95 | out p99 | out max | in p50 | in p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | claude-sonnet-4-6 | 6,187 | 327 | 904 | 1,197 | 1,852 | 32,791 | 59,148 |
| anthropic | claude-sonnet-5 | 2,230 | 305 | 1,203 | 2,141 | 4,096 | 37,420 | 68,306 |
| fireworks | glm-5p2 | 19 | 452 | 4,639 | 4,639 | 4,639 | 28,009 | 71,857 |
| lilac | glm-5.2 | 11 | 373 | 3,519 | 3,519 | 3,519 | 28,308 | 33,338 |

The workload is ~99.6 % frontier Anthropic traffic. The handful of open-weight
requests are experiments, not production share.

## 3. Output-length bands

| band | requests | % req | customer $ | % $ | output tokens |
|---|---:|---:|---:|---:|---:|
| A · ≤256 | 2,665 | 31.5 % | 106.64 | 22.5 % | 379,934 |
| B · 257–512 | 3,899 | 46.2 % | 225.70 | 47.7 % | 1,384,846 |
| C · 513–1024 | 1,560 | 18.5 % | 114.14 | 24.1 % | 1,109,053 |
| D · 1025–2048 | 291 | 3.4 % | 23.41 | 4.9 % | 368,354 |
| E · >2048 | 32 | 0.4 % | 3.68 | 0.8 % | 88,823 |

**Bounded, not variable-length.** 96.2 % of requests finish under 1,024 output
tokens and 99.6 % under 2,048. This is the single most important suitability
signal: the documented failure mode for small-base structured generation is
*sequence-length control* (terminal-token repetition on variable-length tool-call
output), and a workload whose output distribution is this tight largely dodges it.
Band E is the only place where per-request cost runs away (2.9× band A), and it is
0.4 % of traffic — a tail to guard against, not the repair target.

## 4. Reliability

| outcome | status | origin | response source | requests |
|---|---|---|---|---:|
| success | 200 | — | upstream | 7,211 |
| success | 200 | — | (unset) | 923 |
| error | 529 | provider | gateway_synthetic | 196 |
| error | 400 | provider | upstream | 111 |
| error | 503 | provider | gateway_synthetic | 5 |
| error | 502 | provider | gateway_synthetic | 1 |

Error rate is 3.7 %, and 202 of the 313 errors are provider overload/unavailable
(529/503/502) rather than a request-quality problem. Errors are billed at $0.

## 5. Trend

| week of | requests | customer $ | mean ms | p95 ms |
|---|---:|---:|---:|---:|
| 2026-05-31 | 158 | 10.24 | 8,728 | 16,795 |
| 2026-06-07 | 445 | 26.70 | 9,910 | 17,509 |
| 2026-06-14 | 202 | 18.38 | 10,084 | 22,803 |
| 2026-06-21 | 179 | 17.51 | 10,276 | 21,272 |
| 2026-06-28 | 72 | 6.20 | 11,831 | 30,098 |
| 2026-07-05 | 467 | 45.96 | 10,500 | 23,989 |
| 2026-07-12 | 1,402 | 111.90 | 9,584 | 23,199 |
| 2026-07-19 | 2,498 | 126.48 | 9,211 | 20,705 |
| 2026-07-26 | 3,018 | 109.79 | 7,334 | 18,591 |
| 2026-08-02 (partial) | 6 | 0.41 | 7,491 | 16,448 |

Volume grew ~19× from the June floor to the last full week. At the trailing rate
(~3.0K requests and ~$110 per week) the annualised run-rate is ~157K requests and
~$5.7K — small in absolute dollars today, on a steep ramp.

## 6. Repair suitability

| criterion | reading | verdict |
|---|---|---|
| volume | 8.4K requests, ~3.0K/wk trailing and climbing | adequate and improving |
| cost | $473 over the window, 1.51 % of project spend | modest today, ramping |
| repeatability | one event-triggered task shape; 61 % cache-read prefix; latency band tight | high |
| output boundedness | p50 327, p95 ≈0.9–1.2K, 96 % ≤1024 | **strong — dodges the variable-length failure mode** |
| failure surface | 3.7 % errors, mostly provider overload | not a model-quality repair |

**Judgement: suitable repair target, on repeatability and boundedness rather than
on spend.** The economic case alone would not justify it at 1.5 % of project cost;
the *methodological* case does — this is the cleanest bounded-output, single-shape,
high-repeatability workload in the project, so it is where a small-base policy
repair can be measured honestly without the confound that sank prompt-into-weights
SFT on variable-length tool-call generation.

Explicitly **not** the play here: folding the ~33K-token prefix into weights.
Prompt caching already recovers 61 % of the input, and the documented negative
result for prompt-into-weights on a small base applies directly to this task shape.

### Bands to repair

1. **B (257–512 output)** — 46 % of requests and 48 % of spend. The modal decision
   path; any policy repair must hold here or nothing else matters.
2. **C (513–1024)** — 24 % of spend at 18 % of requests. Where the orchestrator
   starts doing multi-write work (reschedule / cancel-and-notify / summary chain).
3. **E (>2048)** — 0.4 % of requests but the worst unit economics, and the
   signature of an over-acting or looping policy. Treated as a *regression guard*,
   not a repair target: the candidate must not grow this band.

The synthetic benchmark slice built for this workload mirrors these bands with
task-shape bands (`single-write`, `discovery`, `conditional`, `multi-write`,
`long-chain`, `no-op-guard`), and the `no-op-guard` and duplicate-suppression
families exist specifically to make band-E-style over-acting score zero.
