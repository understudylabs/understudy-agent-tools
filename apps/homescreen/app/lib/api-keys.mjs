// Pure logic for the API-keys management pane, extracted so `node --test`
// can exercise it (tests/api-keys-pane.test.mjs). Ported from the web
// control plane's app/keys/* — same formats, same envelope handling.

/**
 * YYYY-MM-DD is the densest readable format and matches the dashboard's
 * "memo, not SaaS hero" tone. (Verbatim from apps/web KeysSection.)
 * @param {string} iso
 */
export function formatDate(iso) {
  return typeof iso === "string" ? iso.slice(0, 10) : "";
}

/** @param {string | null | undefined} iso */
export function formatLastUsed(iso) {
  return iso ? formatDate(iso) : "never";
}

/**
 * Narrow the gateway's `{ keys: KeyMetadata[] }` envelope into rows the
 * table can render. Entries missing an id are dropped rather than crashing
 * the pane on a shape drift.
 * @param {unknown} envelope
 * @returns {Array<{id: string, name: string, obfuscated_value: string, created_at: string, last_used_at: string | null}>}
 */
export function normalizeKeys(envelope) {
  const keys =
    envelope && typeof envelope === "object" && Array.isArray(envelope.keys)
      ? envelope.keys
      : [];
  const rows = [];
  for (const k of keys) {
    if (!k || typeof k !== "object" || typeof k.id !== "string") continue;
    rows.push({
      id: k.id,
      name: typeof k.name === "string" ? k.name : "",
      obfuscated_value:
        typeof k.obfuscated_value === "string" ? k.obfuscated_value : "sk_…",
      created_at: typeof k.created_at === "string" ? k.created_at : "",
      last_used_at:
        typeof k.last_used_at === "string" ? k.last_used_at : null,
    });
  }
  return rows;
}

/**
 * Tauri `invoke` rejections arrive as plain strings (our Rust commands
 * return `Result<_, String>`), but keep Error and unknown shapes readable.
 * @param {unknown} err
 * @param {string} fallback
 */
export function invokeErrorMessage(err, fallback) {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
