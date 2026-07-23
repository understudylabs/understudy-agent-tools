export type ProviderInfo = {
  key: string;
  label: string;
  /** File name under /brand/providers/, null when no logo is shipped. */
  logo: string | null;
};

export type ModelRateCard = {
  local: boolean;
  input: number | null;
  cached: number | null;
  output: number | null;
};

export function inferProvider(idOrName: string | null | undefined): ProviderInfo;
export function isLocalModel(id: string | null | undefined): boolean;
export const RATE_CARD: Record<string, { input: number; output: number; cached?: number }>;
export function rateCardFor(id: string | null | undefined): ModelRateCard;
export function formatRate(value: number | null | undefined): string;
export function groupByProvider<T extends { id: string }>(
  models: T[],
): Array<{ provider: ProviderInfo; models: T[] }>;
