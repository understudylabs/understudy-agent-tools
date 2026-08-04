export function buildWorkloadRows(routingEntries = [], healthEntries = []) {
  const rows = new Map();

  for (const route of routingEntries) {
    rows.set(route.workload_id, {
      workloadId: route.workload_id,
      name: route.display_name || route.workload_id,
      environment: route.environment ?? null,
      routeMode: route.route_mode,
      trafficPercent: Number(route.active_traffic_pct ?? 0),
      provider: route.provider_label ?? null,
      model: route.model ?? null,
      requests: 0,
      errors: 0,
      timeouts: 0,
      fallbacks: 0,
      requestIds: [],
    });
  }

  for (const health of healthEntries) {
    const existing = rows.get(health.workload) ?? {
      workloadId: health.workload,
      name: health.workload,
      environment: null,
      routeMode: "unknown",
      trafficPercent: 0,
      provider: null,
      model: null,
      requests: 0,
      errors: 0,
      timeouts: 0,
      fallbacks: 0,
      requestIds: [],
    };
    existing.requests += Number(health.request_count ?? 0);
    existing.errors += Number(health.error_5xx_count ?? 0);
    existing.timeouts += Number(health.timeout_count ?? 0);
    existing.fallbacks += Number(health.fallback_count ?? 0);
    existing.provider ||= health.provider || null;
    existing.model ||= health.model || null;
    existing.requestIds = [...new Set([
      ...existing.requestIds,
      ...(health.example_request_ids ?? []),
    ])].slice(0, 5);
    rows.set(health.workload, existing);
  }

  return [...rows.values()].sort((left, right) => {
    if (right.requests !== left.requests) return right.requests - left.requests;
    return left.name.localeCompare(right.name);
  });
}

export function monitoringState(health) {
  const requests = Number(health?.total_requests ?? 0);
  const errors = Number(health?.total_errors ?? 0);
  const timeouts = (health?.providers ?? []).reduce(
    (sum, provider) => sum + Number(provider.timeout_count ?? 0),
    0,
  );
  const fallbacks = (health?.providers ?? []).reduce(
    (sum, provider) => sum + Number(provider.fallback_count ?? 0),
    0,
  );

  if (errors > 0 || timeouts > 0) {
    return {
      tone: "attention",
      label: "Needs attention",
      detail: `${errors} errors · ${timeouts} timeouts`,
      errors,
      timeouts,
      fallbacks,
    };
  }
  if (fallbacks > 0) {
    return {
      tone: "watch",
      label: "Healthy with fallbacks",
      detail: `${fallbacks} requests used a fallback`,
      errors,
      timeouts,
      fallbacks,
    };
  }
  if (requests === 0) {
    return {
      tone: "quiet",
      label: "No traffic yet",
      detail: "No requests in this window",
      errors,
      timeouts,
      fallbacks,
    };
  }
  return {
    tone: "healthy",
    label: "Everything is green",
    detail: "No provider errors, timeouts, or fallbacks",
    errors,
    timeouts,
    fallbacks,
  };
}

export function cacheReusePercent(summary) {
  const tokens = summary?.tokens;
  if (!tokens) return null;
  const cached = Number(tokens.cache_read_input_tokens ?? 0);
  const totalInput =
    Number(tokens.input_tokens ?? 0) +
    cached +
    Number(tokens.cache_creation_input_tokens ?? 0);
  if (totalInput <= 0) return null;
  return Math.max(0, Math.min(100, (cached / totalInput) * 100));
}

export function topModelRows(rows = [], limit = 6) {
  return [...rows]
    .sort((left, right) => Number(right.cost_usd ?? 0) - Number(left.cost_usd ?? 0))
    .slice(0, limit);
}

export function displayModelName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "Unknown model";
  const path = raw.split("?")[0].replace(/\/+$/, "");
  const segments = path.split(/[/:]/).filter(Boolean);
  return segments.at(-1) || raw;
}

export function snapshotForSelection(snapshot, projectId, window) {
  if (!snapshot) return null;
  return snapshot.project_id === projectId && snapshot.window === window
    ? snapshot
    : null;
}
