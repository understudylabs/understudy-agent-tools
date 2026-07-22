/**
 * Deterministic score-accumulation replay (AutomationBench-style): walk the
 * oracle trajectory's tool events in order — plus the final assistant
 * response — and show the outcome contract scoring ACCUMULATE: each required
 * entry (state effect, read obligation, value propagation, response
 * obligation) flips unmet→met at the event that satisfies it, a running
 * partial-credit meter, and the final task_completed_correctly verdict. No
 * LLM judging anywhere.
 *
 * The matching and write-classification logic is IMPORTED from the compiled
 * foundry (dist/) — the same contractEntryMet/scoreContract/isMutatingTool
 * the generated environment's scorer uses — never forked.
 */
import { contractEntryMet, forbiddenEntryViolated, isMutatingTool, scoreContract } from "../../../dist/trace-foundry.js";
// Re-exported so route handlers import every dist symbol through this module
// (one relative path to keep working under the tests' .build output — the
// apps/dist symlink covers the compiled depth).
export { observedCalls } from "../../../dist/trace-author.js";
export { finalResponseText } from "../../../dist/trace-foundry.js";

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export type ReplayCall = { id?: string | null; name: string; arguments: unknown };

export type ReplayRequired = {
  /** Entry kind: state_effect | read_obligation | value_propagation | response_obligation. */
  kind: string;
  /** Human-readable label the Replay tab renders (tool name for effects, obligation summary otherwise). */
  label: string;
  tool: string | null;
  observed_arguments: unknown;
  /** Event index where this entry flipped unmet→met; null = never met. */
  met_at: number | null;
};

export type ReplayStep = {
  index: number;
  tool: string;
  /** "call" for tool events; "final_response" for the closing response event. */
  event: "call" | "final_response";
  arguments: unknown;
  mutating: boolean;
  /** Required-entry indices this event flipped to met. */
  satisfies: number[];
  forbidden_violation: boolean;
  /** Entries met after this step. */
  met_count: number;
  /** Running partial credit after this step (forbidden violations zero it). */
  partial_credit: number;
};

export type ReplayVerdict = {
  recall: number;
  precision: number;
  policy: number;
  strict: number;
  score: number;
  task_completed_correctly: boolean;
};

export type OracleReplay = {
  required: ReplayRequired[];
  forbidden_tools: string[];
  forbidden_values: number;
  steps: ReplayStep[];
  verdict: ReplayVerdict;
};

const entryLabel = (rule: Obj): string => {
  const type = String(rule.type ?? "state_effect");
  if (type === "read_obligation") return `read: ${rule.tool}`;
  if (type === "value_propagation") {
    const destination = asObject(rule.must_reach);
    const target = destination.kind === "final_response" ? "final response" : `${destination.tool ?? "tool"} args`;
    return `value "${String(rule.value ?? "")}" → ${target}`;
  }
  if (type === "response_obligation") {
    if (rule.kind === "schema_valid") return `response: schema_valid [${(Array.isArray(rule.expected_keys) ? rule.expected_keys : []).join(", ")}]`;
    if (rule.kind === "contains_category") return `response contains "${String(rule.expected ?? "")}"`;
    return `response: ${String(rule.kind ?? "")}`;
  }
  return String(rule.tool ?? "");
};

/**
 * Accumulate the contract over an ordered call list plus the final response.
 * The final verdict comes from the foundry's own scoreContract over the full
 * event stream — identical to the generated environment's scorer.
 */
export function accumulateReplay(task: Obj, calls: ReplayCall[], finalResponse?: string | null): OracleReplay {
  const contract = asObject(task.outcome_contract);
  const requiredRules = (Array.isArray(contract.required) ? contract.required : []).map(asObject);
  const forbiddenRules = (Array.isArray(contract.forbidden) ? contract.forbidden : []).map(asObject);
  const forbiddenTools = forbiddenRules.filter((r) => String(r.type ?? "") !== "forbidden_value").map((r) => String(r.tool ?? "")).filter(Boolean);
  const forbiddenValues = forbiddenRules.filter((r) => String(r.type ?? "") === "forbidden_value");

  const required: ReplayRequired[] = requiredRules.map((r) => ({
    kind: String(r.type ?? "state_effect"),
    label: entryLabel(r),
    tool: typeof r.tool === "string" ? r.tool : null,
    observed_arguments: r.observed_arguments ?? r.arguments_semantic ?? r.value ?? r.expected ?? {},
    met_at: null,
  }));

  const steps: ReplayStep[] = [];
  let violated = false;
  let metCount = 0;
  const events: { name: string; arguments: unknown }[] = [];
  const record = (index: number, tool: string, event: "call" | "final_response", args: unknown, seen: { calls: typeof events; finalResponse?: string | null }): void => {
    const satisfies: number[] = [];
    requiredRules.forEach((rule, i) => {
      if (required[i].met_at !== null) return;
      if (!contractEntryMet(rule, seen)) return;
      required[i].met_at = index;
      satisfies.push(i);
    });
    metCount += satisfies.length;
    const forbidden = event === "call"
      ? forbiddenTools.includes(tool) || forbiddenValues.some((rule) => forbiddenEntryViolated(rule, { calls: [{ tool, arguments: args }] }))
      : forbiddenValues.some((rule) => forbiddenEntryViolated(rule, { calls: [], finalResponse: seen.finalResponse }));
    if (forbidden) violated = true;
    steps.push({
      index,
      tool,
      event,
      arguments: args,
      mutating: event === "call" && isMutatingTool(tool),
      satisfies,
      forbidden_violation: forbidden,
      met_count: metCount,
      // Forbidden violations zero the running credit outright.
      partial_credit: violated ? 0 : requiredRules.length === 0 ? 1 : metCount / requiredRules.length,
    });
  };
  calls.forEach((call, index) => {
    events.push({ name: call.name, arguments: call.arguments ?? {} });
    record(index, call.name, "call", call.arguments ?? {}, { calls: events });
  });
  if (typeof finalResponse === "string" && finalResponse.length > 0) {
    record(calls.length, "final response", "final_response", finalResponse, { calls: events, finalResponse });
  }

  const scored = scoreContract(task, { calls: events, finalResponse: finalResponse ?? "" }) as {
    recall: number; precision: number; policy: number; strict: number; score: number;
  };
  return {
    required,
    forbidden_tools: forbiddenTools,
    forbidden_values: forbiddenValues.length,
    steps,
    verdict: { recall: scored.recall, precision: scored.precision, policy: scored.policy, strict: scored.strict, score: scored.score, task_completed_correctly: scored.strict === 1 },
  };
}
