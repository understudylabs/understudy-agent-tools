// Pure logic for the Settings pane — the desktop port of the web control
// plane's org/project settings pages. Kept in a plain .mjs module (with a
// .d.mts twin) so the repo's node --test suite exercises it directly, the
// same pattern as chat-stream-batcher / training-flow.

/**
 * Mirrors the web RenameCard's `dirty` gate: the Save button enables only
 * when the trimmed input is non-empty and differs from the current name.
 * @param {string} input
 * @param {string} currentName
 * @returns {{ name: string, dirty: boolean }}
 */
export function renameState(input, currentName) {
  const name = String(input ?? "").trim();
  return { name, dirty: name.length > 0 && name !== currentName };
}

/**
 * Mirrors the web DangerZoneCard's confirmation gate: the user must type
 * the project slug exactly (no trimming — the web compares verbatim).
 * @param {string} input
 * @param {string} slug
 * @returns {boolean}
 */
export function deleteConfirmed(input, slug) {
  return typeof slug === "string" && slug.length > 0 && input === slug;
}

/**
 * Picks the project the pane should show: the scoped project when it is in
 * the list, otherwise the first project, otherwise null (empty state).
 * @param {Array<{ id: string, slug: string }>} projects
 * @param {string | null} scopedProjectId
 * @returns {{ id: string, slug: string } | null}
 */
export function projectForScope(projects, scopedProjectId) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (scopedProjectId) {
    const scoped = projects.find(
      (p) => p.id === scopedProjectId || p.slug === scopedProjectId,
    );
    if (scoped) return scoped;
  }
  return projects[0];
}

/**
 * Normalizes the `GET orgs/:org/projects` response: `{ projects: [...] }`,
 * dropping soft-deleted rows and anything without an id and slug.
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeProjects(value) {
  const list =
    value && typeof value === "object" && Array.isArray(value.projects)
      ? value.projects
      : [];
  return list.filter(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof p.id === "string" &&
      typeof p.slug === "string" &&
      !p.deleted_at,
  );
}
