"use client";

// Org "Summary" management surface, ported from the hosted control plane's
// dashboard page.
// Deliberately TRADITIONAL: same metric row, spend trend, and workload-card
// grid. Server-side data loading becomes a client-side fan-out through the
// `admin_get` Tauri command (app/lib/org-summary.mjs); the sk_ key stays in
// the Rust process. Workload cards navigate to the in-app workload
// Configuration pane instead of a /p/[slug] URL.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CalendarIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/app/components/base-ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/base-ui/popover";
import "./cedar-summary.css";
import {
  CedarMetricTile,
  CedarPanel,
  CedarSpendTrend,
  CedarWorkloadCard,
  type CedarHealth,
} from "./CedarSummary";
import { Button } from "@/app/components/base-ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/base-ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/base-ui/tooltip";
import {
  availableBalance,
  balanceDetail,
  deriveOverrideState,
  formatDay,
  formatTokens,
  formatUSD,
  healthLabel,
  loadOrgSummary,
  routeSummary,
  spendTrendPoints,
  type OrgSummary,
  type ReportingSeriesPoint,
  type WorkloadCardData,
  type WorkloadHealth,
} from "../lib/org-summary.mjs";

function adminGet(path: string): Promise<any> {
  return invoke("admin_get", { path });
}

type LoadState =
  | { phase: "loading" }
  | { phase: "signed-out"; detail: string }
  | { phase: "error"; detail: string }
  | { phase: "ready"; data: Extract<OrgSummary, { ok: true }> };

