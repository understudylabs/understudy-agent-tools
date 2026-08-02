// Experiment notes, receipts, and reproduction commands: ./README.md

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference";

export function fireworksCallModel({
  model,
  baseUrl = DEFAULT_BASE_URL,
  temperature = 0,
  maxTokens,
  timeoutMs = 120_000,
  toolChoice = "auto",
  onResponse,
}) {
  if (!model) throw new Error("model is required");
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
  const receipts = [];
  const callModel = async (messages, tools, requestContext = {}) => {
    let delay = 250;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const started = performance.now();
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.FIREWORKS_API_KEY ?? ""}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: toolChoice,
          temperature,
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        }),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (response.ok) {
        const payload = await response.json();
        const requestUsage = payload.usage ?? {};
        usage.prompt_tokens += Number(requestUsage.prompt_tokens ?? 0);
        usage.completion_tokens += Number(requestUsage.completion_tokens ?? 0);
        usage.total_tokens += Number(requestUsage.total_tokens ?? 0);
        usage.requests += 1;
        receipts.push({ latency_ms: latencyMs, usage: { ...requestUsage } });
        const choice = payload.choices?.[0] ?? {};
        requestContext.finishReason = choice.finish_reason ?? null;
        onResponse?.({
          finishReason: requestContext.finishReason,
          latencyMs,
          usage: requestUsage,
          context: requestContext,
        });
        return choice.message ?? { role: "assistant", content: "" };
      }
      if (attempt === 5 || (response.status < 500 && response.status !== 429)) {
        throw new Error(`Fireworks chat completion failed (${response.status}): ${await response.text()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
    throw new Error("Fireworks retry loop exhausted");
  };
  callModel.model = model;
  callModel.usage = usage;
  callModel.receipts = receipts;
  return callModel;
}
