/**
 * Pure helpers behind the trajectory-first explorer (three-pane task
 * inspector, Prime-Environments-Hub style) and the taskset table's header
 * histograms. No fs/react imports — everything here is node:test-able and
 * client-safe.
 *
 * Conversation normalization notes ported from Moraine's session projection
 * (moraine-clickhouse mcp_open_projection): tool payload kinds collapse to
 * two chips — tool_use/tool_call/function_call → "tool call" and
 * tool_result/tool_response/function_call_output → "tool output" — and the
 * system role is demoted out of the turn stream into its own collapsed block.
 */

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/* ---------------- histograms ---------------- */

export type Histogram = { bins: number[]; min: number; max: number; count: number };

/**
 * Fixed-width binning for the tiny header histograms. Degenerate inputs stay
 * renderable: empty → all-zero bins, single value → one full bin.
 */
export function binHistogram(values: (number | null | undefined)[], binCount = 12): Histogram {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const bins = new Array(Math.max(1, binCount)).fill(0);
  if (xs.length === 0) return { bins, min: 0, max: 0, count: 0 };
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const span = max - min;
  for (const x of xs) {
    const i = span === 0 ? 0 : Math.min(bins.length - 1, Math.floor(((x - min) / span) * bins.length));
    bins[i] += 1;
  }
  return { bins, min, max, count: xs.length };
}

/* ---------------- snippets + entity chips ---------------- */

/** First non-empty line, clipped — the one-line row snippet. */
export function firstLine(text: string, maxChars = 140): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line;
}

export type TextSegment = { kind: "text" | "entity"; value: string };

const ENTITY_RE =
  /([A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]*[0-9A-Za-z]{2}|[a-f0-9]{12,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d[\d ().-]{8,}\d)/g;

/**
 * Light regex entity chipping for expanded turns: long alnum ids (≥12 chars
 * mixing letters+digits), hex ids, emails, phone-shaped strings become
 * compact pills. Deliberately unclever — presentation only.
 */
export function entitySegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(ENTITY_RE)) {
    const value = m[0];
    const isId = /^[A-Za-z0-9_-]{12,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
    const isHex = /^[a-f0-9]{12,}$/.test(value);
    const isEmail = value.includes("@");
    const isPhone = /^\+?\d[\d ().-]{8,}\d$/.test(value) && value.replace(/\D/g, "").length >= 10;
    if (!(isId || isHex || isEmail || isPhone)) continue;
    if (m.index > last) segments.push({ kind: "text", value: text.slice(last, m.index) });
    segments.push({ kind: "entity", value });
    last = m.index + value.length;
  }
  if (last < text.length) segments.push({ kind: "text", value: text.slice(last) });
  return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}

/* ---------------- conversation normalization ---------------- */

export type ToolChip = { kind: "call" | "output"; name: string; id: string | null; payload: unknown };

export type Turn = {
  role: string;
  text: string;
  chips: ToolChip[];
};

export type Conversation = {
  /** Deduped system prompt (first non-empty across rounds), demoted to its own collapsed block. */
  system: string | null;
  turns: Turn[];
  /** Names of tools defined on the request, for the overview rail. */
  toolNames: string[];
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
};

function chipsFromBlocks(content: unknown): ToolChip[] {
  if (!Array.isArray(content)) return [];
  const chips: ToolChip[] = [];
  for (const b of content) {
    if (!isObject(b)) continue;
    if (b.type === "tool_use" || b.type === "tool_call" || b.type === "function_call") {
      chips.push({ kind: "call", name: String(b.name ?? "tool"), id: (b.id as string) ?? null, payload: b.input ?? b.arguments ?? {} });
    } else if (b.type === "tool_result" || b.type === "tool_response" || b.type === "function_call_output") {
      chips.push({ kind: "output", name: String(b.name ?? "result"), id: (b.tool_use_id as string) ?? null, payload: b.content ?? b.output ?? null });
    }
  }
  return chips;
}

/** Reassemble streamed text from the foundry's parsed SSE event list. */
export function sseText(events: Obj[]): string {
  let out = "";
  for (const e of events) {
    const delta = isObject(e.delta) ? e.delta : {};
    if (typeof delta.text === "string") out += delta.text;
    for (const choice of Array.isArray(e.choices) ? e.choices : []) {
      const c = isObject(choice) && isObject(choice.delta) ? choice.delta : {};
      if (typeof c.content === "string") out += c.content;
    }
  }
  return out;
}

