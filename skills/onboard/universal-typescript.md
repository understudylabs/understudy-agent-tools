# Universal (TypeScript) — Fallback Conversion Recipe

This recipe slots into the master onboarding task's `<<CONVERT_TARGET>>`
placeholder when the project uses any framework, wrapper, or pattern not
covered by the named recipes (`anthropic-typescript.md`,
`openai-typescript.md`, `mastra-typescript.md`).

Common cases this handles:

- **Vercel AI SDK** (`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic`)
- **LangChain JS** (`langchain`, `@langchain/openai`, `@langchain/anthropic`)
- **LlamaIndex** (`llamaindex`)
- **OpenAI-compatible providers** (OpenRouter, Together, Groq, Fireworks,
  Mistral compat mode, etc.) that already use a custom `baseURL`
- **Raw `fetch` / `axios`** calls to `api.openai.com` or
  `api.anthropic.com`
- **Custom in-house wrappers** around either SDK
- Anything else this skill doesn't have a named recipe for

## The rule

The gateway exposes two endpoints:

| URL | Wire shape | Used by |
|---|---|---|
| `$UNDERSTUDY_GATEWAY_URL/v1/messages` | Anthropic schema | Anthropic SDK, anything calling `api.anthropic.com/v1/messages` |
| `$UNDERSTUDY_GATEWAY_URL/v1/chat/completions` | OpenAI Chat Completions schema | OpenAI SDK and every OpenAI-compatible client (LiteLLM, OpenRouter, Together, Groq, Fireworks, Mistral compat, Gemini compat, vLLM, Ollama, LangChain `ChatOpenAI`, LlamaIndex `OpenAI`, Vercel AI SDK `@ai-sdk/openai`, …) |

Almost everything in the LLM ecosystem speaks one of these two shapes.
Your task is to identify the wire shape the code uses, then rewrite the
client's configuration so it sends to Understudy's URL with the BYO
headers.

## How to find the patch site

1. **Look for explicit base URLs first.** Grep the source for
   `api.openai.com`, `api.anthropic.com`, `baseURL:`, `base_url:`,
   `apiBase:`, `endpoint:`. Any string referencing a provider hostname
   or a base-URL configuration is a candidate.
2. **Then look for client constructors.** Common ones:
   - `new OpenAI({...})` / `new Anthropic({...})` (direct SDKs)
   - `createOpenAI({...})` / `createAnthropic({...})` (Vercel AI SDK)
   - `new ChatOpenAI({...})` / `new ChatAnthropic({...})` (LangChain)
   - `new OpenAI(...)` from `llamaindex`
3. **Then look for raw HTTP calls.** Grep for `fetch(` /  `axios.post(`
   with the provider hostnames in scope. Treat these the same — find
   the URL and the headers, rewrite both.

