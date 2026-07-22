/**
 * rejection-guidance — the world model's rejection messages as an OPTIMIZABLE
 * surface (understudy.rejection_guidance.v1).
 *
 * Motivation (live pilot data): the strict validators reject malformed calls
 * with terse messages ("missing field 'metadata'"); incumbent recovery is
 * partial — targeted SOP prompting zeroed some classes, but load-skill enum
 * rejections barely moved because the message names the rule without pointing
 * the model at a compliant retry. The rejection message is a prompt WE
 * control, and recovery rate (does the model's NEXT call comply?) is a
 * measurable objective — so guidance is generated as DATA
 * (servers/guidance.json), loaded by the generated world.py, editable and
 * regenerable without code changes, and replaceable per-variant for GEPA-style
 * optimization (see docs/rejection-guidance.md).
 *
 * Gold-leakage guard: synthesized examples use observed INPUT values only
 * (the incumbent's call arguments), never contract/gold outputs, and the
 * build-time leakage audit scans guidance.json as a candidate-readable
 * surface like schemas.json.
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REJECTION_GUIDANCE_SCHEMA } from "./benchmark-artifacts.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/** Hard bound on any single guidance message (rejection replies are model input; keep them prompt-sized). */
export const GUIDANCE_MESSAGE_MAX_CHARS = 500;
/** Recovery window: a rejection counts as recovered if a compliant call to the same tool lands within this many subsequent calls to that tool. */
export const RECOVERY_WINDOW_CALLS = 3;

const EXAMPLE_STRING_MAX = 60;
const EXAMPLE_JSON_MAX = 220;

export type RejectionClass =
  | "unknown_tool"
  | "missing_required"
  | "missing_by_observation"
  | "type_mismatch"
  | "enum_violation"
  | "other";

