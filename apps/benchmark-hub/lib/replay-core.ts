/**
 * Deterministic score-accumulation replay (AutomationBench-style): walk the
 * oracle trajectory's tool events in order and show the outcome contract
 * scoring ACCUMULATE — each required effect flips unmet→met at the tool call
 * that satisfies it, a running partial-credit meter, and the final
 * task_completed_correctly verdict. No LLM judging anywhere.
 *
 * The matching and write-classification logic is IMPORTED from the compiled
 * foundry (dist/) — the same semanticArgumentsMatch/scoreState/isMutatingTool
 * the generated environment's scorer uses — never forked.
 */
import { isMutatingTool, scoreState, semanticArgumentsMatch } from "../../../dist/trace-foundry.js";
// Re-exported so route handlers import every dist symbol through this module
// (one relative path to keep working under the tests' .build output — the
// apps/dist symlink covers the compiled depth).
export { observedCalls } from "../../../dist/trace-author.js";

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export type ReplayCall = { id?: string | null; name: string; arguments: unknown };

export type ReplayRequired = {
  tool: string;
  observed_arguments: unknown;
  /** Event index where this effect flipped unmet→met; null = never met. */
  met_at: number | null;
};

export type ReplayStep = {
  index: number;
  tool: string;
  arguments: unknown;
  mutating: boolean;
  /** Required-effect indices this call flipped to met. */
  satisfies: number[];
  forbidden_violation: boolean;
  /** Effects met after this step. */
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
  steps: ReplayStep[];
  verdict: ReplayVerdict;
};

/**
 * Accumulate the contract over an ordered call list. The final verdict comes
 * from the foundry's own scoreState over the mutating calls — identical to
 * the generated environment's scorer.
 */
export function accumulateReplay(task: Obj, calls: ReplayCall[]): OracleReplay {
  const contract = asObject(task.outcome_contract);
  const requiredRules = (Array.isArray(contract.required) ? contract.required : []).map(asObject);
  const forbiddenTools = (Array.isArray(contract.forbidden) ? contract.forbidden : [])
    .map((r) => String(asObject(r).tool ?? ""))
    .filter(Boolean);

  const required: ReplayRequired[] = requiredRules.map((r) => ({
    tool: String(r.tool ?? ""),
    observed_arguments: r.observed_arguments ?? {},
    met_at: null,
  }));

  const steps: ReplayStep[] = [];
  let violated = false;
  let metCount = 0;
  calls.forEach((call, index) => {
    const satisfies: number[] = [];
    requiredRules.forEach((rule, i) => {
      if (required[i].met_at !== null) return;
      if (String(rule.tool ?? "") !== call.name) return;
      if (!semanticArgumentsMatch(asObject(rule.observed_arguments), asObject(call.arguments))) return;
      required[i].met_at = index;
      satisfies.push(i);
    });
    metCount += satisfies.length;
    const forbidden = forbiddenTools.includes(call.name);
    if (forbidden) violated = true;
    steps.push({
      index,
      tool: call.name,
      arguments: call.arguments ?? {},
      mutating: isMutatingTool(call.name),
      satisfies,
      forbidden_violation: forbidden,
      met_count: metCount,
      // Forbidden-effect violations zero the running credit outright.
      partial_credit: violated ? 0 : required.length === 0 ? 1 : metCount / required.length,
    });
  });

  const writes = calls.filter((c) => isMutatingTool(c.name)).map((c) => ({ tool: c.name, arguments: c.arguments ?? {} }));
  const scored = scoreState(task, writes) as { recall: number; precision: number; policy: number; strict: number; score: number };
  return {
    required,
    forbidden_tools: forbiddenTools,
    steps,
    verdict: { ...scored, task_completed_correctly: scored.strict === 1 },
  };
}
