export type ProjectRow = {
  id: string;
  org_id?: string;
  slug: string;
  name?: string;
  created_at?: string;
  deleted_at?: string | null;
  [key: string]: unknown;
};

export function renameState(
  input: string,
  currentName: string,
): { name: string; dirty: boolean };

export function deleteConfirmed(input: string, slug: string): boolean;

export function projectForScope<T extends { id: string; slug: string }>(
  projects: T[],
  scopedProjectId: string | null,
): T | null;

export function normalizeProjects(value: unknown): ProjectRow[];
