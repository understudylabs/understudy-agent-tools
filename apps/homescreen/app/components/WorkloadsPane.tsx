"use client";

// Workloads pane — the single home for everything about a workload. The
// deep version of the Summary's Cedar workload cards: same anatomy (project
// cap, mono name, health dot, chips, minis) plus cache rate, tokens in/out,
// the route summary line, and last-24h status — with the Configuration
// pane's controls (route + capture, WorkloadConfigInline) folded into each
// card. One card expands at a time; card click expands, controls live
// inside. Supersedes the ProjectReportingPane table at the
// "project-reporting" pane id.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import "./cedar-summary.css";
import { CedarHealthDot, CedarPanel, type CedarHealth } from "./CedarSummary";
import { WorkloadConfigInline } from "./WorkloadConfigInline";
import { Button } from "@/app/components/base-ui/button";
import {
  deriveOverrideState,
  formatTokens,
  formatUSD,
  loadOrgSummary,
  routeSummary,
  workloadUsageDetails,
  type OrgSummary,
  type WorkloadCardData,
  type WorkloadUsageDetail,
} from "../lib/org-summary.mjs";

function adminGet(path: string): Promise<any> {
  return invoke("admin_get", { path });
}

/** Deep link from the Summary cards / breadcrumb: expand this card. */
export type WorkloadFocusRequest = {
  projectId: string;
  workloadId: string;
  requestId: number;
};

type LoadState =
  | { phase: "loading" }
  | { phase: "signed-out"; detail: string }
  | { phase: "error"; detail: string }
  | { phase: "ready"; data: Extract<OrgSummary, { ok: true }> };

