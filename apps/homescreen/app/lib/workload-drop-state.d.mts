export type WorkloadDropPhase =
  | "idle"
  | "hovering"
  | "validating"
  | "compiling"
  | "inspecting"
  | "preparing_dataset"
  | "ready"
  | "failed";

export type WorkloadDropAction =
  | { type: "drag_enter" }
  | { type: "drag_leave" }
  | { type: "drop_received" }
  | { type: "validation_started" }
  | { type: "compilation_started" }
  | { type: "inspection_started" }
  | { type: "inspection_succeeded" }
  | { type: "dataset_started" }
  | { type: "dataset_succeeded" }
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "reset" };

export const INITIAL_WORKLOAD_DROP_PHASE: WorkloadDropPhase;

export function workloadDropReducer(
  phase: WorkloadDropPhase,
  action: WorkloadDropAction,
): WorkloadDropPhase;

export function isWorkloadDropBusy(phase: WorkloadDropPhase): boolean;

export function workloadDropPersonaState(
  phase: WorkloadDropPhase,
): "listening" | "thinking" | null;

export function workloadDropStatus(
  phase: WorkloadDropPhase,
): { title: string; detail: string } | null;
