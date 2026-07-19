# Notes: pricing + run assumptions

- **claude-sonnet-4-6 cost**: the AutomationBench harness's own estimate at
  Anthropic list pricing ($3 in / $15 out per Mtok; it prints
  `fallback/claude-sonnet-4-6`). Cached input tokens are billed at full input
  rate in this estimate, so sonnet costs here are an upper bound.
- **gemma-4-31b-it cost**: no public list price on the Understudy gateway;
  computed by the harness from explicit `--input-cost 0.0000001
  --output-cost 0.0000004` overrides — i.e. a **$0.10 in / $0.40 out per Mtok
  demo assumption**, not a real invoice figure.
- **latency_ms** on rows is the harness's accumulated per-task model wall time
  (`model_time_s * 1000`), i.e. time spent inside model calls across the whole
  agentic rollout — not a single-call latency.
- Both arms ran through the Understudy gateway
  (`--base-url https://api.understudylabs.com/v1`), OpenAI Chat Completions
  path (the harness only uses the Anthropic Messages client when the base URL
  contains `anthropic.com`).
- Run slice: the first 2 imported tasks per domain (12 of the 48 imported
  tasks), `--max-steps 50` (default), `--max-concurrent 4`.
