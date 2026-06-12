export interface SnippetParams {
  gatewayUrl: string;
}

/**
 * OpenAI-SDK shape of the BYO patch. The customer's existing
 * `OPENAI_API_KEY` rides on `x-understudy-upstream-key`; the Understudy
 * `sk_*` from `~/.understudy/credentials.json` is the primary auth the
 * gateway validates. The gateway looks up the upstream key from the
 * header and forwards to `api.openai.com` on the customer's behalf.
 *
 * `baseURL` ends in `/v1` for the OpenAI SDK — it appends paths like
 * `/chat/completions` to that prefix.
 */
export function renderSnippet({ gatewayUrl }: SnippetParams): string {
  const base = gatewayUrl.endsWith("/v1") ? gatewayUrl : `${gatewayUrl}/v1`;
  const code = `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "${base}",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
  },
});

// Always stream gateway calls: the edge cuts responses with no first byte
// within ~125s, so non-streaming calls can 524 on slow generations. The
// gateway injects stream_options: { include_usage: true } upstream, so the
// final chunk carries usage.
const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "Say hello from Understudy." }],
});
let text = "";
for await (const chunk of stream) {
  text += chunk.choices[0]?.delta?.content ?? "";
}
console.log(text);`;

  const shell = `export UNDERSTUDY_API_KEY=sk_••••••••
export OPENAI_API_KEY=sk-••••••••   # your existing OpenAI key — keep it`;

  return `${code}\n\n${shell}\n`;
}
