"use client";

// Organization Analytics — faithful desktop port of the web control plane's
// reporting surface (app/(control-plane)/reporting/ReportingClient.tsx).
// The web's Server Action refresh path becomes the `org_reporting` Tauri
// command; the closed-vocabulary sanitizer runs client-side in
// lib/reporting.mjs (`sanitizeReportingQuery`) so malformed filter state
// never fans out, and auth-expired renders the same inline
// ok/error/request-id card instead of breaking the refresh loop.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, RefreshCwIcon } from "lucide-react";
import {
  aggregateBreakdown,
  cacheReadShare,
  defaultGranularity,
  defaultSort,
  dateDaysAgo,
  dateInputValue,
  formatPercent,
  formatRange,
  formatTokens,
  formatUSD,
  granularityLabel,
  granularityOptions,
  groupByLabel,
  groupedChart,
  presetRangeState,
  sanitizeReportingQuery,
  sortBreakdown,
  sortIsVisible,
  toggleSeries,
  type BreakdownColumn,
  type ReportingData,
  type ReportingGranularity,
  type ReportingGroupBy,
  type ReportingMetric,
  type ReportingRange,
  type ReportingResult,
  type ReportingWindow,
  type SortState,
} from "../lib/reporting.mjs";

type FilterState = {
  range: ReportingRange;
  window: ReportingWindow;
  from: string;
  to: string;
  granularity: ReportingGranularity;
  groupBy: ReportingGroupBy;
  projectId: string | null;
  workloadId: string | null;
};

const ALL = "__all__";

// Canonical model colors from the app's globals.css (design system v2.0)
// stand in for the web's --color-chart-1..5.
const PALETTE = [
  "var(--model-mint)",
  "var(--model-violet)",
  "var(--model-amber)",
  "var(--model-cyan)",
  "var(--model-clay)",
] as const;

