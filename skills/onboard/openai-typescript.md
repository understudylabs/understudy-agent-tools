# OpenAI SDK (TypeScript) — Conversion Recipe

This recipe slots into the master onboarding task's `<<CONVERT_TARGET>>`
placeholder. Apply it when the project uses the official OpenAI TypeScript
SDK (`openai`) directly — not via Mastra, Vercel AI SDK, LangChain, or
another wrapper. If the project uses one of those, use the corresponding
recipe instead.

## When this applies

`package.json` lists `openai` as a direct dependency (not `@ai-sdk/openai`
— that's a different package), AND the source code constructs the client
itself:

```ts
import OpenAI from "openai";

const client = new OpenAI();
// or
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

## The patch

Find every `new OpenAI(...)` construction site. Change only the constructor
argument — leave `client.chat.completions.create`, `client.responses.*`,
streaming, and tool calls untouched.

**Before — bare construction:**

```ts
const client = new OpenAI();
```

**Before — explicit apiKey:**

```ts
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

**After — for both:**

```ts
const client = new OpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL/v1",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
  },
  // ...preserve any other fields the user had (timeout, maxRetries, etc.)
});
```

Key points:

- The `baseURL` **ends in `/v1`**. The OpenAI SDK appends paths like
  `/chat/completions` directly to the baseURL — unlike the Anthropic SDK,
  which prepends `/v1/` itself. If you put `$UNDERSTUDY_GATEWAY_URL`
  without `/v1`, the SDK hits `/chat/completions` and the gateway's
  wrong-path 404 helper will explain the fix verbatim.
- `apiKey` is now the Understudy `sk_*` (`UNDERSTUDY_API_KEY`). The SDK
  sends this on `Authorization: Bearer`.
- `defaultHeaders["x-understudy-upstream-key"]` carries the user's real
  OpenAI key. **Do not delete or rename `OPENAI_API_KEY`** anywhere — the
  patch reads it at runtime to forward to `api.openai.com`.
- Preserve any other constructor fields the user had.

## What doesn't need to change

The OpenAI SDK's request and response shapes pass through the gateway
unchanged (gateway `index.ts:205-215` mounts `/v1/chat/completions` as a
direct OpenAI-shape route). Don't touch:

- `client.chat.completions.create(...)` and its streaming form
- `client.responses.create(...)` and `client.responses.stream(...)` (the
  newer Responses API)
- `tools: [...]`, `tool_choice`, and the manual `tool_calls` loop
- `stream_options.include_usage` — the gateway respects what the user set
- Custom `Organization` / `Project` headers (`OpenAI-Organization`,
  `OpenAI-Project`) — merge with the new `x-understudy-upstream-key`
  entry, don't overwrite

## Multiple construction sites

If the repo has more than one `new OpenAI(...)` call, patch all of them in
this run. The master task's "one SDK per run" rule applies to the choice
of SDK, not to the number of construction sites for that SDK.

## What about Azure OpenAI?

If the project uses `AzureOpenAI` from `openai` instead of `OpenAI`, stop
and ask the user. The gateway routes to public OpenAI today — Azure
endpoints aren't supported in M1, and the patch shape would be different.
Do not silently convert an Azure client.
