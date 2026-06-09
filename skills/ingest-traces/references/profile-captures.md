# Profile a whole capture directory (fleet cost + call-type taxonomy)

[`understand-workload`](../../understand-workload/SKILL.md) decomposes **one** trace.
This playbook is its **fleet** sibling: point it at a directory of gateway captures and
sweep **all** of them into a single picture — what kinds of calls there are, where the
spend goes, and **which call types an open-weight / local model could take over**. That
last part is the point: you can't pick what to move until you can see the whole fleet
sorted by what it costs and how hard it is to replace.

This is a playbook, not a shipped script. **You write the profiler on the spot** — a
short, throwaway local program in whatever language the environment already has (Node,
Python, `jq`…), implementing the algorithm below against the *actual* shape of the
captures in front of you. Capture formats vary by gateway and provider; a frozen binary
would rot, and an agent can tailor parsing to what's really there. Run it, produce the
report, then delete the scaffolding — the report is the artifact, the script is not.

It is **provider-agnostic**: the algorithm reads Anthropic, OpenAI, and any
OpenAI-compatible gateway shape (streamed or object responses), clusters on tool/turn
structure rather than any provider's prompt boilerplate, and prices every model from a
swappable table — anything not in the table is treated as open-weight/local ($0).

## When to profile first

- You have a **folder of captures** (gateway `.jsonl` envelopes), not a single prompt.
- You want a **cost breakdown by model and by call type**, not just a token total.
- You want a **shortlist of cheap-to-move calls** (toolless, single-turn, structured)
  to hand to [`run-local-model-lab`](../../run-local-model-lab/SKILL.md).
- You're triaging before optimization and need to know *where the money is* first.

For deep understanding of one representative trace, use
[`understand-workload`](../../understand-workload/SKILL.md) instead (or after).

## Safety gates (profiling-specific)

- **Local-first, no uploads.** The profiler you write reads local files and writes a
  local `profile.json` + `profile.md`. It makes no network calls and needs no auth.
- **Redaction by construction.** Emit **structure only** — model ids, token counts,
  toolset **names**, system-prompt **headings/first line**, message **roles and sizes**.
  Never read, store, or render message bodies, tool inputs, or completions, so the
  report is safe to share. Build the parser so raw payloads can't leak by construction.
- **The script is scaffolding, not an artifact.** Write it to a temp/working path, run
  it, and delete it when the report is produced. Do not commit it.
- **No savings *claims* from the profile alone.** The candidate list is a *shortlist to
  test*, and the dollar figures are *addressable spend at list prices*, not promised
  savings. Prove any number in `run-local-model-lab` and freeze a metric with
  `capture-evidence` before claiming anything.
- **Pricing is explicit.** Use a stated price table; **unknown/local models are
  open-weight ($0)**. Say which table you used.

## Flow

1. **Locate the dump.** Find the directory of `.jsonl` captures; note the file count and
   rough size so you can set the user's expectation (a large dump is a minute or two of
   pure local parsing).
2. **Learn the real shape.** Read **one or two** capture files *for structure only* to
   confirm the envelope fields and, critically, whether responses are **streamed**
   (usage split across stream events) or **parsed objects** (usage on the body), and
   whether requests are Anthropic- or OpenAI-shaped (see the streaming-usage gotcha
   below).
3. **Write the profiler.** Implement the algorithm below: parse token usage (from the
   stream or the object), cluster each request by `model | family | toolset | persona`
   (structure, not the volatile prompt text), price via your table (unknown ⇒
   open-weight $0), and flag **toolless + single-turn + structured-output** clusters as
   takeover candidates, ranked by spend. Keep it redaction-safe.
4. **Run it and read the report back.** It writes `profile.json` + `profile.md` (a
   mermaid call-taxonomy graph, a cost-by-token-type pie for the priciest priced model,
   and the candidate table). Walk the call types: **agentic loops** (many tools,
   multi-turn — hard to move) vs **toolless micro-prompts** (single-turn, often
   structured — cheap to move). Name where spend concentrates and whether it's
   **generation or cache I/O** (the pie answers this — heavy cache I/O means the lever
   is caching/routing, not a smaller model).
5. **Surface the open-weight candidates.** For each, give the call count and addressable
   spend, and that the next step is to *measure*, not assume.
