"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Scope } from "../lib/nav";
import {
  cacheReadShare,
  dailySeries,
  formatShare,
  formatTimestamp,
  formatTokens,
  formatUSD,
  totalsFrom,
} from "../lib/projrep-format.mjs";
import type {
  ReportingResult,
  UsageSummaryData,
  UsageWindow,
  WorkloadStatusEntry,
  WorkloadStatusResponse,
} from "../lib/projrep-format.mjs";

// Web parity (apps/web .../reporting): status is fixed to the endpoint's
// max window; usage offers 7d/30d. Poll cadences match the web page and
// pause while the window is hidden.
const STATUS_WINDOW = "24h";
const USAGE_WINDOWS: readonly UsageWindow[] = ["7d", "30d"] as const;
const STATUS_POLL_MS = 60_000;
const USAGE_POLL_MS = 300_000;

type StatusResult = ReportingResult<WorkloadStatusResponse> | null;
type UsageResult = ReportingResult<UsageSummaryData> | null;

function transportFailure(): { ok: false; error: string; request_id: null } {
  return {
    ok: false,
    error: "the request never reached the reporting API.",
    request_id: null,
  };
}

/**
 * Project Analytics pane — port of the web ReportingClient. The web page
 * server-rendered initial data then re-polled two Server Actions; here
 * both loads go through the `reporting_*` Tauri commands (which hold the
 * sk_ credential natively) with the same envelope, cadence, and
 * visibility-pause semantics. Poll-only by design — no push machinery.
 */
