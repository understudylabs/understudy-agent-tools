# Repair-target memo — synthetic workload WL-chat

Aggregates-only view of the `chat` workload on the gateway (project scoped;
no raw rows, prompts, completions, or tenant identifiers — telemetry used for
counts, tokens, USD, and distributions only). Window: 2026-06-26 → 2026-08-01
(36 active days).

## Volume and cost

| Metric | Value |
| --- | --- |
| Requests | 3,488 |
| Customer cost | $422.16 |
| Cost share of project | ~1.3% (project total ≈ $31.4K over the same window) |
| Cost per request | $0.121 |
| Uncached input tokens | 104.4M |
| Cache-read input tokens | 119.6M (cache-read share of provider-equivalent input: 0.49) |
| Cache-creation input tokens | 20.2M |
| Output tokens | 1.21M (reasoning tokens: 0) |
| Success rate | 3,470 / 3,488 (99.5%); errors: 16× HTTP 400, 2× HTTP 502 |
| Latency | p50 5.4s, p95 22.3s; 65% streaming |
| Inner tool calls | 0 (single-shot generation, no tool loop at the outer span) |

## Serving mix

| Provider / served model | Requests | USD | out p50 | out p95 | out max |
| --- | --- | --- | --- | --- | --- |
| anthropic / claude-sonnet-4-6 | 2,940 | 373.97 | 189 | 976 | 3,837 |
| anthropic / claude-sonnet-5 | 386 | 25.20 | 223 | 4,096 | 4,096 |
| open-weight route A (glm-5.2) | 90 | 11.73 | 200 | 956 | 2,218 |
| open-weight route B (glm-5p2) | 72 | 11.26 | 153 | 1,633 | 4,329 |

## Output-length bands (bounded vs variable)

| Band (output tokens) | Requests | % | USD | avg provider-equivalent input |
| --- | --- | --- | --- | --- |
| ≤64 | 199 | 5.7% | 17.69 | 54K |
| 65–256 | 1,969 | 56.5% | 223.87 | 66K |
| 257–1,024 | 1,136 | 32.6% | 148.80 | 74K |
| 1,025–2,048 | 131 | 3.8% | 22.25 | 80K |
| >2,048 | 53 | 1.5% | 9.55 | 139K |

94.8% of requests emit ≤1,024 output tokens; p50 = 192, p95 = 1,062. The
output side is **effectively bounded** — this workload does not exhibit the
variable-length tool-sequence failure mode that sank prompt-into-weights SFT
on the orchestrator-shaped workload. The dominant band (65–256 tokens, 56.5%
of traffic, 53% of cost) is the natural repair band.

## Task shape (from telemetry shape only)

Single-turn grounded generation: a very large, heavily cached context
(~54–80K provider-equivalent input tokens per request, cache-read share 0.49)
plus a short bounded natural-language answer. No tool loop, no reasoning
tokens. This is a retrieval-grounded assistant answer over a large synthetic
workspace context.

## Repair suitability judgment

- **Volume/repeatability**: 3.5K requests/36 days is modest but steady
  (~97/day) and the task shape is uniform (one shape, one dominant band).
- **Cost**: $422 over the window ($~4.3K/yr run-rate) — a mid-tail target;
  worth repairing as part of the per-workload sweep, not as the headline.
  The incumbent is a frontier model (sonnet-class) at $0.121/request; a tuned
  open-weight model serves the same shape at roughly an order of magnitude
  less per token.
- **Bounded output**: yes — 94.8% ≤1,024 tokens dodges the variable-length
  generation failure mode; outcome-first grading on grounded-fact coverage is
  well-defined.
- **Failing bands to watch**: the >1,024-token tail (5.3% of requests) rides
  the largest contexts (80–139K input) — long-context faithfulness is the
  candidate's likeliest weak band; grade it separately. The ≤64 band is
  short/refusal-style answers where fabrication (answering when the context
  does not support it) is the regression to guard.

**Verdict: suitable repair target.** Bounded output, uniform single-shot
shape, steady volume, frontier incumbent. Primary risk is grounding fidelity
(fabricated facts) rather than length control, so the synthetic slice grades
required-fact coverage with fabrication traps and an unanswerable band, and
the DPO regression guard counts fabricated-assertion episodes per band.
