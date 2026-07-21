// Pure view-model helpers for the remote training run view.
// No React, no Tauri — unit-tested directly with node --test.

/**
 * Merge incoming loss deltas (per-poll batches from event.metrics.loss) into
 * the accumulated curve. Dedupes by step (latest value wins) and keeps the
 * result sorted by step ascending.
 * @param {Array<{step: number, value: number}>} existing
 * @param {Array<{step: number, value: number}>} incoming
 * @returns {Array<{step: number, value: number}>}
 */
export function accumulateLossPoints(existing, incoming) {
  if (!incoming || incoming.length === 0) return existing;
  const byStep = new Map(existing.map((point) => [point.step, point]));
  for (const point of incoming) {
    if (!point || !Number.isFinite(point.step) || !Number.isFinite(point.value)) continue;
    byStep.set(point.step, { step: point.step, value: point.value });
  }
  return [...byStep.values()].sort((left, right) => left.step - right.step);
}

/**
 * Detect where the loss curve flattens: the first point of a terminal window
 * whose spread is small relative to the curve's overall range. Returns the
 * index of the plateau start, or null when the curve is still moving (or is
 * too short to judge).
 * @param {Array<{step: number, value: number}>} points
 * @param {{window?: number, tolerance?: number}} [options]
 * @returns {number | null}
 */
export function detectPlateau(points, options = {}) {
  const window = options.window ?? 6;
  const tolerance = options.tolerance ?? 0.03;
  if (points.length < window + 2) return null;
  const values = points.map((point) => point.value);
  const range = Math.max(...values) - Math.min(...values);
  if (range <= 0) return points.length - window;
  const tail = values.slice(-window);
  const tailSpread = Math.max(...tail) - Math.min(...tail);
  if (tailSpread <= range * tolerance) return points.length - window;
  return null;
}

/**
 * "about Xm left" copy for details.estimated_remaining_seconds.
 * @param {number | null | undefined} seconds
 * @returns {string | null}
 */
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return "about a minute left";
  if (seconds < 3_600) return `about ${Math.round(seconds / 60)}m left`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return minutes > 0 ? `about ${hours}h ${minutes}m left` : `about ${hours}h left`;
}

/** @param {number | null | undefined} seconds */
export function formatWait(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.floor(seconds)}s in line`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m in line` : `${Math.floor(minutes / 60)}h ${minutes % 60}m in line`;
}

/**
 * Phase-aware headline for the running stage.
 * @param {{
 *   phase?: string,
 *   message?: string,
 *   progress?: { completed?: number, total?: number, unit?: string, epoch?: number, total_epochs?: number, percent?: number, step?: number },
 *   details?: { queue_seconds?: number, estimated_remaining_seconds?: number, elapsed_seconds?: number, estimated_spend_usd?: number },
 * } | null | undefined} event
 * @returns {{ title: string, detail: string | null }}
 */
export function progressHeadline(event) {
  if (!event) return { title: "Starting", detail: null };
  const details = event.details ?? {};
  const parts = [];
  if (event.phase === "provider_queue") {
    const wait = formatWait(details.queue_seconds);
    return { title: "Waiting for a training machine", detail: wait };
  }
  if (event.phase === "training") {
    const progress = event.progress ?? {};
    let title = "Training";
    if (progress.epoch != null && progress.total_epochs != null) {
      title = `Training — pass ${progress.epoch} of ${progress.total_epochs}`;
      if (progress.step != null) title += ` · step ${progress.step.toLocaleString()}`;
    } else if (progress.step != null) {
      title = `Training — step ${progress.step.toLocaleString()}`;
    } else if (progress.percent != null) {
      title = `Training — ${Math.round(progress.percent)}%`;
    }
    const eta = formatEta(details.estimated_remaining_seconds);
    if (eta) parts.push(eta);
    if (Number.isFinite(details.estimated_spend_usd) && details.estimated_spend_usd > 0) {
      parts.push(`$${details.estimated_spend_usd.toFixed(2)} so far`);
    }
    return { title, detail: parts.length > 0 ? parts.join(" · ") : null };
  }
  const titles = {
    evaluation: "Evaluating",
    deployment: "Preparing your model",
    cleanup: "Finishing safely",
    upload: "Starting",
    queued: "Starting",
  };
  return { title: titles[event.phase] ?? "Starting", detail: null };
}

