/**
 * Deterministic score-accumulation replay (AutomationBench-style): walk the
 * oracle trajectory's tool events in order — plus the final assistant
 * response — and show the outcome contract scoring ACCUMULATE: each required
 * entry (state effect, read obligation, value propagation, response
 * obligation) flips unmet→met at the event that satisfies it, a running
 * partial-credit meter, and the final task_completed_correctly verdict. No
 * LLM judging anywhere.
 *
 * LIFTED from apps/benchmark-hub/lib/replay-core.ts into the CLI package so
 * the compiled dist is the single source of truth: the hub app re-imports it
 * from dist/ (anti-drift pattern) and `understudy benchmarks mcp` scores
 * rollouts through the exact same accumulation. The matching and
 * write-classification logic comes from the foundry — the same
 * contractEntryMet/scoreContract/isMutatingTool the generated environment's
 * scorer uses — never forked.
 */
import { anchorArguments, contractEntryMet, forbiddenEntryViolated, isMutatingTool, scoreContract, stateEffectMet } from "./trace-foundry.js";
// Re-exported so hub route handlers import every scorer symbol through this
// one module.
export { observedCalls } from "./trace-author.js";
export { finalResponseText } from "./trace-foundry.js";

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export type ReplayCall = { id?: string | null; name: string; arguments: unknown; status?: string };

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
  /** False when the contract has no required entries — nothing to judge; no vacuous 100%s. */
  judgeable: boolean;
  recall: number | null;
  precision: number | null;
  policy: number | null;
  strict: number;
  score: number | null;
  task_completed_correctly: boolean;
};

/** One row of the "rules evaluated" disclosure: exactly what each number is made of. */
export type RuleEvaluation = {
  kind: string;
  label: string;
  /** The matching criterion actually used for this entry. */
  criterion: string;
  met: boolean;
  met_at: number | null;
  provenance: string | null;
};

export type OracleReplay = {
  required: ReplayRequired[];
  forbidden_tools: string[];
  forbidden_values: number;
  steps: ReplayStep[];
  verdict: ReplayVerdict;
  /** Deterministic transparency: every rule with its criterion + result. */
  rules_evaluated: RuleEvaluation[];
  /** precision inputs: each candidate write mapped to the rule it satisfies (or unmapped). */
  writes_mapped: { step: number; tool: string; mapped_to: number | null }[];
  /** policy inputs: each forbidden rule and whether it was violated. */
  forbidden_evaluated: { label: string; violated: boolean }[];
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
  const events: { name: string; arguments: unknown; status?: string }[] = [];
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
      // Forbidden violations zero the running credit; zero rules = zero
      // credit (an empty contract is not judgeable, never a vacuous 1.0).
      partial_credit: violated || requiredRules.length === 0 ? 0 : metCount / requiredRules.length,
    });
  };
  calls.forEach((call, index) => {
    // A validation-rejected call (status=error) rides along so the shared
    // scorer can refuse it — rejects stay VISIBLE in the step walk.
    events.push({ name: call.name, arguments: call.arguments ?? {}, ...(call.status === "error" ? { status: "error" } : {}) });
    record(index, call.name, "call", call.arguments ?? {}, { calls: events });
  });
  if (typeof finalResponse === "string" && finalResponse.length > 0) {
    record(calls.length, "final response", "final_response", finalResponse, { calls: events, finalResponse });
  }

  const scored = scoreContract(task, { calls: events, finalResponse: finalResponse ?? "" }) as {
    judgeable?: boolean; recall: number | null; precision: number | null; policy: number | null; strict: number; score: number | null;
  };
  const judgeable = scored.judgeable !== false && requiredRules.length > 0;

  // "Show me the rule being evaluated": name the criterion each entry was
  // matched with, so recall/precision/policy are inspectable, never opaque.
  const criterionOf = (rule: Obj): string => {
    const type = String(rule.type ?? "state_effect");
    if (type === "state_effect") {
      const semantic = asObject(rule.arguments_semantic);
      if (Object.keys(anchorArguments(semantic)).length > 0) return "authored arguments_semantic (anchored)";
      const anchors = anchorArguments(asObject(rule.observed_arguments));
      return Object.keys(anchors).length > 0
        ? `anchors of observed arguments (${Object.keys(anchors).join(", ")})`
        : "tool call with any arguments (no discrete anchors in observed args)";
    }
    if (type === "read_obligation") return "authored arguments_semantic (anchored, read)";
    if (type === "value_propagation") return "value tokens present at destination";
    if (type === "response_obligation") return `final response: ${String(rule.kind ?? "")}`;
    return type;
  };
  const rulesEvaluated = requiredRules.map((rule, i) => ({
    kind: String(rule.type ?? "state_effect"),
    label: entryLabel(rule),
    criterion: criterionOf(rule),
    met: required[i].met_at !== null,
    met_at: required[i].met_at,
    provenance: typeof rule.provenance === "string" ? rule.provenance : null,
  }));
  const stateRules = requiredRules.filter((rule) => String(rule.type ?? "state_effect") === "state_effect");
  const writesMapped = steps
    .filter((step) => step.mutating)
    .map((step) => {
      const call = { tool: step.tool, arguments: step.arguments };
      const ruleIndex = requiredRules.findIndex((rule, i) => stateRules.includes(rule) && stateEffectMet(rule, call));
      return { step: step.index, tool: step.tool, mapped_to: ruleIndex >= 0 ? ruleIndex : null };
    });
  const forbiddenEvaluated = forbiddenRules.map((rule) => ({
    label: String(rule.type ?? "") === "forbidden_value" ? `value "${String(rule.value ?? "")}"` : `tool ${String(rule.tool ?? "")}`,
    violated: forbiddenEntryViolated(rule, { calls: events, finalResponse: finalResponse ?? "" }) as boolean,
  }));

  return {
    required,
    forbidden_tools: forbiddenTools,
    forbidden_values: forbiddenValues.length,
    steps,
    rules_evaluated: rulesEvaluated,
    writes_mapped: writesMapped,
    forbidden_evaluated: forbiddenEvaluated,
    verdict: {
      judgeable,
      recall: judgeable ? scored.recall : null,
      precision: judgeable ? scored.precision : null,
      policy: judgeable ? scored.policy : null,
      strict: scored.strict,
      score: judgeable ? scored.score : null,
      task_completed_correctly: judgeable && scored.strict === 1,
    },
  };
}
