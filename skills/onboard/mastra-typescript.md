# Mastra (TypeScript) — Conversion Recipe

This recipe slots into the master onboarding task's `<<CONVERT_TARGET>>`
placeholder. Apply it when the project uses [Mastra](https://mastra.ai)
agents (`@mastra/core`). Mastra agents specify their model with a string
like `model: "openai/gpt-5-mini"`, which Mastra resolves through its
built-in model gateway. To route through Understudy, the patch swaps that
string for an explicit AI SDK provider instance with a custom `baseURL`
and headers.

## When this applies

`package.json` lists `@mastra/core` (almost always with `mastra` in
devDependencies for the CLI), AND the source defines one or more
`new Agent({ ... })` instances with a string-form `model`:

```ts
import { Agent } from "@mastra/core/agent";

export const weatherAgent = new Agent({
  id: "weather-agent",
  name: "Weather Agent",
  instructions: `...`,
  model: "openai/gpt-5-mini",   // ← string-form, Mastra resolves it
  tools: { weatherTool },
});
```

If the agent's `model` is already a provider-instance form like
`model: openai("gpt-5-mini")` from `@ai-sdk/openai`, jump straight to step
2 below — you only need to add `baseURL` + headers to the existing
`createOpenAI` / `createAnthropic` call.

## The patch

This is a two-step change: add the right `@ai-sdk/*` dep, then swap the
agent's `model` field.

### Step 1 — install the right AI SDK provider

For each agent, look at the provider prefix in the model string:

- `model: "openai/..."` → `@ai-sdk/openai`
- `model: "anthropic/..."` → `@ai-sdk/anthropic`

Install with the project's package manager (check the lockfile — see the
master task for the rule). Examples:

```bash
pnpm add @ai-sdk/openai
# or
npm install @ai-sdk/anthropic
```

If the project mixes providers across multiple agents (one OpenAI, one
Anthropic), install both. Do not "consolidate" agents onto one provider —
that's a refactor outside this task's scope.

### Step 2 — swap the agent's `model` field

For an OpenAI-backed agent:

**Before:**

```ts
import { Agent } from "@mastra/core/agent";

export const weatherAgent = new Agent({
  id: "weather-agent",
  // ...
  model: "openai/gpt-5-mini",
  // ...
});
```

**After:**

```ts
import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";

const understudy = createOpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL/v1",
  headers: {
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
  },
});

export const weatherAgent = new Agent({
  id: "weather-agent",
  // ...
  model: understudy("gpt-5-mini"),
  // ...
});
```

For an Anthropic-backed agent, swap the same way but with
`@ai-sdk/anthropic` and **no `/v1` on `baseURL`**:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const understudy = createAnthropic({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "$UNDERSTUDY_GATEWAY_URL",
  headers: {
    "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
  },
});

export const weatherAgent = new Agent({
  // ...
  model: understudy("claude-opus-4-7"),
});
```

Key points:

- The provider instance (`understudy`) is created **once** per
  provider per file. If the file defines three OpenAI agents, share a
  single `createOpenAI(...)` call across them.
- `baseURL` rules match the underlying SDK: OpenAI form ends in `/v1`,
  Anthropic form does not. `@ai-sdk/openai` and `@ai-sdk/anthropic`
  follow the same path-appending conventions as their underlying SDKs.
- The model string passed to `understudy(...)` is the **upstream model
  ID without the provider prefix** — `"gpt-5-mini"`, not
  `"openai/gpt-5-mini"`.
- Do not delete `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from `.env` or
  deployment config. The provider reads them at runtime to forward on
  `x-understudy-upstream-key`.

## What doesn't need to change

Mastra's higher-level API stays identical end-to-end. Don't touch:

- `Agent` config fields other than `model` (`instructions`, `tools`,
  `memory`, `scorers`, `id`, `name`)
- `Memory`, `Workflow`, scorer wiring
- `new Mastra({ agents: { ... } })` registration
- Tool definitions (`createTool`, Zod input schemas)
- The `agent.generate(...)` / `agent.stream(...)` call sites
- `mastra dev` / `mastra build` / `mastra start` scripts

## Multiple agents

A typical Mastra project has several agent files under
`src/mastra/agents/`. Patch each one in this run. Share the
`createOpenAI` / `createAnthropic` instance within a single file; create
fresh instances per-file rather than introducing a new shared module —
that's a refactor outside scope.

## What about the custom-gateway path?

Mastra also supports extending `MastraModelGateway` to register a named
gateway (e.g. `"understudy/openai/gpt-5-mini"`). Do **not** introduce that
in this run. The provider-instance form above is one file change per
agent file; the gateway form requires a new class, registration on
`new Mastra({ gateways: ... })`, and rewriting every agent's model
string. Save that for a follow-up if the user explicitly asks.