/**
 * Normalize ONE capture body (understudy normalized capture: request.messages
 * + response) into conversation turns. The response's assistant output —
 * SSE-reassembled when streamed — becomes the final assistant turn; response
 * tool_calls become chips on it.
 */
export function conversationFromCapture(body: Obj): Conversation {
  const request = isObject(body.request) ? body.request : {};
  const response = isObject(body.response) ? body.response : {};
  const system = typeof request.system === "string" && request.system.trim() ? request.system : Array.isArray(request.system) ? contentText(request.system) || null : null;

  const turns: Turn[] = [];
  for (const m of Array.isArray(request.messages) ? request.messages : []) {
    if (!isObject(m)) continue;
    const role = String(m.role ?? "message");
    const text = contentText(m.content);
    const chips = chipsFromBlocks(m.content);
    if (role === "system") continue; // demoted; covered by the system block
    turns.push({ role, text, chips });
  }

  // Assistant turn from the response.
  let responseText = "";
  if (response.encoding === "sse") {
    responseText = sseText(Array.isArray(response.events) ? (response.events as Obj[]) : []);
  } else if (isObject(response.body)) {
    responseText = contentText(response.body.content);
  }
  const responseChips: ToolChip[] = [];
  if (isObject(response.body)) responseChips.push(...chipsFromBlocks(response.body.content));
  for (const c of Array.isArray(response.tool_calls) ? response.tool_calls : []) {
    if (!isObject(c)) continue;
    const fn = isObject(c.function) ? c.function : {};
    let args: unknown = c.arguments ?? fn.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the raw string */
      }
    }
    responseChips.push({ kind: "call", name: String(c.name ?? fn.name ?? "tool"), id: (c.id as string) ?? null, payload: args });
  }
  // Dedup: block-derived call chips can repeat response.tool_calls.
  const seen = new Set<string>();
  const chips = responseChips.filter((c) => {
    const key = c.kind + "|" + c.name + "|" + JSON.stringify(c.payload);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (responseText || chips.length > 0) turns.push({ role: "assistant", text: responseText, chips });

  const toolNames = (Array.isArray(request.tools) ? request.tools : [])
    .map((t) => (isObject(t) ? String(t.name ?? (isObject(t.function) ? t.function.name : "") ?? "") : ""))
    .filter(Boolean);

  return { system, turns, toolNames };
}

/**
 * System-prompt dedup across a task's rounds (Moraine-style): the rounds of
 * one task share a system prompt; surface the FIRST non-empty one once and
 * report whether any round diverged.
 */
export function dedupSystem(systems: (string | null)[]): { system: string | null; diverged: boolean } {
  const nonEmpty = systems.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (nonEmpty.length === 0) return { system: null, diverged: false };
  const first = nonEmpty[0];
  return { system: first, diverged: nonEmpty.some((s) => s !== first) };
}

/* ---------------- flattened trajectory (one conversation, not rounds) ---------------- */

export type DivergenceMarker = { turnIndex: number; label: string; fromRound: string; toRound: string };

/** Edge shape the captures meta API forwards from the task's source DAG. */
export type SpineEdge = { from: string; to: string; type: string; common_prefix_messages?: number | null };

/**
 * Capture rounds are prefix-growing snapshots of ONE conversation, so the
 * LAST round carries the fullest history and becomes the spine. Rounds whose
 * bodies are missing on disk cannot be a spine.
 */
export function spineRoundIndex(rounds: { body_missing?: boolean }[]): number {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    if (!rounds[i].body_missing) return i;
  }
  return rounds.length - 1;
}

const MARKER_LABELS: Record<string, string> = {
  retry: "retried from here",
  branch: "branch",
  destructive_mutation: "destructive mutation",
  same_depth_mutation: "edited in place",
};

/**
 * Where later rounds diverge from strict prefix-append (retries, branches,
 * mutations), a small inline marker in the flattened stream is enough — no
 * separate rounds UI. The marker lands at the divergence point: the edge's
 * common-prefix message count, clamped to the spine's turn range. Multiple
 * edges at one point dedupe to one marker per label.
 */