/**
 * Pull the baseline (untrained model) aggregate score out of the event
 * stream, as a 0–100 percentage, or null while unknown. Tolerant of the
 * score arriving as a 0–1 fraction or a 0–100 percentage in details.
 * @param {Array<{type?: string, details?: Record<string, string | number | boolean>}>} events
 * @returns {number | null}
 */
export function baselineScorePercent(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "baseline_evaluation") continue;
    const details = event.details ?? {};
    if (details.stage !== undefined && details.stage !== "completed") continue;
    const raw = [details.score, details.aggregate_score, details.accuracy]
      .find((value) => typeof value === "number" && Number.isFinite(value));
    if (raw === undefined) continue;
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }
  return null;
}

/** @param {string | undefined} isoTimestamp */
function narrationTime(isoTimestamp) {
  if (!isoTimestamp) return null;
  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The last `limit` narration lines. The service's plain-English message IS
 * the content and renders verbatim, except completed baseline evaluations,
 * which render as the bar-to-beat line. Consecutive duplicate messages
 * collapse so the feed stays quiet.
 * @param {Array<{sequence?: number, type?: string, occurred_at?: string, message?: string, details?: Record<string, string | number | boolean>}>} events
 * @param {number} [limit]
 * @returns {Array<{ key: string, time: string | null, text: string, kind: "narration" | "baseline" }>}
 */
export function narrationFeed(events, limit = 4) {
  const lines = [];
  for (const [index, event] of events.entries()) {
    if (!event?.message) continue;
    let text = event.message;
    let kind = "narration";
    if (event.type === "baseline_evaluation") {
      kind = "baseline";
      const score = baselineScorePercent([event]);
      if (score != null) text = `Untrained model scores ${score}% — that's the bar to beat.`;
    }
    if (lines.length > 0 && lines[lines.length - 1].text === text) continue;
    lines.push({
      key: `${event.sequence ?? index}-${index}`,
      time: narrationTime(event.occurred_at),
      text,
      kind,
    });
  }
  return lines.slice(-limit);
}

/**
 * Geometry for the hand-rolled loss sparkline: polyline + closed area path
 * strings in a fixed viewBox, plus the pixel position of the latest and
 * plateau points. Returns null when there are fewer than two points (the
 * view should render nothing rather than an empty chart skeleton).
 * @param {Array<{step: number, value: number}>} points
 * @param {{width?: number, height?: number, pad?: number}} [options]
 */
export function lossSparklineGeometry(points, options = {}) {
  const width = options.width ?? 240;
  const height = options.height ?? 56;
  const pad = options.pad ?? 4;
  if (points.length < 2) return null;
  const steps = points.map((point) => point.step);
  const values = points.map((point) => point.value);
  const minStep = Math.min(...steps);
  const maxStep = Math.max(...steps);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const stepSpan = maxStep - minStep || 1;
  const valueSpan = maxValue - minValue || 1;
  const x = (step) => pad + ((step - minStep) / stepSpan) * (width - pad * 2);
  const y = (value) => pad + ((maxValue - value) / valueSpan) * (height - pad * 2);
  const coords = points.map((point) => ({ x: x(point.step), y: y(point.value) }));
  const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  const area = `${line} ${coords[coords.length - 1].x.toFixed(2)},${height - pad} ${coords[0].x.toFixed(2)},${height - pad}`;
  const latest = points[points.length - 1];
  return {
    width,
    height,
    line,
    area,
    latest: { ...coords[coords.length - 1], step: latest.step, value: latest.value },
    at: (index) => (index >= 0 && index < coords.length ? coords[index] : null),
  };
}
