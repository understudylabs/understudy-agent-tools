export type LocalTrainingRunnerPhase =
  | "preparing"
  | "downloading"
  | "training"
  | "evaluating"
  | "saving";

export type LocalTrainingPhase =
  | "idle"
  | LocalTrainingRunnerPhase
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type LocalTrainingEvent = {
  type?: "phase";
  phase: LocalTrainingRunnerPhase;
  epoch?: number;
  current?: number;
  total?: number;
  message?: string;
};

export type LocalTrainingState<Result = unknown> = {
  phase: LocalTrainingPhase;
  event: LocalTrainingEvent | null;
  result: Result | null;
  error: string | null;
  runId: string | null;
};

export const INITIAL_LOCAL_TRAINING_STATE: LocalTrainingState;
export function localTrainingReducer<Result>(
  state: LocalTrainingState<Result>,
  action:
    | { type: "start"; runId: string }
    | { type: "phase"; event: LocalTrainingEvent }
    | { type: "cancel_requested" }
    | { type: "cancelled" }
    | { type: "succeeded"; result: Result }
    | { type: "failed"; error: string }
    | { type: "reset" },
): LocalTrainingState<Result>;
export function isLocalTrainingActive(state: LocalTrainingState): boolean;
export function localTrainingProgress(event: LocalTrainingEvent | null): string | null;
export function localTrainingPhaseCopy(phase: LocalTrainingPhase): [string, string] | null;
export function localTrainingVerdict(result: {
  linear_baseline: { accuracy: number; macro_f1: number };
  verdict: {
    status: "not_better" | "improved_not_ready" | "promising";
    reason: string;
  };
}): { tone: "neutral" | "positive" | "caution"; title: string; detail: string };
export function localPredictionConfidence(score: number | undefined): string | null;
