import { request } from "./internal/http.js";
import { parseBillingWindow } from "./internal/reporting-contracts.js";
import {
  WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN,
  WorkloadTraceExportPageRequestSchema,
  WorkloadTraceExportPageSchema,
  type WorkloadTraceExportCapture,
  type WorkloadTraceExportPageRequest,
  type WorkloadTraceExportScope,
} from "./workload-trace-export.js";

const DAY_MS = 86_400_000;
const MAX_MATCHES = 100_000;

export interface CaptureSearchWindow {
  from: string;
  to: string;
}

export interface CaptureSearchInput extends CaptureSearchWindow {
  orgId: string;
  projectId: string;
  workloadId: string;
  now?: Date;
  requestPage?: (body: WorkloadTraceExportPageRequest) => Promise<unknown>;
}

export interface CaptureSearchResult {
  window: CaptureSearchWindow;
  index_window: CaptureSearchWindow;
  ingestion_cutoff: string;
  captures: Array<{ request_id: string; captured_at: string }>;
  scanned_count: number;
  pages: number;
}

export function resolveCaptureSearchWindow(input: {
  from?: string;
  to?: string;
  now?: Date;
}): CaptureSearchWindow {
  if (!input.from || !input.to) {
    throw new Error("Capture time search requires both --from and --to.");
  }
  if ([input.from, input.to].some(value => /\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim()))) {
    throw new Error("Capture search timestamps support at most millisecond precision (three fractional digits).");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("Current time is invalid.");
  const window = parseBillingWindow(input.from, input.to);
  if (Date.parse(window.to) > now.valueOf()) {
    throw new Error("Capture search --to cannot be in the future.");
  }
  if (Date.parse(window.to) - Date.parse(window.from) > DAY_MS) {
    throw new Error("Capture search supports a window of at most 24 hours. Narrow --from and --to.");
  }
  return window;
}

/** Read index metadata only; returned URLs are never fetched or exposed. */
export async function searchWorkloadCaptures(input: CaptureSearchInput): Promise<CaptureSearchResult> {
  const now = input.now ?? new Date();
  const window = resolveCaptureSearchWindow({ ...input, now });
  if (![input.orgId, input.projectId, input.workloadId].every(value => value?.trim())) {
    throw new Error("Capture search requires an organization, project, and workload.");
  }
  // The existing export API requires exactly 24 hours. Historical searches
  // start at the requested instant; recent searches use the last 24 hours.
  const indexStart = Math.min(Date.parse(window.from), now.valueOf() - DAY_MS);
  const indexWindow = {
    from: new Date(indexStart).toISOString(),
    to: new Date(indexStart + DAY_MS).toISOString(),
  };
  const requestPage = input.requestPage ?? (async (body: WorkloadTraceExportPageRequest) => {
    const route = WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN
      .replace(":org_id", encodeURIComponent(input.orgId))
      .replace(":project_id", encodeURIComponent(input.projectId))
      .replace(":workload_id", encodeURIComponent(input.workloadId));
    const response = await request({
      url: `/admin/v1${route}`,
      method: "POST",
      orgId: input.orgId,
      signal: AbortSignal.timeout(60_000),
      body: WorkloadTraceExportPageRequestSchema.parse(body),
    }, WorkloadTraceExportPageSchema);
    return response.data;
  });
  const captures: CaptureSearchResult["captures"] = [];
  const seenCursors = new Set<string>();
  const seenRequests = new Set<string>();
  let scope: WorkloadTraceExportScope | null = null;
  let cursor: string | null = null;
  let previous: WorkloadTraceExportCapture | null = null;
  let scannedCount = 0;
  let pages = 0;
  do {
    const body = WorkloadTraceExportPageRequestSchema.parse({
      ...indexWindow,
      ...(cursor === null ? {} : { cursor, ingestion_cutoff: scope!.ingestion_cutoff }),
    });
    const parsed = WorkloadTraceExportPageSchema.safeParse(await requestPage(body));
    if (!parsed.success) throw new Error("Capture search returned invalid export metadata.");
    const page = parsed.data;
    assertScope(input, indexWindow, page.canonical_scope, scope, now.valueOf());
    scope ??= page.canonical_scope;
    pages += 1;
    if (page.captures.length === 0 && page.next_cursor !== null) {
      throw new Error("Capture search returned an empty non-terminal page.");
    }
    if (page.next_cursor !== null && seenCursors.has(page.next_cursor)) {
      throw new Error("Capture search repeated a continuation cursor.");
    }
    let reachedEnd = false;
    for (const capture of page.captures) {
      assertReference(input, indexWindow, capture);
      if (previous !== null && compareReferences(previous, capture) >= 0) {
        throw new Error("Capture search returned repeated or out-of-order references.");
      }
      previous = capture;
      scannedCount += 1;
      const at = Date.parse(capture.captured_at);
      if (at >= Date.parse(window.to)) reachedEnd = true;
      if (at >= Date.parse(window.from) && at < Date.parse(window.to)) {
        if (seenRequests.has(capture.request_id)) {
          throw new Error("Capture search repeated a request identifier.");
        }
        if (captures.length === MAX_MATCHES) {
          throw new Error("Capture search exceeds 100000 matching references. Narrow --from and --to; no partial result was returned.");
        }
        seenRequests.add(capture.request_id);
        captures.push({ request_id: capture.request_id, captured_at: new Date(at).toISOString() });
      }
    }
    if (reachedEnd) break;
    cursor = page.next_cursor;
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);
  return {
    window,
    index_window: indexWindow,
    ingestion_cutoff: scope!.ingestion_cutoff,
    captures,
    scanned_count: scannedCount,
    pages,
  };
}

function assertScope(
  input: CaptureSearchInput,
  window: CaptureSearchWindow,
  current: WorkloadTraceExportScope,
  frozen: WorkloadTraceExportScope | null,
  now: number,
): void {
  if (current.org_id !== input.orgId || current.project_id !== input.projectId ||
      current.workload_id !== input.workloadId || current.from !== window.from || current.to !== window.to ||
      Date.parse(current.ingestion_cutoff) < Date.parse(window.to) ||
      Date.parse(current.ingestion_cutoff) > now + 60_000) {
    throw new Error("Capture search response changed the requested scope or index window.");
  }
  if (frozen !== null && current.ingestion_cutoff !== frozen.ingestion_cutoff) {
    throw new Error("Capture search response changed its frozen ingestion cutoff.");
  }
}

function assertReference(input: CaptureSearchInput, window: CaptureSearchWindow, capture: WorkloadTraceExportCapture): void {
  const parts = capture.capture_key.split("/");
  if (!capture.capture_key.startsWith(`${input.orgId}/${input.projectId}/`) ||
      !capture.capture_key.endsWith(`/${capture.request_id}.jsonl`) ||
      parts.length < 7 || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("Capture search returned a reference outside the requested scope.");
  }
  const at = Date.parse(capture.captured_at);
  if (!Number.isFinite(at) || at < Date.parse(window.from) || at >= Date.parse(window.to)) {
    throw new Error("Capture search returned a reference outside the index window.");
  }
}

function compareReferences(left: WorkloadTraceExportCapture, right: WorkloadTraceExportCapture): number {
  const timeOrder = Date.parse(left.captured_at) - Date.parse(right.captured_at);
  if (timeOrder !== 0) return timeOrder;
  for (const key of ["request_id", "capture_key"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}
