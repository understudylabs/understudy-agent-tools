# Lower Anthropic Bill — Reference

Use this after loading [`SKILL.md`](SKILL.md). This file carries the sourced
facts and the operational checklist so the public skill can stay short.

## Sources Fetched 2026-06-24

Re-verify before quoting in external copy, a PR, or a customer-facing report.

- Anthropic pricing:
  <https://docs.anthropic.com/en/docs/about-claude/pricing>
- Anthropic prompt caching:
  <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Anthropic token counting:
  <https://docs.anthropic.com/en/docs/build-with-claude/token-counting>
- Anthropic model migration guide:
  <https://docs.anthropic.com/en/docs/about-claude/models/migrating-to-claude-4>
- Anthropic batch processing:
  <https://docs.anthropic.com/en/docs/build-with-claude/batch-processing>
- Anthropic extended thinking:
  <https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking>
- Anthropic Claude Code costs:
  <https://docs.anthropic.com/en/docs/claude-code/costs>
- OpenAI prompt caching:
  <https://developers.openai.com/api/docs/guides/prompt-caching>
- OpenAI prompt engineering:
  <https://developers.openai.com/api/docs/guides/prompt-engineering>
- OpenAI current model guidance:
  <https://developers.openai.com/api/docs/guides/latest-model>
- OpenAI API pricing:
  <https://openai.com/api/pricing/>

## Current Vendor Facts To Carry Into The Audit

### Anthropic pricing and model shape

As of the fetched pricing page, first-party Claude API global list prices are
roughly:

| Model lane | Input $/Mtok | Output $/Mtok | Notes |
|---|---:|---:|---|
| Fable 5 / Mythos 5 | 10 | 50 | Highest published tier; Mythos limited availability. |
| Opus 4.8 / 4.7 / 4.6 / 4.5 | 5 | 25 | Opus 4.7+ uses the newer tokenizer family. |
| Opus 4.1 / Opus 4 | 15 | 75 | Deprecated or retired on most surfaces. |
| Sonnet 4.6 / 4.5 | 3 | 15 | Lower-cost default for many coding and agentic tasks. |
| Haiku 4.5 | 1 | 5 | First Anthropic downgrade candidate for narrow clerical calls. |

Prompt-cache multipliers are stated relative to base input price:

| Token class | Multiplier |
|---|---:|
| Uncached input | 1.0x |
| 5-minute cache write | 1.25x |
| 1-hour cache write | 2.0x |
| Cache read / refresh | 0.1x |

The Batch API discounts input and output by 50%. Anthropic says prompt-caching
and Batch discounts can stack, but batch cache hits are best effort because
batch jobs run asynchronously and concurrently.

Data residency and fast mode can multiply cost. First-party US-only inference
through `inference_geo: "us"` applies a 1.1x multiplier on Claude Opus 4.6,
Sonnet 4.6, and later. Fast mode has separate premium rates for supported Opus
models. Do not miss these flags when reading request builders.

### New-tokenizer risk

Anthropic's pricing page says Opus 4.7 and later use a new tokenizer and that
the same fixed text may use up to 35% more tokens. The migration guide says
that, compared with models before Opus 4.7, the same content can tokenize to
roughly 30% more tokens depending on workload shape.

Treat this as a measurement gate:

- If a repo upgraded from pre-4.7 Opus/Sonnet behavior to Opus 4.7+ or newer
  model families, run `count_tokens` on representative prompts before making a
  savings claim.
- If token counting needs real prompts, get approval for the exact payload class
  first. The token-counting endpoint accepts the same structured message inputs
  as the Messages API and is documented as ZDR eligible for covered orgs.
- If you cannot call the endpoint, report a sensitivity band such as
  `current_tokens x 1.0 to x 1.35`, not a precise token delta.

### Prompt-cache minimums

Anthropic cache minimums are model-specific and silently fail below the
threshold. If both `cache_creation_input_tokens` and `cache_read_input_tokens`
are zero, the prompt likely did not cache.

Current first-party docs list:

