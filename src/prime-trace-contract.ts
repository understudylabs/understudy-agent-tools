export type PrimeTraceDisposition = {
  accepted: boolean;
  normalized: boolean;
  stop_condition: string;
  display_stop_reason: string;
  terminal_outcome: "completed" | "model_failure" | "rejected";
  score: number | null;
  partial_credit: number | null;
  issue: string | null;
};

export const SCORED_TERMINAL_STOP_CONDITIONS = new Set([
  "agent_completed",
  "context_length",
  "max_turns",
]);

const CONTEXT_WINDOW_MESSAGE =
  /ContextWindowExceededError|prompt is too long:\s*\d+\s*tokens?\s*>\s*\d+\s*maximum|Input length \d+ exceeds the maximum allowed input length of \d+ tokens\./i;

function isRecognizedContextWindowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as Record<string, unknown>;
  return (
    row.type === "ProviderError" &&
    Number(row.status_code) === 400 &&
    typeof row.message === "string" &&
    CONTEXT_WINDOW_MESSAGE.test(row.message)
  );
}

export function isNormalizedContextWindowFailure(trace: Record<string, any>): boolean {
  const errors = Array.isArray(trace.errors) ? trace.errors : [];
  const callErrors = (Array.isArray(trace.calls) ? trace.calls : [])
    .map((call: any) => call?.error)
    .filter(Boolean);
  const allErrors = [...errors, ...callErrors];
  return (
    trace.is_completed === true &&
    trace.stop_condition === "error" &&
    allErrors.length > 0 &&
    allErrors.every(isRecognizedContextWindowError)
  );
}

export function primeTraceDisposition(
  trace: Record<string, any>,
  verifierVersion: string,
): PrimeTraceDisposition {
  const stopCondition = String(trace.stop_condition ?? "");
  if (trace.verifiers?.version !== verifierVersion) {
    return rejected(stopCondition, "verifier version mismatch");
  }
  if (trace.is_completed !== true) return rejected(stopCondition, "run is not terminal");

  if (isNormalizedContextWindowFailure(trace)) {
    return {
      accepted: true,
      normalized: true,
      stop_condition: stopCondition,
      display_stop_reason: "context_window_exceeded",
      terminal_outcome: "model_failure",
      score: 0,
      partial_credit: 0,
      issue: null,
    };
  }

  if (!SCORED_TERMINAL_STOP_CONDITIONS.has(stopCondition)) {
    return rejected(stopCondition, `unscored stop condition ${stopCondition || "missing"}`);
  }
  if (!Array.isArray(trace.errors) || trace.errors.length > 0) {
    return rejected(stopCondition, "runtime/provider errors are present");
  }
  if ((trace.calls ?? []).some((call: any) => call?.error)) {
    return rejected(stopCondition, "provider call errors are present");
  }
  if (!Number.isFinite(trace.rewards?.final_state)) {
    return rejected(stopCondition, "final reward is missing");
  }
  if (!Number.isFinite(trace.metrics?.final_state_partial_credit)) {
    return rejected(stopCondition, "partial credit is missing");
  }
  return {
    accepted: true,
    normalized: false,
    stop_condition: stopCondition,
    display_stop_reason: stopCondition,
    terminal_outcome: stopCondition === "agent_completed" ? "completed" : "model_failure",
    score: Number(trace.rewards.final_state),
    partial_credit: Number(trace.metrics.final_state_partial_credit),
    issue: null,
  };
}

function rejected(stopCondition: string, issue: string): PrimeTraceDisposition {
  return {
    accepted: false,
    normalized: false,
    stop_condition: stopCondition,
    display_stop_reason: stopCondition || "unknown",
    terminal_outcome: "rejected",
    score: null,
    partial_credit: null,
    issue,
  };
}
