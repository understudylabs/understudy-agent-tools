"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Scope } from "../lib/nav";
import type { WorkloadSummary } from "./sidebar/ScopeSwitcher";
import {
  PAGE_SIZE,
  captureMetaRows,
  formatBytes,
  formatMaybeJson,
  formatTimestamp,
  initialScanState,
  reducePage,
  workloadIdOf,
} from "../lib/captures.mjs";
import type { ScanState as GenericScanState } from "../lib/captures.mjs";

// Faithful desktop port of the web control plane's capture surfaces
// (understudy-platform apps/web):
//   /p/:slug/logs                         — project capture list + workload filter
//   /p/:slug/workloads/:id/captures       — workload capture list
//   /p/:slug/logs/:request_id             — capture detail (meta + raw payload tabs)
// Server-rendered searchParams pagination becomes a client-side cursor
// stack; the ContinueScan auto-hop loop lives in lib/captures.mjs.

type CaptureListItem = {
  key: string;
  size: number;
  uploaded: string;
  request_id: string;
  workos_org_id: string;
  workos_api_key_id: string;
};

type CaptureListPage = {
  captures: CaptureListItem[];
  truncated: boolean;
  cursor?: string;
  skipped_malformed?: number;
  scanned_through?: string;
};

type ScanState = GenericScanState<CaptureListItem>;

type CaptureEnvelope = Record<string, unknown> & {
  request_id: string;
  provider: string;
  customer_request_body: string;
  upstream_request_body?: string | null;
  response_body: string;
};