/** Classify a validator rejection message into its rule class (mirrors the message shapes _validate / validateCallAgainstSchema emit). */
export function classifyRejection(error: string): RejectionClass {
  const text = String(error ?? "");
  if (/^unknown tool /.test(text)) return "unknown_tool";
  if (/^missing required field /.test(text)) return "missing_required";
  if (/must be one of|accepts exactly one of/.test(text)) return "enum_violation";
  if (/^missing field .* required by observed usage/s.test(text) || /^missing field '/.test(text)) return "missing_by_observation";
  if (/^(field|invalid value)[^]*must be (string|number|integer|boolean|object|array)/.test(text)) return "type_mismatch";
  return "other";
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const boundValue = (value: unknown): unknown => {
  if (typeof value === "string") return truncate(value, EXAMPLE_STRING_MAX);
  if (Array.isArray(value)) return value.slice(0, 3).map(boundValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Obj).slice(0, 4).map(([k, v]) => [k, boundValue(v)]));
  return value;
};

/**
 * Minimal valid example for one tool, synthesized from OBSERVED INPUT calls
 * only: project the first observed call onto the schema's required keys
 * (declared required + heads of required_by_observation); enum'd paths use an
 * allowed value; strings/values are size-bounded. Returns null when no
 * observed call covers the required keys.
 */
export function synthesizeMinimalExample(schema: Obj, observedCalls: Obj[]): Obj | null {
  const required = (Array.isArray(schema.required) ? schema.required : []).map(String);
  const observedRequired = (Array.isArray(schema.required_by_observation) ? schema.required_by_observation : []).map(String);
  const keys = [...new Set([...required, ...observedRequired.map((path) => path.split(".")[0])])];
  if (keys.length === 0) return null;
  const enums = asObject(schema.enums_by_observation);
  const source = observedCalls.map(asObject).find((call) => keys.every((key) => call[key] !== undefined && call[key] !== null));
  const example: Obj = {};
  for (const key of keys) {
    const allowed = Array.isArray(enums[key]) ? enums[key] : undefined;
    const value = allowed && allowed.length > 0 ? allowed[0] : source?.[key];
    if (value === undefined || value === null) return null;
    example[key] = boundValue(value);
  }
  const rendered = JSON.stringify(example);
  return rendered.length <= EXAMPLE_JSON_MAX ? example : null;
}

const bounded = (message: string): string => truncate(message, GUIDANCE_MESSAGE_MAX_CHARS);

export type RejectionGuidance = {
  schema_version: typeof REJECTION_GUIDANCE_SCHEMA;
  note: string;
  /** tool -> "<class>:<path>" -> full replacement message the world serves for that rejection. */
  tools: Record<string, Record<string, string>>;
};

/**
 * Default guidance: structured, informative rejections that state what was
 * wrong AND what valid looks like. Enum violations list the allowed values
 * (already in schemas.json — observed input values); missing required fields
 * carry a minimal valid example synthesized from observed calls when
 * `synthesizeExamples` is true (only set when real normalized captures back
 * the observations — the capture-less fallback derives observations from
 * contract gold, which must never leak into a candidate-readable message).
 */
export function buildRejectionGuidance(schemas: Obj, observedCallsByTool: Map<string, Obj[]>, options: { synthesizeExamples: boolean; exampleTools?: (tool: string) => boolean }): RejectionGuidance {
  const tools: Record<string, Record<string, string>> = {};
  for (const [tool, schemaValue] of Object.entries(schemas)) {
    const schema = asObject(schemaValue);
    const messages: Record<string, string> = {};
    const exampleAllowed = options.synthesizeExamples && (options.exampleTools === undefined || options.exampleTools(tool));
    const example = exampleAllowed ? synthesizeMinimalExample(schema, observedCallsByTool.get(tool) ?? []) : null;
    const exampleSuffix = example === null ? "" : ` A minimal valid call: ${JSON.stringify(example)}.`;
    for (const key of (Array.isArray(schema.required) ? schema.required : []).map(String)) {
      messages[`missing_required:${key}`] = bounded(`missing required field '${key}'. Retry ${tool} with '${key}' included in the arguments.${exampleSuffix}`);
    }
    for (const path of (Array.isArray(schema.required_by_observation) ? schema.required_by_observation : []).map(String)) {
      const [present, of] = (asObject(schema.observation_counts)[path] as [number, number] | undefined) ?? [0, 0];
      messages[`missing_by_observation:${path}`] = bounded(`missing field '${path}' — this API requires it (present in ${present}/${of} observed calls). Retry ${tool} with '${path}' set, keeping your other arguments the same.${exampleSuffix}`);
    }
    for (const [key, declared] of Object.entries(asObject(schema.properties))) {
      messages[`type:${key}`] = bounded(`field '${key}' must be ${String(declared)}. Retry ${tool} with '${key}' as a ${String(declared)} value, keeping your other arguments the same.`);
    }
    for (const [path, allowedValue] of Object.entries(asObject(schema.enums_by_observation))) {
      const allowed = (Array.isArray(allowedValue) ? allowedValue : []).map(String);
      messages[`enum:${path}`] = bounded(`invalid value for '${path}': this API accepts exactly one of ${JSON.stringify(allowed)}. Retry ${tool} with '${path}' set to one of those exact values (no other value will be accepted), keeping your other arguments the same.`);
    }
    if (Object.keys(messages).length > 0) tools[tool] = messages;
  }
  return {
    schema_version: REJECTION_GUIDANCE_SCHEMA,
    note: "Rejection-guidance templates the generated world.py serves on validation rejections. DATA, not code: edit or regenerate freely; test variants via `understudy traces regenerate-env --guidance <file>`. Examples use observed INPUT values only (never contract gold); the build-time leakage audit scans this file.",
    tools,
  };
}

/** Load and validate a guidance file (the --guidance override path). Throws on a wrong/missing schema_version. */
export function loadGuidanceFile(path: string): RejectionGuidance {
  const parsed = asObject(JSON.parse(readFileSync(resolve(path), "utf8")));
  if (parsed.schema_version !== REJECTION_GUIDANCE_SCHEMA) {
    throw new Error(`${path} is not a ${REJECTION_GUIDANCE_SCHEMA} file (schema_version: ${JSON.stringify(parsed.schema_version ?? null)})`);
  }
  return { schema_version: REJECTION_GUIDANCE_SCHEMA, note: String(parsed.note ?? ""), tools: asObject(parsed.tools) as Record<string, Record<string, string>> };
}

// ---------------------------------------------------------------------------
// Recovery metric — the guidance objective.
// ---------------------------------------------------------------------------

export type RecoveryClassStats = { rejections: number; recovered: number; rate: number };

export type RecoveryStats = {
  /** Lookahead window in subsequent calls to the same tool. */
  window: number;
  total_rejections: number;
  total_recovered: number;
  /** Overall recovery rate; 0 when there were no rejections. */
  rate: number;
  by_class: Record<string, RecoveryClassStats>;
  by_tool: Record<string, RecoveryClassStats>;
};

const errorTextFromResult = (content: unknown): string => {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (text.startsWith("ERROR: ")) return text.slice("ERROR: ".length);
  try {
    const parsed = JSON.parse(text);
    const error = asObject(parsed).error;
    if (typeof error === "string") return error;
  } catch { /* not JSON — fall through */ }
  return text;
};

/**
 * Per-rejection-class recovery rate over ONE rollout journal (a runs/live
 * JSONL: alternating {kind:"call"|"result", tool, status, ...} entries).
 * A rejection (call with status "error") is RECOVERED when a compliant
 * (status "ok") call to the SAME tool lands within `window` subsequent calls
 * to that tool. Pure function; classification reads the paired result's
 * error text.
 */
export function computeRecoveryRates(entries: Obj[], window: number = RECOVERY_WINDOW_CALLS): RecoveryStats {
  const rows = entries.map(asObject);
  // Pair each call with the next result entry for the same tool (the world journals result immediately after call).
  const calls: Array<{ tool: string; status: string; error: string }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind !== "call") continue;
    const tool = String(rows[i].tool ?? "");
    let error = "";
    if (rows[i].status === "error") {
      const result = rows.slice(i + 1).find((row) => row.kind === "result" && String(row.tool ?? "") === tool);
      error = result ? errorTextFromResult(result.content) : "";
    }
    calls.push({ tool, status: String(rows[i].status ?? "ok"), error });
  }
  const byClass: Record<string, RecoveryClassStats> = {};
  const byTool: Record<string, RecoveryClassStats> = {};
  const bump = (bucket: Record<string, RecoveryClassStats>, key: string, recovered: boolean): void => {
    const stats = (bucket[key] ??= { rejections: 0, recovered: 0, rate: 0 });
    stats.rejections += 1;
    if (recovered) stats.recovered += 1;
  };
  let total = 0;
  let totalRecovered = 0;
  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i].status !== "error") continue;
    const sameTool = calls.slice(i + 1).filter((call) => call.tool === calls[i].tool).slice(0, window);
    const recovered = sameTool.some((call) => call.status !== "error");
    total += 1;
    if (recovered) totalRecovered += 1;
    bump(byClass, classifyRejection(calls[i].error), recovered);
    bump(byTool, calls[i].tool, recovered);
  }
  for (const bucket of [byClass, byTool]) for (const stats of Object.values(bucket)) stats.rate = stats.rejections === 0 ? 0 : stats.recovered / stats.rejections;
  return { window, total_rejections: total, total_recovered: totalRecovered, rate: total === 0 ? 0 : totalRecovered / total, by_class: byClass, by_tool: byTool };
}

