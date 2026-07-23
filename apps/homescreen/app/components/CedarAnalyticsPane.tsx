"use client";

// Cedar analytics destinations — Usage / Caching / Cost, the desktop
// counterpart of Anthropic's console metric pages. One component, three
// left-nav children (the nav is the metric switch; there is no in-pane
// tab row). Each destination: metric tiles up top, one daily chart with
// stacked per-group segments (workload is the primary dimension), the
// shared 30d range chip, and a chip/dot legend.
//
// Data: the same org fan-out the Summary uses (app/lib/org-summary.mjs),
// which now merges per-project 30d usage summaries; the range chip slices
// the widest series client-side.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCwIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import "./cedar-summary.css";
import {
  CedarLegendChips,
  CedarMetricTile,
  CedarPanel,
  CedarRangePicker,
  CedarRateTrend,
  CedarStackedBars,
  cedarSeriesColors,
} from "./CedarSummary";
import { Button } from "@/app/components/base-ui/button";
import {
  cacheLeaders,
  formatDay,
  formatTokens,
  formatUSD,
  loadOrgSummary,
  spendStack,
  stackTotals,
  tokenStack,
  usageDaySeries,
  usageTotals,
  workloadNameMap,
  type OrgSummary,
  type StackRow,
} from "../lib/org-summary.mjs";

export type AnalyticsMetric = "usage" | "caching" | "cost";

const METRIC_COPY: Record<AnalyticsMetric, { title: string; sub: string }> = {
  usage: {
    title: "Usage",
    sub: "Daily token volume across the organization, stacked by workload.",
  },
  caching: {
    title: "Caching",
    sub: "Prompt tokens served from cache instead of fresh input, day by day.",
  },
  cost: {
    title: "Cost",
    sub: "Estimated daily cost from metered traffic, stacked by workload.",
  },
};

