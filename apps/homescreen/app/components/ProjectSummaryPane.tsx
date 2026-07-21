"use client";

// Project Summary — faithful port of the hosted control plane's
// project overview page
// onto the desktop shell: metric strip, 7-day spend trend, credit position,
// and per-workload cards with a "+ New workload" dialog
// (NewWorkloadButton.tsx verbatim semantics). Server loaders became the
// mgmt_* Tauri commands (sk_ key resolved natively; never in the frontend),
// and the per-render slug->project resolution became a module-level
// project-context cache (`createProjectContextCache`).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Loader2, Plus } from "lucide-react";
import { Badge } from "@/app/components/base-ui/badge";
import { Button } from "@/app/components/base-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/base-ui/dialog";
import { Input } from "@/app/components/base-ui/input";
import {
  availableBalance,
  balanceDetail,
  createProjectContextCache,
  deriveOverrideState,
  formatExpiry,
  formatTokens,
  formatTrendDay,
  formatUSD,
  routeSummary,
  spendTrendPoints,
  totalSpend,
  type BillingBalance,
  type Project,
  type UsageSummaryGroup,
  type Workload,
  type WorkloadStatusEntry,
} from "../lib/management.mjs";
import type { Scope } from "../lib/nav";

type ProjectContext = { projects: Project[] };

// Module-level, like the web's per-render loader but cached across pane
// mounts. Mutations call `invalidate()`.
const projectsCache = createProjectContextCache<ProjectContext>(async () => {
  const body = await invoke<{ projects: Project[] }>("mgmt_projects_list");
  return { projects: body.projects ?? [] };
});

type LoadState =
  | { phase: "loading" }
  | { phase: "signed-out"; message: string }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      project: Project;
      projects: Project[];
      workloads: Workload[];
      // Reporting reads degrade independently, like the web page.
      usageByWorkload: Map<string, UsageSummaryGroup>;
      usageByDay: UsageSummaryGroup[] | null;
      statusByWorkload: Map<string, WorkloadStatusEntry>;
      activeWorkloads: number | null;
      spend: number | null;
      balance: BillingBalance | null;
    };

