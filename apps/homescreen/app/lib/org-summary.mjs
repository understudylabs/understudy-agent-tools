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

// ---------------------------------------------------------------------------
// Analytics series (the Overview Usage / Caching / Cost destinations).
//
// The admin usage-summary endpoint serves per-project rows; these helpers
// merge the per-project fan-out into org-wide daily series. Workload is the
// primary stacking dimension: the combined `group_by=workload,day` query
// gives per-workload per-day rows (the endpoint caps result sets at 5,000
// rows — fine at overview scale: workloads x 30 days per project).

/** workload_id -> display name across all project summaries. */
export function workloadNameMap(summaries) {
  const names = new Map();
  for (const summary of summaries) {
    for (const workload of summary.workloads) names.set(workload.id, workload.name);
  }
  return names;
}

function labelFor(names, workloadId, row) {
  if (!workloadId) return "unattributed";
  return names.get(workloadId) ?? row?.workload ?? workloadId;
}

function dayKey(value) {
  return typeof value === "string" ? value.slice(0, 10) : null;
}

/**
 * Generic day x key stack: rows sorted by day, values keyed by series name,
 * keys sorted by total contribution (largest first, stable by name).
 * `entries`: [{ day, key, value }].
 */
function buildStack(entries) {
  const byDay = new Map();
  const keyTotals = new Map();
  for (const { day, key, value } of entries) {
    if (!day || !key) continue;
    let values = byDay.get(day);
    if (!values) byDay.set(day, (values = {}));
    values[key] = (values[key] ?? 0) + value;
    keyTotals.set(key, (keyTotals.get(key) ?? 0) + value);
  }
  const keys = [...keyTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const rows = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({ day, values }));
  return { keys, rows };
}

/** Daily cost stacked by workload name from the org reporting series. */
export function spendStack(series, names) {
  return buildStack(
    (series ?? []).map((row) => ({
      day: dayKey(row.bucket),
      key: labelFor(names, row.workload_id, row),
      value: row.customer_cost_usd ?? 0,
    })),
  );
}

/**
 * Daily tokens (input + output) stacked by workload name from the merged
 * per-project `group_by=workload,day` rows. Falls back to stacking by
 * project when no project returned the combined shape (dimension flags
 * which one you got).
 */
export function tokenStack(summaries, names) {
  const byWorkload = [];
  const byProject = [];
  for (const summary of summaries) {
    for (const row of summary.usage?.workloadDay ?? []) {
      const day = dayKey(row.day);
      if (!day) continue;
      byWorkload.push({
        day,
        key: labelFor(names, row.workload_id, row),
        value: (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
      });
    }
    for (const row of summary.usage?.byDay ?? []) {
      const day = dayKey(row.day);
      if (!day) continue;
      byProject.push({
        day,
        key: summary.project.name,
        value: (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
      });
    }
  }
  if (byWorkload.length > 0) return { dimension: "workload", ...buildStack(byWorkload) };
  return { dimension: "project", ...buildStack(byProject) };
}

/** Per-key and grand totals over (possibly sliced) stack rows. */
export function stackTotals(rows) {
  const byKey = new Map();
  let total = 0;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.values)) {
      byKey.set(key, (byKey.get(key) ?? 0) + value);
      total += value;
    }
  }
  return { byKey, total };
}

/**
 * Daily org-wide token mix from the per-project by-day rows:
 * [{ day, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *    cacheRatePct }] sorted ascending. Cache rate = reads / (reads + fresh
 * input), as a 0-100 percent.
 */
export function usageDaySeries(summaries) {
  const byDay = new Map();
  for (const summary of summaries) {
    for (const row of summary.usage?.byDay ?? []) {
      const day = dayKey(row.day);
      if (!day) continue;
      let entry = byDay.get(day);
      if (!entry) {
        byDay.set(
          day,
          (entry = { day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        );
      }
      entry.inputTokens += row.input_tokens ?? 0;
      entry.outputTokens += row.output_tokens ?? 0;
      entry.cacheReadTokens += row.cache_read_input_tokens ?? 0;
      entry.cacheWriteTokens += row.cache_creation_input_tokens ?? 0;
    }
  }
  return [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((entry) => ({
      ...entry,
      cacheRatePct: cacheRatePct(entry.cacheReadTokens, entry.inputTokens),
    }));
}

/** reads / (reads + fresh input) as a percent; null when there is no input. */
export function cacheRatePct(cacheReadTokens, inputTokens) {
  const denominator = cacheReadTokens + inputTokens;
  return denominator > 0 ? (cacheReadTokens / denominator) * 100 : null;
}

/** Aggregate of usageDaySeries rows (works on a range-sliced subset). */
export function usageTotals(rows) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const row of rows) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
  }
  return { ...totals, cacheRatePct: cacheRatePct(totals.cacheReadTokens, totals.inputTokens) };
}

