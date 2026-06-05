# Anthropic SDK (TypeScript) — Conversion Recipe

This recipe slots into the master onboarding task's `<<CONVERT_TARGET>>`
placeholder. Apply it when the project uses the official Anthropic
TypeScript SDK (`@anthropic-ai/sdk`) directly — not via Mastra, Vercel AI
SDK, LangChain, or another wrapper. If the project uses one of those, use
the corresponding recipe instead.

## When this applies

`package.json` lists `@anthropic-ai/sdk` as a direct dependency, AND the
source code constructs the client itself:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
// or
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

## The patch

Find every `new Anthropic(...)` construction site. For each one, change
only the constructor argument — do **not** rewrite `client.messages.create`
calls, streaming code, tool definitions, or response handling. The SDK's
public API stays identical; you're just changing where the bytes go.

Three constructor shapes you may see:

**Before — bare construction:**

```ts
const client = new Anthropic();
```

**Before — explicit apiKey:**

```ts
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

**Before — options object with other fields:**

```ts
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60_000,
  maxRetries: 3,
});
```

**After — for all three:**

```ts
const client = new Anthropic({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
  },
  // ...preserve any other fields the user had (timeout, maxRetries, etc.)
});
```

Key points:

- The `baseURL` has **no trailing `/v1`**. The Anthropic SDK appends
  `/v1/messages` itself.
- `apiKey` is now the Understudy `sk_*`, read from `UNDERSTUDY_API_KEY`.
  This becomes the primary auth header the SDK sends.
- `defaultHeaders["x-understudy-upstream-key"]` carries the user's real
  Anthropic key — the gateway reads it and forwards it to
  `api.anthropic.com` on the user's behalf. **Do not delete or rename
  `ANTHROPIC_API_KEY`** in `.env`, the launch script, or any deployment
  config — the patch depends on it being readable at runtime.
- Preserve every other field the constructor already had (`timeout`,
  `maxRetries`, custom `fetch`, etc.). They're orthogonal to gateway
  routing.

## What doesn't need to change

The SDK's response shape, streaming API, tool runner, vision support,
prompt caching, and beta flags all pass through the gateway byte-faithfully
(gateway `index.ts:139-168` preserves `anthropic-beta` and
`anthropic-version` headers). Don't touch:

- `client.messages.create(...)` calls
- `client.messages.stream(...)` and event handlers
- `betaZodTool(...)` definitions and `toolRunner`
- Content-block destructuring (`response.content[i].type === "text"`)
- `usage.input_tokens` / `usage.output_tokens` access
- Anthropic-version pinning via `defaultHeaders["anthropic-version"]`
  (merge with the new `x-understudy-upstream-key` entry, don't overwrite)

## If the patcher's defaults clash

If the user already had `defaultHeaders` on the constructor, merge — do
not replace. Example:

```ts
// Before
const client = new Anthropic({
  defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
});

// After
const client = new Anthropic({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL",
  defaultHeaders: {
    "anthropic-beta": "prompt-caching-2024-07-31",
    "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
  },
});
```

## Multiple construction sites

If the repo has more than one `new Anthropic(...)` call (e.g. one per
worker, one per test file), patch all of them in this run. The master
task's hard rule "one SDK, one language per run" applies to the SDK
choice, not to the count of construction sites for that SDK.