export function OrgSummaryPane({
  onOpenWorkload,
}: {
  onOpenWorkload: (projectId: string, workloadId: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

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
        else if (summary.error.startsWith("not_signed_in") || summary.error.startsWith("org_unknown"))
          setState({ phase: "signed-out", detail: summary.error });
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

  return (
    <>
      <div className="pane-head" style={{ maxWidth: 1100 }}>
        <p className="text-[0.62rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          organization
        </p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="pane-title">Summary</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={state.phase === "loading"}
            aria-label="Refresh overview"
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
            Refresh
          </Button>
        </div>
        <p className="pane-sub">
          A view-only overview of traffic, workloads, and captured activity
          across your organization. Open a workload only when you need to
          change its configuration.
        </p>
      </div>
      <div className="pane-body" style={{ maxWidth: 1100 }}>
        {state.phase === "loading" && <SummarySkeleton />}
        {state.phase === "signed-out" && (
          <Notice title="Sign in to see your organization">
            This overview reads the Understudy gateway with your account key.
            Run <code>understudy login</code> in a terminal (or sign in from
            the Account pane), then refresh.
            <span className="mt-1 block text-xs opacity-80">{state.detail}</span>
          </Notice>
        )}
        {state.phase === "error" && (
          <Notice title="Could not load the overview">
            The control plane could not list your projects. Retry shortly.
            <span className="mt-1 block text-xs opacity-80">{state.detail}</span>
          </Notice>
        )}
        {state.phase === "ready" && (
          <SummaryView data={state.data} onOpenWorkload={onOpenWorkload} />
        )}
      </div>
    </>
  );
}

function SummaryView({
  data,
  onOpenWorkload,
}: {
  data: Extract<OrgSummary, { ok: true }>;
  onOpenWorkload: (projectId: string, workloadId: string) => void;
}): ReactNode {
  const { reporting, balance, cards, metrics, partialErrors } = data;
  return (
    <div className="grid gap-4">
      {partialErrors.length > 0 && (
        <Notice title="Some projects did not load">
          {partialErrors.join("; ")} — their workloads are omitted below.
        </Notice>
      )}
      <div className="sm-metrics">
        <CedarMetricTile
          label="7-day spend"
          value={metrics.totalSpendUsd === null ? "—" : formatUSD(metrics.totalSpendUsd)}
          detail="estimated cost from metered traffic"
        />
        <CedarMetricTile
          label={balance?.billing_mode === "prepaid" ? "available credit" : "current balance"}
          value={balance ? formatUSD(availableBalance(balance)) : "—"}
          detail={balance ? balanceDetail(balance) : "billing data unavailable"}
        />
        <CedarMetricTile
          label="active workloads"
          value={metrics.activeWorkloads === null ? "—" : String(metrics.activeWorkloads)}
          detail="served traffic in the last 7 days"
        />
        <CedarMetricTile
          label="capture enabled"
          value={String(metrics.captureEnabledCount)}
          of={String(metrics.workloadCount)}
          detail="workloads recording gateway traffic"
        />
      </div>

      <SpendCard reporting30={data.reporting30} fallback={reporting} />

      <CedarPanel title="workloads">
        {cards.length === 0 ? (
          <div className="sm-empty">
            no workloads yet — create one in a project to give a stable call
            site its own configuration
          </div>
        ) : (
          <div className="sm-cards">
            {cards.map((card) => (
              <CedarWorkloadCard
                key={card.workload.id}
                project={card.project.name}
                name={card.workload.name}
                isDefault={Boolean(card.workload.is_default)}
                health={card.healthStatus as CedarHealth}
                route={deriveOverrideState(card.workload).kind === "primary" ? "primary" : "routed"}
                cost={card.usage ? formatUSD(card.usage.costUsd) : "—"}
                requests={card.usage ? formatTokens(card.usage.requests) : "—"}
                capture={card.workload.capture_enabled ? "on" : "off"}
                onOpen={() => onOpenWorkload(card.project.id, card.workload.id)}
              />
            ))}
          </div>
        )}
      </CedarPanel>
    </div>
  );
}


function Notice({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/5 p-4 text-sm leading-6">
      <p className="font-medium text-[var(--color-warn)]">{title}</p>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  );
}


// Port of apps/web/components/WorkloadHealthBadge.tsx (non-interactive form).


const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function rangeLabel(range: DateRange): string {
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (range.from && range.to) return `${fmt(range.from)} – ${fmt(range.to)}`;
  if (range.from) return fmt(range.from);
  return "Pick a range";
}

/**
 * Spend trend with a dynamic date range. The hosted reporting API only
 * serves fixed 7d/30d windows, so the widest (30d, daily) series loads once
 * and the picker slices it client-side — any span within the last 30 days.
 */
function SpendCard({
  reporting30,
  fallback,
}: {
  reporting30: { series?: ReportingSeriesPoint[] } | null;
  fallback: { series?: ReportingSeriesPoint[] } | null;
}): ReactNode {
  const today = startOfDay(new Date());
  const minDate = new Date(today.getTime() - 29 * DAY_MS);
  const [range, setRange] = useState<DateRange>({
    from: new Date(today.getTime() - 6 * DAY_MS),
    to: today,
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  // The 30d series drives the slice; if that call failed, fall back to the
  // 7d series the metrics already use.
  const rows = reporting30?.series ?? fallback?.series ?? [];
  const sliced = useMemo(() => {
    if (!range.from) return rows;
    const from = startOfDay(range.from).getTime();
    const to = startOfDay(range.to ?? range.from).getTime() + DAY_MS - 1;
    return rows.filter((row) => {
      const at = Date.parse(row.bucket);
      return Number.isFinite(at) && at >= from && at <= to;
    });
  }, [rows, range.from, range.to]);

  return (
    <CedarPanel
      title="spend"
      action={
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="sm-range" aria-label="Spend date range">
                <CalendarIcon aria-hidden="true" size={12} strokeWidth={1.8} />
                {rangeLabel(range)}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={range}
                defaultMonth={range.from}
                disabled={{ before: minDate, after: today }}
                onSelect={(next) => {
                  if (!next) return;
                  setRange(next);
                  if (next.from && next.to) setPickerOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
      }
    >
      <CedarSpendTrend
        rows={spendTrendPoints(sliced).map(([day, cost]) => ({
          day: formatDay(day),
          cost,
        }))}
      />
    </CedarPanel>
  );
}



function SummarySkeleton(): ReactNode {
  return (
    <div className="grid animate-pulse gap-4" aria-label="Loading organization summary">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 rounded-xl border border-border bg-muted/30" />
        ))}
      </div>
      <div className="h-64 rounded-xl border border-border bg-muted/30" />
      <div className="h-48 rounded-xl border border-border bg-muted/30" />
    </div>
  );
}
