const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";

export class CostLedger {
  constructor({ inputUsdPerMillion = 0, outputUsdPerMillion = 0, budgetUsd = Infinity } = {}) {
    this.inputUsdPerMillion = inputUsdPerMillion;
    this.outputUsdPerMillion = outputUsdPerMillion;
    this.budgetUsd = budgetUsd;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.usd = 0;
  }

  add(usage = {}) {
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completion ?? 0);
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.usd += (prompt * this.inputUsdPerMillion + completion * this.outputUsdPerMillion) / 1e6;
    if (this.usd > this.budgetUsd) throw new Error(`budget cap exceeded: $${this.usd.toFixed(6)} > $${this.budgetUsd.toFixed(6)}`);
    return { prompt, completion };
  }

  snapshot() {
    return { prompt: this.promptTokens, completion: this.completionTokens, usd: this.usd };
  }
}

export class FireworksClient {
  constructor({ apiKey = process.env.FIREWORKS_API_KEY, baseUrl = DEFAULT_BASE_URL, model, concurrency = 8, retries = 3, ledger } = {}) {
    if (!apiKey) throw new Error("FIREWORKS_API_KEY is required for the Fireworks client");
    if (!model) throw new Error("model is required for the Fireworks client");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.retries = retries;
    this.ledger = ledger ?? new CostLedger();
    this.slots = Promise.resolve();
    this.concurrency = Math.max(1, concurrency);
    this.active = 0;
    this.queue = [];
    this.telemetry = { requests: 0, retries: 0, rate_limit_429s: 0 };
  }

  async acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    this.queue.shift()?.();
  }

  async chat(messages, options = {}) {
    await this.acquire();
    this.telemetry.requests += 1;
    try {
      let lastError;
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        try {
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: options.model ?? this.model, messages, temperature: options.temperature ?? 0, max_tokens: options.maxTokens ?? 2048 }),
          });
          if (!response.ok) {
            if (![429, 500, 502, 503, 504].includes(response.status) || attempt === this.retries) throw new Error(`Fireworks HTTP ${response.status}: ${await response.text()}`);
            this.telemetry.retries += 1;
            if (response.status === 429) this.telemetry.rate_limit_429s += 1;
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
            continue;
          }
          const body = await response.json();
          const usage = this.ledger.add(body.usage);
          return { message: body.choices?.[0]?.message ?? { content: "" }, finishReason: body.choices?.[0]?.finish_reason ?? null, usage };
        } catch (error) {
          lastError = error;
          if (attempt === this.retries) throw error;
        }
      }
      throw lastError;
    } finally {
      this.release();
    }
  }
}
