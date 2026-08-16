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
  /ContextWindowExceededError|prompt is too long:\s*\d+\s*tokens?\s*>\s*\d+\s*maximum|Input length \d+ exceeds the maximum allowed input length of \d+ tokens\.|Input tokens exceed the configured limit of \d+ tokens\.\s*(?:Your input contained|Your messages resulted in) \d+ tokens\.(?:\s*Please reduce the length of the messages\.)?/i;

function isRecognizedContextWindowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as Record<string, unknown>;
  return (
    (row.type === "ProviderError" || row.type === "OverlongPromptError") &&
    Number(row.status_code) === 400 &&
    typeof row.message === "string" &&
    CONTEXT_WINDOW_MESSAGE.test(row.message)
  );
}

const RETRYABLE_TRANSPORT_MESSAGES: Record<number, RegExp> = {
  429: /upstream 429:.*rate limit exceeded/is,
  500: /upstream 500:.*internal server error/is,
  502: /upstream 502:.*provider connection error:.*upstream response stream/is,
  503: /upstream 503:.*overloaded_error.*provider is temporarily unavailable/is,
};

function isRecognizedRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as Record<string, unknown>;
  const status = Number(row.status_code);
  return (
    row.type === "ProviderError" &&
    typeof row.message === "string" &&
    RETRYABLE_TRANSPORT_MESSAGES[status]?.test(row.message) === true
  );
}

export function hasOnlyAcceptedCallErrors(trace: Record<string, any>, stopCondition: string): boolean {
  const calls = Array.isArray(trace.calls) ? trace.calls.filter((call: any) => !call?.sampling?.output_config) : [];
  const errorIndexes = calls.flatMap((call: any, index: number) => call?.error ? [index] : []);
  if (errorIndexes.length === 0) return true;
  if (stopCondition === "context_length") {
    return errorIndexes.every((index) => isRecognizedContextWindowError(calls[index].error));
  }
  if (stopCondition !== "agent_completed") return false;
  return errorIndexes.every((index) =>
    isRecognizedRetryableTransportError(calls[index].error) &&
    calls.slice(index + 1).some((later: any) => !later?.error && later?.usage),
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
  if (!hasOnlyAcceptedCallErrors(trace, stopCondition)) {
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