/** Merge recovery over many journals (lookahead never crosses a journal boundary). */
export function computeRecoveryOverJournals(journals: Obj[][], window: number = RECOVERY_WINDOW_CALLS): RecoveryStats {
  const merged: RecoveryStats = { window, total_rejections: 0, total_recovered: 0, rate: 0, by_class: {}, by_tool: {} };
  for (const entries of journals) {
    const stats = computeRecoveryRates(entries, window);
    merged.total_rejections += stats.total_rejections;
    merged.total_recovered += stats.total_recovered;
    for (const [bucketKey, bucket] of [["by_class", stats.by_class], ["by_tool", stats.by_tool]] as const) {
      for (const [key, value] of Object.entries(bucket)) {
        const target = (merged[bucketKey][key] ??= { rejections: 0, recovered: 0, rate: 0 });
        target.rejections += value.rejections;
        target.recovered += value.recovered;
      }
    }
  }
  for (const bucket of [merged.by_class, merged.by_tool]) for (const stats of Object.values(bucket)) stats.rate = stats.rejections === 0 ? 0 : stats.recovered / stats.rejections;
  merged.rate = merged.total_rejections === 0 ? 0 : merged.total_recovered / merged.total_rejections;
  return merged;
}

/** Read every rollout journal under <benchmark>/runs/live/*.jsonl (read-only; missing dir → []). */
export function readRolloutJournals(benchmarkDir: string): Obj[][] {
  const dir = join(resolve(benchmarkDir), "runs", "live");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names.sort().map((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try { return [asObject(JSON.parse(line))]; } catch { return []; }
      }),
  );
}
