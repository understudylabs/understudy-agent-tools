// Pure logic for the Model catalog pane's provider grouping and rate cards.
// Kept in a plain module so node --test can cover it.

/**
 * Provider inference from model ids/names. Local MLX conversions group
 * under their upstream family's provider (a "local" chip marks them).
 */
const PROVIDERS = [
  { key: "anthropic", label: "Anthropic", logo: "Anthropic.svg", match: /claude/ },
  { key: "openai", label: "OpenAI", logo: "openai-icon.svg", match: /gpt|^o\d/ },
  { key: "google", label: "Google", logo: "google-icon.svg", match: /gemma|gemini/ },
  { key: "zai", label: "Z.ai", logo: "z-ai.svg", match: /glm/ },
  { key: "qwen", label: "Qwen", logo: "qwen-icon.svg", match: /qwen/ },
  { key: "xai", label: "xAI", logo: null, match: /grok/ },
  { key: "deepseek", label: "DeepSeek", logo: "deepseek-icon.svg", match: /deepseek/ },
  { key: "moonshot", label: "Moonshot", logo: "moonshot-icon.svg", match: /kimi|moonshot/ },
  { key: "minimax", label: "MiniMax", logo: "minimax-icon.svg", match: /minimax/ },
  { key: "nvidia", label: "NVIDIA", logo: "nvidia.svg", match: /nemotron/ },
  { key: "stepfun", label: "StepFun", logo: null, match: /^step-/ },
  { key: "cohere", label: "Cohere", logo: null, match: /^command-a/ },
];
const OTHER = { key: "other", label: "Other", logo: null };

export function inferProvider(idOrName) {
  const lower = String(idOrName ?? "").toLowerCase();
  return PROVIDERS.find((p) => p.match.test(lower)) ?? OTHER;
}

/** Local MLX conversions: served from this Mac, priced at $0. */
export function isLocalModel(id) {
  return /mlx|-understudy\b|-qat\b|local/.test(String(id ?? "").toLowerCase());
}

/**
 * $/Mtoken rate card, mirroring COST_PER_MTOKEN in src/trace-author.ts
 * (the table the app already uses for cost estimates). Cached-read
 * defaults to 10% of input when the provider doesn't publish one.
 * Keys are id prefixes; longest match wins. Unknown → nulls ("—").
 */
// Customer $/MTok prices mirrored from the platform rate cards. Updated
// 2026-08-02 for the Concentrate-backed catalog expansion. Longest matching
// id prefix wins; explicit zeroes mean the route does not bill cache reads.
export const RATE_CARD = {
  // Anthropic
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // OpenAI
  "gpt-5.5": { input: 1.25, output: 10 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  // Z.ai
  "glm-5.2": { input: 0.6, output: 2.2 },
  // Google
  "gemini-3.6-flash": { input: 3, cached: 0.45, output: 22.5 },
  "gemini-3.5-flash-lite": { input: 0.6, cached: 0.09, output: 7.5 },
  "gemini-3.5-flash": { input: 3, cached: 0.45, output: 27 },
  "gemma-4-31b": { input: 0.28, cached: 0, output: 1.2 },
  "gemma-4-26b": { input: 0.14, cached: 0, output: 1.02 },
  "gemma-3-27b": { input: 0.46, cached: 0, output: 1.14 },
  "gemma-3-12b": { input: 0.18, cached: 0, output: 0.87 },
  "gemma-3-4b": { input: 0.08, cached: 0, output: 0.24 },
  // xAI
  "grok-4.20-multi-agent-0309": { input: 4, cached: 0.6, output: 18 },
  "grok-4.20-0309-reasoning": { input: 4, cached: 0.6, output: 18 },
  "grok-4.20-non-reasoning": { input: 4, cached: 0.6, output: 18 },
  "grok-build-0.1": { input: 2, cached: 0.6, output: 6 },
  "grok-4.5": { input: 4, cached: 1.5, output: 18 },
  "grok-4.3": { input: 2.5, cached: 0.6, output: 7.5 },
  "grok-3-mini": { input: 0.6, cached: 0.225, output: 1.5 },
  // DeepSeek
  "deepseek-v4": { input: 0.3, output: 0.5 },
  "deepseek": { input: 0.14, output: 0.28 },
  // Moonshot
  "kimi-k3": { input: 3, output: 15 },
  "kimi-k2": { input: 0.95, output: 4 },
  // MiniMax
  "minimax": { input: 0.3, output: 1.2 },
  // Qwen
  "qwen3.7-max": { input: 3.3, cached: 0.99, output: 14.853 },
  "qwen3.7-plus": { input: 0.552, cached: 0.168, output: 3.303 },
  "qwen3.7-flash": { input: 0.056, cached: 0.018, output: 0.33 },
  "qwen3.6-plus": { input: 0.552, cached: 0, output: 4.953 },
  "qwen3.6-flash": { input: 0.33, cached: 0, output: 2.97 },
  "qwen3.6-35b": { input: 0.496, cached: 0, output: 4.455 },
  "qwen": { input: 0.5, output: 3 },
  // NVIDIA
  "nemotron-3-ultra-nvfp4": { input: 1.2, cached: 0.4, output: 7.2 },
  "nemotron-3-nano-omni": { input: 0.4, cached: 0, output: 2.4 },
  "nemotron-3-120b": { input: 1, cached: 0, output: 4.5 },
  // StepFun
  "step-3-7-flash": { input: 0.4, cached: 0.12, output: 3.45 },
  "step-3-5-flash": { input: 0.2, cached: 0.06, output: 0.9 },
  // Cohere
  "command-a-vision": { input: 5, cached: 0, output: 30 },
  "command-a": { input: 5, cached: 0, output: 30 },
};

export function rateCardFor(id) {
  const lower = String(id ?? "").toLowerCase();
  if (isLocalModel(lower)) return { local: true, input: 0, cached: 0, output: 0 };
  let best = null;
  for (const [prefix, rate] of Object.entries(RATE_CARD)) {
    if (lower.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, rate };
    }
  }
  if (!best) return { local: false, input: null, cached: null, output: null };
  const { input, output, cached } = best.rate;
  return { local: false, input, cached: cached ?? input * 0.1, output };
}

/** "$1.40" / "$0.14" style — always two decimals so mono columns align. */
export function formatRate(value) {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

/** Group catalog rows into ordered provider sections. */
export function groupByProvider(models) {
  const sections = new Map();
  for (const model of models) {
    const provider = inferProvider(model.id);
    const section = sections.get(provider.key) ?? { provider, models: [] };
    section.models.push(model);
    sections.set(provider.key, section);
  }
  const order = [...PROVIDERS.map((p) => p.key), OTHER.key];
  return [...sections.values()].sort(
    (a, b) => order.indexOf(a.provider.key) - order.indexOf(b.provider.key),
  );
}
