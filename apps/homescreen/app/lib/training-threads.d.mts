import type { TrainingFlow } from "./training-flow.mjs";

export type TrainingThreadStatus = "active" | "completed" | "dismissed";

export type TrainingThreadSummary = {
  thread_id: string;
  title: string;
  status: TrainingThreadStatus;
  created_at: string;
  updated_at: string;
};

export type TrainingThreadRequest = {
  threadId: string;
  requestId: number;
};

export const TRAINING_THREAD_STATUSES: readonly TrainingThreadStatus[];

export function trainingThreadTarget(flow: TrainingFlow | null | undefined): string | null;

export function trainingThreadTitle(
  sourceName: string | null | undefined,
  flow: TrainingFlow | null | undefined,
): string;

export function trainingThreadStatusGlyph(status: string): {
  className: string;
  label: string;
};
