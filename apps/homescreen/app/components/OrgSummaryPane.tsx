"use client";

// Org "Summary" management surface, ported from the web control plane page
// apps/web/app/(control-plane)/dashboard/page.tsx (understudy-platform).
// Deliberately TRADITIONAL: same metric row, spend trend, and workload-card
// grid. Server-side data loading becomes a client-side fan-out through the
// `admin_get` Tauri command (app/lib/org-summary.mjs); the sk_ key stays in
// the Rust process. Workload cards navigate to the in-app workload
// Configuration pane instead of a /p/[slug] URL.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Badge } from "@/app/components/base-ui/badge";
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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="7-day spend"
          value={metrics.totalSpendUsd === null ? "—" : formatUSD(metrics.totalSpendUsd)}
          detail="estimated cost from metered traffic"
        />
        <MetricCard
          label={balance?.billing_mode === "prepaid" ? "available credit" : "current balance"}
          value={balance ? formatUSD(availableBalance(balance)) : "—"}
          detail={balance ? balanceDetail(balance) : "billing data unavailable"}
        />
        <MetricCard
          label="active workloads"
          value={metrics.activeWorkloads === null ? "—" : String(metrics.activeWorkloads)}
          detail="served traffic in the last 7 days"
        />
        <MetricCard
          label="capture enabled"
          value={`${metrics.captureEnabledCount} / ${metrics.workloadCount}`}
          detail="workloads recording gateway traffic"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Spend over the last 7 days</CardTitle>
          <CardDescription>
            Estimated daily cost across the organization. This is a reporting
            view, not a billing action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SpendTrend rows={reporting?.series ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workloads</CardTitle>
          <CardDescription>
            Select a card to configure its routing and capture controls. Those
            controls stay scoped to that workload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cards.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
              No workloads yet. Create one in a project to give a stable call
              site its own configuration and capture controls.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((card) => (
                <WorkloadCard
                  key={card.workload.id}
                  card={card}
                  onOpen={() => onOpenWorkload(card.project.id, card.workload.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="truncate text-2xl font-medium tabular-nums">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="truncate text-sm text-muted-foreground">
        {detail}
      </CardContent>
    </Card>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="border border-[var(--color-stamp)]/50 bg-[var(--color-stamp)]/5 p-4 text-sm leading-6">
      <p className="font-medium text-[var(--color-stamp)]">{title}</p>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  );
}

function WorkloadCard({
  card,
  onOpen,
}: {
  card: WorkloadCardData;
  onOpen: () => void;
}): ReactNode {
  const { project, workload, usage, healthStatus } = card;
  const route = deriveOverrideState(workload);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={`Configure ${workload.name} in ${project.name} — ${healthLabel(healthStatus)}`}
    >
      <Card size="sm" className="gap-3 transition-colors group-hover:border-foreground/40">
        <CardHeader>
          <CardDescription className="truncate">{project.name}</CardDescription>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="truncate">{workload.name}</span>
            {workload.is_default ? <Badge variant="outline">default</Badge> : null}
          </CardTitle>
          <CardAction className="flex items-center gap-2">
            <WorkloadHealthBadge status={healthStatus} />
            <Badge variant="outline">
              {route.kind === "primary" ? "primary" : "routed"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          <MiniMetric label="7-day cost" value={usage ? formatUSD(usage.costUsd) : "—"} />
          <MiniMetric label="requests" value={usage ? formatTokens(usage.requests) : "—"} />
          <MiniMetric label="capture" value={workload.capture_enabled ? "on" : "off"} />
        </CardContent>
        <CardContent className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
          <span className="truncate">{routeSummary(route)}</span>
          <span className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">
            Configure
          </span>
        </CardContent>
      </Card>
    </button>
  );
}

// Port of apps/web/components/WorkloadHealthBadge.tsx (non-interactive form).
const HEALTH_CONTENT: Record<
  WorkloadHealth,
  { label: string; description: string; className: string; Icon: typeof CircleCheckIcon }
> = {
  healthy: {
    label: "Healthy",
    description:
      "Traffic was observed in the last 24 hours and the 5xx error rate is below the degraded threshold.",
    className: "border-[var(--color-ok)]/50 bg-[var(--color-ok)]/15 text-[var(--color-ok)]",
    Icon: CircleCheckIcon,
  },
  degraded: {
    label: "Degraded",
    description:
      "The observed 5xx error rate reached the degraded threshold in the last 24 hours.",
    className: "border-destructive/50 bg-destructive/10 text-destructive",
    Icon: CircleAlertIcon,
  },
  idle: {
    label: "Idle",
    description: "No traffic was observed for this workload in the last 24 hours.",
    className: "border-border bg-muted/40 text-muted-foreground",
    Icon: CircleMinusIcon,
  },
  unavailable: {
    label: "Status unavailable",
    description: "Analytics could not load this workload's current health status.",
    className: "border-border bg-muted/40 text-muted-foreground",
    Icon: CircleMinusIcon,
  },
};

function WorkloadHealthBadge({ status }: { status: WorkloadHealth }): ReactNode {
  const { label, description, className, Icon } = HEALTH_CONTENT[status];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${className}`}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SpendTrend({ rows }: { rows: ReportingSeriesPoint[] }): ReactNode {
  const points = spendTrendPoints(rows);
  if (points.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No metered traffic in the last 7 days.
      </p>
    );
  }
  const maximum = Math.max(...points.map(([, cost]) => cost), 0);
  return (
    <div
      className="grid gap-3"
      role="img"
      aria-label="Estimated daily cost over the last seven days"
    >
      <div className="flex h-44 items-end gap-2 border-b border-border px-1 pt-4">
        {points.map(([day, cost]) => (
          <div key={day} className="flex h-full min-w-0 flex-1 items-end">
            <div
              className="w-full rounded-t-sm bg-[var(--color-stamp)]"
              style={{
                height: `${maximum > 0 ? Math.max((cost / maximum) * 100, 4) : 4}%`,
              }}
              title={`${day}: ${formatUSD(cost)}`}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 px-1 text-[0.62rem] text-muted-foreground">
        {points.map(([day]) => (
          <span key={day} className="min-w-0 flex-1 truncate text-center">
            {formatDay(day)}
          </span>
        ))}
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[0.58rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate pt-1 text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function SummarySkeleton(): ReactNode {
  return (
    <div className="grid animate-pulse gap-4" aria-label="Loading organization summary">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 rounded-xl border border-border bg-muted/30" />
        ))}
      </div>
      <div className="h-64 rounded-xl border border-border bg-muted/30" />
      <div className="h-48 rounded-xl border border-border bg-muted/30" />
    </div>
  );
}
