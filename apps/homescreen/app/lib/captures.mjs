// Pure logic for the management Captures pane (list + detail), ported from
// the hosted control plane's project logs surfaces (log list, request
// detail, and the shared format/continue-scan components).
// Kept as an .mjs module (like training-threads.mjs) so the root
// `node --test` suite can exercise it without a bundler.

/** Page size the web pages used for both list scopes. */
export const PAGE_SIZE = 25;

/**
 * How many empty scan pages the pane follows automatically before pausing
 * for a click (web ContinueScan MAX_AUTO_HOPS). The server scans a full
 * budget per page, so each hop extends coverage substantially; the pause
 * keeps a workload with genuinely nothing to find from looping forever.
 */
export const MAX_AUTO_HOPS = 4;

/** `2026-07-20T12:34:56.789Z` -> `2026-07-20 12:34:56Z` (web format.ts). */
export function formatTimestamp(iso) {
  const t = String(iso).replace("T", " ").slice(0, 19);
  return `${t}Z`;
}

/** Bytes -> human string, same thresholds as the web table (web format.ts). */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pretty-print when the payload is JSON; pass raw text through otherwise. */
export function formatMaybeJson(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Workload id of a capture envelope across schema versions, mirroring
 * `workloadIdOf` in @understudy/types: v4 `workload_id`, legacy v3
 * `placement_id`; v2 captures have neither and render as "legacy".
 */
export function workloadIdOf(capture) {
  if (!capture || typeof capture !== "object") return null;
  if (typeof capture.workload_id === "string" && capture.workload_id) {
    return capture.workload_id;
  }
  if (typeof capture.placement_id === "string" && capture.placement_id) {
    return capture.placement_id;
  }
  return null;
}

/**
 * Cursor to continue a list from, or null when the stream is exhausted.
 * Mirrors the web pages: `result.truncated && result.cursor ? cursor : null`.
 */
export function nextCursorOf(result) {
  if (!result || typeof result !== "object") return null;
  return result.truncated && typeof result.cursor === "string" && result.cursor
    ? result.cursor
    : null;
}

/**
 * Fold one fetched page into the pane's scan state. This is the client-side
 * replacement for the web's URL-searchParams pagination + ContinueScan
 * auto-hop loop:
 *
 * - rows on the page        → show them, reset the auto-hop counter
 * - empty page + cursor     → auto-continue up to MAX_AUTO_HOPS, then pause
 * - empty page + no cursor  → genuinely empty stream
 *
 * `prev` cursors stack so "Newer captures" can walk back (the web reused
 * browser history for this).
 */
export function reducePage(state, page) {
  const nextCursor = nextCursorOf(page);
  const captures = Array.isArray(page.captures) ? page.captures : [];
  const scannedThrough =
    typeof page.scanned_through === "string" ? page.scanned_through : state.scannedThrough;
  const empty = captures.length === 0;
  const autoHops = empty && nextCursor ? state.autoHops + 1 : 0;
  return {
    captures,
    nextCursor,
    scannedThrough,
    skippedMalformed:
      typeof page.skipped_malformed === "number" ? page.skipped_malformed : 0,
    autoHops,
    // Keep scanning silently while pages are empty-but-truncated.
    autoContinue: empty && nextCursor !== null && autoHops <= MAX_AUTO_HOPS,
    exhausted: empty && nextCursor === null,
  };
}

/** Fresh scan state for a new scope / filter selection. */
export function initialScanState() {
  return {
    captures: [],
    nextCursor: null,
    scannedThrough: null,
    skippedMalformed: 0,
    autoHops: 0,
    autoContinue: false,
    exhausted: false,
  };
}

/**
 * Metadata rows for the detail pane's left card, in the web page's order.
 * `workloadName` is the resolved display name (or the raw id / "legacy").
 */
export function captureMetaRows(capture, workloadName) {
  const rows = [
    { label: "status", value: String(capture.status_code) },
    { label: "latency", value: `${capture.latency_ms} ms (first byte)` },
    { label: "workload", value: workloadName },
    { label: "requested model", value: String(capture.requested_model ?? "") },
    {
      label: "served model",
      value: String(capture.upstream_model ?? capture.requested_model ?? ""),
    },
    { label: "mode", value: `${capture.mode} · ${capture.provider}` },
    { label: "captured", value: formatTimestamp(capture.ts) },
  ];
  if (capture.tags && Object.keys(capture.tags).length > 0) {
    rows.push({
      label: "tags",
      value: Object.entries(capture.tags)
        .map(([key, tagValue]) => `${key}=${tagValue}`)
        .join("  "),
    });
  }
  return rows;
}
