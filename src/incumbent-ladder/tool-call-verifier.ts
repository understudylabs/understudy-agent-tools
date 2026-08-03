import { createHash } from "node:crypto";

export const PARSER_REVISION =
  "ladder-local-parser-v2-reasoning-tolerant-raw-rendered-response";
export const PARSER_REVISION_SHA256 =
  "1100c3549286249832c916f711390b02bce1357b053e82028b19432637e31f0f";

const OUTCOME_ARGS: Record<string, string[]> = {
  "run-subagent": ["subagentPath", "documentId"],
  "run-automation-agent": ["agentId"],
  "assign-ai-inbox": ["inboxId"],
  "update-conversation-fields": ["fields", "propose", "targetDealId"],
  "update-next-steps-and-tasks": ["triggerSource"],
};

export type ToolCall = { tool: string; arguments: Record<string, unknown> };
export type Prediction = {
  response?: unknown;
  output?: unknown;
  summary?: unknown;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number | null;
  [key: string]: unknown;
};
export type VerifierTask = {
  task_id?: string;
  band?: string;
  label?: { calls?: ToolCall[]; rationale?: string };
  [key: string]: unknown;
};
export type ScoreRow = {
  task_id: string | null;
  band: string;
  score: number;
  tool_set: number;
  ordered_tool_set_agreement: number;
  tool_set_f1: number;
  arg_score: number;
  no_action_agreement: number | null;
  malformed: number;
  calls_emitted: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
};

export type Aggregate = {
  count: number;
  mean_score: number;
  exact_match_rate: number;
  tool_set_f1: number;
  ordered_tool_set_agreement: number;
  arg_score: number;
  no_action_agreement: number | null;
  malformed_rate: number;
  calls_emitted: number;
  calls_emitted_distribution: Record<string, number>;
  mean_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost: { status: "priced" | "unpriced"; total_usd: number | null; per_1k_calls_usd: number | null };
};

export type VerificationReport = {
  schema_version: "understudy.ladder_verification.v1";
  parser_revision: string;
  parser_revision_sha256: string;
  rows: ScoreRow[];
  aggregate: Aggregate;
  by_band: Record<string, Aggregate>;
};

function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeSubagent(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^org\/subagents\//, "")
    .replace(/^subagents\//, "");
}

function normalizeCall(call: any): ToolCall {
  const fn = call?.function ?? call;
  const tool = fn?.name ?? call?.tool ?? call?.name;
  let args = parseMaybe(fn?.arguments ?? call?.arguments ?? call?.args ?? {});
  if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
  const argumentsValue = { ...(args as Record<string, unknown>) };
  if (tool === "run-subagent" && argumentsValue.subagentPath !== undefined) {
    argumentsValue.subagentPath = normalizeSubagent(argumentsValue.subagentPath);
  }
  return { tool: String(tool ?? ""), arguments: argumentsValue };
}

function extractJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(start, end + 1)));
        } catch {
          // Ignore incomplete objects and continue scanning.
        }
        break;
      }
    }
  }
  return objects;
}

export function normalizePrediction(prediction: unknown): ToolCall[] {
  const response: any = parseMaybe((prediction as any)?.response ?? (prediction as any)?.output ?? prediction);
  const native =
    response?.choices?.[0]?.message?.tool_calls ??
    response?.tool_calls ??
    response?.message?.tool_calls;
  if (Array.isArray(native)) return native.map(normalizeCall).filter((call) => call.tool);
  const text =
    typeof response === "string"
      ? response
      : String(response?.choices?.[0]?.message?.content ?? response?.content ?? "");
  const tagged = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)].flatMap((match) =>
    extractJsonObjects(match[1]),
  );
  const candidates = tagged.length ? tagged : extractJsonObjects(text);
  return candidates
    .flatMap((candidate: any) =>
      Array.isArray(candidate)
        ? candidate
        : candidate?.tool_calls
          ? candidate.tool_calls
          : candidate?.tool || candidate?.name || candidate?.function
            ? [candidate]
            : [],
    )
    .map(normalizeCall)
    .filter((call) => call.tool);
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedArgs(call: ToolCall): string[] {
  return (OUTCOME_ARGS[call.tool] ?? []).filter((key) =>
    Object.prototype.hasOwnProperty.call(call.arguments ?? {}, key),
  );
}

function argumentScore(expected: ToolCall, actual: ToolCall | undefined): number {
  const keys = expectedArgs(expected);
  if (!keys.length || !actual) return keys.length ? 0 : 1;
  return (
    keys.reduce((sum, key) => {
      const expectedValue =
        key === "subagentPath" ? normalizeSubagent(expected.arguments[key]) : expected.arguments[key];
      return sum + (key in actual.arguments && equalValue(actual.arguments[key], expectedValue) ? 1 : 0);
    }, 0) / keys.length
  );
}

function multisetEqual(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  const counts = new Map<string, number>();
  for (const value of expected) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of actual) {
    const count = counts.get(value) ?? 0;
    if (count === 0) return false;
    counts.set(value, count - 1);
  }
  return true;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const NO_ACTION_PATTERN =
  /\bno[\s-]?action\b|\bno(?:\s+\w+){1,2}\s+action\b|\bno-op\b|\bnothing to do\b|\bnot significant\b/i;

function declaresNoAction(value: unknown): boolean {
  return NO_ACTION_PATTERN.test(typeof value === "string" ? value : JSON.stringify(value ?? ""));
}

