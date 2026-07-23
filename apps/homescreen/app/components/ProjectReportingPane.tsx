"use client";

// SUPERSEDED: the "project-reporting" pane id now renders WorkloadsPane (the
// Cedar workload-card home with inline configuration). This table view is
// kept unreferenced for a possible per-project analytics revival.

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
} from "../lib/reporting-format.mjs";
import type {
  ReportingResult,
  UsageSummaryData,
  UsageWindow,
  WorkloadStatusEntry,
  WorkloadStatusResponse,
} from "../lib/reporting-format.mjs";

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
              <div className="card-title">Workloads</div>
              <p className="projrep-card-sub">
                Requests, cost, cache reads, errors, and traffic allocation
                per workload over the last {usageWindow}. Refreshes every 5
                minutes while this window is visible.
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
                <UsageSection
                  data={usage.data}
                  statusEntries={status?.ok ? status.data.workloads : []}
                />
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

// ---- usage table (single combined view) ----

/**
 * Observed route outcome shares — canonical vocabulary only
 * (primary | understudy | fallback), exactly as the API returns them.
 */
const ROUTE_SEGMENTS = [
  { key: "primary", className: "seg-primary" },
  { key: "understudy", className: "seg-understudy" },
  { key: "fallback", className: "seg-fallback" },
] as const;

/** Compact allocation cell: share bar + the nonzero segments as text. */
function AllocationCell({
  shares,
}: {
  shares: WorkloadStatusEntry["route_shares"];
}): ReactNode {
  const nonzero = ROUTE_SEGMENTS.filter(({ key }) => shares[key] > 0);
  return (
    <div className="projrep-alloc">
      <div
        className="projrep-share-bar"
        title={ROUTE_SEGMENTS.map(
          ({ key }) => `${key} ${formatShare(shares[key])}`,
        ).join(" · ")}
      >
        {nonzero.map(({ key, className }) => (
          <div
            key={key}
            className={className}
            style={{ width: `${shares[key] * 100}%` }}
          />
        ))}
      </div>
      <span className="projrep-alloc-label">
        {nonzero.length === 0
          ? "no traffic"
          : nonzero
              .map(({ key }) => `${key} ${formatShare(shares[key])}`)
              .join(" · ")}
      </span>
    </div>
  );
}

function UsageSection({
  data,
  statusEntries,
}: {
  data: UsageSummaryData;
  statusEntries: WorkloadStatusEntry[];
}): ReactNode {
  const daily = dailySeries(data.byDay);
  const rows = [...data.byWorkload].sort((a, b) => b.requests - a.requests);
  const totals = totalsFrom(rows);
  // Status entries key by workload id/display name; usage rows carry both.
  const statusFor = (row: (typeof rows)[number]) =>
    statusEntries.find(
      (entry) =>
        entry.workload_id === row.workload_id ||
        entry.display_name === row.workload,
    ) ?? null;
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
            <th className="num">error rate</th>
            <th>allocation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => {
            const live = statusFor(group);
            return (
              <tr key={group.workload_id ?? group.workload ?? "unattributed"}>
                <td>{group.workload ?? group.workload_id ?? "unattributed"}</td>
                <td className="num">{formatTokens(group.requests)}</td>
                <td className="num">{formatUSD(group.customer_cost_usd)}</td>
                <td className="num">{formatShare(group.cache_read_pct)}</td>
                <td className="num">
                  {live ? formatShare(live.error_rate) : "—"}
                </td>
                <td>
                  {live ? <AllocationCell shares={live.route_shares} /> : "—"}
                </td>
              </tr>
            );
          })}
          <tr className="totals">
            <td>all workloads</td>
            <td className="num">{formatTokens(totals.requests)}</td>
            <td className="num">{formatUSD(totals.costUsd)}</td>
            <td className="num">{formatShare(cacheReadShare(totals))}</td>
            <td className="num">—</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
