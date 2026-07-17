"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  buildWorkloadRows,
  cacheReusePercent,
  displayModelName,
  monitoringState,
  topModelRows,
} from "../lib/monitoring.mjs";

type ReportingProject = {
  id: string;
  slug: string;
  name: string;
  created_at: string;
};

type ReportingProjectsResponse = {
  org_id: string;
  projects: ReportingProject[];
};

type RoutingStatusEntry = {
  workload_id: string;
  display_name: string;
  environment: string | null;
  route_mode: "primary" | "understudy" | "passthrough";
  active_traffic_pct: number;
  provider_label: string | null;
  model: string | null;
  updated_at: string;
};

type ProviderHealthEntry = {
  provider: string;
  workload: string;
  model: string;
  request_count: number;
  error_5xx_count: number;
  error_5xx_rate: number;
  timeout_count: number;
  fallback_count: number;
  last_failing_at: string | null;
  example_request_ids: string[];
};

type TokenBreakdown = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

type MonitoringSnapshot = {
  project_id: string;
  window: string;
  fetched_at: string;
  source: string;
  routing: {
    project_id: string;
    workloads: RoutingStatusEntry[];
    workload_count: number;
    generated_at: string;
  };
  health: {
    project_id: string;
    window: string;
    window_start: string;
    window_end: string;
    total_requests: number;
    total_errors: number;
    providers: ProviderHealthEntry[];
    generated_at: string;
  };
  billing: {
    summary: {
      org_id: string;
      from: string;
      to: string;
      tokens: TokenBreakdown;
      metered_requests: number;
      priced_events: number;
      estimated_cost_usd: number;
      blended_price_per_mtok: number;
    };
  } | null;
  usage_by_model: {
    rows: Array<{
      provider: string;
      served_model: string;
      requests: number;
      tokens: TokenBreakdown;
      cost_usd: number;
    }>;
  } | null;
  warnings: string[];
};

const WINDOWS = [
  ["30m", "30 min"],
  ["1h", "1 hour"],
  ["6h", "6 hours"],
  ["12h", "12 hours"],
  ["24h", "24 hours"],
] as const;
const CACHE_PREFIX = "understudy.monitor.snapshot.v1";
const PROJECT_KEY = "understudy.monitor.project.v1";
const WINDOW_KEY = "understudy.monitor.window.v1";

const count = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function cacheKey(projectId: string, window: string) {
  return `${CACHE_PREFIX}.${projectId}.${window}`;
}

function readCachedSnapshot(projectId: string, window: string): MonitoringSnapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(projectId, window));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MonitoringSnapshot;
    return parsed.project_id === projectId && parsed.window === window ? parsed : null;
  } catch {
    return null;
  }
}

function relativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function routeLabel(mode: string, percent: number) {
  if (mode === "passthrough") return "Direct";
  if (percent >= 100) return "Understudy · all traffic";
  return `Understudy · ${percent}%`;
}