| Model lane | Minimum cacheable prefix |
|---|---:|
| Fable 5 / Mythos 5 | 512 tokens |
| Mythos Preview / Opus 4.7 | 2,048 tokens |
| Opus 4.6 / Opus 4.5 | 4,096 tokens |
| Opus 4.8 / Sonnet 4.6 / Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4 | 1,024 tokens |
| Haiku 4.5 | 4,096 tokens |

The safe report language is: "This prefix appears cacheable by structure, but
the usage fields must confirm it." Do not infer a hit from `cache_control`
being present.

### Usage fields to parse

Anthropic response usage:

- `input_tokens`: uncached input that was processed at base input price.
- `cache_creation_input_tokens`: tokens written into the cache.
- `cache_read_input_tokens`: tokens read from cache.
- `output_tokens`: generated output, including billed thinking tokens where
  applicable.

OpenAI usage:

- `usage.prompt_tokens_details.cached_tokens`: cached input tokens.
- `usage.completion_tokens_details.reasoning_tokens`: reasoning-token metadata
  when present.

For streamed captures, usage may be split across SSE events. Use
[`../ingest-traces/references/profile-captures.md`](../ingest-traces/references/profile-captures.md)
for parsing rules.

### OpenAI comparison facts

OpenAI prompt caching is automatic on recent models for prompts of 1,024 tokens
or more. Best practice is still structural: stable content first, dynamic
user-specific context last, consistent `prompt_cache_key` for common prefixes,
and logging cached-token counts. OpenAI states prompt caching can reduce input
token cost by up to 90% and latency by up to 80% when it hits.

As of the fetched pricing page:

| OpenAI model | Input $/Mtok | Cached input $/Mtok | Output $/Mtok |
|---|---:|---:|---:|
| GPT-5.5 | 5.00 | 0.50 | 30.00 |
| GPT-5.4 | 2.50 | 0.25 | 15.00 |
| GPT-5.4 mini | 0.75 | 0.075 | 4.50 |

OpenAI docs recommend pinning production model snapshots, building evals before
prompt/model changes, using developer-message structure, putting repeated
content at the beginning for caching, using Structured Outputs instead of
describing schemas only in prose, and tuning reasoning effort and verbosity for
cost/latency.

Important repo boundary: the Understudy gateway path in this repo is still
Chat-Completions-shaped for OpenAI examples. If a customer app should move to
the OpenAI Responses API, record that as an API-surface migration and do not
pretend the Understudy gateway already supports Responses unless the current
repo proves it.

## Repo Scan Checklist

Start from declared dependencies, then concrete call sites:

```sh
rg -n -i "anthropic|@anthropic-ai/sdk|claude|messages\\.create|messages\\.stream|/v1/messages" --hidden -g '!**/node_modules/**'
rg -n -i "ANTHROPIC_API_KEY|ANTHROPIC_MODEL|CLAUDE_MODEL|BASE_URL|inference_geo|service_tier" --hidden -g '.env*' -g '*.ts' -g '*.tsx' -g '*.js' -g '*.py' -g '*.yaml' -g '*.yml'
rg -n -i "cache_control|cache_read_input_tokens|cache_creation_input_tokens|count_tokens|prompt-cach" --hidden -g '!**/node_modules/**'
rg -n -i "Date\\.now|new Date\\(|datetime\\.now|time\\.time|uuid|randomUUID|Math\\.random|sort_keys|json\\.dumps|JSON\\.stringify" --hidden -g '!**/node_modules/**'
rg -n -i "batch|cron|queue|worker|backfill|digest|eval|map\\(|Promise\\.all|for await" --hidden -g '!**/node_modules/**'
```

Group findings by shared wrapper, not by every leaf call. One provider wrapper
usually controls most of the bill.

For each route, record:

- call site path and wrapper;
- model ID and where it is configured;
- whether tools are present;
- system/tool/message construction order;
- prompt-cache markers and likely stable prefix size;
- dynamic fields before the cache breakpoint;
- monthly volume source;
- usage fields available;
- eval or test harness available;
- data class and approval needs.

## Cost Math

Always show assumptions. The core formula is:

```text
monthly_cost = monthly_calls * (input_tokens * input_rate
  + output_tokens * output_rate
  + cache_write_tokens * cache_write_rate
  + cache_read_tokens * cache_read_rate) / 1_000_000
```

