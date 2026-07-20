import rawModelCards from "../../src-tauri/knowledge/model_cards.json";

export type ModelCardProvenance = {
  base_model: string;
  source_checkpoint: string;
  conversion: string;
  understudy_training: string;
  license: string;
};

export type ModelCardDecodeContract = {
  temperature: number;
  top_p: number;
  top_k: number;
  warning: string;
  required_server_flags: string[];
};

export type ModelCardCertification = {
  status: string;
  scope: string;
  verified: string[];
  certified_at: string;
};

export type ModelCardFootprint = {
  disk_gb: number;
  peak_runtime_memory_gb?: number;
  runtime: string;
};

export type ModelCardRoutingHints = {
  role: string;
  escalate_when: string[];
  escalate_to: string;
};

export type PublicModelCard = {
  id: string;
  card_schema?: string;
  alias?: string;
  alias_for?: string;
  provenance?: ModelCardProvenance;
  decode_contract?: ModelCardDecodeContract;
  certification?: ModelCardCertification;
  footprint?: ModelCardFootprint;
  routing_hints?: ModelCardRoutingHints;
};

export type DetailedPublicModelCard = PublicModelCard & {
  provenance: ModelCardProvenance;
  decode_contract: ModelCardDecodeContract;
  certification: ModelCardCertification;
  footprint: ModelCardFootprint;
  routing_hints: ModelCardRoutingHints;
};

const cards = rawModelCards as PublicModelCard[];
const cardsById = new Map(cards.map((card) => [card.id.toLowerCase(), card]));

export function normalizeModelCardId(modelId: string): string {
  const withoutRoute = modelId.replace(/^(?:local|cloud|anthropic):/i, "");
  const basename = withoutRoute.split(/[\\/]/).filter(Boolean).at(-1) ?? withoutRoute;
  return basename.toLowerCase().replaceAll("-4-bit", "-4bit");
}

export function isDetailedModelCard(card: PublicModelCard | null): card is DetailedPublicModelCard {
  return Boolean(
    card?.provenance &&
    card.decode_contract &&
    card.certification &&
    card.footprint &&
    card.routing_hints,
  );
}

export function modelCardFor(modelId: string): PublicModelCard | null {
  let card = cardsById.get(normalizeModelCardId(modelId));
  const visited = new Set<string>();
  while (card?.alias_for && !visited.has(card.id)) {
    visited.add(card.id);
    card = cardsById.get(card.alias_for.toLowerCase());
  }
  return card ?? null;
}

export function compactModelId(modelId: string): string {
  return normalizeModelCardId(modelId)
    .replace(/^gemma-4-/, "")
    .replace(/-it-qat-mlx-vlm(?:-4bit)?-understudy$/, "")
    .replaceAll("-", " ")
    .toUpperCase();
}
