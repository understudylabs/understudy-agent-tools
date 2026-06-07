# profile-captures — reference

Deeper notes for the [`profile-captures`](SKILL.md) skill. The runnable is
[`profile_captures.ts`](profile_captures.ts) — dependency-free, run by Node ≥ 22.6 via
native type-stripping (no build step, like `mlx-arena/blind_arena.ts`).

## What it reads (capture envelope)

Each line of a `.jsonl` capture is one request envelope. The profiler is tolerant of
field naming and of both Anthropic and OpenAI shapes. It looks for:

| Field | Used for |
|---|---|
| `requested_model` / `model` | model id (→ pricing, clustering) |
| `mode` | reseller / byo split |
| `ts` | per-day volume |
| `latency_ms` | average latency per cluster |
| `customer_request_body` (JSON string or object) | system, tools, messages → structure |
| `response_body` (SSE string or object) | token usage |

`customer_request_body` and `response_body` are commonly **JSON-encoded strings** in
captures — the profiler parses them lazily.

## The streaming-usage gotcha

Most gateway captures store the response as the **raw SSE stream**, not a parsed
object. Token usage is **not** a top-level field — it is split across stream events:

- Anthropic: `message_start.message.usage` carries `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`; the final `message_delta`
  carries the real `output_tokens`.
- OpenAI: a streamed usage chunk (when `stream_options.include_usage`) or, for
  non-streamed captures, `usage` on the response object — `prompt_tokens`,
  `completion_tokens`, `prompt_tokens_details.cached_tokens`.

A naive `JSON.parse(response_body).usage` returns nothing for streamed captures and
silently undercounts everything. The profiler walks the `data:` lines and also handles
the parsed-object case.

## Clustering key (call types)

A "call type" is `model | family | toolsetHash | personaHash` — all provider-agnostic:

- **family** — `agent` (the request carries tools → a tool-using call/loop) or
  `direct` (no tools → a single-shot micro-prompt). No provider-specific string
  matching; it keys purely on whether tools are present.
- **toolsetHash** — hash of the **sorted tool names** (Anthropic `tools[].name` or
  OpenAI `tools[].function.name`). The toolset variant is what distinguishes an
  orchestrator from a worker sub-agent — *not* the system text, which is often
  per-session unique (an injected header block + dynamic context).
- **personaHash** — hash of the persona label (below).

This is why per-session-unique system prompts don't fragment the taxonomy: clustering
keys on toolset + persona-heading, not the volatile full prompt.

## Redaction by construction

The report is structure-only and safe to share:

- **persona label** = the first `#`/`##`/`###` heading of the first non-header system
  block (header-shaped blocks like `x-...: ...` from any gateway are skipped), or its
  first line truncated to 60 chars — **headings, not bodies**. Works across shapes: a
  top-level `system`, an array of system blocks, or a leading `system`/`developer` role
  message (OpenAI).
- **messages** → only **roles and turn depth** (system messages are not counted as
  turns); never content.
- **tools** → only **names**.

It never reads or emits raw message text, tool inputs, or completions.

## Open-weight / local candidate heuristic

A cluster is flagged as an open-weight takeover candidate when **all** hold:

- `n_tools == 0` (no tool-calling loop to reproduce),
- `> 90%` of calls are **single-turn** (one user turn; system excluded),
- `> 50%` of calls look **structured** (`response_format` / `output_config`, or a
  system prompt that asks for JSON / an array / a schema / a verdict),
- the model is **priced** (not already open-weight/local).

These are the cheapest, lowest-risk calls to move: a small model only has to produce a
schema, and a cascade (local-first, escalate the ambiguous tail to the frontier) covers
the rest. Agentic loops (tools + multi-turn) are deliberately **not** flagged here — they
need `understand-workload` + `mlx-arena`, not a drop-in swap.

The dollar figure on a candidate is **addressable spend at the table's list prices**,
i.e. what those calls cost today — an upper bound on what moving them could save, to be
proven by `run-local-model-lab`, not a guaranteed saving.

## Pricing

Built-in `$/Mtok` table (input, output, cache-write, cache-read). Cache write is priced
at 1.25× input (5-minute TTL); cache read at 0.10× input. **Any model not in the table
is treated as open-weight/local and priced at $0** — so a local rung shows up as free,
which is the whole point. Override or extend with `--pricing prices.json` (same shape as
the built-in `DEFAULT_PRICES`), and state which table you used in the writeup.

## Output

- `profile.json` — `schema_version: understudy.profile_captures.v1`; per-model spend +
  tokens, families, top clusters, and `open_weight_candidates`.
- `profile.md` — the human report: spend-by-model table, a mermaid **call-taxonomy**
  graph, a mermaid **cost-by-token-type pie** for the priciest priced model, and the
  **candidate** table, ending in concrete next-skill hand-offs.
