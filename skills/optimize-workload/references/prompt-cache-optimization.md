# Prompt-cache optimization — cut input cost without touching the model

Use this lens when an incumbent's bill is input-token-heavy (shared primer,
long system prompt, growing agentic context, per-row repeated instructions) or
when a harness's measured cost looks higher than the same workload in
production. Cache structure is usually the cheapest lever available — check it
**before** proposing a model swap, because a cache-blind comparison misprices
every candidate (see the caching-parity rule in
[`compare-model-sweep`](../../compare-model-sweep/SKILL.md)).

Mechanics, multipliers, and minimums below are from the Anthropic prompt-caching
and pricing docs, refreshed 2026-06-24. They are provider-specific —
re-verify before quoting, and treat other providers separately (OpenAI caches
long shared prefixes automatically with no markers; vLLM/SGLang do server-side
prefix caching for local serving; the same structure rules pay off on all of
them).

## Measure before changing anything

Pull the cache fields from real response usage:

- `cache_read_input_tokens` — served from cache (~0.1× base input price)
- `cache_creation_input_tokens` — written to cache (1.25× for 5-min TTL, 2× for 1-hour)
- `input_tokens` — the uncached remainder only (full price)

Total prompt = the sum of all three. Two checks:

1. **Hit rate**: `cache_read / (cache_read + cache_creation + input)` across a
   sample of real calls. A workload with a shared primer and near-zero reads
   has broken structure — that's the finding.
2. **Don't misread `input_tokens`**: if an agent ran for hours but
   `input_tokens` shows 4K, the rest was cached — check the sum, not one field.

## Structure rules

Caching is a **prefix match**: one changed byte invalidates everything after
it. Render order is `tools` → `system` → `messages`.

- **Stable content first.** Frozen system prompt and deterministic tool list
  before anything per-session; per-row/per-turn content last, after the final
  breakpoint. Never interpolate timestamps, UUIDs, user IDs, or mode flags
  into the system prompt — inject them later in `messages`.
- **Byte-stable means deterministic.** Sort JSON keys, fix tool ordering,
  don't shuffle few-shot examples per request.
- **Breakpoints** (`cache_control: {type: "ephemeral"}`): max 4 per request;
  place at stability boundaries (end of shared portion, not end of prompt).
  Top-level `cache_control` auto-places on the last cacheable block — fine for
  simple cases.
- **Minimum cacheable prefix is model-dependent**. First-party Anthropic docs
  currently list: Fable 5 / Mythos 5 at 512 tokens; Mythos Preview / Opus 4.7
  at 2,048; Opus 4.6 / Opus 4.5 / Haiku 4.5 at 4,096; and Opus 4.8, Sonnet
  4.6, Sonnet 4.5, Opus 4.1, Opus 4, and Sonnet 4 at 1,024. Shorter prefixes
  *silently* don't cache — no error, just `cache_creation_input_tokens: 0`.
- Tool-definition or model changes invalidate everything; `tool_choice`,
  thinking toggles, and images invalidate only the messages tier — the
  tools+system cache survives them.

## Diagnose misses instead of guessing

If the hit rate is low and the prefix "looks" stable, use **cache diagnostics**
(beta, Claude API only, header `cache-diagnosis-2026-04-07`): pass the previous
response's `id` as `diagnostics.previous_message_id` and the API reports the
first divergence as a `cache_miss_reason` — `model_changed`, `system_changed`,
`tools_changed`, or `messages_changed` (plus an estimate of how many input
tokens fell after the divergence). Read it together with usage:

| diagnostics | cache_read | Meaning |
|---|---|---|
| null | high | Working as intended |
| null | low/zero | Requests match but the entry expired — shorten gaps or use 1h TTL |
| `*_changed` | low/zero | Your bug — fix the named divergence |

Fix the earliest divergence first; later ones may be hidden behind it.

## Harness traps (where evals silently pay full price)

- **Concurrent fan-out all-misses.** A cache entry is readable only after the
  first response starts streaming. A sweep that fires 24 rows in parallel pays
  full price on all 24. Warm with one row, await the first streamed token,
  then fan out the rest.
- **Interleaving candidates busts the cache.** Caches are model-scoped. Run
  all rows for one candidate grouped together within the TTL, not round-robin
  across candidates.
- **Per-candidate prompt edits must stay out of the shared prefix** or the
  comparison loses both cache and parity.
- **LLM-judge and fork calls** (scoring, summarization, repair) must reuse the
  parent call's `system`/`tools`/model verbatim and append at the end —
  a rebuilt prefix misses the parent's cache entirely.
- **Long agentic turns**: a breakpoint only looks back 20 content blocks for a
  prior entry. Turns that add more than 20 blocks (many tool_use/tool_result
  pairs) need an intermediate breakpoint every ~15 blocks.

## TTL economics

- 5-min TTL: write 1.25×, read 0.1× — breaks even at two requests. Refreshes
  free on every hit, so steady traffic keeps itself warm.
- 1-hour TTL (`ttl: "1h"`): write 2× — needs ≥3 reads to pay off. Use for
  bursty/slow loops with gaps longer than 5 minutes (overnight batches,
  human-in-the-loop reviews).
- Batch rows so gaps stay under the TTL; for user-facing first-request
  latency, pre-warm with a `max_tokens: 0` request against the shared prefix.

## Output standard

Report: measured hit rate before/after, the specific invalidator(s) found
(quote the diagnostics `cache_miss_reason` or the offending prompt-builder
line), and the cost delta per the workload's unit of work — same
cost-per-deal/-ticket framing as the compare-model-sweep decision memo. State
the caching basis of any number you carry into a model comparison.
