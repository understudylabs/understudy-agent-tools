// Pure display/aggregation logic for the project reporting (Analytics)
// pane. Ported from the web project's ReportingClient.tsx helpers plus
// lib/billing-format.ts so `node --test` can cover them directly.

/** `$X.XX` from a dollar value (the admin API returns DOLLARS, not cents). */
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

/** 0..1 share → "0%", "3.4%", "12%" (sub-10% keeps one decimal). */
export function formatShare(share) {
  const pct = share * 100;
  return `${pct === 0 || pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/** "2026-07-14" → "Jul 14" (UTC calendar days, matching the API). */
export function formatDayLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** ISO timestamp → "YYYY-MM-DD HH:MM:SSZ" (web _components/format.ts). */
export function formatTimestamp(iso) {
  const t = iso.replace("T", " ").slice(0, 19);
  return `${t}Z`;
}

/**
 * `group_by=day` rows → sorted chart series
 * [{ rawDay, label, requests }] ascending by day; rows without a day
 * (defensive: the API always sets it for this grouping) are dropped.
 */
export function dailySeries(byDay) {
  return byDay
    .flatMap((group) =>
      group.day ? [{ rawDay: group.day, requests: group.requests }] : [],
    )
    .sort((a, b) => a.rawDay.localeCompare(b.rawDay))
    .map(({ rawDay, requests }) => ({
      rawDay,
      label: formatDayLabel(rawDay),
      requests,
    }));
}

/** Totals across `group_by=workload` rows for the summary row. */
export function totalsFrom(rows) {
  return rows.reduce(
    (acc, group) => ({
      requests: acc.requests + group.requests,
      costUsd: acc.costUsd + group.customer_cost_usd,
      inputTokens: acc.inputTokens + group.input_tokens,
      cacheReadTokens: acc.cacheReadTokens + group.cache_read_input_tokens,
      cacheCreationTokens:
        acc.cacheCreationTokens + group.cache_creation_input_tokens,
    }),
    {
      requests: 0,
      costUsd: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  );
}

/**
 * Share of prompt tokens served from cache for the totals row. Same
 * denominator as the per-group `cache_read_pct` the admin API computes
 * (input + cache_read + cache_creation), re-derived here because the
 * totals row spans every workload group.
 */
export function cacheReadShare(row) {
  const promptTokens =
    row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
  return promptTokens > 0 ? row.cacheReadTokens / promptTokens : 0;
}