export function ProjectSummaryPane({
  scope,
  onScopeChange,
  onOpenWorkload,
}: {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** "Configure" on a workload card: scope the workload and open its pane. */
  onOpenWorkload: (projectId: string, workloadId: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ phase: "signed-out", message: "Open the desktop app to view project management." });
      return;
    }
    try {
      const { projects } = await projectsCache.get();
      if (projects.length === 0) {
        setState({
          phase: "signed-out",
          message:
            "No projects are visible. Sign in from the Account pane, then come back here.",
        });
        return;
      }
      const project =
        projects.find((p) => p.id === scope.projectId) ?? projects[0];
      const [workloadsBody, statusRes, usageDayRes, usageWorkloadRes, balanceRes] =
        await Promise.all([
          invoke<{ workloads: Workload[] }>("mgmt_workloads_list", {
            projectId: project.id,
          }),
          invoke<{ workloads: WorkloadStatusEntry[] }>("mgmt_workload_status", {
            projectId: project.id,
          }).catch(() => null),
          invoke<{ groups: UsageSummaryGroup[] }>("mgmt_usage_summary", {
            projectId: project.id,
            window: "7d",
            groupBy: "day",
          }).catch(() => null),
          invoke<{ groups: UsageSummaryGroup[] }>("mgmt_usage_summary", {
            projectId: project.id,
            window: "7d",
            groupBy: "workload",
          }).catch(() => null),
          invoke<{ balance: BillingBalance }>("mgmt_billing_balance").catch(
            () => null,
          ),
        ]);
      const workloads = workloadsBody.workloads ?? [];
      const statusEntries = statusRes?.workloads ?? null;
      const usageGroups = usageWorkloadRes?.groups ?? null;
      setState({
        phase: "ready",
        project,
        projects,
        workloads,
        usageByWorkload: new Map(
          (usageGroups ?? [])
            .filter((group) => group.workload_id)
            .map((group) => [group.workload_id as string, group]),
        ),
        usageByDay: usageDayRes?.groups ?? null,
        statusByWorkload: new Map(
          (statusEntries ?? []).map((entry) => [entry.workload_id, entry]),
        ),
        activeWorkloads: statusEntries
          ? statusEntries.filter((entry) => entry.status !== "idle").length
          : null,
        spend: usageGroups ? totalSpend(usageGroups) : null,
        balance: balanceRes?.balance ?? null,
      });
      if (scope.projectId !== project.id) {
        onScopeChange({ projectId: project.id, workloadId: scope.workloadId });
      }
    } catch (err) {
      setState({ phase: "error", message: String(err) });
    }
  }, [scope.projectId, scope.workloadId, onScopeChange]);

  useEffect(() => {
    setState((current) =>
      current.phase === "ready" ? current : { phase: "loading" },
    );
    load();
  }, [load, refreshToken]);

  const refresh = useCallback(() => {
    projectsCache.invalidate();
    setRefreshToken((token) => token + 1);
  }, []);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">
          {state.phase === "ready" ? state.project.name : "Project"}
        </h1>
        <p className="pane-sub">
          {state.phase === "ready"
            ? "A concise view of spend, traffic, and what you can configure."
            : "Project metadata, spend, and workloads."}
        </p>
      </div>
      <div className="pane-body">
        {state.phase === "loading" && (
          <div className="card mgmt-empty">Loading project…</div>
        )}
        {state.phase === "signed-out" && (
          <MgmtNotice label="access">{state.message}</MgmtNotice>
        )}
        {state.phase === "error" && (
          <MgmtNotice label="attention">
            {state.message}
            <div style={{ marginTop: 10 }}>
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          </MgmtNotice>
        )}
        {state.phase === "ready" && (
          <ProjectSummaryBody
            state={state}
            onRefresh={refresh}
            onOpenWorkload={onOpenWorkload}
          />
        )}
      </div>
    </>
  );
}