function adminGet(path: string): Promise<any> {
  return invoke("admin_get", { path });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function inRange(day: string, range: DateRange): boolean {
  if (!range.from) return true;
  const at = Date.parse(day.slice(0, 10));
  if (!Number.isFinite(at)) return false;
  const from = startOfDay(range.from).getTime();
  const to = startOfDay(range.to ?? range.from).getTime() + DAY_MS - 1;
  return at >= from && at <= to;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; detail: string }
  | { phase: "ready"; data: Extract<OrgSummary, { ok: true }> };

export function CedarAnalyticsPane({ metric }: { metric: AnalyticsMetric }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const today = startOfDay(new Date());
  const [range, setRange] = useState<DateRange>({
    from: new Date(today.getTime() - 29 * DAY_MS),
    to: today,
  });

  const refresh = useCallback(() => {
    setState({ phase: "loading" });
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadOrgSummary(adminGet).then(
      (summary) => {
        if (cancelled) return;
        if (summary.ok) setState({ phase: "ready", data: summary });
        else setState({ phase: "error", detail: summary.error });
      },
      (error) => {
        if (!cancelled) setState({ phase: "error", detail: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const copy = METRIC_COPY[metric];
  return (
    <>
      <div className="pane-head" style={{ maxWidth: 1100 }}>
        <p className="text-[0.62rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          organization · analytics
        </p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="pane-title">{copy.title}</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={state.phase === "loading"}
            aria-label={`Refresh ${copy.title.toLowerCase()} analytics`}
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
            Refresh
          </Button>
        </div>
        <p className="pane-sub">{copy.sub}</p>
      </div>
      <div className="pane-body" style={{ maxWidth: 1100 }}>
        {state.phase === "loading" && <AnalyticsSkeleton />}
        {state.phase === "error" && (
          <div className="sm-panel">
            <span className="sm-panel-title">could not load analytics</span>
            <div className="sm-empty">{state.detail}</div>
          </div>
        )}
        {state.phase === "ready" && (
          <MetricView
            metric={metric}
            data={state.data}
            range={range}
            onRangeChange={setRange}
            minDate={new Date(today.getTime() - 29 * DAY_MS)}
            maxDate={today}
          />
        )}
      </div>
    </>
  );
}

function sliceStack(rows: StackRow[], range: DateRange) {
  return rows.filter((row) => inRange(row.day, range));
}

function chartRows(rows: StackRow[]) {
  return rows.map((row) => ({ ...row, label: formatDay(row.day) }));
}

function MetricView({
  metric,
  data,
  range,
  onRangeChange,
  minDate,
  maxDate,
}: {
  metric: AnalyticsMetric;
  data: Extract<OrgSummary, { ok: true }>;
  range: DateRange;
  onRangeChange: (next: DateRange) => void;
  minDate: Date;
  maxDate: Date;
}): ReactNode {
  const names = useMemo(() => workloadNameMap(data.summaries), [data.summaries]);
  // All series memos run unconditionally (rules of hooks); each branch below
  // renders only its own. The inputs are already loaded, so the extra
  // aggregation is a few array passes.
  const costStack = useMemo(
    () => spendStack(data.reporting30?.series ?? data.reporting?.series ?? [], names),
    [data.reporting30, data.reporting, names],
  );
  const tokensStack = useMemo(() => tokenStack(data.summaries, names), [data.summaries, names]);
  const daySeries = useMemo(() => usageDaySeries(data.summaries), [data.summaries]);
  const leaders = useMemo(() => cacheLeaders(data.summaries, names), [data.summaries, names]);
  const rangeChip = (
    <CedarRangePicker
      range={range}
      onChange={onRangeChange}
      minDate={minDate}
      maxDate={maxDate}
      label={`${metric} date range`}
    />
  );

  if (metric === "cost") {
    const stack = costStack;
    const sliced = sliceStack(stack.rows, range);
    const totals = stackTotals(sliced);
    const leaders = [...totals.byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const colors = cedarSeriesColors(stack.keys);
    return (
      <div className="grid gap-4">
        <div className="sm-metrics">
          <CedarMetricTile
            label="total cost"
            value={formatUSD(totals.total)}
            detail="estimated cost over the selected range"
          />
          {leaders.map(([name, cost], index) => (
            <CedarMetricTile
              key={name}
              label={`#${index + 1} ${name}`}
              value={formatUSD(cost)}
              detail="workload cost over the selected range"
            />
          ))}
        </div>
        <CedarPanel title="daily cost · by workload" action={rangeChip}>
          <CedarStackedBars
            rows={chartRows(sliced)}
            keys={stack.keys}
            format={(value) => formatUSD(value)}
            ariaLabel="estimated daily cost stacked by workload"
          />
          <CedarLegendChips
            items={stack.keys.map((key) => ({ name: key, color: colors.get(key)! }))}
          />
        </CedarPanel>
      </div>
    );
  }

  if (metric === "usage") {
    const stack = tokensStack;
    const slicedDays = daySeries.filter((row) => inRange(row.day, range));
    const totals = usageTotals(slicedDays);
    const sliced = sliceStack(stack.rows, range);
    const colors = cedarSeriesColors(stack.keys);
    const hasData = daySeries.length > 0;
    return (
      <div className="grid gap-4">
        <div className="sm-metrics">
          <CedarMetricTile
            label="tokens in"
            value={hasData ? formatTokens(totals.inputTokens + totals.cacheReadTokens) : "—"}
            detail="fresh + cache-read input over the selected range"
          />
          <CedarMetricTile
            label="tokens out"
            value={hasData ? formatTokens(totals.outputTokens) : "—"}
            detail="generated tokens over the selected range"
          />
          <CedarMetricTile
            label="token volume"
            value={hasData ? formatTokens(totals.inputTokens + totals.outputTokens) : "—"}
            detail="fresh input + output over the selected range"
          />
        </div>
        <CedarPanel title={`daily tokens · by ${stack.dimension}`} action={rangeChip}>
          <CedarStackedBars
            rows={chartRows(sliced)}
            keys={stack.keys}
            format={(value) => formatTokens(value)}
            ariaLabel={`daily token volume stacked by ${stack.dimension}`}
          />
          <CedarLegendChips
            items={stack.keys.map((key) => ({ name: key, color: colors.get(key)! }))}
            note={
              stack.dimension === "project"
                ? "by project — per-workload day series unavailable"
                : undefined
            }
          />
        </CedarPanel>
      </div>
    );
  }

  // caching
  const slicedDays = daySeries.filter((row) => inRange(row.day, range));
  const totals = usageTotals(slicedDays);
  const hasData = daySeries.length > 0;
  return (
    <div className="grid gap-4">
      <div className="sm-metrics">
        <CedarMetricTile
          label="cache rate"
          value={totals.cacheRatePct === null ? "—" : `${totals.cacheRatePct.toFixed(1)}%`}
          detail="prompt input served from cache"
        />
        <CedarMetricTile
          label="cache reads"
          value={hasData ? formatTokens(totals.cacheReadTokens) : "—"}
          detail="tokens read from cache"
        />
        <CedarMetricTile
          label="cache writes"
          value={hasData ? formatTokens(totals.cacheWriteTokens) : "—"}
          detail="tokens written into cache"
        />
        <CedarMetricTile
          label="fresh input"
          value={hasData ? formatTokens(totals.inputTokens) : "—"}
          detail="uncached prompt tokens"
        />
      </div>
      <CedarPanel title="daily cache-read rate" action={rangeChip}>
        <CedarRateTrend
          rows={slicedDays.map((row) => ({ label: formatDay(row.day), pct: row.cacheRatePct }))}
          ariaLabel="daily cache-read rate as a percent of prompt input"
        />
        {leaders.length > 0 ? (
          <CedarLegendChips
            items={[]}
            note={
              "top cached workloads · " +
              leaders
                .slice(0, 3)
                .map((leader) => `${leader.name} ${leader.cacheRatePct.toFixed(0)}%`)
                .join(" · ")
            }
          />
        ) : null}
      </CedarPanel>
    </div>
  );
}

function AnalyticsSkeleton(): ReactNode {
  return (
    <div className="grid animate-pulse gap-4" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 rounded-xl border border-border bg-muted/30" />
        ))}
      </div>
      <div className="h-80 rounded-xl border border-border bg-muted/30" />
    </div>
  );
}