function noActionAgreement(task: VerifierTask, actual: ToolCall[], prediction: Prediction): number | null {
  const rationale = task.label?.rationale;
  const expectedSummary = (task.label?.calls ?? []).find((call) => call.tool === "save-execution-summary");
  if (!expectedSummary || !declaresNoAction(rationale)) return null;

  const emittedSummary =
    prediction.summary ??
    actual.find((call) => call.tool === "save-execution-summary")?.arguments.summary ??
    prediction.response;
  return Number(declaresNoAction(emittedSummary));
}

export function scoreTask(task: VerifierTask, prediction: Prediction = {}): ScoreRow {
  const expected = task.label?.calls ?? [];
  const actual = normalizePrediction(prediction);
  const expectedTools = expected.map((call) => call.tool);
  const actualTools = actual.map((call) => call.tool);
  const toolSet = multisetEqual(expectedTools, actualTools);
  const ordered = expectedTools.length === actualTools.length && expectedTools.every((tool, index) => tool === actualTools[index]);
  const actualCounts = new Map<string, number>();
  const expectedCounts = new Map<string, number>();
  for (const tool of actualTools) actualCounts.set(tool, (actualCounts.get(tool) ?? 0) + 1);
  for (const tool of expectedTools) expectedCounts.set(tool, (expectedCounts.get(tool) ?? 0) + 1);
  const names = new Set([...actualCounts.keys(), ...expectedCounts.keys()]);
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const name of names) {
    const overlap = Math.min(actualCounts.get(name) ?? 0, expectedCounts.get(name) ?? 0);
    truePositive += overlap;
    falsePositive += (actualCounts.get(name) ?? 0) - overlap;
    falseNegative += (expectedCounts.get(name) ?? 0) - overlap;
  }
  const toolSetF1 = truePositive
    ? (2 * truePositive) / (2 * truePositive + falsePositive + falseNegative)
    : 0;
  const actualByTool = new Map<string, ToolCall[]>();
  for (const call of actual) actualByTool.set(call.tool, [...(actualByTool.get(call.tool) ?? []), call]);
  const seen = new Map<string, number>();
  const args = toolSet
    ? expected.reduce((sum, call) => {
        const occurrence = seen.get(call.tool) ?? 0;
        seen.set(call.tool, occurrence + 1);
        return sum + argumentScore(call, actualByTool.get(call.tool)?.[occurrence]);
      }, 0) / Math.max(1, expected.length)
    : 0;
  const score = !actual.length && expected.length ? 0 : 0.6 * Number(toolSet) + 0.4 * args;
  const cost = prediction.cost_usd;
  return {
    task_id: typeof task.task_id === "string" ? task.task_id : null,
    band: typeof task.band === "string" ? task.band : "all",
    score,
    tool_set: Number(toolSet),
    ordered_tool_set_agreement: Number(ordered),
    tool_set_f1: toolSetF1,
    arg_score: args,
    no_action_agreement: noActionAgreement(task, actual, prediction),
    malformed: Number(actual.length === 0),
    calls_emitted: actual.length,
    latency_ms: numberOr(prediction.latency_ms, 0),
    input_tokens: numberOr(prediction.input_tokens, 0),
    output_tokens: numberOr(prediction.output_tokens, 0),
    cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}

function aggregateRows(rows: ScoreRow[]): Aggregate {
  const mean = (key: keyof ScoreRow): number =>
    rows.length ? rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / rows.length : 0;
  const noActionRows = rows.filter((row) => row.no_action_agreement !== null);
  const priced = rows.filter((row) => row.cost_usd !== null);
  const total = priced.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
  const distribution: Record<string, number> = {};
  for (const row of rows) distribution[String(row.calls_emitted)] = (distribution[String(row.calls_emitted)] ?? 0) + 1;
  return {
    count: rows.length,
    mean_score: mean("score"),
    exact_match_rate: rows.length
      ? rows.filter((row) => row.tool_set === 1 && row.arg_score === 1).length / rows.length
      : 0,
    tool_set_f1: mean("tool_set_f1"),
    ordered_tool_set_agreement: mean("ordered_tool_set_agreement"),
    arg_score: mean("arg_score"),
    no_action_agreement: noActionRows.length
      ? noActionRows.reduce((sum, row) => sum + (row.no_action_agreement ?? 0), 0) / noActionRows.length
      : null,
    malformed_rate: mean("malformed"),
    calls_emitted: rows.reduce((sum, row) => sum + row.calls_emitted, 0),
    calls_emitted_distribution: distribution,
    mean_latency_ms: mean("latency_ms"),
    input_tokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
    output_tokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    cost: {
      status: priced.length === rows.length ? "priced" : "unpriced",
      total_usd: priced.length === rows.length ? total : null,
      per_1k_calls_usd: priced.length === rows.length && rows.length ? (total * 1000) / rows.length : null,
    },
  };
}

export function aggregateScores(rows: ScoreRow[]): Aggregate {
  return aggregateRows(rows);
}

export function verifyTasks(tasks: VerifierTask[], predictions: Map<string, Prediction> | Record<string, Prediction>): VerificationReport {
  const lookup = predictions instanceof Map ? (id: string) => predictions.get(id) : (id: string) => predictions[id];
  const rows = tasks.map((task) => scoreTask(task, lookup(String(task.task_id ?? "")) ?? {}));
  const bands = [...new Set(rows.map((row) => row.band))].sort();
  return {
    schema_version: "understudy.ladder_verification.v1",
    parser_revision: PARSER_REVISION,
    parser_revision_sha256: PARSER_REVISION_SHA256,
    rows,
    aggregate: aggregateRows(rows),
    by_band: Object.fromEntries(bands.map((band) => [band, aggregateRows(rows.filter((row) => row.band === band))])),
  };
}

export function parserRevisionHash(): string {
  return createHash("sha256").update(PARSER_REVISION).digest("hex");
}