export function divergenceMarkers(edges: SpineEdge[], turnCount: number): DivergenceMarker[] {
  const markers: DivergenceMarker[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!e || e.type === "prefix_append") continue;
    const label = MARKER_LABELS[e.type] ?? e.type.replaceAll("_", " ");
    const raw = typeof e.common_prefix_messages === "number" ? e.common_prefix_messages : turnCount;
    const turnIndex = Math.max(0, Math.min(turnCount, raw));
    const key = `${turnIndex}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ turnIndex, label, fromRound: e.from, toRound: e.to });
  }
  return markers.sort((a, b) => a.turnIndex - b.turnIndex);
}

/* ---------------- rollout summaries ---------------- */

export type RolloutMeta = {
  /** capture_id (proposed) or row index key (promoted). */
  id: string;
  label: string;
  score: number | null;
  status: string | null;
  snippet: string;
  model?: string | null;
  subscores?: Record<string, number | null> | null;
  traceId?: string | null;
};

/** Turn count + one-line snippet metadata for a capture round (LEFT pane row). */
export function captureRolloutMeta(captureId: string, body: Obj): { snippet: string; messageCount: number; toolCallCount: number; workload: string | null; traceId: string | null; capturedAt: string | null } {
  const conv = conversationFromCapture(body);
  const firstUser = conv.turns.find((t) => t.role === "user");
  const scope = isObject(body.scope) ? body.scope : {};
  const traceId = typeof body.trace_id === "string" ? body.trace_id : typeof (body as Obj).traceId === "string" ? String((body as Obj).traceId) : null;
  return {
    snippet: firstLine(firstUser?.text ?? conv.turns[0]?.text ?? "", 120),
    messageCount: conv.turns.length,
    toolCallCount: conv.turns.reduce((n, t) => n + t.chips.filter((c) => c.kind === "call").length, 0),
    workload: typeof scope.workload_name === "string" ? scope.workload_name : null,
    traceId,
    capturedAt: typeof body.captured_at === "string" ? body.captured_at : null,
  };
}

/* ---------------- taskset aggregation ---------------- */

export type TaskAggregate = {
  taskId: string;
  /** authored intent_summary wins as display name everywhere; falls back to title/task_id. */
  displayName: string;
  rollouts: number;
  avgScore: number | null;
  scores: number[];
  /** Proxy for prompt length: title/statement length in chars. */
  promptLength: number;
};

export function aggregatePromotedTasks(
  tasks: { task_id: string }[],
  rows: { task_id: string; score?: number | null; status: string }[],
  displayNames: Record<string, string> = {},
  promptLengths: Record<string, number> = {},
): TaskAggregate[] {
  const byTask = new Map<string, { scores: number[]; n: number }>();
  for (const r of rows) {
    const agg = byTask.get(r.task_id) ?? { scores: [], n: 0 };
    agg.n += 1;
    if (r.status === "ok" && typeof r.score === "number") agg.scores.push(r.score);
    byTask.set(r.task_id, agg);
  }
  return tasks.map((t) => {
    const agg = byTask.get(t.task_id) ?? { scores: [], n: 0 };
    const avg = agg.scores.length > 0 ? agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length : null;
    return {
      taskId: t.task_id,
      displayName: displayNames[t.task_id] ?? t.task_id,
      rollouts: agg.n,
      avgScore: avg,
      scores: agg.scores,
      promptLength: promptLengths[t.task_id] ?? 0,
    };
  });
}

/**
 * "9 turns · 55 tool calls · ~40k ctx" — the frontier upper-bound label.
 * Mirrors dist/trace-author complexityLabel (presentation only).
 */
export function complexityLabel(m: {
  turn_count: number;
  tool_call_count: number;
  approx_context_tokens: number;
}): string {
  const ctx =
    m.approx_context_tokens >= 1000 ? `~${Math.round(m.approx_context_tokens / 1000)}k ctx` : `~${m.approx_context_tokens} ctx`;
  return `${m.turn_count} turns · ${m.tool_call_count} tool calls · ${ctx}`;
}

/** Score → viz series color class index: high=3 (green slot), mid=2, low=destructive handled by caller. */
export function scoreColor(score: number | null | undefined): string {
  if (score == null) return "var(--muted-foreground)";
  if (score >= 0.8) return "var(--viz-series-3)";
  if (score >= 0.5) return "var(--viz-series-2)";
  return "var(--destructive)";
}
