type OpenAIShapeConfig = {
  apiKey: string | undefined;
  baseURL: string;
  defaultHeaders: Record<string, string>;
};

export function buildUnderstudyOpenAIConfig(env: NodeJS.ProcessEnv): OpenAIShapeConfig {
  const gatewayUrl = env.UNDERSTUDY_GATEWAY_URL ?? "https://gateway.example.test";
  return {
    apiKey: env.UNDERSTUDY_API_KEY,
    baseURL: `${gatewayUrl.replace(/\/$/, "")}/v1`,
    defaultHeaders: {
      "x-understudy-upstream-key": env.OPENAI_API_KEY ?? "",
    },
  };
}
