export type SnapshotAlias = {
  id: string;
  short_name?: string | null;
  name?: string;
};

export function modelShortName(modelId: string | null | undefined, snapshots: SnapshotAlias[]) {
  if (!modelId) return null;
  const match = snapshots.find((snapshot) => snapshot.id === modelId);
  return match?.short_name || modelId;
}
