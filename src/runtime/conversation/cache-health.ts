import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_HEALTH_SCHEMA = "understudy-cache-health-v1";
export const CACHE_TTL_MS = 5 * 60 * 1_000;
export const CACHE_REGRESSION_POINTS = 20;
export const CACHE_REGRESSION_MIN_ELIGIBLE_TOKENS = 4_096;
export const CACHE_REGRESSION_MIN_MISSED_TOKENS = 2_048;

type Usage = {
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
};

export type CacheUsageSample = {
  session_id: string;
  timestamp: number;
  model_key: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reset_before?: boolean;
};

export type CacheHealth = {
  schema_version: typeof CACHE_HEALTH_SCHEMA;
  status: "unavailable" | "warming" | "healthy" | "regressed";
  alert: boolean;
  score_pct: number | null;
  baseline_score_pct: number | null;
  regression_points: number | null;
  turns: number;
  comparable_turns: number;
  recent_comparable_turns: number;
  recent_cache_read_tokens: number;
  recent_cache_eligible_tokens: number;
  recent_missed_tokens: number;
  significant_miss_count: number;
  detail: string;
};

type ComparableTurn = {
  timestamp: number;
  eligible: number;
  read: number;
  missed: number;
};

function finiteNonnegative(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function score(turns: ComparableTurn[]): number | null {
  const eligible = turns.reduce((total, turn) => total + turn.eligible, 0);
  if (eligible <= 0) return null;
  const read = turns.reduce((total, turn) => total + turn.read, 0);
  return Math.max(0, Math.min(100, (read / eligible) * 100));
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function computeCacheHealth(samples: CacheUsageSample[]): CacheHealth {
  const ordered = [...samples].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const reportedCache = ordered.some(
    (sample) => sample.cache_read_tokens + sample.cache_write_tokens > 0,
  );
  const comparable: ComparableTurn[] = [];
  const previousBySession = new Map<string, CacheUsageSample>();
  const reportedBySession = new Map<string, boolean>();

  for (const sample of ordered) {
    const sessionReported =
      (reportedBySession.get(sample.session_id) ?? false) ||
      sample.cache_read_tokens + sample.cache_write_tokens > 0;
    reportedBySession.set(sample.session_id, sessionReported);
    const previous = sample.reset_before
      ? undefined
      : previousBySession.get(sample.session_id);
    previousBySession.set(sample.session_id, sample);
    if (!previous) continue;
    if (!sessionReported) continue;
    if (previous.model_key !== sample.model_key) continue;
    if (sample.timestamp - previous.timestamp > CACHE_TTL_MS) continue;

    const previousPrompt =
      previous.input_tokens +
      previous.cache_read_tokens +
      previous.cache_write_tokens;
    const prompt =
      sample.input_tokens + sample.cache_read_tokens + sample.cache_write_tokens;
    const eligible = Math.min(previousPrompt, prompt);
    if (eligible <= 0) continue;
    const read = Math.min(sample.cache_read_tokens, eligible);
    comparable.push({
      timestamp: sample.timestamp,
      eligible,
      read,
      missed: Math.max(0, eligible - read),
    });
  }

  const recent = comparable.slice(-5);
  const baseline = comparable.slice(-10, -5);
  const recentScore = score(recent);
  const baselineScore = score(baseline);
  const eligible = recent.reduce((total, turn) => total + turn.eligible, 0);
  const read = recent.reduce((total, turn) => total + turn.read, 0);
  const missed = recent.reduce((total, turn) => total + turn.missed, 0);
  const regression =
    recentScore !== null && baselineScore !== null
      ? baselineScore - recentScore
      : null;
  const alert = Boolean(
    recent.length >= 3 &&
      baseline.length >= 3 &&
      regression !== null &&
      regression >= CACHE_REGRESSION_POINTS &&
      eligible >= CACHE_REGRESSION_MIN_ELIGIBLE_TOKENS &&
      missed >= CACHE_REGRESSION_MIN_MISSED_TOKENS,
  );

  let status: CacheHealth["status"] = "healthy";
  let detail = `Stable across ${recent.length} comparable turn${recent.length === 1 ? "" : "s"}.`;
  if (!reportedCache) {
    status = "unavailable";
    detail = "The active provider has not reported prompt-cache usage yet.";
  } else if (comparable.length < 3) {
    status = "warming";
    detail = `Collecting cache evidence (${comparable.length}/3 comparable turns).`;
  } else if (alert) {
    status = "regressed";
    detail = `Cache reuse fell ${rounded(regression)} points across the recent window.`;
  }

  return {
    schema_version: CACHE_HEALTH_SCHEMA,
    status,
    alert,
    score_pct: reportedCache ? rounded(recentScore) : null,
    baseline_score_pct: reportedCache ? rounded(baselineScore) : null,
    regression_points: reportedCache ? rounded(regression) : null,
    turns: ordered.length,
    comparable_turns: comparable.length,
    recent_comparable_turns: recent.length,
    recent_cache_read_tokens: read,
    recent_cache_eligible_tokens: eligible,
    recent_missed_tokens: missed,
    significant_miss_count: recent.filter(
      (turn) => turn.missed > 1_024,
    ).length,
    detail,
  };
}

function sessionFiles(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

export function readCacheUsageSamples(sessionRoot: string): CacheUsageSample[] {
  const samples: CacheUsageSample[] = [];
  for (const path of sessionFiles(sessionRoot)) {
    const sessionId = path;
    let resetBefore = false;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        resetBefore = true;
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;
      const usage = (message.usage ?? {}) as Usage;
      const timestamp = finiteNonnegative(message.timestamp) || Date.now();
      const provider = String(message.provider ?? "unknown");
      const model = String(message.model ?? "unknown");
      samples.push({
        session_id: sessionId,
        timestamp,
        model_key: `${provider}/${model}`,
        input_tokens: finiteNonnegative(usage.input),
        cache_read_tokens: finiteNonnegative(usage.cacheRead),
        cache_write_tokens: finiteNonnegative(usage.cacheWrite),
        ...(resetBefore ? { reset_before: true } : {}),
      });
      resetBefore = false;
    }
  }
  return samples;
}

export function cacheHealthFromSessionRoot(sessionRoot: string): CacheHealth {
  return computeCacheHealth(readCacheUsageSamples(sessionRoot));
}