export function ProjectReportingPane({ scope }: { scope: Scope }) {
  const projectId = scope.projectId;
  const [status, setStatus] = useState<StatusResult>(null);
  const [usage, setUsage] = useState<UsageResult>(null);
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("7d");
  const [usageLoading, setUsageLoading] = useState(false);
  const [statusFetchedAt, setStatusFetchedAt] = useState<number | null>(null);
  const [usageFetchedAt, setUsageFetchedAt] = useState<number | null>(null);
  // Discards responses of superseded usage fetches (window/project flips).
  const usageSeq = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (!projectId || !isTauri()) return;
    try {
      setStatus(
        await invoke<ReportingResult<WorkloadStatusResponse>>(
          "reporting_workload_status",
          { projectId },
        ),
      );
    } catch {
      setStatus(transportFailure());
    } finally {
      setStatusFetchedAt(Date.now());
    }
  }, [projectId]);

  const refreshUsage = useCallback(
    async (window: UsageWindow) => {
      if (!projectId || !isTauri()) return;
      const seq = ++usageSeq.current;
      setUsageLoading(true);
      try {
        const result = await invoke<ReportingResult<UsageSummaryData>>(
          "reporting_usage_summary",
          { projectId, window },
        );
        if (seq !== usageSeq.current) return;
        setUsage(result);
        setUsageFetchedAt(Date.now());
      } catch {
        if (seq !== usageSeq.current) return;
        setUsage(transportFailure());
        setUsageFetchedAt(Date.now());
      } finally {
        if (seq === usageSeq.current) setUsageLoading(false);
      }
    },
    [projectId],
  );

  // Initial load + reload when the scoped project changes.
  useEffect(() => {
    setStatus(null);
    setUsage(null);
    setStatusFetchedAt(null);
    setUsageFetchedAt(null);
    usageSeq.current += 1;
    setUsageLoading(false);
    if (!projectId) return;
    void refreshStatus();
    void refreshUsage(usageWindow);
    // usageWindow deliberately excluded: window flips refetch explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshStatus, refreshUsage]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshUsage(usageWindow);
    }, USAGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshUsage, usageWindow]);

  // Catch up when the window becomes visible after a long background stay.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (statusFetchedAt && Date.now() - statusFetchedAt > STATUS_POLL_MS) {
        void refreshStatus();
      }
      if (usageFetchedAt && Date.now() - usageFetchedAt > USAGE_POLL_MS) {
        void refreshUsage(usageWindow);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshStatus, refreshUsage, statusFetchedAt, usageFetchedAt, usageWindow]);

  function onWindowChange(next: UsageWindow) {
    if (next === usageWindow) return;
    setUsageWindow(next);
    void refreshUsage(next);
  }

  if (!projectId) {
    return (
      <>
        <PaneHead />
        <div className="pane-body">
          <div className="projrep-empty">
            Select a project in the sidebar switcher to see its analytics.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PaneHead />
      <div className="pane-body">
        <div className="card">
          <div className="projrep-card-head">
            <div>
              <div className="card-title">Workload status</div>
              <p className="projrep-card-sub">
                Observed traffic over the last {STATUS_WINDOW}. Refreshes
                every 60s while this window is visible.
              </p>
            </div>
            <UpdatedStamp at={statusFetchedAt} />
          </div>
          {status === null ? (
            <LoadingRows />
          ) : status.ok ? (
            status.data.workloads.length === 0 ? (
              <EmptyState>
                No workloads yet. Send a request through the gateway and it
                will show up here within a minute.
              </EmptyState>
            ) : (
              <div className="projrep-status-grid">
                {status.data.workloads.map((entry) => (
                  <WorkloadStatusCard key={entry.workload_id} entry={entry} />
                ))}
              </div>
            )
          ) : (
            <FetchError
              what="workload status"
              error={status.error}
              requestId={status.request_id}
              onRetry={() => void refreshStatus()}
            />
          )}
        </div>

        <div className="card">
          <div className="projrep-card-head">
            <div>
              <div className="card-title">Usage</div>
              <p className="projrep-card-sub">
                Requests, cost, and cache reads per workload over the last{" "}
                {usageWindow}. Refreshes every 5 minutes while this window is
                visible.
              </p>
            </div>
            <div className="projrep-card-actions">
              <UpdatedStamp at={usageFetchedAt} />
              {USAGE_WINDOWS.map((window) => (
                <button
                  key={window}
                  type="button"
                  className={
                    "btn projrep-window-btn" +
                    (window === usageWindow ? " primary" : "")
                  }
                  disabled={usageLoading}
                  onClick={() => onWindowChange(window)}
                >
                  {window}
                </button>
              ))}
            </div>
          </div>
          <div className={usageLoading ? "projrep-usage loading" : "projrep-usage"}>
            {usage === null ? (
              <LoadingRows />
            ) : usage.ok ? (
              usage.data.byWorkload.length === 0 ? (
                <EmptyState>No usage in this window yet.</EmptyState>
              ) : (
                <UsageSection data={usage.data} />
              )
            ) : (
              <FetchError
                what="usage summary"
                error={usage.error}
                requestId={usage.request_id}
                onRetry={() => void refreshUsage(usageWindow)}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function PaneHead(): ReactNode {
  return (
    <div className="pane-head">
      <h1 className="pane-title">Analytics</h1>
      <p className="pane-sub">
        Per-workload status and usage, straight from gateway traffic.
      </p>
    </div>
  );
}

/**
 * "updated Ns ago" stamp with its own 1s ticker. The tick state is local
 * on purpose: lifting it into the pane would re-render the whole
 * dashboard every second.
 */
function UpdatedStamp({ at }: { at: number | null }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return <span className="projrep-stamp">updated {seconds}s ago</span>;
}

function LoadingRows(): ReactNode {
  return (
    <div className="projrep-loading" aria-label="Loading">
      <div className="projrep-loading-bar" />
      <div className="projrep-loading-bar" />
      <div className="projrep-loading-bar short" />
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }): ReactNode {
  return <div className="projrep-empty">{children}</div>;
}

function CopyId({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="projrep-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function FetchError({
  what,
  error,
  requestId,
  onRetry,
}: {
  what: string;
  error: string;
  requestId: string | null;
  onRetry: () => void;
}): ReactNode {
  return (
    <div className="projrep-error">
      <p>
        Could not load {what}: {error}
      </p>
      {requestId ? (
        <p className="projrep-error-request">
          Quote this request id to support:{" "}
          <code>{requestId}</code> <CopyId value={requestId} />
        </p>
      ) : null}
      <div className="projrep-error-actions">
        <button type="button" className="btn" onClick={onRetry}>
          Retry now
        </button>
        <span>Also retries automatically on the next poll.</span>
      </div>
    </div>
  );
}

// ---- workload status cards ----

function StatusPill({
  status,
}: {
  status: WorkloadStatusEntry["status"];
}): ReactNode {
  return (
    <span className={`projrep-status-pill ${status}`}>
      <span aria-hidden="true" className="dot" />
      {status}
    </span>
  );
}

function WorkloadStatusCard({
  entry,
}: {
  entry: WorkloadStatusEntry;
}): ReactNode {
  return (
    <div className="projrep-workload-card">
      <div className="projrep-workload-head">
        <span className="projrep-workload-name">{entry.display_name}</span>
        <StatusPill status={entry.status} />
      </div>

      <dl className="projrep-ministats">
        <MiniStat
          label="requests"
          value={entry.requests.toLocaleString("en-US")}
        />
        <MiniStat label="error rate" value={formatShare(entry.error_rate)} />
        <MiniStat
          label="declared route"
          value={
            entry.declared.routed === "none"
              ? "none"
              : `${entry.declared.routed} @ ${entry.declared.split_pct}%`
          }
        />
      </dl>

      <RouteShares shares={entry.route_shares} />
      <ServedModels entry={entry} />

      {entry.last_error_at ? (
        <div className="projrep-last-error">
          <span className="muted">
            last error {formatTimestamp(entry.last_error_at)}
          </span>
          {entry.example_request_ids.slice(0, 3).map((id) => (
            <span key={id} className="projrep-request-id">
              <code>{id}</code> <CopyId value={id} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MiniStat({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="projrep-ministat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Observed route outcome shares — canonical vocabulary only
 * (primary | understudy | fallback), exactly as the API returns them.
 */
const ROUTE_SEGMENTS = [
  { key: "primary", className: "seg-primary" },
  { key: "understudy", className: "seg-understudy" },
  { key: "fallback", className: "seg-fallback" },
] as const;

function RouteShares({
  shares,
}: {
  shares: WorkloadStatusEntry["route_shares"];
}): ReactNode {
  return (
    <div className="projrep-route-shares">
      <span className="projrep-label">route shares</span>
      <div className="projrep-share-bar">
        {ROUTE_SEGMENTS.map(({ key, className }) =>
          shares[key] > 0 ? (
            <div
              key={key}
              className={className}
              style={{ width: `${shares[key] * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="projrep-share-legend">
        {ROUTE_SEGMENTS.map(({ key, className }) => (
          <span key={key}>
            <span aria-hidden="true" className={`legend-dot ${className}`} />
            {key} {formatShare(shares[key])}
          </span>
        ))}
      </div>
    </div>
  );
}

function ServedModels({ entry }: { entry: WorkloadStatusEntry }): ReactNode {
  return (
    <div className="projrep-served-models">
      <span className="projrep-label">served models</span>
      {entry.served_models.length === 0 ? (
        <span className="muted">no traffic in window</span>
      ) : (
        entry.served_models.map((served) => (
          <div key={served.model} className="projrep-served-row">
            <code>{served.model}</code>
            <span className="muted">
              {served.provider_label} · {formatShare(served.share)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ---- usage section ----

function UsageSection({ data }: { data: UsageSummaryData }): ReactNode {
  const daily = dailySeries(data.byDay);
  const rows = [...data.byWorkload].sort((a, b) => b.requests - a.requests);
  const totals = totalsFrom(rows);
  const maxRequests = Math.max(1, ...daily.map((d) => d.requests));
  return (
    <>
      <div
        className="projrep-chart"
        role="img"
        aria-label="Requests per day"
      >
        {daily.map((point) => (
          <div
            key={point.rawDay}
            className="projrep-chart-col"
            title={`${point.label}: ${formatTokens(point.requests)} requests`}
          >
            <div
              className="projrep-chart-bar"
              style={{ height: `${(point.requests / maxRequests) * 100}%` }}
            />
            <span className="projrep-chart-tick">{point.label}</span>
          </div>
        ))}
      </div>

      <table className="projrep-table">
        <thead>
          <tr>
            <th>workload</th>
            <th className="num">requests</th>
            <th className="num">cost</th>
            <th className="num">cache read</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => (
            <tr key={group.workload_id ?? group.workload ?? "unattributed"}>
              <td>{group.workload ?? group.workload_id ?? "unattributed"}</td>
              <td className="num">{formatTokens(group.requests)}</td>
              <td className="num">{formatUSD(group.customer_cost_usd)}</td>
              <td className="num">{formatShare(group.cache_read_pct)}</td>
            </tr>
          ))}
          <tr className="totals">
            <td>all workloads</td>
            <td className="num">{formatTokens(totals.requests)}</td>
            <td className="num">{formatUSD(totals.costUsd)}</td>
            <td className="num">{formatShare(cacheReadShare(totals))}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
