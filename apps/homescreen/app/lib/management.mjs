// Pure management-surface logic, ported from the hosted control plane:
//   - deriveOverrideState  <- app/p/[project_slug]/_components/override-state.ts
//   - routeSummary, totalSpend, availableBalance, balanceDetail,
//     formatTrendDay, formatExpiry, spendTrendPoints
//                          <- app/p/[project_slug]/page.tsx
//   - formatUSD, formatTokens <- lib/billing-format.ts
//   - project-context cache <- replaces the per-server-render slug->project
//     resolution in _components/project-data.ts with a client-side cache.
// Plain .mjs so `node --test` can exercise it directly (repo convention).

/**
 * Derives the human-facing override state of a workload from its stored
 * routing columns. Mirrors `chooseTarget(workload, hash)` in the gateway:
 *   primary  — no deployment configured; passthrough.
 *   override — model configured and pct >= 100; full cutover.
 *   split    — model configured and 0 < pct < 100.
 *   hold     — model configured but pct <= 0; clean rollback that keeps
 *              the model selection.
 * Reflects configured intent, not observed delivery.
 */
export function deriveOverrideState(workload) {
  const modelId = workload.route_model_id ?? null;
  const pct = workload.route_traffic_pct;
  const configured =
    (workload.route_deployment_id ?? null) !== null || modelId !== null;

  if (!configured) {
    return { kind: "primary", modelId: null, trafficPct: pct };
  }
  if (pct <= 0) {
    return { kind: "hold", modelId, trafficPct: pct };
  }
  if (pct >= 100) {
    return { kind: "override", modelId, trafficPct: pct };
  }
  return { kind: "split", modelId, trafficPct: pct };
}

/** One-line route description for a workload card. */
export function routeSummary(state) {
  if (state.kind === "primary") return "Primary route";
  if (state.kind === "hold") return "Understudy held at 0%";
  if (state.kind === "split") return `Understudy split at ${state.trafficPct}%`;
  return `Understudy route at ${state.trafficPct}%`;
}

/** `$X.XX` from a dollar value (admin API amounts are already dollars). */
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

export function totalSpend(groups) {
  return groups.reduce((total, group) => total + group.customer_cost_usd, 0);
}

export function availableBalance(balance) {
  return balance.billing_mode === "prepaid"
    ? balance.grants.total_remaining_usd
    : balance.balance_usd;
}

export function balanceDetail(balance) {
  if (!balance) return "billing data unavailable";
  if (balance.billing_mode === "prepaid")
    return "organization credit remaining";
  return "postpaid usage, billed in arrears";
}

export function formatTrendDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatExpiry(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Sorted per-day cost points for the spend trend, with bar heights
 * pre-computed (minimum 4% so a bar is always visible, like the web chart).
 */
export function spendTrendPoints(byDayGroups) {
  const points = byDayGroups
    .flatMap((group) =>
      group.day ? [{ day: group.day, cost: group.customer_cost_usd }] : [],
    )
    .sort((a, b) => a.day.localeCompare(b.day));
  const maximum = Math.max(...points.map((point) => point.cost), 0);
  return {
    points: points.map((point) => ({
      ...point,
      heightPct: maximum > 0 ? Math.max((point.cost / maximum) * 100, 4) : 4,
    })),
    maximum,
  };
}

/**
 * Client-side project-context cache. The web app resolved slug->project on
 * every server render (`loadProjectContext`); the desktop app keeps one
 * in-memory copy per process and invalidates on mutation or explicit
 * refresh. `loader` is injected (the Tauri invoke wrapper) so tests can
 * drive the cache without a backend.
 */
export function createProjectContextCache(loader, ttlMs = 60_000, now = Date.now) {
  let cached = null; // { at, value }
  let inflight = null;

  const load = async () => {
    const value = await loader();
    cached = { at: now(), value };
    inflight = null;
    return value;
  };

  return {
    /** Cached value when fresh; otherwise one shared in-flight load. */
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      if (!inflight) {
        inflight = load().catch((err) => {
          inflight = null;
          throw err;
        });
      }
      return inflight;
    },
    /** Drop the cache (after a mutation) so the next get() refetches. */
    invalidate() {
      cached = null;
      inflight = null;
    },
    /** Peek without loading — for instant paint before a refresh lands. */
    peek() {
      return cached ? cached.value : null;
    },
  };
}
