export type SnapshotAlias = {
  id: string;
  short_name?: string | null;
  name?: string;
};

const FALLBACK_ALIASES: Record<string, string> = {
  "gemma-4-e2b-it-qat-mlx-vlm-understudy": "understudy-small",
  "gemma-4-e2b-it-qat-mlx-vlm-4bit-understudy": "understudy-small",
  "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy": "understudy-fast",
  "gemma-4-26b-a4b-it-qat-mlx-vlm-4bit-understudy": "understudy-fast",
};

function canonicalModelId(modelId: string) {
  return modelId
    .split("/")
    .pop()!
    .replace(/-4-bit/g, "-4bit");
}

export function modelShortName(modelId: string | null | undefined, snapshots: SnapshotAlias[]) {
  if (!modelId) return null;
  const canonical = canonicalModelId(modelId);
  const match = snapshots.find((snapshot) => canonicalModelId(snapshot.id) === canonical);
  return match?.short_name || FALLBACK_ALIASES[canonical] || modelId;
}
