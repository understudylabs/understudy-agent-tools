export interface SnippetParams {
  gatewayUrl: string;
}

/**
 * Anthropic-SDK shape of the BYO patch. The customer's existing
 * `ANTHROPIC_API_KEY` rides on `x-understudy-upstream-key`; the
 * Understudy `sk_*` from `~/.understudy/credentials.json` is the primary
 * auth the gateway validates. The gateway looks up the upstream key
 * from the header and forwards to `api.anthropic.com` on the customer's
 * behalf.
 *
 * `baseURL` does NOT end in `/v1` — the Anthropic SDK prepends `/v1/`
 * to every path itself.
 */
export function renderSnippet({ gatewayUrl }: SnippetParams): string {
  const base = gatewayUrl.replace(/\/v1\/?$/, "");
  const code = `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.UNDERSTUDY_API_KEY,
  baseURL: "${base}",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
  },
});

// Always stream gateway calls: the edge cuts responses with no first byte
// within ~125s, so non-streaming calls can 524 on slow generations.
// finalMessage() aggregates the stream back into one Message object.
const msg = await client.messages
  .stream({
    model: "claude-opus-4-7",
    max_tokens: 256,
    messages: [{ role: "user", content: "Say hello from Understudy." }],
  })
  .finalMessage();
console.log(msg.content[0].type === "text" ? msg.content[0].text : "");`;

  const shell = `export UNDERSTUDY_API_KEY=sk_••••••••
export ANTHROPIC_API_KEY=sk-ant-••••••••   # your existing Anthropic key — keep it`;

  return `${code}\n\n${shell}\n`;
}
