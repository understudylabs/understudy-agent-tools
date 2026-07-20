export type TinkerPriceCatalogEntry = {
  model: string;
  prefill_usd_per_million: number;
  sample_usd_per_million: number;
  train_usd_per_million: number;
  preference: number;
};

export const TINKER_PRICE_CATALOG = Object.freeze({
  schema_version: "understudy.tinker.price_catalog.v1",
  checked_at: "2026-07-19T00:00:00.000Z",
  expires_at: "2026-08-19T00:00:00.000Z",
  source_url: "https://tinker-docs.thinkingmachines.ai/tinker/models/",
  // The provider prices checkpoints by stored GB/month, but their size is not
  // known before training. Reserve one cent and expire sampler weights after an
  // hour so the preflight remains fail-closed instead of silently omitting it.
  checkpoint_storage_reserve_usd: 0.01,
  entries: Object.freeze<TinkerPriceCatalogEntry[]>([
    {
      model: "Qwen/Qwen3.5-4B",
      prefill_usd_per_million: 0.33,
      sample_usd_per_million: 1.005,
      train_usd_per_million: 0.737,
      preference: 1,
    },
    {
      model: "Qwen/Qwen3-8B",
      prefill_usd_per_million: 0.195,
      sample_usd_per_million: 0.6,
      train_usd_per_million: 0.44,
      preference: 2,
    },
    {
      model: "openai/gpt-oss-20b",
      prefill_usd_per_million: 0.18,
      sample_usd_per_million: 0.45,
      train_usd_per_million: 0.396,
      preference: 3,
    },
  ]),
} as const);
