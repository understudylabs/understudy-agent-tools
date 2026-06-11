# Gateway OpenAI TypeScript Cookbook

This fixture shows how an OpenAI-shaped TypeScript client can route through
Understudy after CLI auth. It is a configuration pattern, not a live provider
call.

Use the gateway capability first:

```sh
understudy status --json
understudy login --email you@example.com
understudy run -- npm run your-local-script
```

Inside the child process, `understudy run` injects
`UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL`. The application keeps its
own upstream provider key in its existing environment variable.

See [`src/client.ts`](src/client.ts) for the synthetic config helper.

## Always stream gateway calls

When you wire this config into a real client, set `stream: true` on every
completion request. The gateway's edge cuts any response with no first byte
within ~125s (a 524, with no usage block to meter); streaming returns SSE
framing within seconds, so that timeout can never fire. The gateway injects
`stream_options: { include_usage: true }` upstream, so the final chunk
carries usage. If you need one final object, stream and aggregate:

```ts
const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  stream: true,
  messages: [{ role: "user", content: "hello" }],
});
let text = "";
for await (const chunk of stream) {
  text += chunk.choices[0]?.delta?.content ?? "";
}
```

Patterns for other clients:
[`skills/use-understudy-gateway/reference.md`](../../skills/use-understudy-gateway/reference.md)
→ "Always-stream rule".