type StatusRow = Extract<OrgSummary, { ok: true }>["summaries"][number]["statuses"][number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD (UTC) for "the last 7 days including today". */
function sevenDaysAgo(): string {
  return new Date(Date.now() - 6 * DAY_MS).toISOString().slice(0, 10);
}

export function WorkloadsPane({
  requestedWorkload,
}: {
  requestedWorkload: WorkloadFocusRequest | null;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setState((current) =>
      current.phase === "ready" ? current : { phase: "loading" },
    );
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

  // Deep link: expand the requested card (fires again on each request).
  useEffect(() => {
    if (requestedWorkload) setExpandedId(requestedWorkload.workloadId);
  }, [requestedWorkload]);

  return (
    <>
      <div className="pane-head" style={{ maxWidth: 1100 }}>
        <p className="text-[0.62rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          organization
        </p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="pane-title">Workloads</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={state.phase === "loading"}
            aria-label="Refresh workloads"
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
            Refresh
          </Button>
        </div>
        <p className="pane-sub">
          Every workload with its traffic, health, and configuration. Expand a
          card to change its route or capture.
        </p>
        {/* Aggregate capture state — replaces the Summary's removed
            "capture enabled" tile. */}
        {state.phase === "ready" ? (
          <span className="sm-cap" style={{ display: "block", marginTop: 6 }}>
            capture {state.data.metrics.captureEnabledCount} /{" "}
            {state.data.metrics.workloadCount}
          </span>
        ) : null}
      </div>
      <div className="pane-body" style={{ maxWidth: 1100 }}>
        {state.phase === "loading" && <WorkloadsSkeleton />}
        {state.phase === "signed-out" && (
          <Notice title="Sign in to see your workloads">
            This view reads the Understudy gateway with your account key. Run{" "}
            <code>understudy login</code> in a terminal (or sign in from the
            Account pane), then refresh.
            <span className="mt-1 block text-xs opacity-80">{state.detail}</span>
          </Notice>
        )}
        {state.phase === "error" && (
          <Notice title="Could not load workloads">
            The control plane could not list your projects. Retry shortly.
            <span className="mt-1 block text-xs opacity-80">{state.detail}</span>
          </Notice>
        )}
        {state.phase === "ready" && (
          <WorkloadsView
            data={state.data}
            expandedId={expandedId}
            requestedWorkload={requestedWorkload}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
            onChanged={refresh}
          />
        )}
      </div>
    </>
  );
}

function WorkloadsView({
  data,
  expandedId,
  requestedWorkload,
  onToggle,
  onChanged,
}: {
  data: Extract<OrgSummary, { ok: true }>;
  expandedId: string | null;
  requestedWorkload: WorkloadFocusRequest | null;
  onToggle: (id: string) => void;
  onChanged: () => void;
}): ReactNode {
  const { cards, summaries, partialErrors } = data;

  const usage7d = useMemo(
    () => workloadUsageDetails(summaries, sevenDaysAgo()),
    [summaries],
  );
  const statusByWorkload = useMemo(() => {
    const map = new Map<string, StatusRow>();
    for (const summary of summaries) {
      for (const row of summary.statuses) map.set(row.workload_id, row);
    }
    return map;
  }, [summaries]);

  // Grouped by project when the org has more than one; card order inside a
  // group keeps the overall cost sort.
  const groups = useMemo(() => {
    const byProject = new Map<string, { name: string; cards: WorkloadCardData[] }>();
    for (const card of cards) {
      let group = byProject.get(card.project.id);
      if (!group) byProject.set(card.project.id, (group = { name: card.project.name, cards: [] }));
      group.cards.push(card);
    }
    return [...byProject.values()];
  }, [cards]);

  if (cards.length === 0) {
    return (
      <CedarPanel title="workloads">
        <div className="sm-empty">
          no workloads yet — create one in a project to give a stable call
          site its own configuration
        </div>
      </CedarPanel>
    );
  }

  const renderCards = (rows: WorkloadCardData[]) => (
    <div className="sm-cards sm-cards-deep">
      {rows.map((card) => (
        <WorkloadDeepCard
          key={card.workload.id}
          card={card}
          detail={usage7d.get(card.workload.id)}
          status={statusByWorkload.get(card.workload.id)}
          expanded={expandedId === card.workload.id}
          requested={requestedWorkload?.workloadId === card.workload.id}
          onToggle={() => onToggle(card.workload.id)}
          onChanged={onChanged}
        />
      ))}
    </div>
  );

  return (
    <div className="grid gap-4">
      {partialErrors.length > 0 && (
        <Notice title="Some projects did not load">
          {partialErrors.join("; ")} — their workloads are omitted below.
        </Notice>
      )}
      {groups.length > 1 ? (
        groups.map((group) => (
          <CedarPanel key={group.name} title={group.name}>
            {renderCards(group.cards)}
          </CedarPanel>
        ))
      ) : (
        <CedarPanel title="workloads">{renderCards(cards)}</CedarPanel>
      )}
    </div>
  );
}

function WorkloadDeepCard({
  card,
  detail,
  status,
  expanded,
  requested,
  onToggle,
  onChanged,
}: {
  card: WorkloadCardData;
  detail: WorkloadUsageDetail | undefined;
  status: StatusRow | undefined;
  expanded: boolean;
  requested: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): ReactNode {
  const { workload, project, usage, healthStatus } = card;
  const route = deriveOverrideState(workload);
  const ref = useRef<HTMLDivElement | null>(null);

  // Deep-linked card: bring it into view once it is expanded.
  useEffect(() => {
    if (expanded && requested) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, requested]);

  const statusLine =
    status && typeof status.error_rate === "number"
      ? `24h ${status.status} · err ${(status.error_rate * 100).toFixed(1)}%`
      : status
        ? `24h ${status.status}`
        : "24h status unavailable";

  return (
    <div ref={ref} className={"sm-cardx" + (expanded ? " expanded" : "")}>
      <button
        type="button"
        className="sm-cardx-head"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "collapse" : "expand"} ${workload.name} in ${project.name}`}
      >
        <div className="sm-card-top">
          <span className="sm-cap">{project.name}</span>
          <span className="sm-spacer" />
          <CedarHealthDot status={healthStatus as CedarHealth} />
        </div>
        <div className="sm-card-top">
          <span className="sm-card-name">{workload.name}</span>
          {workload.is_default ? <span className="sm-chip">default</span> : null}
          <span className="sm-chip">{route.kind === "primary" ? "primary" : "routed"}</span>
          <span className="sm-spacer" />
          <ChevronDownIcon
            aria-hidden="true"
            size={14}
            strokeWidth={1.8}
            className="sm-cardx-chev"
          />
        </div>
        <div className="sm-cardx-lines">
          <span>
            {routeSummary(route)}
            {route.modelId ? (
              <>
                {" — "}
                <code>{route.modelId}</code> @{" "}
                <span className="tabular-nums">{route.trafficPct}%</span>
              </>
            ) : null}
          </span>
          <span>{statusLine}</span>
        </div>
        <div className="sm-card-minis sm-minis-6">
          <span className="sm-mini">
            <span className="sm-cap">7-day cost</span>
            <b>{usage ? formatUSD(usage.costUsd) : "—"}</b>
          </span>
          <span className="sm-mini">
            <span className="sm-cap">requests</span>
            <b>{usage ? formatTokens(usage.requests) : "—"}</b>
          </span>
          <span className="sm-mini">
            <span className="sm-cap">capture</span>
            <b style={{ color: workload.capture_enabled ? "var(--mb-mint)" : "var(--text-2)" }}>
              {workload.capture_enabled ? "on" : "off"}
            </b>
          </span>
          <span className="sm-mini">
            <span className="sm-cap">cache rate</span>
            <b>{detail?.cacheRatePct != null ? `${detail.cacheRatePct.toFixed(1)}%` : "—"}</b>
          </span>
          <span className="sm-mini">
            <span className="sm-cap">tokens in</span>
            <b>{detail ? formatTokens(detail.inputTokens) : "—"}</b>
          </span>
          <span className="sm-mini">
            <span className="sm-cap">tokens out</span>
            <b>{detail ? formatTokens(detail.outputTokens) : "—"}</b>
          </span>
        </div>
      </button>
      <div className="sm-cardx-body">
        <div>
          {expanded ? (
            <WorkloadConfigInline
              projectId={project.id}
              workloadId={workload.id}
              onChanged={onChanged}
            />
          ) : null}
        </div>
      </div>
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

function WorkloadsSkeleton(): ReactNode {
  return (
    <div className="grid animate-pulse gap-4" aria-label="Loading workloads">
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-44 rounded-xl border border-border bg-muted/30" />
        ))}
      </div>
    </div>
  );
}