function ProjectSummaryBody({
  state,
  onRefresh,
  onOpenWorkload,
}: {
  state: Extract<LoadState, { phase: "ready" }>;
  onRefresh: () => void;
  onOpenWorkload: (projectId: string, workloadId: string) => void;
}) {
  const { project, workloads, balance, spend, activeWorkloads } = state;
  const captureCount = workloads.filter((w) => w.capture_enabled).length;

  return (
    <div className="mgmt-grid">
      <section className="mgmt-metric-row" aria-label="Project at a glance">
        <MetricCard
          label="7-day spend"
          value={spend === null ? "—" : formatUSD(spend)}
          detail="estimated cost from metered traffic"
        />
        <MetricCard
          label={
            balance?.billing_mode === "prepaid"
              ? "available credit"
              : "current balance"
          }
          value={balance ? formatUSD(availableBalance(balance)) : "—"}
          detail={balanceDetail(balance)}
        />
        <MetricCard
          label="active workloads"
          value={activeWorkloads === null ? "—" : String(activeWorkloads)}
          detail="served traffic in the last 24 hours"
        />
        <MetricCard
          label="capture enabled"
          value={`${captureCount} / ${workloads.length}`}
          detail="workloads recording gateway traffic"
        />
      </section>

      <section className="mgmt-two-col">
        <div className="card">
          <div className="card-title">Spend over the last 7 days</div>
          <p className="mgmt-card-sub">
            Estimated daily cost for this project. This is a reporting view,
            not a billing action.
          </p>
          {state.usageByDay ? (
            <SpendTrend groups={state.usageByDay} />
          ) : (
            <DataUnavailable label="Spend data is unavailable right now." />
          )}
        </div>

        <div className="card">
          <div className="card-title">Credit position</div>
          <p className="mgmt-card-sub">Organization-wide billing status.</p>
          {balance ? (
            <CreditPosition balance={balance} />
          ) : (
            <DataUnavailable label="Billing could not be loaded." />
          )}
          {/* Billing surface is not ported yet; no dead links. */}
          <Button variant="outline" size="sm" disabled title="Coming in this migration">
            View billing
          </Button>
        </div>
      </section>

      <div className="card">
        <div className="mgmt-card-head">
          <div>
            <div className="card-title">Workloads</div>
            <p className="mgmt-card-sub">
              Traffic and spend are view-only here. Use Configure only when you
              want to change routing or capture.
            </p>
          </div>
          <NewWorkloadButton projectId={project.id} onCreated={onRefresh} />
        </div>
        {workloads.length === 0 ? (
          <DataUnavailable label="No workloads yet. Create one to give a stable call site its own routing and capture controls." />
        ) : (
          <div className="mgmt-workload-grid">
            {workloads.map((workload) => (
              <WorkloadCard
                key={workload.id}
                workload={workload}
                usage={state.usageByWorkload.get(workload.id)}
                status={state.statusByWorkload.get(workload.id)}
                onConfigure={() => onOpenWorkload(project.id, workload.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Port of the web `WorkloadHealthBadge` onto the app's health-dot tokens. */
function WorkloadHealthBadge({ status }: { status?: WorkloadStatusEntry["status"] }) {
  // Web shows a muted "Not observed" chip when the status read had no
  // entry for this workload; keep that wording.
  const label = status ?? "not observed";
  const dot =
    status === "healthy" ? "healthy" : status === "degraded" ? "degraded" : "unknown";
  return (
    <Badge variant="outline" className="mgmt-health-badge">
      <span className={`workload-health-dot ${dot}`} aria-hidden="true" />
      {label}
    </Badge>
  );
}

function WorkloadCard({
  workload,
  usage,
  status,
  onConfigure,
}: {
  workload: Workload;
  usage?: UsageSummaryGroup;
  status?: WorkloadStatusEntry;
  onConfigure: () => void;
}) {
  const configuration = deriveOverrideState(workload);
  return (
    <div className="card mgmt-workload-card">
      <div className="mgmt-card-head">
        <div className="mgmt-workload-title">
          <span className="mgmt-workload-name">{workload.name}</span>
          {workload.is_default ? <Badge variant="outline">default</Badge> : null}
        </div>
        <WorkloadHealthBadge status={status?.status} />
      </div>
      <p className="mgmt-card-sub">{routeSummary(configuration)}</p>
      <dl className="mgmt-mini-metrics">
        <MiniMetric
          label="7-day cost"
          value={usage ? formatUSD(usage.customer_cost_usd) : "—"}
        />
        <MiniMetric
          label="requests"
          value={usage ? formatTokens(usage.requests) : "—"}
        />
        <MiniMetric label="capture" value={workload.capture_enabled ? "on" : "off"} />
      </dl>
      <div className="mgmt-card-actions">
        {/* Reporting surface is not ported yet; no dead links. */}
        <Button variant="outline" size="sm" disabled title="Coming in this migration">
          View reporting
        </Button>
        <Button size="sm" onClick={onConfigure}>
          Configure
        </Button>
      </div>
    </div>
  );
}

function SpendTrend({ groups }: { groups: UsageSummaryGroup[] }): ReactNode {
  const { points, maximum } = useMemo(() => spendTrendPoints(groups), [groups]);
  if (points.length === 0) {
    return <DataUnavailable label="No metered traffic in the last 7 days." />;
  }
  return (
    <div
      className="mgmt-trend"
      role="img"
      aria-label="Estimated daily cost over the last seven days"
    >
      <div className="mgmt-trend-bars">
        {points.map((point) => (
          <div key={point.day} className="mgmt-trend-slot">
            <div
              className="mgmt-trend-bar"
              style={{ height: `${point.heightPct}%` }}
              title={`${formatTrendDay(point.day)}: ${formatUSD(point.cost)}`}
            />
          </div>
        ))}
      </div>
      <div className="mgmt-trend-labels">
        {points.map((point) => (
          <span key={point.day}>{formatTrendDay(point.day)}</span>
        ))}
      </div>
      <div className="mgmt-trend-max">
        <span>Highest day</span>
        <span className="mgmt-tabular">{formatUSD(maximum)}</span>
      </div>
    </div>
  );
}

function CreditPosition({ balance }: { balance: BillingBalance }): ReactNode {
  const prepaid = balance.billing_mode === "prepaid";
  const warning =
    balance.status === "warning" ||
    balance.status === "suspended" ||
    balance.status === "delinquent";
  return (
    <div className="mgmt-credit">
      <p className="mgmt-credit-amount">{formatUSD(availableBalance(balance))}</p>
      <p className="mgmt-card-sub">{balanceDetail(balance)}</p>
      {warning ? (
        <p className="mgmt-credit-warning">
          {balance.status === "delinquent"
            ? "Payment needs attention."
            : "Low credit may interrupt traffic."}
        </p>
      ) : null}
      {prepaid && balance.grants.soonest_expiry ? (
        <p className="mgmt-card-sub">
          Credit expires {formatExpiry(balance.grants.soonest_expiry)}.
        </p>
      ) : null}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mgmt-mini-metric">
      <dt>{label}</dt>
      <dd className="mgmt-tabular">{value}</dd>
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
}) {
  return (
    <div className="card mgmt-metric-card">
      <div className="mgmt-metric-label">{label}</div>
      <div className="mgmt-metric-value mgmt-tabular">{value}</div>
      <div className="mgmt-card-sub">{detail}</div>
    </div>
  );
}

function DataUnavailable({ label }: { label: string }) {
  return <div className="mgmt-empty">{label}</div>;
}

/** Port of `_components/Notice.tsx` (clay "stamp" accent -> model-clay). */
function MgmtNotice({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="card mgmt-notice">
      <div className="mgmt-notice-label">
        <span aria-hidden="true" className="mgmt-notice-dot" />
        {label}
      </div>
      <div className="mgmt-notice-body">{children}</div>
    </div>
  );
}

/**
 * "+ New workload" — port of `_components/NewWorkloadButton.tsx`. The
 * server action became `mgmt_workload_create`; on success the cache is
 * invalidated and the summary refreshed (router.refresh() equivalent).
 */
function NewWorkloadButton({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [capture, setCapture] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  const reset = () => {
    setName("");
    setCapture(true);
    setError(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      await invoke("mgmt_workload_create", {
        projectId,
        name: trimmed,
        captureEnabled: capture,
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        New workload
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && !pending) reset();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mgmt-dialog-form"
          >
            <DialogHeader>
              <DialogTitle>New workload</DialogTitle>
              <DialogDescription>
                One workload per stable call site. The gateway reads{" "}
                <code className="mgmt-code">x-understudy-workload</code> and
                routes missing values to <code className="mgmt-code">main</code>.
              </DialogDescription>
            </DialogHeader>
            <div className="mgmt-dialog-fields">
              <label className="mgmt-field-label" htmlFor="summary-workload-name">
                Name
              </label>
              <Input
                id="summary-workload-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={63}
                placeholder="ad-copy"
                autoFocus
                disabled={pending}
                style={{ fontFamily: "var(--mono)" }}
              />
              <p className="mgmt-card-sub">
                Lowercase letters, numbers, hyphens, and underscores.
              </p>
              <label className="mgmt-checkbox">
                <input
                  type="checkbox"
                  checked={capture}
                  onChange={(event) => setCapture(event.target.checked)}
                  disabled={pending}
                />
                Enable capture
              </label>
            </div>
            {error ? (
              <p role="alert" className="mgmt-form-error">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {pending ? (
                  <>
                    <Loader2 aria-hidden="true" className="animate-spin" />
                    Creating
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