export function MonitorPane({ onOpenAccount }: { onOpenAccount: () => void }) {
  const [projects, setProjects] = useState<ReportingProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [window, setWindow] = useState("12h");
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadSnapshot = useCallback(async (
    nextProjectId: string,
    nextWindow: string,
    options: { preferCache?: boolean; background?: boolean } = {},
  ) => {
    if (!nextProjectId || !isTauri()) return;
    const sequence = ++requestSequence.current;
    const cached = options.preferCache ? readCachedSnapshot(nextProjectId, nextWindow) : null;
    if (cached) {
      setSnapshot(cached);
      setLoading(false);
    }
    if (options.background) setRefreshing(true);
    else if (!cached) setLoading(true);
    setError(null);
    try {
      const next = await invoke<MonitoringSnapshot>("reporting_snapshot", {
        projectId: nextProjectId,
        window: nextWindow,
      });
      if (sequence !== requestSequence.current) return;
      setSnapshot(next);
      localStorage.setItem(cacheKey(nextProjectId, nextWindow), JSON.stringify(next));
    } catch (nextError) {
      if (sequence !== requestSequence.current) return;
      setError(String(nextError));
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      setError("Production monitoring is available in the installed Desktop app.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await invoke<ReportingProjectsResponse>("reporting_projects");
        if (cancelled) return;
        setProjects(response.projects);
        const storedProject = localStorage.getItem(PROJECT_KEY);
        const selected = response.projects.find((project) => project.id === storedProject)
          ?? response.projects[0];
        const storedWindow = localStorage.getItem(WINDOW_KEY);
        const selectedWindow = WINDOWS.some(([value]) => value === storedWindow)
          ? storedWindow!
          : "12h";
        setWindow(selectedWindow);
        if (!selected) {
          setLoading(false);
          setError("No projects are available for this organization yet.");
          return;
        }
        setProjectId(selected.id);
        await loadSnapshot(selected.id, selectedWindow, { preferCache: true });
      } catch (nextError) {
        if (!cancelled) {
          setLoading(false);
          setError(String(nextError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSnapshot]);

  useEffect(() => {
    if (!projectId) return;
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadSnapshot(projectId, window, { background: true });
      }
    }, 60_000);
    return () => globalThis.clearInterval(timer);
  }, [loadSnapshot, projectId, window]);

  const state = useMemo(() => monitoringState(snapshot?.health), [snapshot]);
  const workloads = useMemo(
    () => buildWorkloadRows(snapshot?.routing.workloads, snapshot?.health.providers),
    [snapshot],
  );
  const models = useMemo(
    () => topModelRows(snapshot?.usage_by_model?.rows ?? [], 6),
    [snapshot],
  );
  const reuse = cacheReusePercent(snapshot?.billing?.summary);
  const maxModelCost = Math.max(0, ...models.map((model) => model.cost_usd));
  const selectedProject = projects.find((project) => project.id === projectId);

  const copyRequestId = async (requestId: string) => {
    await navigator.clipboard.writeText(requestId);
    setCopied(requestId);
    globalThis.setTimeout(() => setCopied((current) => current === requestId ? null : current), 1800);
  };

  return (
    <section className="monitor-pane settle" aria-labelledby="monitor-title">
      <header className="monitor-topbar">
        <div>
          <span className="monitor-kicker">Production monitor</span>
          <h1 id="monitor-title">{selectedProject?.name ?? "Your traffic"}</h1>
          <p>Customer-safe aggregates only. Prompts and responses never load here.</p>
        </div>
        <div className="monitor-controls">
          {projects.length > 1 && (
            <label>
              <span className="sr-only">Project</span>
              <select
                value={projectId}
                onChange={(event) => {
                  const next = event.target.value;
                  setProjectId(next);
                  localStorage.setItem(PROJECT_KEY, next);
                  void loadSnapshot(next, window, { preferCache: true });
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="sr-only">Time window</span>
            <select
              value={window}
              onChange={(event) => {
                const next = event.target.value;
                setWindow(next);
                localStorage.setItem(WINDOW_KEY, next);
                void loadSnapshot(projectId, next, { preferCache: true });
              }}
            >
              {WINDOWS.map(([value, label]) => (
                <option key={value} value={value}>Last {label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="monitor-refresh"
            aria-label="Refresh production monitor"
            disabled={!projectId || refreshing}
            onClick={() => void loadSnapshot(projectId, window, { background: true })}
          >
            <RefreshCwIcon aria-hidden="true" size={15} className={refreshing ? "spinning" : ""} />
            Refresh
          </button>
        </div>
      </header>

      {loading && !snapshot ? (
        <div className="monitor-loading" aria-live="polite">
          <span className="monitor-loading-ring" aria-hidden="true" />
          <strong>Checking production traffic…</strong>
          <span>Routing and health first; spend follows independently.</span>
        </div>
      ) : error && !snapshot ? (
        <div className="monitor-blocked" role="alert">
          <AlertTriangleIcon aria-hidden="true" size={20} />
          <div>
            <strong>Monitoring could not open</strong>
            <p>{error}</p>
          </div>
          {error.toLowerCase().includes("sign in") && (
            <button type="button" onClick={onOpenAccount}>Sign in</button>
          )}
        </div>
      ) : snapshot ? (
        <>
          <section className={`monitor-verdict ${state.tone}`} aria-live="polite">
            <div className="monitor-verdict-icon">
              {state.tone === "healthy" ? (
                <CheckCircle2Icon aria-hidden="true" size={25} strokeWidth={1.6} />
              ) : (
                <AlertTriangleIcon aria-hidden="true" size={25} strokeWidth={1.6} />
              )}
            </div>
            <div>
              <span>Right now</span>
              <h2>{state.label}</h2>
              <p>{state.detail}</p>
            </div>
            <time dateTime={snapshot.fetched_at}>Updated {relativeTime(snapshot.fetched_at)}</time>
          </section>

          {error && <div className="monitor-stale" role="status">Showing the last local snapshot. {error}</div>}
          {snapshot.warnings.length > 0 && (
            <div className="monitor-warning" role="status">
              Traffic health is current. Some spend context is unavailable.
            </div>
          )}

          <section className="monitor-metrics" aria-label="Production summary">
            <article>
              <span>Requests</span>
              <strong>{count.format(snapshot.health.total_requests)}</strong>
              <small>Selected project</small>
            </article>
            <article>
              <span>Estimated spend</span>
              <strong>{snapshot.billing ? money.format(snapshot.billing.summary.estimated_cost_usd) : "—"}</strong>
              <small>All org projects</small>
            </article>
            <article className={state.errors > 0 ? "attention" : ""}>
              <span>Provider failures</span>
              <strong>{count.format(state.errors)}</strong>
              <small>{state.timeouts} timeouts · {state.fallbacks} fallbacks</small>
            </article>
            <article>
              <span>Input reused</span>
              <strong>{reuse === null ? "—" : `${reuse.toFixed(1)}%`}</strong>
              <small>Org-wide prompt cache</small>
            </article>
          </section>

          <div className="monitor-grid">
            <section className="monitor-panel monitor-workloads">
              <header>
                <div>
                  <span className="monitor-kicker">Traffic by workload</span>
                  <h2>What is live</h2>
                </div>
                <span>{workloads.length} workloads</span>
              </header>
              <div className="monitor-workload-list">
                {workloads.length === 0 ? (
                  <p className="monitor-empty">No workloads are configured yet.</p>
                ) : workloads.map((workload) => {
                  const hasProblem = workload.errors > 0 || workload.timeouts > 0;
                  const hasFallback = workload.fallbacks > 0;
                  return (
                    <article key={workload.workloadId} className={hasProblem ? "attention" : hasFallback ? "watch" : ""}>
                      <div className="monitor-workload-main">
                        <span className="monitor-health-dot" aria-hidden="true" />
                        <div>
                          <strong>{workload.name}</strong>
                          <small>{routeLabel(workload.routeMode, workload.trafficPercent)}{workload.model ? ` · ${displayModelName(workload.model)}` : ""}</small>
                        </div>
                      </div>
                      <div className="monitor-workload-count">
                        <strong>{count.format(workload.requests)}</strong>
                        <span>requests</span>
                      </div>
                      <div className="monitor-workload-state">
                        {hasProblem
                          ? `${workload.errors} errors · ${workload.timeouts} timeouts`
                          : hasFallback
                            ? `${workload.fallbacks} fallbacks`
                            : workload.requests > 0 ? "Healthy" : "No traffic"}
                      </div>
                      {workload.requestIds.length > 0 && (
                        <div className="monitor-request-ids">
                          <span>Affected requests</span>
                          {workload.requestIds.map((requestId) => (
                            <button key={requestId} type="button" onClick={() => void copyRequestId(requestId)}>
                              <code>{requestId}</code>
                              {copied === requestId
                                ? <ClipboardCheckIcon aria-hidden="true" size={12} />
                                : <CopyIcon aria-hidden="true" size={12} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="monitor-panel monitor-models">
              <header>
                <div>
                  <span className="monitor-kicker">Spend-weighted</span>
                  <h2>Models used</h2>
                </div>
                <span>Org-wide</span>
              </header>
              {models.length === 0 ? (
                <p className="monitor-empty">Model spend is not available for this window.</p>
              ) : (
                <div className="monitor-model-list">
                  {models.map((model) => (
                    <article key={`${model.provider}:${model.served_model}`}>
                      <div>
                        <strong>{displayModelName(model.served_model)}</strong>
                        <span>{count.format(model.requests)} requests</span>
                      </div>
                      <b>{money.format(model.cost_usd)}</b>
                      <i aria-hidden="true"><span style={{ width: `${maxModelCost > 0 ? (model.cost_usd / maxModelCost) * 100 : 0}%` }} /></i>
                    </article>
                  ))}
                </div>
              )}
              <footer>
                Ranked by spend so the highest-leverage traffic is always first.
              </footer>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