If you find more than one site, list them all and ask the user which
client to convert (per the master task's "one SDK per run" rule).

## The patch — find these three things and change them

Whichever client you're patching, the change is the same conceptually.
Find the three concepts and change them:

### 1. The base URL

Whatever the client uses to point at the provider — `baseURL`, `base_url`,
`apiBase`, the URL argument to `fetch`, etc. — change it to:

- `$UNDERSTUDY_GATEWAY_URL` if the wire shape is **Anthropic**
  (paths like `/v1/messages`). The Anthropic SDK and anything calling
  `api.anthropic.com/v1/...` falls here.
- `$UNDERSTUDY_GATEWAY_URL/v1` if the wire shape is **OpenAI**
  (paths like `/chat/completions`). The OpenAI SDK and every
  OpenAI-compatible client falls here. The `/v1` suffix matters — the
  OpenAI SDK appends `/chat/completions` directly to the configured
  base URL.

If unsure which shape applies, look at what method the code calls:
`messages.create` / `messages.stream` → Anthropic; `chat.completions.create`
/ `responses.create` → OpenAI.

### 2. The primary auth credential

Whatever the client sends as its main API key — `apiKey`, `api_key`,
`Authorization: Bearer ...`, `x-api-key: ...` — change the source to
`process.env.UNDERSTUDY_API_KEY` (the `sk_*` stored by `understudy login`).

If the client requires a non-empty string at construction time and you
want a graceful fallback when `UNDERSTUDY_API_KEY` is unset, use
`process.env.UNDERSTUDY_API_KEY ?? process.env.OPENAI_API_KEY` (or the
matching upstream var). That lets the app keep working in dev when the
user hasn't set up Understudy yet.

### 3. The upstream-key header

Add `x-understudy-upstream-key` to whatever the client uses for default
or per-request headers. Its value is the user's *existing* upstream
provider key, **kept exactly where it lives today**. Do not delete or
rename `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from `.env` — the patch
reads it at runtime.

The header lookup is mechanical:

| Upstream | Env var to forward |
|---|---|
| OpenAI | `process.env.OPENAI_API_KEY` |
| Anthropic | `process.env.ANTHROPIC_API_KEY` |
| OpenRouter | `process.env.OPENROUTER_API_KEY` |
| Together | `process.env.TOGETHER_API_KEY` |
| Groq | `process.env.GROQ_API_KEY` |
| Fireworks | `process.env.FIREWORKS_API_KEY` |
| Anything else OpenAI-shape | whatever the user's current env var is |

The header machinery varies by client. Common forms:

- SDK constructors: `defaultHeaders: { "x-understudy-upstream-key": ... }`
- Vercel AI SDK `createOpenAI` / `createAnthropic`:
  `headers: { "x-understudy-upstream-key": ... }`
- LangChain `ChatOpenAI` / `ChatAnthropic`: passes through
  `defaultHeaders` on the underlying client — set it in the
  constructor's `configuration` field (TS) or `default_headers`
  (Python)
- Raw `fetch`: add to the `headers` object on the request

## Worked examples

### Vercel AI SDK with OpenAI

**Before:**

```ts
import { createOpenAI } from "@ai-sdk/openai";

const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
```

**After:**

```ts
import { createOpenAI } from "@ai-sdk/openai";

const provider = createOpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL/v1",
  headers: {
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
  },
});
```

### LangChain ChatOpenAI

**Before:**

```ts
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o-mini",
});
```

**After:**

```ts
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  modelName: "gpt-4o-mini",
  configuration: {
    baseURL: "$UNDERSTUDY_GATEWAY_URL/v1",
    defaultHeaders: {
      "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
    },
  },
});
```

### LangChain ChatAnthropic

```ts
import { ChatAnthropic } from "@langchain/anthropic";

const llm = new ChatAnthropic({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  modelName: "claude-opus-4-7",
  clientOptions: {
    baseURL: "$UNDERSTUDY_GATEWAY_URL",
    defaultHeaders: {
      "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
    },
  },
});
```

### OpenAI-compatible provider already pointed at a non-OpenAI URL

If the project already uses a custom baseURL (OpenRouter, Together,
Groq, etc.), just **swap the URL** and add the upstream-key header
named for the provider's env var.

**Before — OpenRouter:**

```ts
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});
```

**After:**

```ts
const client = new OpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL/v1",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.OPENROUTER_API_KEY ?? "",
  },
});
```

### Raw fetch

```ts
const res = await fetch("$UNDERSTUDY_GATEWAY_URL/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.UNDERSTUDY_API_KEY}`,
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
  },
  body: JSON.stringify({ model, messages, ... }),
});
```

## When to ask the user instead of guessing

- The code uses a wire shape that isn't Anthropic or OpenAI (e.g.
  native Cohere, native Gemini, Mistral *without* compat mode, AWS
  Bedrock SDK). The Understudy gateway can't proxy those today —
  stop and tell the user that.
- There are multiple client constructions for genuinely different
  upstream providers in the same file (not a refactor target — out of
  scope for this run).
- The constructor takes a hand-rolled HTTP client factory or a
  function that returns headers — you can wrap it, but ask first.

## Anything you don't touch

Same as the named recipes:

- Request shapes (`messages.create`, `chat.completions.create`, etc.)
  do not change. The wire format is preserved on the way to the
  gateway and back.
- Streaming, tool calls, vision content blocks, response handling —
  all unchanged. The gateway is byte-faithful for whichever wire
  shape it's routing.
- Existing constructor fields other than `apiKey` / `baseURL` /
  `defaultHeaders` — preserve them. Add the BYO bits; never wholesale
  rewrite the client.
