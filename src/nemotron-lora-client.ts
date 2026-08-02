export type ModelInfo = {
  id: string;
  object?: string;
  [key: string]: unknown;
};

export type ChatMessage = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
};

export type ChatCompletionResponse = {
  id?: string;
  choices?: unknown[];
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

export class NemotronLoraClient {
  readonly baseUrl: string;
  readonly apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async listModels(): Promise<{ data: ModelInfo[]; [key: string]: unknown }> {
    return this.request("/v1/models", { method: "GET" });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async loadLoraAdapter(name: string, path: string): Promise<unknown> {
    return this.request("/v1/load_lora_adapter", {
      method: "POST",
      body: JSON.stringify({ lora_name: name, lora_path: path }),
    });
  }

  async unloadLoraAdapter(name: string): Promise<unknown> {
    return this.request("/v1/unload_lora_adapter", {
      method: "POST",
      body: JSON.stringify({ lora_name: name }),
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    if (!response.ok) {
      throw new Error(
        `Nemotron vLLM request failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    return body as T;
  }
}
