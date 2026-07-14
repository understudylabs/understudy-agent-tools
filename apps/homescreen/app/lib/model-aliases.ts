export type SnapshotAlias = {
  id: string;
  short_name?: string | null;
  name?: string;
};

// Offline fallback only. Short names are owned by the model catalog
// (live /catalog via the Rust snapshot cache, else knowledge/snapshots.json):
// `modelShortName` always prefers the `short_name` on the snapshot rows the
// caller passes in. This map covers callers with no snapshot rows in hand
// (e.g. the sidekick header) plus legacy alias ids, and must stay in sync
// with the catalog's short_names. Locally installed Understudy artifacts may
// appear here before they are promoted into the public pullable catalog; that
// keeps internal checkpoint ids out of the chat UI without advertising them.
const FALLBACK_ALIASES: Record<string, string> = {
  "gemma-4-e2b-it-qat-mlx-vlm-understudy": "understudy-small",
  "gemma-4-e2b-it-qat-mlx-vlm-4bit-understudy": "understudy-small",
  "gemma-4-e4b-it-qat-mlx-vlm-understudy": "understudy-balanced",
  "gemma-4-e4b-it-qat-mlx-vlm-4bit-understudy": "understudy-balanced",
  "gemma-4-12b-it-qat-mlx-vlm-understudy": "understudy-quality",
  "gemma-4-12b-it-qat-mlx-vlm-4bit-understudy": "understudy-quality",
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
