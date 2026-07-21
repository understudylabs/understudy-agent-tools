export type TrainingFlowCardKind =
  | "data_profile"
  | "prediction_target"
  | "plan"
  | "calibration"
  | "compile_gates"
  | "backend"
  | "consent"
  | "run"
  | "outcome";

export type TrainingFlowCardStatus =
  | "pending"
  | "loading"
  | "ready"
  | "answered"
  | "active";

export type TrainingFlowDecisionDetails =
  | string
  | number
  | boolean
  | null
  | TrainingFlowDecisionDetails[]
  | { [key: string]: TrainingFlowDecisionDetails };

/**
 * Label-choice value-object answer (the clarification-queue shape): the user
 * confirms the current label, corrects it to `label`, or marks the example
 * ambiguous. `of_labels` records the candidates that were on offer.
 */
export type TrainingFlowLabelChoiceAnswer = {
  choice: "confirm" | "correct" | "ambiguous";
  label?: string;
  of_labels?: string[];
};

export type TrainingFlowAnswer = "yes" | "no" | string | TrainingFlowLabelChoiceAnswer;

export type TrainingFlowDecision = {
  question: string;
  answer: TrainingFlowAnswer;
  answered_at: string;
  details?: TrainingFlowDecisionDetails;
};

export type TrainingFlowCard = {
  id: string;
  kind: TrainingFlowCardKind;
  status: TrainingFlowCardStatus;
  decision: TrainingFlowDecision | null;
};

export type TrainingFlow = {
  schema_version: "understudy.training_flow.v1";
  cards: TrainingFlowCard[];
};

export const TRAINING_FLOW_SCHEMA_VERSION: "understudy.training_flow.v1";
export const TRAINING_FLOW_KIND_ORDER: readonly TrainingFlowCardKind[];
export const TRAINING_FLOW_KIND_LABELS: Readonly<Record<TrainingFlowCardKind, string>>;

export function createTrainingFlow(kinds: readonly TrainingFlowCardKind[]): TrainingFlow;
export function answersEqual(left: TrainingFlowAnswer, right: TrainingFlowAnswer): boolean;
export function activeCard(flow: TrainingFlow): TrainingFlowCard | null;
export function invalidatesLaterAnswers(
  flow: TrainingFlow,
  id: string,
  answer: TrainingFlowDecision["answer"],
): boolean;
export function answerCard(
  flow: TrainingFlow,
  id: string,
  decision: {
    question: string;
    answer: TrainingFlowDecision["answer"];
    answered_at?: string;
    details?: TrainingFlowDecisionDetails;
  },
): TrainingFlow;
export function insertCard(flow: TrainingFlow, kind: TrainingFlowCardKind): TrainingFlow;
export function navigateToAnswered(flow: TrainingFlow, id: string): TrainingFlow;
export function markCardLoading(flow: TrainingFlow, id: string): TrainingFlow;
export function markCardReady(flow: TrainingFlow, id: string): TrainingFlow;
export function serializeTrainingFlow(flow: TrainingFlow): string;
export function deserializeTrainingFlow(serialized: string): TrainingFlow;
