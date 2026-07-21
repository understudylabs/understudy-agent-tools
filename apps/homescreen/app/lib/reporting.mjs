// Pure logic for the organization Analytics (reporting) pane.
//
// Ported from the web control plane's `app/(control-plane)/reporting/`
// (actions.ts sanitizer + ReportingClient.tsx aggregation/format helpers).
// The web keeps the closed-vocabulary sanitizer in a Server Action because
// actions are public entry points; on desktop the equivalent boundary is the
// Tauri command, so the sanitizer runs client-side right before `invoke` and
// malformed state can never fan out to the admin API.

/** @typedef {"24h" | "7d" | "30d" | "custom"} ReportingWindow */
/** @typedef {"minute" | "hour" | "day"} ReportingGranularity */
/** @typedef {"project" | "workload" | "model"} ReportingGroupBy */

// ---- closed-vocabulary sanitizer (port of actions.ts) ----

export function cleanDate(value) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export function cleanFilter(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed.length <= 255 ? trimmed : undefined;
}

/**
 * Closed vocabulary, same fallbacks as the web server action: unknown
 * windows collapse to "7d", granularities to "day", groupings to "project";
 * dates must be YYYY-MM-DD; filters are trimmed and length-capped.
 */
export function sanitizeReportingQuery(input) {
  return {
    window:
      input.window === "24h" || input.window === "30d" || input.window === "custom"
        ? input.window
        : "7d",
    from: cleanDate(input.from ?? null),
    to: cleanDate(input.to ?? null),
    granularity:
      input.granularity === "minute" || input.granularity === "hour"
        ? input.granularity
        : "day",
    group_by:
      input.groupBy === "workload" || input.groupBy === "model"
        ? input.groupBy
        : "project",
    project_id: cleanFilter(input.projectId ?? null),
    workload_id: cleanFilter(input.workloadId ?? null),
  };
}

// ---- range presets / granularity vocabulary ----

export function dateInputValue(value) {
  return value.slice(0, 10);
}

export function dateDaysAgo(days, now = new Date()) {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function presetRangeState(range, now = new Date()) {
  const today = dateInputValue(now.toISOString());
  if (range === "24h") return { range, window: "24h", from: today, to: today };
  if (range === "7d") return { range, window: "7d", from: dateDaysAgo(6, now), to: today };
  if (range === "30d") return { range, window: "30d", from: dateDaysAgo(29, now), to: today };
  if (range === "month-to-date") {
    const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    return { range, window: "custom", from: firstDay, to: today };
  }
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return {
    range,
    window: "custom",
    from: dateInputValue(firstDay.toISOString()),
    to: dateInputValue(lastDay.toISOString()),
  };
}

export function granularityOptions(from, to) {
  const days = Math.max(
    1,
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1,
  );
  return [
    ["day", "Day"],
    ...(days <= 31 ? [["hour", "Hour"]] : []),
    ...(days <= 1 ? [["minute", "Minute"]] : []),
  ];
}

export function defaultGranularity(from, to, current) {
  return granularityOptions(from, to).some(([value]) => value === current)
    ? current
    : "day";
}

// ---- series → chart / breakdown aggregation ----

function rowLabel(row, groupBy) {
  return groupBy === "project"
    ? row.project ?? "Unknown project"
    : groupBy === "workload"
      ? row.workload ?? "Unknown workload"
      : row.model ?? "Unknown model";
}

// Workload names are project-local, so two `main` workloads must never merge
// in an organization-wide report. Keep names for display only.
function rowIdentity(row, groupBy, label) {
  return groupBy === "project"
    ? row.project_id ?? label
    : groupBy === "workload"
      ? row.workload_id ?? label
      : row.model ?? label;
}

export function groupedChart(rows, groupBy, metric, granularity, palette) {
  const groups = new Map();
  const buckets = new Map();
  for (const row of rows) {
    const label = rowLabel(row, groupBy);
    const identity = rowIdentity(row, groupBy, label);
    const group = groups.get(identity) ?? { key: `group-${groups.size}`, label };
    groups.set(identity, group);
    const bucket = buckets.get(row.bucket) ?? {
      bucket: row.bucket,
      label: formatBucket(row.bucket, granularity),
      values: {},
    };
    bucket.values[group.key] =
      (bucket.values[group.key] ?? 0) +
      (metric === "usage"
        ? row.total_tokens
        : metric === "caching"
          ? row.cache_read_input_tokens
          : row.customer_cost_usd);
    buckets.set(row.bucket, bucket);
  }
  const series = [...groups.entries()].map(([identity, group], index) => ({
    ...group,
    identity,
    color: palette[index % palette.length],
  }));
  return { rows: [...buckets.values()], series };
}

export function aggregateBreakdown(rows, groupBy) {
  const groups = new Map();
  for (const row of rows) {
    const label = rowLabel(row, groupBy);
    const key = rowIdentity(row, groupBy, label);
    const group =
      groups.get(key) ?? {
        id: key,
        label,
        requests: 0,
        inputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReadPct: 0,
        costUsd: 0,
      };
    group.requests += row.requests;
    group.inputTokens += row.input_tokens;
    group.totalTokens += row.total_tokens;
    group.cacheReadTokens += row.cache_read_input_tokens;
    group.cacheWriteTokens += row.cache_creation_input_tokens;
    group.costUsd += row.customer_cost_usd;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((values) => ({ ...values, cacheReadPct: cacheReadShare(values) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}

export function defaultSort(metric) {
  return metric === "caching"
    ? { column: "cacheReadTokens", direction: "desc" }
    : { column: "costUsd", direction: "desc" };
}

export function sortIsVisible(metric, column) {
  return (
    column === "label" ||
    (metric === "caching" ? column.startsWith("cache") : !column.startsWith("cache"))
  );
}

export function sortBreakdown(rows, sort) {
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const comparison =
      sort.column === "label"
        ? left.label.localeCompare(right.label)
        : left[sort.column] - right[sort.column];
    return comparison * multiplier;
  });
}

export function toggleSeries(current, identity) {
  const next = new Set(current);
  if (next.has(identity)) next.delete(identity);
  else next.add(identity);
  return next;
}

export function cacheReadShare(row) {
  const input = row.input_tokens ?? row.inputTokens ?? 0;
  const cacheRead = row.cache_read_input_tokens ?? row.cacheReadTokens ?? 0;
  const cacheWrite = row.cache_creation_input_tokens ?? row.cacheWriteTokens ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? cacheRead / promptTokens : 0;
}

// ---- formatters ----

export function formatTokens(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
  }).format(value);
}

export function formatUSD(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function granularityLabel(granularity) {
  return granularity === "minute" ? "Minute" : granularity === "hour" ? "Hourly" : "Daily";
}

export function formatBucket(bucket, granularity) {
  const hasTime = bucket.includes(":");
  const date = new Date(hasTime ? `${bucket.replace(" ", "T")}Z` : `${bucket}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return bucket;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: hasTime ? "numeric" : undefined,
    minute: granularity === "minute" ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(date);
}

export function formatRange(start, end, inclusiveEnd = false) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const displayedEnd = inclusiveEnd
    ? new Date(new Date(end).getTime() - 86_400_000)
    : new Date(end);
  return `${formatter.format(new Date(start))} – ${formatter.format(displayedEnd)}`;
}

export function groupByLabel(groupBy) {
  return groupBy === "workload" ? "Workload" : groupBy === "model" ? "Model" : "Project";
}