For a stable prefix reused `N` times within the 5-minute TTL:

```text
cache_cost = prefix_tokens * input_rate / 1_000_000 * (1.25 + 0.1 * (N - 1))
uncached_cost = prefix_tokens * input_rate / 1_000_000 * N
```

Do not double count. If a finding both shortens and caches the same prefix,
compute the combined new state once.

### Synthetic cost sensitivity checks

These were local arithmetic checks using fetched list prices. They are not
quality claims and should not appear as promised savings.

| Scenario | Baseline | Candidate | Modeled delta |
|---|---:|---:|---:|
| 8k-token stable Opus 4.8 prefix, 50k calls/month, 5-minute cache warm | $2,000 | $200 | 90% lower input-prefix cost |
| 100k clerical calls, 2k input + 200 output, Opus 4.8 to Haiku 4.5 | $1,500 | $300 | 80% lower token cost |
| Same clerical route, Opus 4.8 to GPT-5.4 mini | $1,500 | $240 | 84% lower token cost |
| 40k async Opus 4.8 calls, 4k input + 600 output, move to Batch | $1,400 | $700 | 50% lower token cost |

The real question is whether the candidate clears the route's quality gate.
Use these numbers only to rank where measurement is worth doing first.

## Cache Audit Playbook

Look for the specific invalidator, not a generic "use caching" note:

- volatile values before a breakpoint: timestamps, UUIDs, user IDs, request IDs,
  feature flags, random few-shot ordering;
- nondeterministic JSON: unsorted object construction, set iteration, tool arrays
  built from unstable maps;
- cache marker after dynamic content instead of after the stable prefix;
- prefix below current model minimum;
- tool list changes per request, because tools render before system/messages;
- model changes in a conversation, because caches are model-scoped;
- concurrent fan-out where every request races before the first cache write is
  readable;
- a 1-hour TTL recommended for steady high-QPS traffic where 5 minutes would
  already keep the prefix warm.

Confirm with one of:

- response usage fields from repeated requests;
- a local rendered-prefix diff between two requests;
- Anthropic token counting on a synthetic or approved representative prompt;
- an approved live cache probe with `max_tokens: 0` when the request shape
  supports it.

## Candidate Lanes

Use this order unless the evidence says otherwise:

1. **Cache structure.** Cheapest for long repeated system/tools/doc context.
2. **Output and retry controls.** Lower `max_tokens`, avoid whole-prompt retries,
   narrow parse repairs, and remove unnecessary thinking/effort settings.
3. **Batch async work.** Backfills, evals, digests, and cron jobs usually do not
   need synchronous Messages API calls.
4. **Cheaper Anthropic lane.** Try Haiku or Sonnet for narrow clerical work
   before changing provider semantics.
5. **Local/open-weight lane.** Local catalog guidance from the current machine
   points classification and structured-output candidates at small Qwen/Gemma
   rungs first; measure with `compare-model-sweep` or `run-local-model-lab`.
6. **OpenAI lane.** Use OpenAI pricing, automatic caching, Structured Outputs,
   reasoning effort, and verbosity controls. Treat API-shape migration as a
   separate implementation step when moving beyond Chat Completions.
7. **GEPA lane.** Use GEPA only after a measured eval exists. Train/dev only;
   holdout stays sealed. The feedback function must explain why each row failed
   and what to change.

## OpenAI Prompt Migration Notes

When proposing an OpenAI candidate:

- preserve the task contract first: inputs, outputs, tools, side effects,
  refusal/error behavior, and quality metric;
- keep production prompts in code with typed dynamic values;
- translate Anthropic `system` into OpenAI developer instructions;
- move schema prose into Structured Outputs where supported;
- put repeated instructions/examples/tools first and dynamic user context last;
- set `prompt_cache_key` for repeated prefixes when using eligible OpenAI APIs;
- tune `reasoning.effort` and `text.verbosity` instead of adding prompt words;
- log cached tokens, reasoning tokens, latency, output length, fallback rate, and
  score in the same comparison artifact.

For Understudy-gateway-backed tests in this repo, stay within currently
supported OpenAI Chat Completions examples unless the repo has added Responses
support.