6. **Hand off, then clean up.** Route each finding to the right next skill, then
   **delete the throwaway profiler script**; keep `profile.json`/`profile.md` local.
   - cheap candidate → [`run-local-model-lab`](../../run-local-model-lab/SKILL.md)
     to score a local open-weight model against it; cascade if it's close.
   - an agentic-loop cluster worth moving →
     [`understand-workload`](../../understand-workload/SKILL.md) to decompose it, then
     [`compare-model-sweep`](../../compare-model-sweep/SKILL.md).
   - before any savings claim → [`capture-evidence`](../../capture-evidence/SKILL.md)
     to freeze the metric and splits.

## Build it (algorithm)

```
for each line in each *.jsonl under the dump:
  env  = parse the envelope (JSON)
  req  = parse env.customer_request_body|request|body   (often a JSON string)
  usage = extractUsage(env.response_body|response)       (see streaming gotcha)
  model = env.requested_model | env.model | req.model
  price = table[firstKeySubstringMatch(model)]  or  {open_weight:true, all $0}
  cost  = (usage.input*in + usage.output*out
           + usage.cache_write*cacheWrite + usage.cache_read*cacheRead) / 1e6
  tools   = names(req.tools)                         # [].name or [].function.name
  family  = tools.length ? "agent" : "direct"
  persona = firstHeadingOrLine(systemBlocks(req), skipping header-shaped blocks)
  turns   = req.messages without role=="system"      # user/assistant turns only
  key     = model | family | hash(sortedTools) | hash(persona)
  accumulate cost, tokens, count, single(=turns<=1), structured(=looksStructured) into cluster[key]
  accumulate cost+tokens into byModel[model] and count into byFamily[family]

candidates = clusters where n_tools==0
             AND single/count > 0.9
             AND structured/count > 0.5
             AND not price.open_weight,    sorted by cost desc
write profile.json + profile.md
```

`looksStructured` = `req.response_format` or `req.output_config` present, **or** a system
block that mentions JSON together with one of {only, array, object, schema, verdict}.

## What it reads (capture envelope)

Each line of a `.jsonl` capture is one request envelope. Be tolerant of field naming and
of both Anthropic and OpenAI shapes. Look for:

| Field | Used for |
|---|---|
| `requested_model` / `model` | model id (→ pricing, clustering) |
| `mode` | reseller / byo split |
| `ts` | per-day volume |
| `latency_ms` | average latency per cluster |
| `customer_request_body` (JSON string or object) | system, tools, messages → structure |
| `response_body` (SSE string or object) | token usage |

`customer_request_body` and `response_body` are commonly **JSON-encoded strings** in
captures — parse them lazily.

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
need `understand-workload` and whole-case comparison, not a drop-in swap.

The dollar figure on a candidate is **addressable spend at the table's list prices**,
i.e. what those calls cost today — an upper bound on what moving them could save, to be
proven by `run-local-model-lab`, not a guaranteed saving.

## Pricing

Use a `$/Mtok` table keyed by model (input, output, cache-write, cache-read). A common
default: cache write ≈ 1.25× input (5-minute TTL), cache read ≈ 0.10× input — but set
per-model values from the provider's published prices (OpenAI's cached-input rate
differs, etc.). **Any model not in the table is treated as open-weight/local and priced
at $0** — so a local rung shows up as free, which is the whole point. State which table
you used in the writeup, and let the user pass their own (e.g. negotiated rates).

## Output

- `profile.json` — `schema_version: understudy.profile_captures.v1`; per-model spend +
  tokens, families, top clusters, and `open_weight_candidates`.
- `profile.md` — the human report: spend-by-model table, a mermaid **call-taxonomy**
  graph, a mermaid **cost-by-token-type pie** for the priciest priced model, and the
  **candidate** table, ending in concrete next-skill hand-offs.

## Output standard

End with: the dump profiled (files, requests, window); the cost split by model and by
family; the call-type taxonomy (the mermaid graph from the report); the ranked
open-weight-candidate table with call counts and addressable spend; and the specific
next skill for the top candidate. Keep `profile.json`/`profile.md` local and delete the
profiler script. Make every cost/structure claim from the profile, not from memory.