const PAYLOAD_TABS = ["request", "upstream", "response", "metadata"] as const;
type PayloadTab = (typeof PAYLOAD_TABS)[number];

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="captures-copy"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // request_id stays visible in the cell; silent failure is fine.
        }
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function CapturesPane({ scope }: { scope: Scope }) {
  const [workloads, setWorkloads] = useState<WorkloadSummary[]>([]);
  // Filter defaults to the scoped workload (Aamir's workload Captures page);
  // "all" reads the project aggregate (the web /logs page).
  const [workloadFilter, setWorkloadFilter] = useState<string | null>(scope.workloadId);
  const [scan, setScan] = useState<ScanState>(initialScanState() as ScanState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cursors of pages "above" the current one so Newer can walk back.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [detail, setDetail] = useState<CaptureEnvelope | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<PayloadTab>("request");
  const seq = useRef(0);

  const projectId = scope.projectId;

  useEffect(() => {
    setWorkloadFilter(scope.workloadId);
  }, [scope.workloadId, scope.projectId]);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<WorkloadSummary[]>("workloads_list")
      .then((rows) => setWorkloads(rows.filter((w) => !projectId || w.project_id === projectId)))
      .catch(() => setWorkloads([]));
  }, [projectId]);

  const loadPage = useCallback(
    async (cursor: string | null, prev: ScanState) => {
      if (!projectId) return;
      const token = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const page = await invoke<CaptureListPage>("captures_list", {
          projectId,
          workloadId: workloadFilter,
          cursor,
          limit: PAGE_SIZE,
        });
        if (seq.current !== token) return;
        setScan(reducePage(prev, page) as ScanState);
      } catch (e) {
        if (seq.current !== token) return;
        setError(String(e));
      } finally {
        if (seq.current === token) setLoading(false);
      }
    },
    [projectId, workloadFilter],
  );

  // New scope or filter: restart the scan from the newest page.
  useEffect(() => {
    setDetail(null);
    setCursorStack([]);
    const fresh = initialScanState() as ScanState;
    setScan(fresh);
    if (projectId && isTauri()) void loadPage(null, fresh);
  }, [projectId, workloadFilter, loadPage]);

  // ContinueScan: follow empty-but-truncated pages automatically (replace,
  // not stack — mirrors the web's router.replace) until the hop budget.
  useEffect(() => {
    if (!loading && scan.autoContinue && scan.nextCursor) {
      setCursorStack((stack) =>
        stack.length === 0 ? [scan.nextCursor] : [...stack.slice(0, -1), scan.nextCursor],
      );
      void loadPage(scan.nextCursor, scan);
    }
  }, [scan, loading, loadPage]);

  const older = () => {
    if (!scan.nextCursor) return;
    setCursorStack((stack) => [...stack, scan.nextCursor]);
    void loadPage(scan.nextCursor, { ...scan, autoHops: 0 });
  };
  const newer = () => {
    const stack = cursorStack.slice(0, -1);
    setCursorStack(stack);
    void loadPage(stack.length > 0 ? stack[stack.length - 1] : null, {
      ...(initialScanState() as ScanState),
    });
  };

  const openDetail = async (requestId: string) => {
    if (!projectId) return;
    setDetailLoading(true);
    setError(null);
    setTab("request");
    try {
      const res = await invoke<{ capture: CaptureEnvelope }>("capture_get", {
        projectId,
        requestId,
        workloadId: workloadFilter,
      });
      setDetail(res.capture);
    } catch (e) {
      setError(String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const workloadName = (id: string | null) =>
    id ? workloads.find((w) => w.workload_id === id)?.name ?? id : null;

  if (!projectId) {
    return (
      <>
        <div className="pane-head">
          <h1 className="pane-title">Captures</h1>
          <p className="pane-sub">Gateway captures for the scoped project and workload.</p>
        </div>
        <div className="pane-body">
          <div className="card">
            <div className="card-title">No project scoped</div>
            <div className="card-sub">
              Pick a project in the sidebar scope switcher to read its capture stream.
            </div>
          </div>
        </div>
      </>
    );
  }

  // ---- detail view -------------------------------------------------------
  if (detail) {
    const wlId = workloadIdOf(detail) as string | null;
    const wlName = wlId ? workloadName(wlId) ?? wlId : "legacy";
    const rows = captureMetaRows(detail, wlName) as { label: string; value: string }[];
    const payload: Record<PayloadTab, string> = {
      request: String(detail.customer_request_body ?? ""),
      upstream: String(detail.upstream_request_body ?? "null"),
      response: String(detail.response_body ?? ""),
      metadata: JSON.stringify(detail, null, 2),
    };
    return (
      <>
        <div className="pane-head">
          <div className="card-row">
            <div>
              <h1 className="pane-title captures-mono">{String(detail.request_id)}</h1>
              <p className="pane-sub">
                request / {String(detail.provider)} — raw request and response data captured
                by the gateway.
              </p>
            </div>
            <button className="btn" type="button" onClick={() => setDetail(null)}>
              Back to captures
            </button>
          </div>
        </div>
        <div className="pane-body captures-detail">
          <div className="card">
            <div className="card-title">Capture metadata</div>
            <div className="card-sub">The scoped facts for this gateway request.</div>
            <div className="captures-meta">
              {rows.map((row) => (
                <div key={row.label} className="captures-meta-row">
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </div>
          <div className="card captures-payloads">
            <div className="card-title">Raw payloads</div>
            <div className="card-sub">Request, upstream request, response, and full metadata.</div>
            <div className="captures-tabs" role="tablist">
              {PAYLOAD_TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`captures-tab${tab === t ? " active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <pre className="captures-code">
              <code>{formatMaybeJson(payload[tab])}</code>
            </pre>
          </div>
        </div>
      </>
    );
  }

  // ---- list view ---------------------------------------------------------
  const filterName = workloadName(workloadFilter);
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Captures</h1>
        <p className="pane-sub">
          Dense trace view for requests intercepted by the gateway. Filter by workload, copy
          request ids, and open raw details for request and response bodies.
        </p>
      </div>
      <div className="pane-body">
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">Capture stream</div>
              <div className="card-sub">
                Filter by workload to compare a single call site, or read the project
                aggregate — every captured request under this project.
              </div>
            </div>
            <span className="captures-count">{scan.captures.length} shown</span>
          </div>
          <div className="captures-filters">
            <button
              type="button"
              className={`captures-filter${workloadFilter === null ? " active" : ""}`}
              onClick={() => setWorkloadFilter(null)}
            >
              all
            </button>
            {workloads.map((w) => (
              <button
                key={w.workload_id}
                type="button"
                className={`captures-filter${workloadFilter === w.workload_id ? " active" : ""}`}
                onClick={() => setWorkloadFilter(w.workload_id)}
              >
                {w.name}
              </button>
            ))}
          </div>
        </div>

        {error ? <div className="card captures-error">Could not load captures: {error}</div> : null}
        {scan.skippedMalformed > 0 ? (
          <div className="card captures-error">
            {scan.skippedMalformed} {scan.skippedMalformed === 1 ? "capture" : "captures"} on
            this page could not be displayed.
          </div>
        ) : null}

        {loading && scan.captures.length === 0 ? (
          <div className="card">
            <div className="card-sub" aria-live="polite">
              {scan.autoHops > 0 ? (
                <>
                  No matches yet — scanning older captures…
                  {scan.scannedThrough ? (
                    <>
                      {" "}
                      Searched back to <span className="captures-mono">{scan.scannedThrough}</span>.
                    </>
                  ) : null}
                </>
              ) : (
                "Loading captures…"
              )}
            </div>
          </div>
        ) : scan.exhausted && cursorStack.length === 0 ? (
          <div className="card">
            <div className="card-title">No captures yet</div>
            <div className="card-sub">
              Make a request through the gateway
              {filterName ? ` with workload ${filterName}` : ""} and it will appear here.
            </div>
            <pre className="captures-code captures-hint">
              <code>{`base_url = "https://api.understudylabs.com"
x-understudy-project = "<project slug>"
x-understudy-workload = "${filterName ?? "main"}"`}</code>
            </pre>
          </div>
        ) : scan.captures.length === 0 && scan.nextCursor && !scan.autoContinue ? (
          <div className="card">
            <div className="card-sub">
              No captures for this {workloadFilter ? "workload" : "page"} found so far.
              {scan.scannedThrough ? (
                <>
                  {" "}
                  Searched back to <span className="captures-mono">{scan.scannedThrough}</span>.
                </>
              ) : null}
            </div>
            <div className="captures-pager">
              <button className="btn" type="button" onClick={older} disabled={loading}>
                Keep searching older captures
              </button>
            </div>
          </div>
        ) : scan.captures.length > 0 ? (
          <div className="card">
            <div className="captures-table" role="table">
              <div className="captures-row captures-row-head" role="row">
                <span>captured</span>
                <span>request id</span>
                <span>key</span>
                <span className="captures-right">size</span>
              </div>
              {scan.captures.map((capture) => (
                <div className="captures-row" role="row" key={capture.key}>
                  <span>{formatTimestamp(capture.uploaded)}</span>
                  <span className="captures-id-cell">
                    <button
                      type="button"
                      className="captures-id"
                      onClick={() => void openDetail(capture.request_id)}
                    >
                      {capture.request_id}
                    </button>
                    <CopyButton value={capture.request_id} label="request id" />
                  </span>
                  <span className="captures-mono">{capture.workos_api_key_id}</span>
                  <span className="captures-right">{formatBytes(capture.size)}</span>
                </div>
              ))}
            </div>
            <div className="captures-pager">
              {workloadFilter && scan.scannedThrough ? (
                <p className="captures-scanned">
                  searched back to <span className="captures-mono">{scan.scannedThrough}</span>
                </p>
              ) : null}
              {cursorStack.length > 0 ? (
                <button className="btn" type="button" onClick={newer} disabled={loading}>
                  Newer captures
                </button>
              ) : null}
              {scan.nextCursor ? (
                <button className="btn" type="button" onClick={older} disabled={loading}>
                  {workloadFilter ? "Older captures" : "Next page"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {detailLoading ? (
          <div className="card">
            <div className="card-sub">Loading capture…</div>
          </div>
        ) : null}
      </div>
    </>
  );
}
