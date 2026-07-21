export type CatalogModelRow = {
  id: string;
  display_name: string;
  /** ISO date part of created_at, "" when unknown. */
  added: string;
};

export function normalizeSupportedModels(models: unknown): CatalogModelRow[];

export function catalogCurlExample(
  exampleModelId: string | null | undefined,
  gatewayUrl?: string | null,
): string;
