// Pure logic for the Model catalog pane (ported from the web control
// plane's /models page). Kept in a plain module so node --test can cover it.

/**
 * Normalize the admin API's `models` payload into display rows.
 * Tolerates partial rows; drops entries without an id.
 */
export function normalizeSupportedModels(models) {
  if (!Array.isArray(models)) return [];
  const rows = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const displayName =
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : id;
    const createdAt = typeof entry.created_at === "string" ? entry.created_at : "";
    rows.push({
      id,
      display_name: displayName,
      // Web page renders created_at.slice(0, 10) — the ISO date part.
      added: createdAt.slice(0, 10),
    });
  }
  return rows;
}

/** The curl example the web /models page renders, verbatim. */
export function catalogCurlExample(exampleModelId, gatewayUrl) {
  const base = (gatewayUrl || "https://api.understudylabs.com").replace(/\/+$/, "");
  const model = exampleModelId || "model-id";
  return `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "hello"}]
  }'`;
}
