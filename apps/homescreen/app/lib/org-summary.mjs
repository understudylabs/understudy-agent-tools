// Pure logic for the org Summary pane, ported from the web control plane:
//   apps/web/app/(control-plane)/dashboard/page.tsx   (aggregation + formats)
//   apps/web/lib/org-data.ts                          (per-project fan-out)
//   apps/web/app/p/[project_slug]/_components/override-state.ts
//   apps/web/lib/billing-format.ts
//
// The web page runs server-side with a WorkOS token; on desktop the same
// fan-out runs in the webview against the `admin_get` Tauri command (which
// holds the sk_ key natively). `loadOrgSummary` takes the fetcher as an
// argument so this module stays pure and `node --test`-able.

export const OVERVIEW_PROJECT_LIMIT = 12;

/** Mirrors `chooseTarget(workload, hash)` intent — see override-state.ts. */
export function deriveOverrideState(workload) {
  const modelId = workload.route_model_id ?? null;
  const pct = workload.route_traffic_pct;
  const configured = (workload.route_deployment_id ?? null) !== null || modelId !== null;

  if (!configured) return { kind: "primary", modelId: null, trafficPct: pct };
  if (pct <= 0) return { kind: "hold", modelId, trafficPct: pct };
  if (pct >= 100) return { kind: "override", modelId, trafficPct: pct };
  return { kind: "split", modelId, trafficPct: pct };
}

export function routeSummary(route) {
  if (route.kind === "primary") return "Primary routing";
  if (route.kind === "split") return "Partial route";
  if (route.kind === "hold") return "Route on hold";
  return "Override route";
}

/** Per-workload {requests, costUsd} rollup of the 7d reporting series. */
export function aggregateUsage(rows) {
  const usage = new Map();
  for (const row of rows) {
    if (!row.workload_id) continue;
    const current = usage.get(row.workload_id) ?? { requests: 0, costUsd: 0 };
    current.requests += row.requests;
    current.costUsd += row.customer_cost_usd;
    usage.set(row.workload_id, current);
  }
  return usage;
}

/** Daily [bucketDay, cost] points for the spend trend, sorted ascending. */
export function spendTrendPoints(rows) {
  const costs = new Map();
  for (const row of rows) {
    costs.set(row.bucket, (costs.get(row.bucket) ?? 0) + row.customer_cost_usd);
  }
  return [...costs.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/** Flattened, cost-sorted workload cards across project summaries. */
export function buildWorkloadCards(summaries, usageByWorkload, statusByWorkload) {
  return summaries
    .flatMap((summary) =>
      summary.workloads.map((workload) => ({
        workload,
        project: summary.project,
        usage: usageByWorkload.get(workload.id),
        healthStatus: statusByWorkload.get(workload.id) ?? "unavailable",
      })),
    )
    .sort((left, right) => (right.usage?.costUsd ?? 0) - (left.usage?.costUsd ?? 0));
}

export function healthLabel(status) {
  return status === "unavailable" ? "status unavailable" : status;
}

export function availableBalance(balance) {
  return balance.billing_mode === "prepaid"
    ? balance.grants.total_remaining_usd
    : balance.balance_usd;
}

export function balanceDetail(balance) {
  return balance.billing_mode === "prepaid"
    ? "available organization credit"
    : "organization billing balance";
}

/** `$X.XX` from a dollar value (the admin API reports dollars, not cents). */
export function formatUSD(usd) {
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Thousands-separated integer count. */
export function formatTokens(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** "Jul 14" from an ISO bucket, pinned to UTC like the web dashboard. */
export function formatDay(day) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
}

function readableError(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "unknown error";
}

/**
 * Full overview load: projects, per-project workloads + 24h status
 * (parallel fan-out, partial failures degrade to empty per project), 7d
 * reporting grouped by workload, and the billing balance.
 *
 * `adminGet(path)` resolves an org-relative admin/v1 GET to parsed JSON.
 */
export async function loadOrgSummary(adminGet) {
  let projects;
  try {
    const response = await adminGet("projects?limit=100");
    projects = (response.projects ?? []).slice(0, OVERVIEW_PROJECT_LIMIT);
  } catch (error) {
    return { ok: false, error: readableError(error) };
  }

  const [reporting, balance, summaries] = await Promise.all([
    adminGet("reporting?window=7d&granularity=day&group_by=workload").catch(() => null),
    adminGet("billing/balance")
      .then((response) => response.balance)
      .catch(() => null),
    Promise.all(
      projects.map(async (project) => {
        const id = encodeURIComponent(project.id);
        const [workloadsResult, statusResult] = await Promise.allSettled([
          adminGet(`projects/${id}/workloads`),
          adminGet(`projects/${id}/workload-status?window=24h`),
        ]);
        return {
          project,
          workloads:
            workloadsResult.status === "fulfilled"
              ? workloadsResult.value.workloads ?? []
              : [],
          statuses:
            statusResult.status === "fulfilled"
              ? statusResult.value.workloads ?? []
              : [],
          error:
            workloadsResult.status === "rejected"
              ? readableError(workloadsResult.reason)
              : null,
        };
      }),
    ),
  ]);

  const statusByWorkload = new Map(
    summaries.flatMap((summary) =>
      summary.statuses.map((entry) => [entry.workload_id, entry.status]),
    ),
  );
  const usageByWorkload = aggregateUsage(reporting?.series ?? []);
  const cards = buildWorkloadCards(summaries, usageByWorkload, statusByWorkload);
  const workloads = summaries.flatMap((summary) => summary.workloads);

  return {
    ok: true,
    projects,
    summaries,
    reporting,
    balance,
    cards,
    metrics: {
      totalSpendUsd: reporting?.totals?.customer_cost_usd ?? null,
      activeWorkloads: reporting
        ? cards.filter((card) => (card.usage?.requests ?? 0) > 0).length
        : null,
      captureEnabledCount: workloads.filter((workload) => workload.capture_enabled).length,
      workloadCount: workloads.length,
    },
    partialErrors: summaries
      .filter((summary) => summary.error)
      .map((summary) => `${summary.project.name}: ${summary.error}`),
  };
}
