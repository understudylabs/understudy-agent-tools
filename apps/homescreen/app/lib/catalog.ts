// Curated model data for the Models + Marketplace tabs.
//
// Reality: there is no live pricing feed and no structured benchmark dump. Past
// experimental numbers live in Moraine traces + on-disk model sizes. So this is a
// CURATED dataset, cited per data point, structured so live local benchmarks and
// org-wide / individual datasets can be merged in later via the DataSource seam.

export type Provider =
  | "local"
  | "understudy"
  | "openai"
  | "anthropic"
  | "google"
  | "zai"
  | "moonshot"
  | "minimax"
  | "nvidia"
  | "other";

export type SourceKind = "measured" | "research" | "advertised";

export type BenchmarkPoint = {
  model: string;
  family: string;
  quant?: string;
  tok_per_sec?: number; // generation tok/s (local, on an M5 Max / 128GB)
  prompt_tok_per_sec?: number;
  mem_gb?: number; // resident unified memory
  load_ms?: number; // cold load
  source: string;
  source_kind: SourceKind;
};

export type MarketEntry = {
  model: string;
  display_name: string;
  provider: Provider;
  route?: string; // local path | gateway model id
  context?: number; // tokens
  price_in?: number; // $ / Mtok input
  price_out?: number; // $ / Mtok output
  tok_per_sec?: number; // advertised (cloud) or measured (local)
  quality?: number; // 0..100, internal/leaderboard
  note?: string;
};

// ---------------------------------------------------------------------------
// Seed: Gemma 4 family on Apple M5 Max / 128 GB. Memory figures are measured
// from the on-disk model directories; the QAT tok/s is measured from a past
// understudy lab session; others are marked pending a live benchmark run.
// ---------------------------------------------------------------------------
export const curatedBenchmarks: BenchmarkPoint[] = [
  {
    model: "gemma-4-26b-a4b-it-qat-mlx-vlm-4bit",
    family: "Gemma 4 26B (A4B MoE)",
    quant: "qat · 4bit",
    tok_per_sec: 108.3,
    mem_gb: 17,
    source: "understudy lab · calm-sailor session · 2026-06-27",
    source_kind: "measured",
  },
  {
    model: "gemma-4-26b-a4b-it-optiq-4bit",
    family: "Gemma 4 26B (A4B MoE)",
    quant: "optiq · 4bit",
    mem_gb: 17.6,
    source: "dir size measured · tok/s pending benchmark",
    source_kind: "research",
  },
  {
    model: "gemma-4-26b-a4b-it-mlx-vlm-bf16",
    family: "Gemma 4 26B (A4B MoE)",
    quant: "bf16",
    mem_gb: 52,
    source: "understudy lab · bf16 load observed · 2026-06-27",
    source_kind: "research",
  },
  {
    model: "gemma-4-12b-it-optiq-4bit",
    family: "Gemma 4 12B",
    quant: "optiq · 4bit",
    mem_gb: 8.4,
    source: "dir size measured · tok/s pending benchmark",
    source_kind: "research",
  },
  {
    model: "gemma-4-e2b-it-qat-mlx-vlm-4bit",
    family: "Gemma 4 E2B",
    quant: "qat · 4bit",
    mem_gb: 3.3,
    source: "dir size measured · tok/s pending benchmark",
    source_kind: "research",
  },
];

// ---------------------------------------------------------------------------
// Seed marketplace: advertised provider pricing (NOT authoritative — verify) +
// an Understudy-inference entry for the route we ship today (glm-5.2). Prices
// are $/Mtok, approximate public list; the point is the comparison scaffold.
// ---------------------------------------------------------------------------
export const curatedMarketplace: MarketEntry[] = [
  { model: "glm-5.2", display_name: "GLM 5.2", provider: "understudy", route: "glm-5.2", context: 128000, price_in: 0.6, price_out: 2.2, tok_per_sec: 90, quality: 84, note: "Understudy inference · default cloud route" },
  { model: "gpt-5.4", display_name: "GPT-5.4", provider: "openai", context: 400000, price_in: 1.25, price_out: 10, quality: 92 },
  { model: "gpt-5.4-mini", display_name: "GPT-5.4 mini", provider: "openai", context: 400000, price_in: 0.15, price_out: 0.6, quality: 78 },
  { model: "gpt-5.4-nano", display_name: "GPT-5.4 nano", provider: "openai", context: 400000, price_in: 0.05, price_out: 0.2, quality: 64 },
  { model: "claude-opus-4-8", display_name: "Claude Opus 4.8", provider: "anthropic", context: 200000, price_in: 5, price_out: 25, quality: 90 },
  { model: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", provider: "anthropic", context: 200000, price_in: 3, price_out: 15, quality: 88 },
  { model: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", provider: "anthropic", context: 200000, price_in: 0.8, price_out: 4, quality: 76 },
  { model: "gemma-4-31b-it", display_name: "Gemma 4 (31B)", provider: "google", context: 256000, price_in: 0.7, price_out: 1.2, quality: 82 },
  { model: "kimi-k2.6", display_name: "Kimi K2.6", provider: "moonshot", context: 256000, price_in: 0.6, price_out: 2.5, quality: 81 },
  { model: "nemotron-3-ultra", display_name: "Nemotron 3 Ultra", provider: "nvidia", context: 128000, price_in: 0.5, price_out: 1.5, quality: 80 },
];

// ---------------------------------------------------------------------------
// Source seam. Today: a single curated source. Tomorrow: implement DataSource
// again for `benchmarks` (live SQLite reads) and org-wide / individual datasets,
// then add to `sources`. The UI merges across all sources.
// ---------------------------------------------------------------------------
export interface DataSource {
  id: string;
  label: string;
  benchmarks: () => BenchmarkPoint[];
  marketplace: () => MarketEntry[];
}

export const curatedSource: DataSource = {
  id: "curated",
  label: "Curated · understudy research",
  benchmarks: () => curatedBenchmarks,
  marketplace: () => curatedMarketplace,
};

export const sources: DataSource[] = [curatedSource];

export function allBenchmarks(): BenchmarkPoint[] {
  return sources.flatMap((s) => s.benchmarks());
}
export function allMarketplace(): MarketEntry[] {
  return sources.flatMap((s) => s.marketplace());
}
export function sourceLabels(): string[] {
  return sources.map((s) => s.label);
}