export function ReportingPane() {
  const [result, setResult] = useState<ReportingResult<ReportingData> | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => ({
    range: "7d",
    window: "7d",
    from: dateDaysAgo(6),
    to: dateInputValue(new Date().toISOString()),
    granularity: "day",
    groupBy: "project",
    projectId: null,
    workloadId: null,
  }));
  const [metric, setMetric] = useState<ReportingMetric>("usage");
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async (next: FilterState) => {
    const sequence = ++requestSequence.current;
    setFilters(next);
    setLoading(true);
    try {
      if (!isTauri()) {
        setResult({
          ok: false,
          error: "Organization analytics is only available in the desktop app.",
          request_id: null,
        });
        return;
      }
      const isPreset = next.range === "24h" || next.range === "7d" || next.range === "30d";
      const query = sanitizeReportingQuery({
        window: next.window,
        from: isPreset ? null : next.from,
        to: isPreset ? null : next.to,
        granularity: next.granularity,
        groupBy: next.groupBy,
        projectId: next.projectId,
        workloadId: next.workloadId,
      });
      const response = await invoke<ReportingResult<ReportingData>>("org_reporting", { query });
      if (sequence === requestSequence.current) setResult(response);
    } catch {
      if (sequence === requestSequence.current) {
        setResult({
          ok: false,
          error: "Analytics could not be refreshed. Try again shortly.",
          request_id: null,
        });
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh({
      range: "7d",
      window: "7d",
      from: dateDaysAgo(6),
      to: dateInputValue(new Date().toISOString()),
      granularity: "day",
      groupBy: "project",
      projectId: null,
      workloadId: null,
    });
  }, [refresh]);

  const data = result?.ok ? result.data : null;
  const workloads = useMemo(
    () =>
      data?.options.workloads.filter(
        (workload) => !filters.projectId || workload.project_id === filters.projectId,
      ) ?? [],
    [data?.options.workloads, filters.projectId],
  );

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Analytics</h1>
        <p className="pane-sub">
          Usage and estimated cost across every project. Filters only change this view;
          workload routing and capture controls stay in the project workbench.
        </p>
      </div>
      <div className="pane-body">
        <div className="card reporting-filters">
          <FilterSelect
            label="Range"
            value={filters.range}
            onChange={(value) => {
              const nextRange = value as ReportingRange;
              const next =
                nextRange === "custom"
                  ? { range: "custom" as const, window: "custom" as const, from: filters.from, to: filters.to }
                  : presetRangeState(nextRange);
              void refresh({
                ...filters,
                ...next,
                granularity: defaultGranularity(next.from, next.to, filters.granularity),
              });
            }}
            options={[
              ["month-to-date", "Month to date"],
              ["7d", "Last 7 days"],
              ["30d", "Last 30 days"],
              ["last-month", "Last month"],
              ["24h", "Last 24 hours"],
              ["custom", "Custom range"],
            ]}
          />
          {filters.range === "custom" ? (
            <>
              <DateFilter
                label="From"
                value={filters.from}
                onChange={(from) =>
                  void refresh({
                    ...filters,
                    from,
                    granularity: defaultGranularity(from, filters.to, filters.granularity),
                  })
                }
              />
              <DateFilter
                label="To"
                value={filters.to}
                onChange={(to) =>
                  void refresh({
                    ...filters,
                    to,
                    granularity: defaultGranularity(filters.from, to, filters.granularity),
                  })
                }
              />
            </>
          ) : null}
          <FilterSelect
            label="Project"
            value={filters.projectId ?? ALL}
            onChange={(value) =>
              void refresh({
                ...filters,
                projectId: value === ALL ? null : value,
                workloadId: null,
              })
            }
            options={[
              [ALL, "All projects"],
              ...(data?.options.projects.map((project) => [project.id, project.name] as const) ?? []),
            ]}
          />
          <FilterSelect
            label="Workload"
            value={filters.workloadId ?? ALL}
            onChange={(value) =>
              void refresh({ ...filters, workloadId: value === ALL ? null : value })
            }
            options={[
              [ALL, "All workloads"],
              ...workloads.map((workload) => [workload.id, workload.name] as const),
            ]}
          />
          <FilterSelect
            label="Granularity"
            value={filters.granularity}
            onChange={(value) =>
              void refresh({ ...filters, granularity: value as ReportingGranularity })
            }
            options={granularityOptions(filters.from, filters.to)}
          />
          <FilterSelect
            label="Group by"
            value={filters.groupBy}
            onChange={(value) =>
              void refresh({ ...filters, groupBy: value as ReportingGroupBy })
            }
            options={[
              ["project", "Project"],
              ["workload", "Workload"],
              ["model", "Model"],
            ]}
          />
        </div>

        <div className="reporting-toolbar">
          <div className="reporting-metric-tabs" role="tablist" aria-label="Metric">
            {(["usage", "caching", "cost"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={metric === tab}
                className={metric === tab ? "active" : ""}
                onClick={() => setMetric(tab)}
              >
                {tab === "usage" ? "Usage" : tab === "caching" ? "Caching" : "Cost"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="reporting-refresh"
            disabled={loading}
            onClick={() => void refresh(filters)}
          >
            <RefreshCwIcon size={13} className={loading ? "reporting-spin" : undefined} />
            Refresh
          </button>
        </div>

        {data ? (
          <ReportingContent data={data} metric={metric} groupBy={filters.groupBy} />
        ) : result && !result.ok ? (
          <ReportingFailure error={result.error} requestId={result.request_id} />
        ) : (
          <div className="card">
            <div className="card-sub">Loading organization reporting…</div>
          </div>
        )}
      </div>
    </>
  );
}

function ReportingContent({
  data,
  metric,
  groupBy,
}: {
  data: ReportingData;
  metric: ReportingMetric;
  groupBy: ReportingGroupBy;
}): ReactNode {
  const { reporting } = data;
  const chart = groupedChart(reporting.series, groupBy, metric, reporting.granularity, PALETTE);
  const breakdown = aggregateBreakdown(reporting.series, groupBy);
  const [hiddenSeries, setHiddenSeries] = useState(() => ({
    groupBy,
    identities: new Set<string>(),
  }));
  const [sort, setSort] = useState<SortState>({ column: "costUsd", direction: "desc" });
  const hiddenIdentities =
    hiddenSeries.groupBy === groupBy ? hiddenSeries.identities : new Set<string>();
  const visibleSeries = chart.series.filter((series) => !hiddenIdentities.has(series.identity));
  const displaySort = sortIsVisible(metric, sort.column) ? sort : defaultSort(metric);
  const sortedBreakdown = sortBreakdown(breakdown, displaySort);
  const updateSort = (column: BreakdownColumn) => {
    setSort(() =>
      displaySort.column === column
        ? { column, direction: displaySort.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "label" ? "asc" : "desc" },
    );
  };
  const activeScope = [
    reporting.filters.project_id ? "project" : null,
    reporting.filters.workload_id ? "workload" : null,
  ].filter(Boolean).length;
  const cacheReadPct = cacheReadShare(reporting.totals);

  return (
    <>
      {metric === "caching" ? (
        <div className="reporting-metric-grid">
          <MetricCard label="Cache reads" value={formatTokens(reporting.totals.cache_read_input_tokens)} />
          <MetricCard label="Cache writes" value={formatTokens(reporting.totals.cache_creation_input_tokens)} />
          <MetricCard label="Cache read rate" value={formatPercent(cacheReadPct)} />
          <MetricCard label="Fresh input" value={formatTokens(reporting.totals.input_tokens)} />
        </div>
      ) : (
        <div className="reporting-metric-grid">
          <MetricCard label="Total tokens" value={formatTokens(reporting.totals.total_tokens)} />
          <MetricCard label="Input tokens" value={formatTokens(reporting.totals.input_tokens)} />
          <MetricCard label="Output tokens" value={formatTokens(reporting.totals.output_tokens)} />
          <MetricCard label="Estimated cost" value={formatUSD(reporting.totals.customer_cost_usd)} />
        </div>
      )}

      <div className="card">
        <div className="card-row" style={{ alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div className="card-title">
              {metric === "usage" ? "Token usage" : metric === "caching" ? "Cache reads" : "Estimated cost"}
            </div>
            <div className="card-sub">
              {metric === "caching"
                ? "Prompt tokens served from cache"
                : granularityLabel(reporting.granularity)}{" "}
              reporting · {formatRange(reporting.window_start, reporting.window_end, reporting.window === "custom")}
            </div>
          </div>
          <span className="card-sub">
            {activeScope
              ? `${activeScope} active filter${activeScope === 1 ? "" : "s"}`
              : "All organization data"}
          </span>
        </div>
        {chart.rows.length > 0 ? (
          <>
            <StackedBarChart rows={chart.rows} series={visibleSeries} metric={metric} />
            <div className="reporting-legend">
              {chart.series.map((series) => {
                const selected = !hiddenIdentities.has(series.identity);
                return (
                  <button
                    key={series.key}
                    type="button"
                    aria-pressed={selected}
                    className={selected ? "" : "muted"}
                    onClick={() =>
                      setHiddenSeries((current) => ({
                        groupBy,
                        identities: toggleSeries(
                          current.groupBy === groupBy ? current.identities : new Set(),
                          series.identity,
                        ),
                      }))
                    }
                  >
                    <span className="reporting-swatch" style={{ backgroundColor: series.color }} />
                    {series.label}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <p className="reporting-empty">No reporting data matches this view.</p>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "16px 18px 6px" }}>
          <div className="card-title">{groupBy} breakdown</div>
          <div className="card-sub">
            Aggregated over the selected window. Click a column heading to sort; rows remain read-only.
          </div>
        </div>
        <table className="reporting-table">
          <thead>
            <tr>
              <SortHeader label={groupByLabel(groupBy)} column="label" sort={displaySort} onSort={updateSort} />
              {metric === "caching" ? (
                <>
                  <SortHeader label="Cache reads" column="cacheReadTokens" sort={displaySort} onSort={updateSort} align="right" />
                  <SortHeader label="Cache writes" column="cacheWriteTokens" sort={displaySort} onSort={updateSort} align="right" />
                  <SortHeader label="Cache read rate" column="cacheReadPct" sort={displaySort} onSort={updateSort} align="right" />
                </>
              ) : (
                <>
                  <SortHeader label="Requests" column="requests" sort={displaySort} onSort={updateSort} align="right" />
                  <SortHeader label="Tokens" column="totalTokens" sort={displaySort} onSort={updateSort} align="right" />
                  <SortHeader label="Estimated cost" column="costUsd" sort={displaySort} onSort={updateSort} align="right" />
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedBreakdown.length > 0 ? (
              sortedBreakdown.map((row) => (
                <tr key={row.id}>
                  <td className="reporting-cell-label">{row.label}</td>
                  {metric === "caching" ? (
                    <>
                      <td className="num">{formatTokens(row.cacheReadTokens)}</td>
                      <td className="num">{formatTokens(row.cacheWriteTokens)}</td>
                      <td className="num">{formatPercent(row.cacheReadPct)}</td>
                    </>
                  ) : (
                    <>
                      <td className="num">{formatTokens(row.requests)}</td>
                      <td className="num">{formatTokens(row.totalTokens)}</td>
                      <td className="num">{formatUSD(row.costUsd)}</td>
                    </>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="reporting-empty">
                  No grouped data for this selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Traditional stacked bar chart. The web renders this with Recharts; the
 * desktop app carries no charting dependency, so the same stacked-bucket
 * data draws as flex columns with per-segment tooltips.
 */
function StackedBarChart({
  rows,
  series,
  metric,
}: {
  rows: { bucket: string; label: string; values: Record<string, number> }[];
  series: { key: string; label: string; color: string }[];
  metric: ReportingMetric;
}): ReactNode {
  const max = Math.max(
    1e-9,
    ...rows.map((row) => series.reduce((sum, item) => sum + (row.values[item.key] ?? 0), 0)),
  );
  const labelEvery = Math.max(1, Math.ceil(rows.length / 12));
  return (
    <div className="reporting-chart" role="img" aria-label="Stacked bar chart">
      {rows.map((row, index) => {
        const total = series.reduce((sum, item) => sum + (row.values[item.key] ?? 0), 0);
        return (
          <div key={row.bucket} className="reporting-chart-col">
            <div className="reporting-chart-bar">
              {series.map((item) => {
                const value = row.values[item.key] ?? 0;
                if (value <= 0) return null;
                return (
                  <div
                    key={item.key}
                    className="reporting-chart-seg"
                    style={{ height: `${(value / max) * 100}%`, backgroundColor: item.color }}
                    title={`${row.label} · ${item.label}: ${
                      metric === "cost" ? formatUSD(value) : formatTokens(value)
                    }`}
                  />
                );
              })}
            </div>
            <span className="reporting-chart-label">
              {index % labelEvery === 0 ? row.label : " "}
            </span>
            <span className="visually-hidden">
              {row.label}: {metric === "cost" ? formatUSD(total) : formatTokens(total)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  align,
}: {
  label: string;
  column: BreakdownColumn;
  sort: SortState;
  onSort: (column: BreakdownColumn) => void;
  align?: "right";
}): ReactNode {
  const active = sort.column === column;
  const Icon = !active ? ArrowUpDownIcon : sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <th
      className={align === "right" ? "num" : undefined}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => onSort(column)}>
        {label}
        <Icon size={12} aria-hidden="true" />
      </button>
    </th>
  );
}

function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="reporting-filter">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="reporting-filter">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function MetricCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="card reporting-metric-card">
      <div className="card-sub">{label}</div>
      <div className="reporting-metric-value">{value}</div>
    </div>
  );
}

function ReportingFailure({
  error,
  requestId,
}: {
  error: string;
  requestId: string | null;
}): ReactNode {
  return (
    <div className="card reporting-failure">
      <div className="card-title">Analytics is unavailable</div>
      <div className="card-sub" style={{ marginTop: 4 }}>{error}</div>
      {requestId ? <div className="reporting-request-id">request {requestId}</div> : null}
    </div>
  );
}