/**
 * Per-workload cache-rate leaders from the combined workload,day rows,
 * sorted by cache reads (largest first). Ignores workloads with no input.
 */
export function cacheLeaders(summaries, names) {
  const byWorkload = new Map();
  for (const summary of summaries) {
    for (const row of summary.usage?.workloadDay ?? []) {
      const key = labelFor(names, row.workload_id, row);
      let entry = byWorkload.get(key);
      if (!entry) byWorkload.set(key, (entry = { name: key, cacheReadTokens: 0, inputTokens: 0 }));
      entry.cacheReadTokens += row.cache_read_input_tokens ?? 0;
      entry.inputTokens += row.input_tokens ?? 0;
    }
  }
  return [...byWorkload.values()]
    .map((entry) => ({ ...entry, cacheRatePct: cacheRatePct(entry.cacheReadTokens, entry.inputTokens) }))
    .filter((entry) => entry.cacheRatePct !== null)
    .sort((a, b) => b.cacheReadTokens - a.cacheReadTokens);
}

/**
 * Per-workload usage detail from the merged `group_by=workload,day` rows,
 * optionally restricted to days >= sinceDay (YYYY-MM-DD, inclusive). Feeds
 * the deep workload cards: workload_id -> { requests, inputTokens,
 * outputTokens, cacheReadTokens, cacheRatePct }.
 */
export function workloadUsageDetails(summaries, sinceDay = null) {
  const byWorkload = new Map();
  for (const summary of summaries) {
    for (const row of summary.usage?.workloadDay ?? []) {
      if (!row.workload_id) continue;
      const day = dayKey(row.day);
      if (sinceDay && (!day || day < sinceDay)) continue;
      let entry = byWorkload.get(row.workload_id);
      if (!entry) {
        byWorkload.set(
          row.workload_id,
          (entry = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
        );
      }
      entry.requests += row.requests ?? 0;
      entry.inputTokens += row.input_tokens ?? 0;
      entry.outputTokens += row.output_tokens ?? 0;
      entry.cacheReadTokens += row.cache_read_input_tokens ?? 0;
    }
  }
  return new Map(
    [...byWorkload].map(([id, entry]) => [
      id,
      { ...entry, cacheRatePct: cacheRatePct(entry.cacheReadTokens, entry.inputTokens) },
    ]),
  );
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

  const [reporting, reporting30, balance, summaries] = await Promise.all([
    adminGet("reporting?window=7d&granularity=day&group_by=workload").catch(() => null),
    // Chart-only series: the widest window the hosted API supports, so the
    // range picker can slice arbitrary spans client-side. Metrics stay on
    // the 7d call above (web parity).
    adminGet("reporting?window=30d&granularity=day&group_by=workload").catch(() => null),
    adminGet("billing/balance")
      .then((response) => response.balance)
      .catch(() => null),
    Promise.all(
      projects.map(async (project) => {
        const id = encodeURIComponent(project.id);
        const [workloadsResult, statusResult, workloadDayResult, byDayResult] =
          await Promise.allSettled([
            adminGet(`projects/${id}/workloads`),
            adminGet(`projects/${id}/workload-status?window=24h`),
            // 30d usage-summary series for the Usage/Caching/Cost analytics
            // destinations. Two single-purpose queries: the combined
            // workload,day shape stacks tokens by workload; the plain day
            // shape backs the org-wide token/cache-rate series (and the
            // token fallback if the combined query is unavailable).
            adminGet(`projects/${id}/usage-summary?window=30d&group_by=workload,day`),
            adminGet(`projects/${id}/usage-summary?window=30d&group_by=day`),
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
          // Analytics degrade independently of the workload list: a failed
          // usage-summary leaves `usage` empty and the charts show their
          // empty state rather than blocking the overview.
          usage: {
            workloadDay:
              workloadDayResult.status === "fulfilled"
                ? workloadDayResult.value.groups ?? []
                : [],
            byDay:
              byDayResult.status === "fulfilled" ? byDayResult.value.groups ?? [] : [],
          },
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
    reporting30,
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
