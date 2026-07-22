"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/app/components/base-ui/message-scroller";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  Persona,
  type PersonaColor,
  type PersonaState,
} from "@/components/ai-elements/persona";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import {
  persistableChatMessages,
  recentUniqueAttachmentRefs,
  withHydratedAttachments,
  type ChatAttachment,
  type ChatAttachmentUpload,
} from "../lib/chat-attachments";
import { modelShortName, type SnapshotAlias } from "../lib/model-aliases";
import type { ChatSessionRequest } from "../lib/chat-history";
import { resolveChatModelSelection } from "../lib/model-selection.mjs";
import {
  SKIP_HINT_THRESHOLD,
  StreamPacer,
  pacingEnabled,
} from "../lib/stream-pacer.mjs";
import {
  ChatStreamBatcher,
  type ChatStreamPatch,
} from "../lib/chat-stream-batcher.mjs";
import {
  INITIAL_WORKLOAD_DROP_PHASE,
  isWorkloadDropBusy,
  shouldInspectDroppedTable,
  shouldInspectStructuredDataset,
  workloadHandoffPrompt,
  workloadDropPersonaState,
  workloadDropReducer,
  workloadDropStatus,
} from "../lib/workload-drop-state.mjs";
import {
  activeCard as activeFlowCard,
  answerCard as answerFlowCardModel,
  createTrainingFlow,
  insertCard,
  invalidatesLaterAnswers,
  markCardLoading,
  markCardReady,
  navigateToAnswered,
  type TrainingFlow,
  type TrainingFlowAnswer,
  type TrainingFlowCard,
  type TrainingFlowCardKind,
  type TrainingFlowDecisionDetails,
} from "../lib/training-flow.mjs";
import { deserializeTrainingFlow } from "../lib/training-flow.mjs";
import { trainingThreadTitle } from "../lib/training-threads.mjs";
import type { TrainingThreadRequest, TrainingThreadStatus } from "../lib/training-threads.mjs";
import { TrainingFlowStepper, TrainingFlowTimeline } from "./TrainingFlowStepper";
import { ModelCardDrawer } from "./ModelCardDrawer";
import { CsvProfile } from "./CsvProfile";
import { CsvTrainingPlan } from "./CsvTrainingPlan";
import { LocalTrainingPanel } from "./LocalTrainingPanel";
import {
  recommendedManagedTrainingSpend,
  remoteTrainingArtifactLimitError,
  RemoteTrainingPanel,
  type RemotePlan,
  type RemoteTrainingCapabilities,
} from "./RemoteTrainingPanel";
import {
  CustomTrainingCompileCard,
  type CustomCompileEvent,
  type CustomCompileSummary,
} from "./CustomTrainingCompile";
import { LocalSftTrainingPanel } from "./LocalSftTrainingPanel";
import { LocalClassifierLibraryDialog } from "./LocalClassifierLibraryDialog";
import { TrainingHalo, type TrainingHaloVisual } from "./TrainingHalo";
import { ChatScrollControls } from "./ChatScrollControls";
import type { FileUIPart } from "ai";
import { LibraryBigIcon } from "lucide-react";

type Role = "user" | "assistant";
type ToolTrace = {
  name: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};
type Msg = {
  role: Role;
  content: string;
  model?: string;
  reasoning?: string;
  tools?: ToolTrace[];
  attachments?: ChatAttachment[];
};
type ChatEvent =
  | { type: "Notice"; message: string }
  | { type: "Chunk"; text: string }
  | { type: "ReplaceChunk"; text: string }
  | { type: "ReasoningChunk"; text: string }
  | { type: "ToolCall"; name: string; args: unknown }
  | { type: "ToolResult"; name: string; ok: boolean; result: unknown }
  | { type: "SidekickEvent"; mode: string; stage: string; detail: string }
  | { type: "Error"; message: string }
  | { type: "Done" };
type ResidencySnapshot = {
  slots: {
    id: number;
    model_id?: string | null;
    state: string;
    port?: number | null;
    thinking: boolean;
  }[];
};
type SnapshotModel = SnapshotAlias;
type ChatStatus = "ready" | "streaming" | "error";
type DroppedWorkload = {
  source_name: string;
  source_path: string;
  source_type: "file" | "directory";
  scanned_file_count: number;
  source_count: number;
  total_bytes: number;
  source_kinds: Record<string, number>;
  truncated: boolean;
  local_only: true;
  payload_read: false;
  artifact_root: string;
  workload_card_path: string;
};
type WorkloadDropEvent = { type: "validating" | "compiling" };
type CsvInspection = {
  schema_version: "understudy.capture_import.csv_inspection.v1";
  source_sha256: string;
  source_bytes: number;
  local_only: true;
  payload_read: true;
  source_rows_persisted: false;
  persisted_data: "statistics-and-label-aggregates";
  row_count: number;
  column_count: number;
  duplicate_row_count: number;
  row_preview: Array<{
    row_number: number;
    values: Record<string, string>;
  }>;
  columns: {
    name: string;
    non_empty_count: number;
    empty_count: number;
    unique_count: number;
    unique_ratio: number;
    numeric_count: number;
    numeric_ratio: number;
    profile_kind: "number" | "date" | "category" | "text";
    profile_bars: number[];
  }[];
  recommended_mapping: {
    label_column: string | null;
    input_columns: string[];
    group_column: string | null;
    confidence: "high" | "low" | "none";
    requires_confirmation: true;
  };
  label_distribution: { value: string; count: number }[];
  label_distribution_truncated: boolean;
  training_readiness: {
    ready: boolean;
    status: "ready" | "needs_mapping" | "needs_data" | "needs_cleanup";
    class_count: number;
    minimum_examples_per_class: number | null;
    reasons: string[];
    warnings: string[];
  };
  artifact_path: string;
};
type TrainingRecipeInspection = {
  schema_version: "understudy.remote_training.recipe_inspection.v1";
  source_path: string;
  source_sha256: string;
  local_only: true;
  payload_read: true;
  source_format: string;
  artifact_kind: "dataset" | "benchmark_report";
  field_names: string[];
  field_profiles: Array<{
    name: string;
    unique_count: number;
    profile_kind: "number" | "category" | "text";
    profile_bars: number[];
  }>;
  row_preview: Array<{ input: string; target: string | null }>;
  benchmark: {
    dataset_name: string;
    model_name: string | null;
    score: number;
    evaluated_examples: number;
  } | null;
  detected_use_case: string;
  recipe_id: string | null;
  task_kind: string;
  method: string;
  evaluator: string | null;
  confidence: "high" | "medium" | "low";
  ready: boolean;
  requires_confirmation: true;
  evidence: {
    total_rows: number;
    chat_rows: number;
    gsm8k_rows: number;
    gsm8k_public_rows: number;
    classification_rows: number;
    preference_rows: number;
    tool_trace_rows: number;
    multimodal_rows: number;
    invalid_rows: number;
    duplicate_input_rows: number;
    conflicting_target_rows: number;
    unique_target_count: number;
  };
  reasons: string[];
  warnings: string[];
  inspection_duration_ms?: number;
};
type RecipeBackendCompatibility = {
  backends: Array<{
    id: "mlx-local" | "fireworks" | "tinker";
    compatible: boolean;
    execution_ready: boolean;
  }>;
};
type TrainingGoalCard = {
  schema_version: "understudy.training.goal_card.v1";
  detected_task: string;
  evaluator: string;
  splits: {
    strategy: string;
    hash: string;
    train: number;
    validation: number;
    heldout: number;
  };
  promotion: {
    minimum_accuracy: number;
    minimum_improvement_over_base: number;
  };
  backend: { requested: string; compatible: string[] };
  privacy: {
    local_only: true;
    uploads: false;
    provider_calls: false;
    preview_source: "train_only";
    heldout_targets_visible: false;
  };
  runtime: { maximum_seconds: number };
  cost: { maximum_usd: number };
  training_preview: Array<{ source_split: "train"; input: string; target: string }>;
  environment: { proposal_path: string; status: "proposed" | "executable" | "needs_verifier" };
};
type PiEnvironmentArchitectResult = {
  schema_version: "understudy.environment_architect.pi_result.v1";
  status: "analyzed";
  proposal_path: string;
  runtime_backend: "pi";
  analysis_route: "cloud" | "anthropic" | "local";
  analysis_model: string;
  dataset_summary: string;
  target_goal: string;
  environment_summary: string;
  validation_summary: string;
  plan_check: {
    status: "passed" | "warnings";
    checked_fields: number;
    warnings: string[];
    advisory: true;
  };
  source_file_local: true;
  remote_content_shared: boolean;
  executable: false;
  next_step: string;
};
type PiDatasetAnalysisEvent =
  | {
      type: "phase";
      phase: "profiling" | "inferring" | "checking" | "complete";
      current: number;
      total: number;
      message: string;
    }
  | { type: "draft_delta"; phase: "inferring"; text: string };
type CustomCompileResult = CustomCompileSummary & {
  plan: RemotePlan;
  goal_card: TrainingGoalCard;
};
type ClassificationDataset = {
  schema_version: "understudy.capture_import.classification_dataset.v2";
  dataset_id: string;
  source_sha256: string;
  mapping_sha256: string;
  local_only: true;
  network_required: false;
  mapping_confirmation: "caller-provided";
  source_rows_persisted_as_transformed_examples: true;
  row_count: number;
  // Rows the preparer excluded; drive the calibration review card.
  unusable_rows_removed: number;
  conflicted_group_rows_removed: number;
  mapping: {
    input_columns: string[];
    label_column: string;
    group_column: string;
    text_template: "named-fields-v1";
  };
  split_policy: {
    name: "deterministic-stratified-group-aware-v2";
    group_key: string;
    group_normalization: "casefold-reference-stripping-v1";
    no_group_overlap: true;
  };
  labels: string[];
  splits: {
    train: { path: string; row_count: number; sha256: string };
    dev: { path: string; row_count: number; sha256: string };
    holdout: { path: string; row_count: number; sha256: string };
  };
  manifest_path: string;
};

const CLOUD_SUPERVISOR_FALLBACK_NOTICE =
  "Tried to hand off to a larger cloud model, but it is unavailable. Continuing with the local model.";
const LOCAL_SUPERVISOR_FALLBACK_NOTICE =
  "The supervising model is unavailable. Continuing with the selected local model.";

type SidekickEvent = {
  id: number;
  session_id: string;
  mode: string;
  stage: string;
  detail: string;
  created_at: string;
};
type PersistedChatSession = {
  session_id: string;
  messages: Msg[];
  updated_at: string;
};
type LocalModelChoice = {
  id: string;
  modelId: string;
  label: string;
  detail: string;
  route: "local";
  slotId: number;
  thinking: boolean;
  loading: boolean;
  active: boolean;
};
type ModelChoice =
  | LocalModelChoice
  | {
      id: string;
      label: string;
      detail: string;
      route: "cloud";
      slotId: null;
      active: boolean;
    }
  | {
      id: string;
      label: string;
      detail: string;
      route: "anthropic";
      slotId: null;
      active: boolean;
    };

type AnthropicModel = { id: string; label: string; detail: string };
type AnthropicStatus = { present: boolean; source: string | null };
type ActiveTaskModel = {
  id: string;
  version: string;
  name: string;
  base_ready: boolean;
  top_k: number;
};
type TaskModelPrediction = {
  prediction: { l3_id: number; l3: string; probability: number };
  top_k: Array<{ l3_id: number; l3: string; probability: number }>;
  elapsed_ms: number;
};
type TaskModelFileRun = {
  rows: number;
  labeled_rows: number;
  right: number;
  accuracy?: number | null;
  elapsed_ms: number;
  output_path: string;
};

const CLOUD_MODEL: ModelChoice = {
  id: "cloud:glm-5.2",
  label: "GLM 5.2",
  detail: "Understudy gateway fallback",
  route: "cloud",
  slotId: null,
  active: true,
};

const PERSONA_WHITE: PersonaColor = { red: 255, green: 255, blue: 255 };
const PERSONA_CYAN: PersonaColor = { red: 103, green: 232, blue: 249 };
const PERSONA_TASK: PersonaColor = { red: 244, green: 114, blue: 182 };
const PERSONA_ERROR: PersonaColor = { red: 248, green: 113, blue: 113 };
const ACTIVE_TASK_MODEL_KEY = "understudy.active-task-model.v1";

function compactBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function localModelCapabilityScore(choice: LocalModelChoice): number {
  const sizes = Array.from(choice.modelId.matchAll(/(?:^|[^0-9])(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/gi))
    .map((match) => Number.parseFloat(match[1]))
    .filter(Number.isFinite);
  if (sizes.length > 0) return Math.max(...sizes);
  return ({
    "understudy-small": 2,
    "understudy-balanced": 4,
    "understudy-quality": 12,
    "understudy-fast": 26,
  } as Record<string, number>)[choice.label.toLowerCase()] ?? 0;
}

function trainingUseCaseLabel(useCase: string): string {
  return ({
    grade_school_math_reasoning: "Grade-school math reasoning",
    model_evaluation: "Model evaluation report",
    tabular_analysis: "Tabular prediction",
    preference_optimization: "Preference optimization",
    agentic_tool_use: "Agent and tool use",
    vision_language: "Vision-language tuning",
    classification: "Text classification",
    text_classification: "Text classification",
    general_chat: "General chat",
    custom_chat_assistant: "Custom chat assistant",
  } as Record<string, string>)[useCase] ?? "Custom training workload";
}

function proposedSplitCounts(total: number) {
  const train = Math.floor(total * 0.7);
  const validation = Math.floor(total * 0.15);
  return { train, validation, heldout: Math.max(0, total - train - validation) };
}

const PI_ANALYSIS_STAGES = [
  { phase: "profiling", label: "Profile data", detail: "Rows and fields" },
  { phase: "inferring", label: "Infer plan", detail: "Understudy" },
  { phase: "checking", label: "Check plan", detail: "Advisory" },
  { phase: "complete", label: "Ready", detail: "Your decision" },
] as const;

function streamedJsonString(draft: string, key: string): string | null {
  const match = draft.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function GoalCardSkeleton({ width = "full" }: { width?: "short" | "medium" | "full" }) {
  return <span className={`automatic-goal-card-skeleton is-${width}`} aria-hidden="true" />;
}

function PiAnalysisElapsed({ active }: { active: boolean }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const update = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return <time className="pi-analysis-elapsed" aria-label={`${elapsedSeconds} seconds elapsed`}>{minutes}:{seconds} elapsed</time>;
}

function PiAnalysisRail({
  architect,
  progress,
  error,
}: {
  architect: PiEnvironmentArchitectResult | null;
  progress: PiDatasetAnalysisEvent | null;
  error?: string | null;
}) {
  const phaseProgress = progress?.type === "phase" ? progress : null;
  const stageCurrent = architect
    ? PI_ANALYSIS_STAGES.length
    : phaseProgress
      ? Math.max(1, phaseProgress.current)
      : 0;
  return (
    <ol className="automatic-goal-card-stages" aria-label="Dataset analysis progress">
      {PI_ANALYSIS_STAGES.map((stage, index) => {
        const number = index + 1;
        const state = error && number === stageCurrent
          ? "error"
          : architect || number < stageCurrent
          ? "complete"
          : number === stageCurrent
            ? "active"
            : "pending";
        return (
          <li
            key={stage.phase}
            data-state={state}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span>{number.toString().padStart(2, "0")}</span>
            <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
          </li>
        );
      })}
    </ol>
  );
}

function PiDesignCards({
  architect,
  progress,
  draft,
  error,
  onRetry,
}: {
  architect: PiEnvironmentArchitectResult | null;
  progress: PiDatasetAnalysisEvent | null;
  draft: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  const phaseProgress = progress?.type === "phase" ? progress : null;
  const active = Boolean(phaseProgress && phaseProgress.phase !== "complete" && !error);
  const streamedTarget = streamedJsonString(draft, "target_goal");
  const streamedDataset = streamedJsonString(draft, "dataset_summary");
  const streamedEnvironment = streamedJsonString(draft, "environment");
  const streamedValidation = streamedJsonString(draft, "validation_plan");
  const hasDraft = Boolean(draft);
  return (
    <section className="automatic-goal-card-design" aria-live="polite">
      <header>
        <div><strong>Target and verifier</strong></div>
        <small>
          {error
            ? "Analysis stopped"
            : phaseProgress?.message
              ?? (architect
                ? architect.plan_check.status === "passed"
                  ? null
                  : "Draft ready with advisory warnings"
                : "Waiting for Understudy")}
          <PiAnalysisElapsed active={active} />
        </small>
      </header>
      {error ? (
        <div className="automatic-goal-card-error" role="alert">
          <strong>Understudy needs another pass</strong>
          <p>{error}</p>
          {onRetry && <button type="button" onClick={onRetry}>Retry analysis</button>}
        </div>
      ) : <div>
        <article>
          <span>Target goal</span>
          {architect || streamedTarget || streamedDataset ? <>
            <strong>{architect?.target_goal ?? streamedTarget ?? "Inferring the target…"}</strong>
            <p>{architect?.dataset_summary ?? streamedDataset ?? "Reading representative examples…"}</p>
          </> : <><GoalCardSkeleton width="medium" /><GoalCardSkeleton /><GoalCardSkeleton width="medium" /></>}
        </article>
        <article>
          <span>Verifier design</span>
          {architect || streamedEnvironment || streamedValidation ? <>
            <strong>{architect?.environment_summary ?? streamedEnvironment ?? "Drafting the verifier…"}</strong>
            <p>{architect?.validation_summary ?? streamedValidation ?? "The check is advisory; you can continue with the draft."}</p>
          </> : <><GoalCardSkeleton width="short" /><GoalCardSkeleton /><GoalCardSkeleton width="full" /></>}
        </article>
      </div>}
      {!architect && hasDraft && !error && (
        <p className="automatic-goal-card-draft-status">Draft streaming · continue anytime while Understudy checks it.</p>
      )}
    </section>
  );
}

function TableExampleCards({
  rows,
  inputColumns,
  labelColumn,
}: {
  rows: CsvInspection["row_preview"];
  inputColumns: string[];
  labelColumn: string | null;
}) {
  return (
    <section className="automatic-goal-card-preview csv-analysis-examples" aria-label="Dataset examples">
      <header>
        <div><span>Dataset evidence</span><strong>Example rows</strong></div>
        <small>{rows.length} shown · updates with the target card</small>
      </header>
      <div className="automatic-goal-card-preview-grid">
        {rows.map((row, index) => {
          const visibleInputs = inputColumns.length > 0
            ? inputColumns
            : Object.keys(row.values).filter((field) => field !== labelColumn);
          const input = visibleInputs
            .map((field) => `${field}: ${row.values[field] ?? ""}`)
            .filter((field) => !field.endsWith(": "))
            .join(" · ");
          const target = labelColumn ? row.values[labelColumn] : null;
          return (
            <article key={`${row.row_number}:${index}`}>
              <header>
                <span>Row {row.row_number.toLocaleString()}</span>
                <small>{target ? <>Expected · <b>{target}</b></> : "Target being inferred"}</small>
              </header>
              <p>{input || "No populated input fields in this row."}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DatasetAnalysisLoadingTemplate({ message }: { message: string }) {
  const progress: PiDatasetAnalysisEvent = {
    type: "phase",
    phase: "profiling",
    current: 1,
    total: 4,
    message,
  };
  return (
    <section className="csv-analysis-loading-template" role="status" aria-live="polite" aria-busy="true">
      <header>
        <div><span>1 · data structure</span><strong>Understanding your data</strong></div>
        <small>{message}</small>
      </header>
      <PiAnalysisRail architect={null} progress={progress} />
      <div className="csv-analysis-loading-columns" aria-hidden="true">
        {[0, 1].map((index) => (
          <article key={index}>
            <GoalCardSkeleton width="short" />
            <GoalCardSkeleton />
            <GoalCardSkeleton width="medium" />
          </article>
        ))}
      </div>
    </section>
  );
}

function structuredFieldRole(fieldName: string): "input" | "target" | "preference" | "context" {
  const normalized = fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (/(^|_)(chosen|rejected|preferred|preference)(_|$)/.test(normalized)) return "preference";
  if (/(^|_)(label|target|answer|expected|output|completion|response)(_|$)/.test(normalized)) return "target";
  if (/(^|_)(prompt|question|input|instruction|text|message|messages)(_|$)/.test(normalized)) return "input";
  return "context";
}

function StructuredDataProfile({
  sourceName,
  inspection,
}: {
  sourceName: string;
  inspection: TrainingRecipeInspection;
}) {
  const visibleFields = inspection.field_names.slice(0, 8);
  const profiles = new Map((inspection.field_profiles ?? []).map((profile) => [profile.name, profile]));
  const hiddenFieldCount = Math.max(0, inspection.field_names.length - visibleFields.length);
  return (
    <section className="structured-data-profile" aria-label="Detected dataset structure">
      <header>
        <strong>{sourceName.replace(/\.[^.]+$/, "")}</strong>
        <span>
          {inspection.evidence.total_rows.toLocaleString()} rows · {inspection.field_names.length.toLocaleString()} fields
        </span>
      </header>
      <div className="structured-data-field-grid">
        {visibleFields.map((field) => {
          const role = structuredFieldRole(field);
          const profile = profiles.get(field);
          return (
            <article key={field} data-role={role}>
              <div className="structured-data-field-histogram" aria-hidden="true">
                {(profile?.profile_bars.length ? profile.profile_bars : [1]).map((bar, index) => (
                  <i key={`${field}:${index}`} style={{ height: `${Math.max(5, Math.min(100, bar * 100))}%` }} />
                ))}
              </div>
              <strong>{field}</strong>
              <small>
                {role === "context"
                  ? profile?.profile_kind === "category"
                    ? `${profile.unique_count.toLocaleString()} sampled kinds`
                    : profile?.profile_kind ?? "observed field"
                  : `${role} candidate`}
              </small>
            </article>
          );
        })}
      </div>
      {hiddenFieldCount > 0 && <small className="structured-data-more">+ {hiddenFieldCount} more fields</small>}
    </section>
  );
}

function StructuredTrainingExamples({
  inspection,
  card,
}: {
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
}) {
  const preview = inspection.row_preview.length > 0
    ? inspection.row_preview
    : card?.training_preview ?? [];
  return (
    <section className="automatic-goal-card-preview" aria-label="Training examples">
      <header>
        <div><span>Dataset evidence</span><strong>Source examples</strong></div>
        <small>{preview.length > 0 ? `${preview.length} shown · before splitting` : "No readable examples found"}</small>
      </header>
      <div className="automatic-goal-card-preview-grid">
        {preview.length > 0 ? preview.map((row, index) => (
          <article key={`${index}:${row.input}`}>
            <header>
              <span>Example {String(index + 1).padStart(2, "0")}</span>
              <small>{row.target ? <>Expected · <b>{row.target}</b></> : "Target being inferred"}</small>
            </header>
            <p>{row.input}</p>
          </article>
        )) : (
          <article className="automatic-goal-card-preview-empty" role="alert">
            <strong>Understudy could not decode representative rows.</strong>
            <p>Check the delimiter or workbook sheet, then drop the dataset again.</p>
          </article>
        )}
      </div>
    </section>
  );
}

function StructuredDatasetProfilePage({
  sourceName,
  inspection,
  card,
  ready,
  onConfirm,
  onClose,
}: {
  sourceName: string;
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  ready: boolean;
  onConfirm: () => void;
  onClose?: () => void;
}) {
  return (
    <section className="automatic-goal-card structured-dataset-profile-page" aria-label="Review dataset profile">
      {onClose && (
        <button
          type="button"
          className="dataset-profile-close"
          aria-label="Close dataset review"
          onClick={onClose}
        >
          ✕
        </button>
      )}
      <div className="csv-analysis-step-label csv-analysis-step-structure">1 · data structure</div>
      <StructuredDataProfile sourceName={sourceName} inspection={inspection} />
      {!inspection.benchmark && <StructuredTrainingExamples inspection={inspection} card={card} />}
      <div className="dataset-profile-confirm">
        <div>
          <strong>Does this look like the data you meant to train on?</strong>
          <small>Confirming starts Understudy analysis and builds the training plan.</small>
        </div>
        <button type="button" className="btn primary" disabled={!ready} onClick={onConfirm}>
          {ready ? "Yes, analyze this dataset" : "Finishing the dataset profile…"}
        </button>
      </div>
    </section>
  );
}

/**
 * The yes/no footer every focus card carries: one question, one primary yes,
 * and an optional scoped "no" alternative. Reuses the confirm styling the
 * dataset-profile card established.
 */
function FlowQuestion({
  question,
  hint,
  yesLabel,
  yesDisabled,
  onYes,
  noLabel,
  onNo,
}: {
  question: string;
  hint?: string | null;
  yesLabel: string;
  yesDisabled?: boolean;
  onYes: () => void;
  noLabel?: string;
  onNo?: () => void;
}) {
  return (
    <div className="dataset-profile-confirm training-flow-question">
      <div>
        <strong>{question}</strong>
        {hint && <small>{hint}</small>}
      </div>
      {noLabel && onNo && (
        <button type="button" className="btn secondary" onClick={onNo}>
          {noLabel}
        </button>
      )}
      <button type="button" className="btn primary" disabled={yesDisabled} onClick={onYes}>
        {yesLabel}
      </button>
    </div>
  );
}

/**
 * "Acceptable error" line on the goal card: the plan's promotion gate,
 * human-phrased and editable within sane bounds (50–99%). The value is
 * recorded on the card decision; plan preparation does not accept it yet.
 */
function AcceptableErrorLine({
  minimumAccuracy,
  onChange,
}: {
  minimumAccuracy: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(minimumAccuracy * 100);
  return (
    <label className="training-flow-accuracy-line">
      <span>Must be right at least</span>
      <input
        type="number"
        min={50}
        max={99}
        value={percent}
        onChange={(event) => {
          const raw = Number(event.target.value);
          if (!Number.isFinite(raw)) return;
          onChange(Math.min(0.99, Math.max(0.5, raw / 100)));
        }}
      />
      <span>% of the time on unseen examples.</span>
    </label>
  );
}

/**
 * One reviewed example on the calibration card. `verdict` is what today's
 * yes/no UI records; the optional label-choice fields are the
 * forward-compatible clarification-queue shape — a follow-up feature lets the
 * user pick the correct label ({choice:"correct", corrected_label, of_labels})
 * or mark the example ambiguous. All plain JSON, recorded in decision details.
 */
type CalibrationVerdict = {
  group: string;
  label: string;
  verdict: "yes" | "no";
  choice?: "confirm" | "correct" | "ambiguous";
  corrected_label?: string;
  of_labels?: string[];
};

/**
 * Calibration review: the prepared dataset excluded rows (conflicted leakage
 * groups and/or unusable rows). Shows the counts, then walks disputed
 * examples one at a time — sourced from the inspection's row preview, since
 * the manifest exposes counts only. Verdicts are recorded on the card
 * decision; they cannot flow back into the dataset yet (see decision details).
 */
function CalibrationReviewCard({
  dataset,
  samples,
  verdicts,
  onVerdict,
  onConfirm,
  onChangeTarget,
}: {
  dataset: ClassificationDataset;
  samples: Array<{ group: string; label: string; text: string }>;
  verdicts: CalibrationVerdict[];
  onVerdict: (verdict: CalibrationVerdict) => void;
  onConfirm: (question: string, details: TrainingFlowDecisionDetails) => void;
  onChangeTarget: () => void;
}) {
  const conflicted = dataset.conflicted_group_rows_removed ?? 0;
  const unusable = dataset.unusable_rows_removed ?? 0;
  const current = samples[verdicts.length];
  const countsLine = [
    conflicted > 0
      ? `${conflicted.toLocaleString()} row${conflicted === 1 ? " fell" : "s fell"} in ${dataset.mapping.group_column} groups carrying different ${dataset.mapping.label_column} labels`
      : null,
    unusable > 0
      ? `${unusable.toLocaleString()} row${unusable === 1 ? " was" : "s were"} unusable (empty target or inputs)`
      : null,
  ].filter(Boolean).join(", and ");
  const question = `Proceed without the ${(conflicted + unusable).toLocaleString()} excluded rows?`;
  const confirm = () => onConfirm(question, {
    conflicted_group_rows_removed: conflicted,
    unusable_rows_removed: unusable,
    reviewed_examples: verdicts.map((verdict) => ({ ...verdict })),
    // The dataset was already split; these verdicts are a record, not yet a
    // feedback loop into preparation.
    verdicts_applied: false,
  });
  return (
    <section className="automatic-goal-card structured-dataset-analysis" aria-label="Review excluded rows">
      <div className="csv-analysis-step-label">Review · rows we excluded</div>
      <div className="csv-analysis-next">
        <p className="csv-analysis-note" role="status">
          {countsLine} — we excluded them before splitting so labels stay consistent.
        </p>
        {current ? (
          <div className="training-flow-calibration-example">
            <span className="training-flow-timeline-kicker">
              disputed example {verdicts.length + 1} of {samples.length}
            </span>
            <blockquote>{current.text || `(${dataset.mapping.group_column}: ${current.group})`}</blockquote>
            <FlowQuestion
              question={`This says “${current.label}” — is that right?`}
              hint="Your call is recorded with this decision; the excluded rows stay out either way for now."
              yesLabel="Yes, that label is right"
              onYes={() => onVerdict({ group: current.group, label: current.label, verdict: "yes", choice: "confirm" })}
              noLabel="No, that label is wrong"
              onNo={() => onVerdict({ group: current.group, label: current.label, verdict: "no" })}
            />
          </div>
        ) : (
          <>
            {samples.length === 0 && (
              <p className="csv-analysis-note" role="status">
                The row-level conflicts aren&apos;t exported by the preparer yet, and none of the
                disputed rows appear in the local preview — so there&apos;s no sample to show here.
              </p>
            )}
            <FlowQuestion
              question={question}
              hint={samples.length > 0
                ? "Your reviews are recorded with this decision."
                : "Only the counts are available for this dataset."}
              yesLabel="Yes, proceed"
              onYes={confirm}
              noLabel="No — change target"
              onNo={onChangeTarget}
            />
          </>
        )}
      </div>
    </section>
  );
}

function predictionStatement(
  inspection: TrainingRecipeInspection,
  targetField: string | undefined,
  targetGoal: string | null,
): string | null {
  if (targetGoal) return targetGoal;
  if (!targetField) return null;
  const inputFields = inspection.field_names.filter(
    (field) => field !== targetField && structuredFieldRole(field) === "input",
  );
  let line = inputFields.length > 0
    ? `Predicting ${targetField} from ${inputFields.join(", ")}`
    : `Predicting ${targetField}`;
  const answerCount = inspection.evidence.unique_target_count;
  if (answerCount > 0) {
    const samples = [...new Set(
      inspection.row_preview
        .map((row) => row.target)
        .filter((target): target is string => Boolean(target && target.trim())),
    )].slice(0, 2);
    line += ` — ${answerCount.toLocaleString()} possible answers${samples.length > 0 ? `: ${samples.join(", ")}` : ""}`;
  }
  return `${line}.`;
}

function StructuredTrainingPlan({
  inspection,
  card,
  targetGoal,
  backend,
  localAvailable,
  onBackendChange,
}: {
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  targetGoal: string | null;
  backend: "local" | "managed";
  localAvailable: boolean;
  onBackendChange: (backend: "local" | "managed") => void;
}) {
  const planned = proposedSplitCounts(inspection.evidence.total_rows);
  const splits = card?.splits ?? planned;
  const evaluator = card?.evaluator ?? inspection.evaluator ?? "Understudy verifier draft";
  const targetField = inspection.field_names.find((field) => structuredFieldRole(field) === "target");
  const predicting = predictionStatement(inspection, targetField, targetGoal);
  return (
    <div className="csv-training-plan structured-training-plan" role="list" aria-label="Proposed training plan">
      <div className="csv-training-plan-step" role="listitem">
        <span>Understand</span>
        <strong>{trainingUseCaseLabel(inspection.detected_use_case)}</strong>
        <small>{inspection.evidence.total_rows.toLocaleString()} rows · {inspection.field_names.length.toLocaleString()} fields</small>
        {targetField && <em className="training-target-badge">Target · {targetField}</em>}
        {predicting && <p className="training-prediction-statement">{predicting}</p>}
      </div>
      <div className="csv-training-plan-step" role="listitem">
        <span>Train</span>
        <strong>{backend === "managed" ? "Cloud · Understudy auto" : `Local · ${inspection.method.replaceAll("_", " ")}`}</strong>
        <small>{backend === "managed" ? "Cost-efficient model selected automatically" : `${splits.train.toLocaleString()} train · ${splits.validation.toLocaleString()} validation`}</small>
        <div className="training-backend-choice" role="radiogroup" aria-label="Training backend">
          <button type="button" role="radio" aria-checked={backend === "managed"} onClick={() => onBackendChange("managed")}>Cloud</button>
          <button
            type="button"
            role="radio"
            aria-checked={backend === "local"}
            disabled={!localAvailable}
            title={localAvailable ? "Train on this Mac" : "No compatible local trainer is ready"}
            onClick={() => onBackendChange("local")}
          >Local</button>
        </div>
      </div>
      <div className="csv-training-plan-step" role="listitem">
        <span>Prove</span>
        <strong>{evaluator === "exact_label" ? "Answers checked against the real labels" : evaluator.replaceAll("_", " ")}</strong>
        <small>Tested on {splits.heldout.toLocaleString()} examples the model never sees during training — and compared against the untrained model.</small>
      </div>
    </div>
  );
}

/**
 * The Understudy-analysis heading (use case + live status chip) shared by the
 * prediction-target focus card. Extracted from the former AutomaticGoalCard,
 * whose sections now live on separate decision cards.
 */
function AnalysisHeading({
  inspection,
  card,
  architect,
  architectProgress,
  architectError,
}: {
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  architect: PiEnvironmentArchitectResult | null;
  architectProgress: PiDatasetAnalysisEvent | null;
  architectError: string | null;
}) {
  const analysisIsLive = Boolean(
    architectProgress?.type === "phase"
      && architectProgress.phase !== "complete"
      && !architectError,
  );
  const environmentStatus = architectError
    ? "analysis_error"
    : analysisIsLive
    ? "pi_live"
    : card?.environment.status ?? architect?.status ?? (inspection.ready ? "proposed" : "queued");
  const statusLabel = ({
    pi_live: "Understudy live",
    executable: "Ready to test",
    analyzed: "Draft ready",
    needs_verifier: "Needs verifier",
    analysis_error: "Needs retry",
    proposed: "Proposed",
    queued: "Queued",
  } as Record<string, string>)[environmentStatus] ?? environmentStatus.replaceAll("_", " ");
  return (
    <div className="automatic-goal-card-heading structured-analysis-heading">
      <div>
        <strong>{trainingUseCaseLabel(inspection.detected_use_case)}</strong>
      </div>
      <em data-status={environmentStatus}>
        {analysisIsLive && <i aria-hidden="true" />}
        {statusLabel}
      </em>
    </div>
  );
}

type RemoteTrainingCapabilitiesEnvelope = {
  schema_version: "understudy.remote_training.capabilities.v1";
  enabled: boolean;
  reason?: string;
  capabilities?: RemoteTrainingCapabilities;
};

function trainedModelName(sourceName: string, labelColumn: string): string {
  const sourceStem = sourceName.replace(/\.[^.]+$/, "").replace(/(?:^|[-_])dataset(?:$|[-_])/gi, "-");
  const normalized = `${sourceStem}-${labelColumn}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "");
  return normalized || "understudy-model";
}

function piDatasetAnalysisFailure(cause: unknown): string {
  const detail = String(cause);
  if (detail.includes("pi_length_continuation_exhausted") || detail.includes("output limit")) {
    return "The draft exceeded its response budget. Retry asks Understudy for a shorter structured answer.";
  }
  if (detail.includes("exceeded 90 seconds") || detail.includes("timed out")) {
    return "The active model did not finish within 45 seconds. Retry starts a fresh bounded pass.";
  }
  return "The active model stopped before the verifier draft was complete. Retry starts a fresh pass.";
}

function cleanReasoningText(text: string) {
  return text
    .replace(/<\|?channel\|?>\s*thought/gi, "")
    .replace(/<\/?\|?(?:channel|message|start|end)\|?>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/^\s*thought\s*$/gim, "")
    .trim();
}

function ReasoningSubstream({
  active,
  text,
}: {
  active: boolean;
  text: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(active);

  useEffect(() => {
    setOpen(active);
  }, [active]);

  useEffect(() => {
    if (!active || !ref.current) return;
    const frame = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, text]);

  const expanded = active || open;

  return (
    <div className={"reasoning-substream" + (active ? " active" : "")}>
      <button
        type="button"
        className="reasoning-substream-label"
        aria-expanded={expanded}
        onClick={() => {
          if (!active) setOpen((value) => !value);
        }}
      >
        <span />
        {active ? "Thinking" : "Thoughts"}
      </button>
      {expanded && (
        <div ref={ref} className="reasoning-substream-text">
          {text}
        </div>
      )}
    </div>
  );
}

function ChatToolTrace({ tool }: { tool: ToolTrace }) {
  const shouldAutoOpen = tool.state !== "output-available";
  const [open, setOpen] = useState(shouldAutoOpen);

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader type="dynamic-tool" toolName={tool.name} state={tool.state} />
      <ToolContent>
        <ToolInput input={tool.input} />
        {(tool.output !== undefined || tool.errorText) && (
          <ToolOutput output={tool.output} errorText={tool.errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}

export function ChatPane({
  resetToken,
  activeSessionId,
  requestedSession,
  requestedThread,
  onSessionChange,
  onTrainingThreadChange,
  onHistoryChanged,
  onStreamingChange,
  onTrainingChange,
  onNeedsSignIn,
}: {
  resetToken: number;
  activeSessionId: string | null;
  requestedSession: ChatSessionRequest | null;
  requestedThread?: TrainingThreadRequest | null;
  onSessionChange?: (sessionId: string) => void;
  onTrainingThreadChange?: (threadId: string | null) => void;
  onHistoryChanged?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
  onTrainingChange?: (active: boolean) => void;
  onNeedsSignIn?: () => void;
}) {
  const [initialSession] = useState(() => {
    const restore = activeSessionId !== null;
    const sessionId = activeSessionId ?? crypto.randomUUID();
    return { sessionId, restore };
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(initialSession.sessionId);
  const [streaming, setStreaming] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choices, setChoices] = useState<ModelChoice[]>([CLOUD_MODEL]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [gatewaySignedIn, setGatewaySignedIn] = useState<boolean | null>(null);
  const [thinkingPending, setThinkingPending] = useState<{ slotId: number; thinking: boolean } | null>(null);
  const [personaReady, setPersonaReady] = useState(false);
  const [personaCycle, setPersonaCycle] = useState(0);
  const [introThinking, setIntroThinking] = useState(true);
  const [sidekickEvents, setSidekickEvents] = useState<SidekickEvent[]>([]);
  const [sessionHydrated, setSessionHydrated] = useState(!initialSession.restore);
  const [dropPhase, dispatchDrop] = useReducer(
    workloadDropReducer,
    INITIAL_WORKLOAD_DROP_PHASE,
  );
  const [droppedWorkload, setDroppedWorkload] = useState<DroppedWorkload | null>(null);
  const [csvInspection, setCsvInspection] = useState<CsvInspection | null>(null);
  const [trainingRecipe, setTrainingRecipe] = useState<TrainingRecipeInspection | null>(null);
  const [remoteRecipePlan, setRemoteRecipePlan] = useState<RemotePlan | null>(null);
  const [datasetProfileConfirmed, setDatasetProfileConfirmed] = useState(false);
  const [trainingFlow, setTrainingFlow] = useState<TrainingFlow | null>(null);
  // Training thread: the persisted identity of this flow. Created the moment
  // data is dropped (status active) so a mid-flow restart resumes from the
  // nav; every decision, invalidation, and run-terminal saves it.
  const [trainingThreadId, setTrainingThreadId] = useState<string | null>(null);
  const [trainingThreadStatus, setTrainingThreadStatus] = useState<TrainingThreadStatus>("active");
  // Reopened completed/dismissed threads render their timeline read-only.
  const [threadReadOnly, setThreadReadOnly] = useState(false);
  // The thread's artifact_root no longer exists on disk: card bodies cannot
  // be re-rendered, say so honestly instead of re-running the pipeline.
  const [threadArtifactMissing, setThreadArtifactMissing] = useState<string | null>(null);
  // Editable goal card: user-corrected goal statement and acceptable-error
  // threshold. The threshold is recorded on the decision; plan preparation
  // does not accept it yet (hardcoded 0.80 server-side) — see the card copy.
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [structuredTargetChoice, setStructuredTargetChoice] = useState<string | null>(null);
  const [minAccuracyDraft, setMinAccuracyDraft] = useState<number | null>(null);
  // Calibration review: verdicts on disputed examples, recorded on the card.
  const [calibrationVerdicts, setCalibrationVerdicts] = useState<CalibrationVerdict[]>([]);
  const [remoteRecipeEligibilityError, setRemoteRecipeEligibilityError] = useState<string | null>(null);
  const [trainingGoalCard, setTrainingGoalCard] = useState<TrainingGoalCard | null>(null);
  const [environmentArchitect, setEnvironmentArchitect] = useState<PiEnvironmentArchitectResult | null>(null);
  const [environmentArchitectProgress, setEnvironmentArchitectProgress] = useState<PiDatasetAnalysisEvent | null>(null);
  const [environmentArchitectDraft, setEnvironmentArchitectDraft] = useState("");
  const [environmentArchitectError, setEnvironmentArchitectError] = useState<string | null>(null);
  const [environmentArchitectRetry, setEnvironmentArchitectRetry] = useState(0);
  const [customCompilePhases, setCustomCompilePhases] = useState<CustomCompileEvent[]>([]);
  const [customCompileResult, setCustomCompileResult] = useState<CustomCompileResult | null>(null);
  const [customCompileError, setCustomCompileError] = useState<string | null>(null);
  const [customCompileBusy, setCustomCompileBusy] = useState(false);
  const [recipeBackend, setRecipeBackend] = useState<"local" | "managed">("managed");
  const [recipeLocalAvailable, setRecipeLocalAvailable] = useState(false);
  const [mappingInputColumns, setMappingInputColumns] = useState<string[]>([]);
  const [mappingLabelColumn, setMappingLabelColumn] = useState("");
  const [mappingGroupColumn, setMappingGroupColumn] = useState("");
  const [classificationDataset, setClassificationDataset] = useState<ClassificationDataset | null>(null);
  const [csvBackend, setCsvBackend] = useState<"local" | "managed" | null>(null);
  const [csvCloudCapabilities, setCsvCloudCapabilities] = useState<RemoteTrainingCapabilities | null>(null);
  const [csvCloudError, setCsvCloudError] = useState<string | null>(null);
  const [localTrainingActive, setLocalTrainingActive] = useState(false);
  const [remoteTrainingView, setRemoteTrainingView] = useState(false);
  const [trainingHaloVisual, setTrainingHaloVisual] = useState<TrainingHaloVisual | null>(null);
  const [classifierLibraryOpen, setClassifierLibraryOpen] = useState(false);
  const [activeTaskModel, setActiveTaskModel] = useState<ActiveTaskModel | null>(null);
  const [taskModelFileRun, setTaskModelFileRun] = useState<TaskModelFileRun | null>(null);
  const [pacingMessageIndex, setPacingMessageIndex] = useState<number | null>(null);
  const [pacedRevealed, setPacedRevealed] = useState<number | null>(null);
  const [animatedMessageId, setAnimatedMessageId] = useState<string | null>(null);
  const observedResetToken = useRef(false);
  const observedSessionRequest = useRef<number | null>(null);
  const observedThreadRequest = useRef<number | null>(null);
  // A flow restored from a persisted thread; consumed (instead of creating a
  // fresh flow) when the re-run inspection lands.
  const restoredFlowRef = useRef<TrainingFlow | null>(null);
  // One resume-side re-preparation of the CSV splits per reopened thread.
  const resumePrepareAttempted = useRef<string | null>(null);
  const wasTrainingActive = useRef(false);
  const dropInFlight = useRef(false);
  const dropRequestGeneration = useRef(0);
  // Fresh `send` for the drag-drop effect (its dep array is deliberately
  // narrow, so calling `send` directly from there would capture stale state).
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);
  const environmentArchitectAttempted = useRef<string | null>(null);
  const customCompileAttempted = useRef<string | null>(null);
  const environmentArchitectDraftRef = useRef("");
  const environmentArchitectDraftFrame = useRef<number | null>(null);
  const selectedModelUserOwned = useRef(false);
  const streamPacer = useRef<StreamPacer | null>(null);
  const streamPacerGeneration = useRef(0);
  const streamBatcher = useRef<ChatStreamBatcher | null>(null);
  const dropHovering = dropPhase === "hovering";
  const dropRunning = isWorkloadDropBusy(dropPhase);
  const dropStatus = workloadDropStatus(dropPhase);

  useEffect(() => {
    onTrainingChange?.(localTrainingActive || dropPhase === "preparing_dataset");
  }, [dropPhase, localTrainingActive, onTrainingChange]);

  useEffect(() => () => onTrainingChange?.(false), [onTrainingChange]);

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_TASK_MODEL_KEY);
    if (!stored) return;
    let identity: { id?: string; version?: string };
    try {
      identity = JSON.parse(stored) as { id?: string; version?: string };
    } catch {
      window.localStorage.removeItem(ACTIVE_TASK_MODEL_KEY);
      return;
    }
    invoke<ActiveTaskModel[]>("list_task_models")
      .then((models) => {
        const match = models.find((model) => model.id === identity.id && model.version === identity.version);
        if (match) setActiveTaskModel(match);
        else window.localStorage.removeItem(ACTIVE_TASK_MODEL_KEY);
      })
      .catch(() => undefined);
  }, []);

  const applyAssistantPatch = (patch: ChatStreamPatch) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const lastIndex = next.length - 1;
      const last = next[lastIndex];
      const baseContent = patch.replaceContent ?? last.content;
      next[lastIndex] = {
        ...last,
        content: baseContent + patch.appendContent,
        reasoning: (last.reasoning ?? "") + patch.appendReasoning,
      };
      return next;
    });
  };

  useEffect(() => {
    const batcher = new ChatStreamBatcher(applyAssistantPatch, {
      schedule: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    });
    streamBatcher.current = batcher;
    return () => {
      batcher.dispose();
      streamBatcher.current = null;
    };
  }, []);

  const resetStreamPacer = () => {
    streamBatcher.current?.reset();
    streamPacerGeneration.current += 1;
    streamPacer.current?.dispose();
    streamPacer.current = null;
    setPacingMessageIndex(null);
    setPacedRevealed(null);
  };

  const resetDroppedWorkload = () => {
    dropRequestGeneration.current += 1;
    dropInFlight.current = false;
    environmentArchitectAttempted.current = null;
    customCompileAttempted.current = null;
    setCustomCompilePhases([]);
    setCustomCompileResult(null);
    setCustomCompileError(null);
    setCustomCompileBusy(false);
    setDroppedWorkload(null);
    setCsvInspection(null);
    setTrainingRecipe(null);
    setTrainingThreadId(null);
    setTrainingThreadStatus("active");
    setThreadReadOnly(false);
    setThreadArtifactMissing(null);
    restoredFlowRef.current = null;
    resumePrepareAttempted.current = null;
    wasTrainingActive.current = false;
    setRemoteRecipePlan(null);
    setDatasetProfileConfirmed(false);
    setTrainingFlow(null);
    setRemoteRecipeEligibilityError(null);
    setTrainingGoalCard(null);
    setEnvironmentArchitect(null);
    setEnvironmentArchitectProgress(null);
    setEnvironmentArchitectDraft("");
    environmentArchitectDraftRef.current = "";
    setEnvironmentArchitectError(null);
    setEnvironmentArchitectRetry(0);
    setRecipeBackend("managed");
    setRecipeLocalAvailable(false);
    setMappingInputColumns([]);
    setMappingLabelColumn("");
    setMappingGroupColumn("");
    setClassificationDataset(null);
    setCsvBackend(null);
    setCsvCloudCapabilities(null);
    setCsvCloudError(null);
    setLocalTrainingActive(false);
    setRemoteTrainingView(false);
    setTrainingHaloVisual(null);
    dispatchDrop({ type: "reset" });
  };

  const persistTrainingThread = (
    threadId: string,
    workload: DroppedWorkload,
    flow: TrainingFlow | null,
    status: TrainingThreadStatus,
  ) =>
    invoke("training_thread_save", {
      threadId,
      title: trainingThreadTitle(workload.source_name, flow),
      artifactRoot: workload.artifact_root,
      workload,
      flow,
      status,
    })
      .then(() => onHistoryChanged?.())
      .catch(() => {
        setNotice("This training thread could not be saved for restart; the current step is unaffected.");
      });

  /** Explicit dismissal: record the muted outcome, then clear the surface. */
  const dismissWorkloadThread = () => {
    if (trainingThreadId && droppedWorkload && !threadReadOnly && trainingThreadStatus === "active") {
      void persistTrainingThread(trainingThreadId, droppedWorkload, trainingFlow, "dismissed");
    }
    resetDroppedWorkload();
  };

  const applyCsvInspection = (result: CsvInspection) => {
    setCsvInspection(result);
    setMappingInputColumns(result.recommended_mapping.input_columns);
    setMappingLabelColumn(result.recommended_mapping.label_column ?? "");
    setMappingGroupColumn(result.recommended_mapping.group_column ?? "");
    dispatchDrop({ type: "inspection_succeeded" });
  };

  const inspectCsvWorkload = async (workload: DroppedWorkload, requestGeneration: number) => {
    const result = await invoke<CsvInspection>("inspect_dropped_csv", {
      path: workload.source_path,
      artifactRoot: workload.artifact_root,
    });
    if (dropRequestGeneration.current !== requestGeneration) return;
    applyCsvInspection(result);
  };

  const inspectTrainingRecipe = async (workload: DroppedWorkload, requestGeneration: number) => {
    const result = await invoke<TrainingRecipeInspection>("inspect_remote_training_recipe", {
      path: workload.source_path,
    });
    if (dropRequestGeneration.current !== requestGeneration) return;
    environmentArchitectAttempted.current = null;
    customCompileAttempted.current = null;
    setCustomCompilePhases([]);
    setCustomCompileResult(null);
    setCustomCompileError(null);
    setCustomCompileBusy(false);
    setTrainingRecipe(result);
    setTrainingGoalCard(null);
    setDatasetProfileConfirmed(false);
    setRemoteRecipeEligibilityError(null);
    setEnvironmentArchitect(null);
    setEnvironmentArchitectProgress(null);
    setEnvironmentArchitectDraft("");
    environmentArchitectDraftRef.current = "";
    setEnvironmentArchitectError(null);
    setEnvironmentArchitectRetry(0);
    dispatchDrop({ type: "inspection_succeeded" });
  };

  const prepareDetectedRecipe = useCallback(() => {
    if (
      !droppedWorkload
      || !trainingRecipe
      || !trainingRecipe.ready
      || !trainingRecipe.recipe_id
      || dropInFlight.current
    ) return;
    dropInFlight.current = true;
    const requestGeneration = dropRequestGeneration.current + 1;
    dropRequestGeneration.current = requestGeneration;
    setRemoteRecipePlan(null);
    setRemoteRecipeEligibilityError(null);
    setRecipeBackend("managed");
    setRecipeLocalAvailable(false);
    setErr(null);
    dispatchDrop({ type: "dataset_started" });
    void invoke<RemotePlan>("prepare_remote_training_recipe", {
      sourcePath: droppedWorkload.source_path,
      artifactRoot: droppedWorkload.artifact_root,
      expectedSourceSha256: trainingRecipe.source_sha256,
      recipeId: trainingRecipe.recipe_id,
      modelProfile: "understudy/auto",
      maximumSpendUsd: 0,
    })
      .then(async (plan) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        const [compatibility, goalCard] = await Promise.all([
          invoke<RecipeBackendCompatibility>("compile_remote_training_backends", {
            planPath: plan.plan_path,
          }),
          invoke<TrainingGoalCard>("automatic_training_goal_card", {
            planPath: plan.plan_path,
            previewLimit: 2,
          }),
        ]);
        if (dropRequestGeneration.current !== requestGeneration) return;
        const localAvailable = compatibility.backends.some(
          (backend) => backend.id === "mlx-local" && backend.compatible && backend.execution_ready,
        );
        setRecipeLocalAvailable(localAvailable);
        setRecipeBackend("managed");
        setRemoteRecipePlan(plan);
        setTrainingGoalCard(goalCard);
        dispatchDrop({ type: "dataset_succeeded" });

        try {
          const envelope = await invoke<RemoteTrainingCapabilitiesEnvelope>("remote_training_capabilities");
          if (dropRequestGeneration.current !== requestGeneration) return;
          const capabilities = envelope.enabled ? envelope.capabilities : undefined;
          const managedAvailable = capabilities?.providers.some(
            (provider) => provider.id === "managed" && provider.enabled && provider.model_profiles.length > 0,
          );
          if (!capabilities || !managedAvailable) {
            setRemoteRecipeEligibilityError(envelope.reason ?? "Cloud training is unavailable in this Desktop build.");
            return;
          }
          const artifactLimitError = remoteTrainingArtifactLimitError(plan, capabilities);
          if (artifactLimitError) {
            setRemoteRecipeEligibilityError(artifactLimitError);
            return;
          }
          const maximumSpendUsd = recommendedManagedTrainingSpend(capabilities);
          const pricedPlan = await invoke<RemotePlan>("prepare_remote_training_recipe", {
            sourcePath: droppedWorkload.source_path,
            artifactRoot: droppedWorkload.artifact_root,
            expectedSourceSha256: trainingRecipe.source_sha256,
            recipeId: trainingRecipe.recipe_id,
            modelProfile: "understudy/auto",
            maximumSpendUsd,
          });
          if (dropRequestGeneration.current !== requestGeneration) return;
          setRemoteRecipePlan(pricedPlan);
          setRemoteRecipeEligibilityError(null);
        } catch (cause) {
          if (dropRequestGeneration.current === requestGeneration) {
            setRemoteRecipeEligibilityError(`Cloud readiness check failed: ${String(cause)}`);
          }
        }
      })
      .catch((error) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        setErr(String(error));
        dispatchDrop({ type: "failed" });
      })
      .finally(() => {
        if (dropRequestGeneration.current === requestGeneration) dropInFlight.current = false;
      });
  }, [droppedWorkload, trainingRecipe]);

  useEffect(() => {
    // Read-only reopened threads are an audit trail — never restart the
    // priced-plan pipeline for them.
    if (!remoteRecipePlan && trainingRecipe?.ready && !threadReadOnly) prepareDetectedRecipe();
  }, [prepareDetectedRecipe, remoteRecipePlan, threadReadOnly, trainingRecipe?.ready]);

  /**
   * Compile the Pi environment-architect proposal for a Custom training
   * workload into an executable local plan, then — only when the deterministic
   * environment reports "executable" — flow into the existing priced-recipe
   * path (capabilities check + re-preparation with the recommended managed
   * spend), mirroring prepareDetectedRecipe. Local-only until the user
   * approves an upload; the compiled plan always starts at $0.
   */
  const compileCustomTrainingPlan = useCallback(() => {
    if (!droppedWorkload || !trainingRecipe || customCompileBusy) return;
    const requestGeneration = dropRequestGeneration.current;
    const sourceSha256 = trainingRecipe.source_sha256;
    customCompileAttempted.current = sourceSha256;
    setCustomCompileBusy(true);
    setCustomCompileError(null);
    setCustomCompilePhases([]);
    const channel = new Channel<CustomCompileEvent>();
    channel.onmessage = (event) => {
      if (dropRequestGeneration.current !== requestGeneration || event.type !== "phase") return;
      setCustomCompilePhases((current) => [
        ...current.filter((seen) => seen.phase !== event.phase),
        event,
      ]);
    };
    const mapping =
      csvInspection && mappingLabelColumn && mappingGroupColumn && mappingInputColumns.length > 0
        ? {
            input_columns: mappingInputColumns,
            label_column: mappingLabelColumn,
            group_column: mappingGroupColumn,
          }
        : undefined;
    void invoke<CustomCompileResult>("compile_custom_training_plan", {
      artifactRoot: droppedWorkload.artifact_root,
      sourcePath: droppedWorkload.source_path,
      mapping,
      modelProfile: "understudy/auto",
      onEvent: channel,
    })
      .then(async (compiled) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        setCustomCompileResult(compiled);
        setTrainingGoalCard(compiled.goal_card);
        if (compiled.environment_status !== "executable") return;
        setRemoteRecipePlan(compiled.plan);
        setRemoteRecipeEligibilityError(null);
        try {
          const [compatibility, envelope] = await Promise.all([
            invoke<RecipeBackendCompatibility>("compile_remote_training_backends", {
              planPath: compiled.plan.plan_path,
            }),
            invoke<RemoteTrainingCapabilitiesEnvelope>("remote_training_capabilities"),
          ]);
          if (dropRequestGeneration.current !== requestGeneration) return;
          setRecipeLocalAvailable(compatibility.backends.some(
            (backend) => backend.id === "mlx-local" && backend.compatible && backend.execution_ready,
          ));
          setRecipeBackend("managed");
          const capabilities = envelope.enabled ? envelope.capabilities : undefined;
          const managedAvailable = capabilities?.providers.some(
            (provider) => provider.id === "managed" && provider.enabled && provider.model_profiles.length > 0,
          );
          if (!capabilities || !managedAvailable) {
            setRemoteRecipeEligibilityError(envelope.reason ?? "Cloud training is unavailable in this Desktop build.");
            return;
          }
          const artifactLimitError = remoteTrainingArtifactLimitError(compiled.plan, capabilities);
          if (artifactLimitError) {
            setRemoteRecipeEligibilityError(artifactLimitError);
            return;
          }
          const maximumSpendUsd = recommendedManagedTrainingSpend(capabilities);
          const pricedPlan = compiled.dataset_manifest_path
            ? await invoke<RemotePlan>("prepare_remote_classification_training", {
                manifestPath: compiled.dataset_manifest_path,
                modelProfile: "understudy/auto",
                maximumSpendUsd,
              })
            : await invoke<RemotePlan>("prepare_remote_training_recipe", {
                sourcePath: droppedWorkload.source_path,
                artifactRoot: droppedWorkload.artifact_root,
                expectedSourceSha256: sourceSha256,
                recipeId: compiled.recipe_id,
                modelProfile: "understudy/auto",
                maximumSpendUsd,
              });
          if (dropRequestGeneration.current !== requestGeneration) return;
          setRemoteRecipePlan(pricedPlan);
          setRemoteRecipeEligibilityError(null);
        } catch (cause) {
          if (dropRequestGeneration.current === requestGeneration) {
            setRemoteRecipeEligibilityError(`Cloud readiness check failed: ${String(cause)}`);
          }
        }
      })
      .catch((cause) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        setCustomCompileError(String(cause));
      })
      .finally(() => {
        if (dropRequestGeneration.current === requestGeneration) setCustomCompileBusy(false);
      });
  }, [csvInspection, customCompileBusy, droppedWorkload, mappingGroupColumn, mappingInputColumns, mappingLabelColumn, trainingRecipe]);

  // A landed Pi proposal for a not-yet-executable workload drives compilation
  // automatically. Tabular sources with a live inspection wait for the user to
  // confirm the column mapping and press Compile instead.
  useEffect(() => {
    if (
      !environmentArchitect
      || !droppedWorkload
      || !trainingRecipe
      || trainingRecipe.ready
      || csvInspection
      || customCompileBusy
      || customCompileResult
      || customCompileError
    ) return;
    if (customCompileAttempted.current === trainingRecipe.source_sha256) return;
    compileCustomTrainingPlan();
  }, [compileCustomTrainingPlan, csvInspection, customCompileBusy, customCompileError, customCompileResult, droppedWorkload, environmentArchitect, trainingRecipe]);

  const openManagedRecipeTraining = useCallback(() => {
    setRecipeBackend("managed");
    if (remoteRecipeEligibilityError) setErr(remoteRecipeEligibilityError);
  }, [remoteRecipeEligibilityError]);

  const chooseCsvCloudTraining = useCallback(async () => {
    setCsvCloudError(null);
    try {
      const envelope = await invoke<RemoteTrainingCapabilitiesEnvelope>("remote_training_capabilities");
      const capabilities = envelope.enabled ? envelope.capabilities : undefined;
      const managedAvailable = capabilities?.providers.some(
        (provider) => provider.id === "managed" && provider.enabled && provider.model_profiles.length > 0,
      );
      if (!capabilities || !managedAvailable) {
        setCsvCloudError(envelope.reason ?? "Cloud training is unavailable in this Desktop build.");
        return;
      }
      setCsvCloudCapabilities(capabilities);
      setCsvBackend("managed");
    } catch (error) {
      setCsvCloudError(String(error));
    }
  }, []);

  const prepareDroppedClassification = () => {
    if (
      !droppedWorkload ||
      !csvInspection ||
      !mappingLabelColumn ||
      !mappingGroupColumn ||
      mappingInputColumns.length === 0 ||
      dropInFlight.current
    ) return;
    dropInFlight.current = true;
    const requestGeneration = dropRequestGeneration.current + 1;
    dropRequestGeneration.current = requestGeneration;
    setClassificationDataset(null);
    setCsvBackend(null);
    setCsvCloudCapabilities(null);
    setCsvCloudError(null);
    setErr(null);
    setNotice(null);
    dispatchDrop({ type: "dataset_started" });
    void invoke<ClassificationDataset>("prepare_dropped_csv_classification", {
      path: droppedWorkload.source_path,
      artifactRoot: droppedWorkload.artifact_root,
      inputColumns: mappingInputColumns,
      labelColumn: mappingLabelColumn,
      groupColumn: mappingGroupColumn,
    })
      .then((result) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        setClassificationDataset(result);
        dispatchDrop({ type: "dataset_succeeded" });
        setNotice(null);
      })
      .catch((error) => {
        if (dropRequestGeneration.current !== requestGeneration) return;
        dispatchDrop({ type: "failed" });
        setErr(String(error));
      })
      .finally(() => {
        if (dropRequestGeneration.current === requestGeneration) dropInFlight.current = false;
      });
  };

  const startStreamPacer = (messageIndex: number) => {
    resetStreamPacer();
    if (!pacingEnabled()) return null;
    const generation = streamPacerGeneration.current;
    const pacer = new StreamPacer((revealed: number) => {
      if (streamPacerGeneration.current === generation) setPacedRevealed(revealed);
    });
    streamPacer.current = pacer;
    setPacingMessageIndex(messageIndex);
    setPacedRevealed(0);
    return pacer;
  };

  const refreshModels = async () => {
    try {
      const [residency, snapshots, anthropicStatus, accountStatus] = await Promise.all([
        invoke<ResidencySnapshot>("get_residency"),
        invoke<SnapshotModel[]>("list_snapshot_models"),
        invoke<AnthropicStatus>("anthropic_status").catch(() => ({ present: false, source: null })),
        invoke<{ signed_in?: boolean }>("account_status").catch(() => ({ signed_in: false })),
      ]);
      setGatewaySignedIn(Boolean(accountStatus.signed_in));
      const anthropic: ModelChoice[] = anthropicStatus.present
        ? (await invoke<AnthropicModel[]>("anthropic_models").catch(() => [])).map((model) => ({
            id: `anthropic:${model.id}`,
            label: model.label,
            detail: model.detail,
            route: "anthropic" as const,
            slotId: null,
            active: true,
          }))
        : [];
      const local = residency.slots
        .filter((slot) => (slot.state === "running" || slot.state === "loading") && slot.model_id)
        .map<LocalModelChoice>((slot) => ({
          id: `local:${slot.id}`,
          modelId: slot.model_id!,
          label: modelShortName(slot.model_id, snapshots) ?? `slot ${slot.id}`,
          detail: `${slot.model_id}${slot.port ? ` · :${slot.port}` : ""}${slot.state === "loading" ? " · loading" : ""}`,
          route: "local",
          slotId: slot.id,
          thinking: slot.thinking,
          loading: slot.state === "loading",
          active: slot.state === "running",
        }));
      setThinkingPending((pending) => {
        if (!pending) return pending;
        const slot = local.find((choice) => choice.slotId === pending.slotId);
        if (slot?.active && slot.thinking === pending.thinking) return null;
        return pending;
      });
      const cloudChoice: ModelChoice = {
        ...CLOUD_MODEL,
        active: Boolean(accountStatus.signed_in),
      };
      const next = [cloudChoice, ...local, ...anthropic];
      setChoices((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
      setSelectedModel((current) => {
        const activeChoices = next.filter((choice) => choice.active);
        const strongestLocal = local
          .filter((choice) => choice.active)
          .sort((left, right) => localModelCapabilityScore(right) - localModelCapabilityScore(left))[0];
        const preferredActiveId = accountStatus.signed_in
          ? CLOUD_MODEL.id
          : strongestLocal?.id ?? anthropic[0]?.id ?? null;
        const resolved = resolveChatModelSelection({
          currentId: current,
          choiceIds: activeChoices.map((choice) => choice.id),
          preferredActiveId,
          userSelected: selectedModelUserOwned.current,
        });
        selectedModelUserOwned.current = resolved.userSelected;
        return resolved.selectedId;
      });
    } catch {
      setGatewaySignedIn(false);
      setChoices((current) =>
        current.length === 1 && current[0]?.id === CLOUD_MODEL.id ? current : [CLOUD_MODEL],
      );
      setSelectedModel((current) => current ?? CLOUD_MODEL.id);
    }
  };

  const stopStreaming = () => {
    streamPacer.current?.skip();
    void invoke<{ status: string }>("conversation_runtime_cancel", { sessionId })
      .then((result) => {
        if (result.status === "idle") {
          setNotice("No active response was found to stop.");
        }
      })
      .catch((e) => {
        setErr(String(e));
        setStreaming(false);
        setAssistantSpeaking(false);
      });
  };

  useEffect(() => {
    void refreshModels();
    if (streaming) return;
    const timer = window.setInterval(refreshModels, 2500);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(
    () => () => {
      streamPacerGeneration.current += 1;
      streamPacer.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const compileDroppedPath = (path: string) => {
      if (dropInFlight.current) {
        setNotice("The current dropped workload is still being compiled locally.");
        return;
      }
      dropInFlight.current = true;
      dispatchDrop({ type: "drop_received" });
      const requestGeneration = dropRequestGeneration.current + 1;
      dropRequestGeneration.current = requestGeneration;
      setDroppedWorkload(null);
      // A new drop always starts a NEW thread; whatever thread was open
      // stays persisted with the status it already had.
      setTrainingThreadId(null);
      setTrainingThreadStatus("active");
      setThreadReadOnly(false);
      setThreadArtifactMissing(null);
      restoredFlowRef.current = null;
      resumePrepareAttempted.current = null;
      wasTrainingActive.current = false;
      setCsvInspection(null);
      setMappingInputColumns([]);
      setMappingLabelColumn("");
      setMappingGroupColumn("");
      setClassificationDataset(null);
      setErr(null);
      setNotice(null);
      const channel = new Channel<WorkloadDropEvent>();
      channel.onmessage = (message) => {
        if (disposed || dropRequestGeneration.current !== requestGeneration) return;
        dispatchDrop({
          type: message.type === "validating" ? "validation_started" : "compilation_started",
        });
      };
      void invoke<DroppedWorkload>("compile_dropped_workload", {
        path,
        onEvent: channel,
      })
        .then(async (result) => {
          if (disposed || dropRequestGeneration.current !== requestGeneration) return;
          const inspectTable = shouldInspectDroppedTable(result);
          const inspectStructured = shouldInspectStructuredDataset(result);
          if (!inspectTable && !inspectStructured) {
            // Directories and non-table files have no deterministic training
            // flow — handing them to the in-chat agent (which carries the
            // benchmark-lab profile_workload/from_dataset tools) instead of
            // opening a training thread that nothing would ever advance.
            dispatchDrop({ type: "succeeded" });
            dispatchDrop({ type: "reset" });
            const handoff = sendRef.current;
            if (handoff) {
              void handoff(workloadHandoffPrompt(result));
            } else {
              setNotice("Workload draft created locally; ask in chat to profile it.");
            }
            return;
          }
          setDroppedWorkload(result);
          // Dropping data creates the thread immediately (status active) so
          // a mid-flow restart can resume this flow from the nav.
          const threadId = crypto.randomUUID();
          setTrainingThreadId(threadId);
          void persistTrainingThread(threadId, result, null, "active");
          if (inspectStructured) {
            dispatchDrop({ type: "inspection_started" });
            try {
              await inspectTrainingRecipe(result, requestGeneration);
            } catch (error) {
              if (!inspectTable) throw error;
              try {
                await inspectCsvWorkload(result, requestGeneration);
              } catch {
                // Surface the structured inspector's diagnostic, not the
                // table fallback's.
                throw error;
              }
            }
          } else {
            dispatchDrop({ type: "inspection_started" });
            try {
              await inspectCsvWorkload(result, requestGeneration);
            } catch {
              // Inspection is a best-effort probe: files the local reader
              // cannot parse as a table still become a metadata-only card.
              dispatchDrop({ type: "succeeded" });
              setNotice("Workload draft created locally; this file is not a supported table.");
            }
          }
        })
        .catch((error) => {
          if (!disposed && dropRequestGeneration.current === requestGeneration) {
            dispatchDrop({ type: "failed" });
            setErr(String(error));
          }
        })
        .finally(() => {
          if (dropRequestGeneration.current !== requestGeneration) return;
          dropInFlight.current = false;
        });
    };
    const installDroppedModel = async (path: string, inspectFirst: boolean) => {
      if (dropInFlight.current) {
        setNotice("The current dropped file is still being processed locally.");
        return;
      }
      dropInFlight.current = true;
      let handedOffToWorkload = false;
      setErr(null);
      setNotice(inspectFirst ? "Checking ZIP for a portable task model…" : "Verifying portable task model…");
      try {
        if (inspectFirst) await invoke("inspect_task_model", { path });
        const installed = await invoke<{
          id: string;
          name: string;
          version: string;
          base_ready: boolean;
          top_k: number;
        }>("install_task_model", { path });
        if (disposed) return;
        const taskModel = {
          id: installed.id,
          name: installed.name,
          version: installed.version,
          base_ready: installed.base_ready,
          top_k: installed.top_k,
        };
        setActiveTaskModel(taskModel);
        window.localStorage.setItem(ACTIVE_TASK_MODEL_KEY, JSON.stringify({
          id: installed.id,
          version: installed.version,
        }));
        setNotice(installed.base_ready
          ? `${installed.name} is active.`
          : `${installed.name} is active. Downloading its required base model now…`);
        dispatchDrop({ type: "reset" });
      } catch (error) {
        if (disposed) return;
        if (inspectFirst) {
          dropInFlight.current = false;
          handedOffToWorkload = true;
          compileDroppedPath(path);
          return;
        }
        dispatchDrop({ type: "failed" });
        setErr(`Model package rejected: ${String(error)}`);
      } finally {
        if (!handedOffToWorkload) dropInFlight.current = false;
      }
    };
    const scoreDroppedFile = async (path: string) => {
      if (!activeTaskModel || dropInFlight.current) return;
      dropInFlight.current = true;
      setErr(null);
      setTaskModelFileRun(null);
      setNotice(`Scoring test data with ${activeTaskModel.name}…`);
      try {
        const result = await invoke<TaskModelFileRun>("run_task_model_file", {
          request: {
            model_id: activeTaskModel.id,
            version: activeTaskModel.version,
            path,
          },
        });
        if (disposed) return;
        setTaskModelFileRun(result);
        setNotice(result.accuracy == null
          ? `Scored ${result.rows.toLocaleString()} rows for human review.`
          : `${result.right.toLocaleString()} of ${result.labeled_rows.toLocaleString()} labeled rows matched.`);
        dispatchDrop({ type: "reset" });
      } catch (error) {
        if (disposed) return;
        dispatchDrop({ type: "failed" });
        setErr(`Test data could not be scored: ${String(error)}`);
      } finally {
        dropInFlight.current = false;
      }
    };
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // The trained-model dialog owns portable model packages while open;
        // do not also compile them as generic dropped workloads.
        if (classifierLibraryOpen) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          dispatchDrop({ type: "drag_enter" });
          return;
        }
        if (event.payload.type === "leave") {
          dispatchDrop({ type: "drag_leave" });
          return;
        }

        const paths = event.payload.paths;
        if (dropInFlight.current) {
          setNotice("The current dropped workload is still being compiled locally.");
          return;
        }
        dispatchDrop({ type: "drop_received" });
        if (paths.length !== 1) {
          dispatchDrop({ type: "failed" });
          setErr("Drop one file or folder at a time so each Workload Card has a clear source.");
          return;
        }
        const path = paths[0];
        const lowerPath = path.toLowerCase();
        if (lowerPath.endsWith(".understudy-model")) {
          void installDroppedModel(path, false);
          return;
        }
        if (lowerPath.endsWith(".zip")) {
          void installDroppedModel(path, true);
          return;
        }
        if (activeTaskModel && /\.(?:csv|tsv|jsonl|ndjson)$/.test(lowerPath)) {
          void scoreDroppedFile(path);
          return;
        }
        compileDroppedPath(path);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        if (!disposed) setNotice(`File and folder drop is unavailable: ${String(error)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeTaskModel, classifierLibraryOpen]);

  const hydrateSavedMessages = async (
    saved: PersistedChatSession,
    isCancelled: () => boolean = () => false,
  ): Promise<Msg[] | null> => {
    const attachmentRefs = recentUniqueAttachmentRefs(saved.messages);
    const hydrated =
      attachmentRefs.length > 0
        ? await invoke<Array<ChatAttachment & { dataUrl: string }>>(
            "chat_attachments_hydrate",
            {
              sessionId: saved.session_id,
              attachments: attachmentRefs,
            },
          ).catch((error) => {
            if (!isCancelled()) {
              setNotice(`Some saved image previews could not be restored: ${String(error)}`);
            }
            return [];
          })
        : [];
    if (isCancelled()) return null;
    if (hydrated.length < attachmentRefs.length) {
      setNotice("Some saved image previews are unavailable; their history references were preserved.");
    }
    return withHydratedAttachments(saved.messages, hydrated);
  };

  useEffect(() => {
    // A cold launch intentionally begins with a new blank session. If the user
    // merely navigated away from Chat and back, restore the active session by
    // its exact ID instead of whichever historical chat happens to be newest.
    if (!initialSession.restore || requestedSession) return;
    let cancelled = false;
    invoke<PersistedChatSession | null>("chat_session_get", {
      sessionId: initialSession.sessionId,
    })
      .then(async (saved) => {
        if (cancelled || !saved) return;
        const restored = await hydrateSavedMessages(saved, () => cancelled);
        if (!restored || cancelled) return;
        setMessages(restored);
      })
      .catch((error) => {
        if (!cancelled) setNotice(`Current chat could not be restored: ${String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setSessionHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionHydrated || streaming || messages.length === 0) return;
    const timer = window.setTimeout(() => {
      invoke("chat_session_save", {
        sessionId,
        messages: persistableChatMessages(messages),
      })
        .then(() => onHistoryChanged?.())
        .catch(() => {
          setNotice("This chat could not be saved for restart; the current turn is unaffected.");
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [messages, onHistoryChanged, sessionHydrated, sessionId, streaming]);

  useEffect(() => {
    onSessionChange?.(sessionId);
  }, [onSessionChange, sessionId]);

  useEffect(() => {
    onStreamingChange?.(streaming);
  }, [onStreamingChange, streaming]);

  useEffect(
    () => () => {
      onStreamingChange?.(false);
    },
    [onStreamingChange],
  );

  useEffect(() => {
    setIntroThinking(true);
    const timer = window.setTimeout(() => setIntroThinking(false), 1850);
    return () => window.clearTimeout(timer);
  }, [personaCycle]);

  useEffect(() => {
    let cancelled = false;
    const refreshSidekickEvents = () => {
      invoke<SidekickEvent[]>("sidekick_events", { limit: 12 })
        .then((events) => {
          if (cancelled) return;
          const next = events.filter((event) => event.session_id === sessionId);
          setSidekickEvents((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
        })
        .catch(() => {
          if (!cancelled) setSidekickEvents((current) => current.length === 0 ? current : []);
        });
    };
    refreshSidekickEvents();
    const timer = window.setInterval(refreshSidekickEvents, streaming ? 1200 : 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, streaming]);

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === selectedModel) ?? choices[0] ?? CLOUD_MODEL,
    [choices, selectedModel],
  );

  const retryEnvironmentArchitect = () => {
    environmentArchitectAttempted.current = null;
    setEnvironmentArchitect(null);
    setEnvironmentArchitectProgress(null);
    setEnvironmentArchitectDraft("");
    environmentArchitectDraftRef.current = "";
    setEnvironmentArchitectError(null);
    setEnvironmentArchitectRetry((attempt) => attempt + 1);
  };

  // ----- Decision-card flow ("20 questions"): one card at a time. ---------
  // The flow model (training-flow.mjs) is the serializable contract; ChatPane
  // only maps existing state into card readiness and answers.

  useEffect(() => {
    // A reopened thread resumes its persisted flow verbatim instead of
    // starting a fresh one; decision-derived drafts rehydrate from the
    // recorded decisions so the resumed cards say what was decided.
    const restored = restoredFlowRef.current;
    if (restored && (trainingRecipe || csvInspection)) {
      restoredFlowRef.current = null;
      setTrainingFlow(restored);
      const target = restored.cards.find((card) => card.kind === "prediction_target")?.decision;
      const details = target?.details;
      const targetDetails = details && typeof details === "object" && !Array.isArray(details)
        ? details as Record<string, unknown>
        : null;
      const targetColumn = typeof targetDetails?.target_column === "string"
        ? targetDetails.target_column
        : null;
      const targetGoal = typeof targetDetails?.target_goal === "string"
        ? targetDetails.target_goal
        : null;
      setGoalDraft(targetGoal);
      setStructuredTargetChoice(trainingRecipe ? targetColumn : null);
      setMinAccuracyDraft(
        typeof targetDetails?.minimum_accuracy === "number" ? targetDetails.minimum_accuracy : null,
      );
      setCalibrationVerdicts([]);
      if (csvInspection && targetColumn) {
        setMappingLabelColumn(targetColumn);
        setMappingInputColumns(csvInspection.columns
          .filter((column) => column.name !== targetColumn && column.non_empty_count > 0)
          .map((column) => column.name));
      }
      if (
        !threadReadOnly
        && restored.cards.some((card) => card.kind === "data_profile" && card.decision)
      ) {
        setDatasetProfileConfirmed(true);
      }
      return;
    }
    if (trainingRecipe) {
      setTrainingFlow(createTrainingFlow(trainingRecipe.ready
        ? ["data_profile", "prediction_target", "plan", "consent", "run"]
        : ["data_profile", "prediction_target", "plan", "compile_gates", "consent", "run"]));
    } else if (csvInspection) {
      setTrainingFlow(createTrainingFlow(["data_profile", "prediction_target", "plan", "backend", "run"]));
    } else {
      setTrainingFlow(null);
    }
    setGoalDraft(null);
    setStructuredTargetChoice(null);
    setMinAccuracyDraft(null);
    setCalibrationVerdicts([]);
  }, [trainingRecipe, csvInspection]);

  // Persist the thread on every flow change (each answered card, each
  // invalidation) — debounced like the chat transcript save.
  useEffect(() => {
    if (!trainingThreadId || !droppedWorkload || !trainingFlow || threadReadOnly) return;
    const timer = window.setTimeout(() => {
      void persistTrainingThread(trainingThreadId, droppedWorkload, trainingFlow, trainingThreadStatus);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [trainingThreadId, droppedWorkload, trainingFlow, trainingThreadStatus, threadReadOnly]);

  // Run terminal: the training panel reports inactive after having been
  // active. Record the run decision on the flow and complete the thread —
  // the persisted timeline becomes the audit trail.
  useEffect(() => {
    if (localTrainingActive) {
      wasTrainingActive.current = true;
      return;
    }
    if (!wasTrainingActive.current || threadReadOnly) return;
    wasTrainingActive.current = false;
    if (!trainingThreadId) return;
    setTrainingFlow((flow) => {
      if (!flow || activeFlowCard(flow)?.kind !== "run") return flow;
      return answerFlowCardModel(flow, "run", {
        question: "Did the training run finish?",
        answer: "yes",
      });
    });
    setTrainingThreadStatus("completed");
  }, [localTrainingActive, threadReadOnly, trainingThreadId]);

  useEffect(() => {
    onTrainingThreadChange?.(trainingThreadId);
  }, [onTrainingThreadChange, trainingThreadId]);

  // Background work keeps running eagerly; this only surfaces readiness on
  // the upcoming steps of the rail.
  useEffect(() => {
    setTrainingFlow((flow) => {
      if (!flow) return flow;
      const has = (id: string) => flow.cards.some((card) => card.id === id);
      let next = flow;
      if (has("prediction_target")) {
        if (environmentArchitect) next = markCardReady(next, "prediction_target");
        else if (environmentArchitectProgress) next = markCardLoading(next, "prediction_target");
      }
      if (has("plan")) next = markCardReady(next, "plan");
      if (has("compile_gates")) {
        if (customCompileResult) next = markCardReady(next, "compile_gates");
        else if (customCompileBusy) next = markCardLoading(next, "compile_gates");
      }
      if (has("consent")) {
        if (remoteRecipePlan && remoteRecipePlan.maximum_spend_usd > 0) next = markCardReady(next, "consent");
        else if (remoteRecipePlan) next = markCardLoading(next, "consent");
      }
      if (has("backend") && classificationDataset) next = markCardReady(next, "backend");
      return next;
    });
  }, [environmentArchitect, environmentArchitectProgress, customCompileResult, customCompileBusy, remoteRecipePlan, classificationDataset]);

  const answerTrainingFlowCard = (
    id: string,
    answer: TrainingFlowAnswer,
    question: string,
    details?: TrainingFlowDecisionDetails,
  ) => {
    if (!trainingFlow || threadReadOnly) return;
    const active = activeFlowCard(trainingFlow);
    if (!active || active.id !== id) return;
    if (invalidatesLaterAnswers(trainingFlow, id, answer)) {
      if (!window.confirm("Changing this answer resets the steps after it. Continue?")) return;
      setClassificationDataset(null);
      setCsvBackend(null);
    }
    setTrainingFlow(answerFlowCardModel(trainingFlow, id, { question, answer, details }));
  };

  const navigateTrainingFlowTo = (id: string) => {
    if (!trainingFlow || threadReadOnly) return;
    if (localTrainingActive || remoteTrainingView) {
      setNotice("Training is running; earlier decisions are locked for this run.");
      return;
    }
    const card = trainingFlow.cards.find((existing) => existing.id === id);
    if (card?.status !== "answered") return;
    setTrainingFlow(navigateToAnswered(trainingFlow, id));
  };

  // Approval happens inside the training panels (their own consent buttons);
  // when a run actually starts, record the consent answer and move focus to
  // the run card.
  useEffect(() => {
    if (!localTrainingActive && !remoteTrainingView) return;
    setTrainingFlow((flow) => {
      if (!flow || activeFlowCard(flow)?.kind !== "consent") return flow;
      return answerFlowCardModel(flow, "consent", {
        question: "Approve this upload and spend?",
        answer: "yes",
      });
    });
  }, [localTrainingActive, remoteTrainingView]);

  // CSV flow: the plan's "yes" kicks off local split preparation; the answer
  // lands when the splits exist. If the preparer excluded rows (conflicted
  // leakage groups or unusable rows), a calibration review card slots in
  // right after the plan; otherwise the backend question takes focus.
  useEffect(() => {
    if (!classificationDataset) return;
    const excludedRows = (classificationDataset.conflicted_group_rows_removed ?? 0)
      + (classificationDataset.unusable_rows_removed ?? 0);
    setCalibrationVerdicts([]);
    setTrainingFlow((flow) => {
      if (!flow || activeFlowCard(flow)?.kind !== "plan") return flow;
      let next = flow;
      if (excludedRows > 0) next = insertCard(next, "calibration");
      next = answerFlowCardModel(next, "plan", {
        question: "Is this the plan you want?",
        answer: "yes",
      });
      // A re-prepared dataset (e.g. new target) may have nothing to review
      // even though an earlier prepare inserted the card — skip it cleanly.
      if (excludedRows === 0 && activeFlowCard(next)?.kind === "calibration") {
        next = answerFlowCardModel(next, "calibration", {
          question: "Review the rows excluded during preparation?",
          answer: { choice: "confirm" },
          details: { excluded_rows: 0, note: "No rows were excluded this time." },
        });
      }
      return next;
    });
  }, [classificationDataset]);

  useEffect(() => {
    if (!csvBackend) return;
    setTrainingFlow((flow) => {
      if (!flow || activeFlowCard(flow)?.kind !== "backend") return flow;
      return answerFlowCardModel(flow, "backend", {
        question: "Where should this train?",
        answer: csvBackend === "managed" ? "cloud" : "local",
      });
    });
  }, [csvBackend]);

  useEffect(() => {
    const evidence = trainingRecipe
      ? {
          sourceSha256: trainingRecipe.source_sha256,
          detectedUseCase: trainingRecipe.detected_use_case,
          taskKind: trainingRecipe.task_kind,
          evaluator: trainingRecipe.evaluator,
          totalRows: trainingRecipe.evidence.total_rows,
          sourceFormat: trainingRecipe.source_format,
          artifactKind: trainingRecipe.artifact_kind,
          fieldNames: trainingRecipe.field_names,
        }
      : csvInspection
        ? {
            sourceSha256: csvInspection.source_sha256,
            detectedUseCase: csvInspection.recommended_mapping.label_column ? "classification" : "tabular_analysis",
            taskKind: csvInspection.recommended_mapping.label_column ? "text_classification" : "tabular_dataset",
            evaluator: csvInspection.recommended_mapping.label_column ? "exact_label" : null,
            totalRows: csvInspection.row_count,
            sourceFormat: droppedWorkload?.source_name.includes(".")
              ? droppedWorkload.source_name.split(".").pop()?.toLowerCase() ?? "delimited_text"
              : "delimited_text",
            artifactKind: "dataset",
            fieldNames: csvInspection.columns.map((column) => column.name),
          }
        : null;
    const routeReady = selectedChoice.route === "cloud"
      ? gatewaySignedIn === true
      : selectedChoice.route === "local"
        ? selectedChoice.active && selectedChoice.slotId != null
        : selectedChoice.active;
    const analysisModel = selectedChoice.route === "cloud"
      ? "glm-5.2"
      : selectedChoice.route === "anthropic"
        ? selectedChoice.id.replace(/^anthropic:/, "")
        : selectedChoice.modelId;
    const attemptKey = evidence ? `${evidence.sourceSha256}:${selectedChoice.id}:${environmentArchitectRetry}` : null;
    if (
      !droppedWorkload
      || !evidence
      || !datasetProfileConfirmed
      || environmentArchitect
      || !attemptKey
      || environmentArchitectAttempted.current === attemptKey
      || !routeReady
    ) return;
    environmentArchitectAttempted.current = attemptKey;
    setEnvironmentArchitectError(null);
    const channel = new Channel<PiDatasetAnalysisEvent>();
    channel.onmessage = (event) => {
      if (environmentArchitectAttempted.current !== attemptKey) return;
      if (event.type === "phase") {
        setEnvironmentArchitectProgress(event);
        return;
      }
      environmentArchitectDraftRef.current += event.text;
      if (environmentArchitectDraftFrame.current === null) {
        environmentArchitectDraftFrame.current = window.requestAnimationFrame(() => {
          environmentArchitectDraftFrame.current = null;
          setEnvironmentArchitectDraft(environmentArchitectDraftRef.current);
        });
      }
    };
    setEnvironmentArchitectProgress({
      type: "phase",
      phase: "profiling",
      current: 0,
      total: 4,
      message: "Starting Understudy dataset analysis",
    });
    void invoke<PiEnvironmentArchitectResult>("propose_training_environment_with_pi", {
      sourcePath: droppedWorkload.source_path,
      artifactRoot: droppedWorkload.artifact_root,
      expectedSourceSha256: evidence.sourceSha256,
      route: selectedChoice.route,
      model: analysisModel,
      slotId: selectedChoice.slotId,
      detectedUseCase: evidence.detectedUseCase,
      taskKind: evidence.taskKind,
      evaluator: evidence.evaluator,
      totalRows: evidence.totalRows,
      sourceFormat: evidence.sourceFormat,
      artifactKind: evidence.artifactKind,
      fieldNames: evidence.fieldNames,
      onEvent: channel,
    })
      .then((result) => {
        if (environmentArchitectAttempted.current === attemptKey) {
          setEnvironmentArchitect(result);
          setEnvironmentArchitectProgress(null);
          setEnvironmentArchitectDraft(environmentArchitectDraftRef.current);
          setEnvironmentArchitectError(null);
        }
      })
      .catch((cause) => {
        if (environmentArchitectAttempted.current === attemptKey) {
          setEnvironmentArchitectError(piDatasetAnalysisFailure(cause));
        }
      });
  }, [csvInspection, datasetProfileConfirmed, droppedWorkload, environmentArchitect, environmentArchitectRetry, gatewaySignedIn, selectedChoice, trainingRecipe]);

  const runActiveTaskModel = async (clean: string, files: FileUIPart[]) => {
    if (activeTaskModel) {
      if (!clean || files.length > 0) {
        setErr(`${activeTaskModel.name} accepts text only.`);
        return;
      }
      let installed: ActiveTaskModel | undefined;
      try {
        const models = await invoke<ActiveTaskModel[]>("list_task_models");
        installed = models.find((model) => model.id === activeTaskModel.id && model.version === activeTaskModel.version);
      } catch (cause) {
        setErr(`Could not check ${activeTaskModel.name}. ${String(cause)}`);
        return;
      }
      if (!installed) {
        setActiveTaskModel(null);
        window.localStorage.removeItem(ACTIVE_TASK_MODEL_KEY);
        setErr(`${activeTaskModel.name} is no longer installed. Drop the model file here to install it again.`);
        return;
      }
      if (!installed.base_ready) {
        setActiveTaskModel(installed);
        setNotice(`${activeTaskModel.name} is absorbed. Its base model is still downloading.`);
        return;
      }
      setActiveTaskModel(installed);
      setInput("");
      const toSend: Msg[] = [
        ...messages,
        { role: "user", content: clean, model: installed.name },
      ];
      setAnimatedMessageId(`${sessionId}:message:${messages.length}`);
      setMessages([...toSend, { role: "assistant", content: "", model: installed.name }]);
      setStreaming(true);
      setAssistantSpeaking(false);
      try {
        const [result] = await invoke<TaskModelPrediction[]>("run_task_model", {
          request: {
            model_id: installed.id,
            version: installed.version,
            rows: [{ task_id: `${sessionId}:${messages.length}`, text: clean }],
          },
        });
        if (!result) throw new Error("The classifier returned no prediction.");
        const top = result.top_k.slice(0, 3);
        const detail = top.map((choice, index) =>
          `${index + 1}. ${choice.l3} — ${(choice.probability * 100).toFixed(1)}%`
        ).join("\n");
        setMessages([...toSend, {
          role: "assistant",
          model: installed.name,
          content: `**${result.prediction.l3}**\n\n${detail}\n\nRan locally in ${result.elapsed_ms} ms.`,
        }]);
      } catch (error) {
        setErr(String(error));
        setMessages(toSend);
      } finally {
        setStreaming(false);
        setAssistantSpeaking(false);
      }
    }
  };

  const send = async (text: string, files: FileUIPart[] = []) => {
    const clean = text.trim();
    if ((!clean && files.length === 0) || streaming) return;
    setErr(null);
    setNotice(null);

    if (activeTaskModel) {
      await runActiveTaskModel(clean, files);
      return;
    }

    const choice = selectedChoice;
    if (choice.route === "cloud") {
      const signedIn = gatewaySignedIn ?? Boolean(
        (await invoke<{ signed_in?: boolean }>("account_status").catch(() => ({ signed_in: false }))).signed_in,
      );
      setGatewaySignedIn(signedIn);
      if (!signedIn) {
        setNotice("Sign in to use GLM 5.2, or choose the private local model after it finishes downloading.");
        onNeedsSignIn?.();
        return;
      }
    }
    if (choice.route === "local" && choice.slotId == null) {
      setErr("No local model is warm. Open Serving, warm a local model slot, then send again.");
      return;
    }
    if (choice.route === "local" && !choice.active) {
      setErr("The selected local model is still loading. Try again in a moment.");
      return;
    }
    setInput("");

    let attachments: ChatAttachment[] = [];
    if (files.length > 0) {
      const uploads: ChatAttachmentUpload[] = files.map((file) => ({
        filename: file.filename || "image",
        mediaType: file.mediaType || "",
        dataUrl: file.url,
      }));
      try {
        const stored = await invoke<Array<Omit<ChatAttachment, "previewUrl">>>(
          "chat_attachments_store",
          { sessionId, attachments: uploads },
        );
        attachments = stored.map((attachment, index) => ({
          ...attachment,
          previewUrl: files[index]?.url,
        }));
      } catch (error) {
        setErr(`Could not attach image: ${String(error)}`);
        throw error;
      }
    }

    const toSend: Msg[] = [
      ...messages,
      { role: "user", content: clean, model: choice.label, attachments },
    ];
    setAnimatedMessageId(`${sessionId}:message:${messages.length}`);
    const turnPacer = startStreamPacer(toSend.length);
    setMessages([...toSend, { role: "assistant", content: "", reasoning: "", model: choice.label }]);
    setStreaming(true);
    setAssistantSpeaking(false);

    const ch = new Channel<ChatEvent>();
    ch.onmessage = (msg) => {
      if (msg.type === "Notice") {
        setNotice(msg.message);
      } else if (msg.type === "Chunk") {
        setAssistantSpeaking(true);
        turnPacer?.append(msg.text);
        if (streamBatcher.current) streamBatcher.current.appendContent(msg.text);
        else applyAssistantPatch({ replaceContent: null, appendContent: msg.text, appendReasoning: "" });
      } else if (msg.type === "ReplaceChunk") {
        setAssistantSpeaking(true);
        turnPacer?.replace(msg.text);
        if (streamBatcher.current) streamBatcher.current.replaceContent(msg.text);
        else applyAssistantPatch({ replaceContent: msg.text, appendContent: "", appendReasoning: "" });
      } else if (msg.type === "ReasoningChunk") {
        if (streamBatcher.current) streamBatcher.current.appendReasoning(msg.text);
        else applyAssistantPatch({ replaceContent: null, appendContent: "", appendReasoning: msg.text });
      } else if (msg.type === "ToolCall") {
        streamBatcher.current?.flush();
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          p[last] = {
            ...p[last],
            tools: [
              ...(p[last].tools ?? []),
              { name: msg.name, state: "input-available", input: msg.args },
            ],
          };
          return p;
        });
      } else if (msg.type === "ToolResult") {
        streamBatcher.current?.flush();
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const p = [...prev];
          const last = p.length - 1;
          const tools = [...(p[last].tools ?? [])];
          const idx = tools.findLastIndex((tool) => tool.name === msg.name && tool.state === "input-available");
          const next = {
            name: msg.name,
            state: msg.ok ? "output-available" : "output-error",
            input: idx >= 0 ? tools[idx].input : undefined,
            output: msg.ok ? msg.result : undefined,
            errorText: msg.ok ? undefined : JSON.stringify(msg.result),
          } satisfies ToolTrace;
          if (idx >= 0) tools[idx] = next;
          else tools.push(next);
          p[last] = { ...p[last], tools };
          return p;
        });
      } else if (msg.type === "SidekickEvent") {
        if (msg.mode === "supervision" && msg.stage === "cloud_fallback_local") {
          setNotice(CLOUD_SUPERVISOR_FALLBACK_NOTICE);
        } else if (msg.mode === "supervision" && msg.stage === "supervisor_fallback_local") {
          setNotice(LOCAL_SUPERVISOR_FALLBACK_NOTICE);
        }
        setSidekickEvents((prev) => [
          {
            id: Date.now(),
            session_id: sessionId,
            mode: msg.mode,
            stage: msg.stage,
            detail: msg.detail,
            created_at: new Date().toISOString(),
          },
          ...prev.filter((event) => event.session_id === sessionId),
        ].slice(0, 12));
      } else if (msg.type === "Error") {
        streamBatcher.current?.flush();
        turnPacer?.skip();
        setErr(msg.message);
        setStreaming(false);
        setAssistantSpeaking(false);
      } else if (msg.type === "Done") {
        streamBatcher.current?.flush();
        turnPacer?.finish();
        setStreaming(false);
        setAssistantSpeaking(false);
      }
    };

    try {
      await invoke("chat_stream", {
        messages: toSend.map(({ role, content, attachments: messageAttachments }) => ({
          role,
          content,
          attachments: messageAttachments ?? [],
        })),
        // Anthropic choices encode the model in the id (anthropic:<model>).
        route: choice.route === "anthropic" ? choice.id : choice.route,
        slotId: choice.slotId,
        sessionId,
        onEvent: ch,
      });
    } catch (e: unknown) {
      streamBatcher.current?.flush();
      turnPacer?.skip();
      setErr(String(e));
      setStreaming(false);
      setAssistantSpeaking(false);
    }
  };
  sendRef.current = (text: string) => send(text);

  const connectAnthropic = async () => {
    const key = window.prompt(
      "Anthropic API key (stored locally in the app database, never uploaded):",
    );
    if (!key?.trim()) return;
    try {
      await invoke("anthropic_key_set", { key: key.trim() });
      await refreshModels();
    } catch (e: unknown) {
      setErr(String(e));
    }
  };

  const restartChat = () => {
    if (streaming) return;
    resetStreamPacer();
    if (messages.length > 0) {
      void invoke("chat_session_save", {
        sessionId,
        messages: persistableChatMessages(messages),
      })
        .then(() => onHistoryChanged?.())
        .catch(() => {
          // The debounced save normally ran already. Starting a new chat should
          // remain available if this final best-effort flush fails.
        });
    }
    const nextSessionId = crypto.randomUUID();
    setAnimatedMessageId(null);
    setMessages([]);
    setInput("");
    setErr(null);
    setNotice(null);
    setSessionId(nextSessionId);
    setSessionHydrated(true);
    setAssistantSpeaking(false);
    resetDroppedWorkload();
    setPersonaReady(false);
    setIntroThinking(true);
    setPersonaCycle((value) => value + 1);
  };

  useEffect(() => {
    if (!observedResetToken.current) {
      observedResetToken.current = true;
      return;
    }
    restartChat();
  }, [resetToken]);

  const restoreHistorySession = async (historySessionId: string) => {
    if (streaming) {
      setNotice("Finish or stop the current turn before opening another chat.");
      return;
    }
    setErr(null);
    setNotice(null);
    try {
      if (messages.length > 0) {
        await invoke("chat_session_save", {
          sessionId,
          messages: persistableChatMessages(messages),
        }).catch(() => {
          setNotice("The current chat could not be saved before switching.");
        });
      }
      const saved = await invoke<PersistedChatSession | null>("chat_session_get", {
        sessionId: historySessionId,
      });
      if (!saved) {
        setNotice("That saved chat is no longer available.");
        return;
      }
      const restored = await hydrateSavedMessages(saved);
      if (!restored) return;
      resetStreamPacer();
      setAnimatedMessageId(null);
      setSessionId(saved.session_id);
      setMessages(restored);
      setSessionHydrated(true);
      setInput("");
      setAssistantSpeaking(false);
      resetDroppedWorkload();
      setPersonaCycle((value) => value + 1);
      onHistoryChanged?.();
    } catch (error) {
      setNotice(`Saved chat could not be opened: ${String(error)}`);
    } finally {
      // A missing or damaged saved session must not permanently disable
      // persistence for whatever conversation the user starts next.
      setSessionHydrated(true);
    }
  };

  useEffect(() => {
    if (!requestedSession || observedSessionRequest.current === requestedSession.requestId) return;
    observedSessionRequest.current = requestedSession.requestId;
    void restoreHistorySession(requestedSession.sessionId);
  }, [requestedSession]);

  /**
   * Reopen a persisted training thread. Completed/dismissed threads render
   * their full timeline read-only (the audit trail); an active thread
   * resumes exactly at the flow's active card. Card bodies come from the
   * workload artifacts at artifact_root — when those have moved or vanished
   * we say so inline instead of re-running the pipeline.
   */
  const openTrainingThread = async (threadId: string) => {
    if (streaming) {
      setNotice("Finish or stop the current turn before opening a training thread.");
      return;
    }
    setErr(null);
    setNotice(null);
    try {
      const thread = await invoke<{
        thread_id: string;
        title: string;
        artifact_root: string;
        artifact_root_present: boolean;
        workload: DroppedWorkload | null;
        flow: TrainingFlow | null;
        status: TrainingThreadStatus;
      } | null>("training_thread_get", { threadId });
      if (!thread || !thread.workload) {
        setNotice("That training thread is no longer available.");
        return;
      }
      let flow: TrainingFlow | null = null;
      if (thread.flow) {
        try {
          flow = deserializeTrainingFlow(JSON.stringify(thread.flow));
        } catch (error) {
          setNotice(`This thread's saved decisions could not be read: ${String(error)}`);
        }
      }
      resetStreamPacer();
      resetDroppedWorkload();
      const readOnly = thread.status !== "active";
      setTrainingThreadId(thread.thread_id);
      setTrainingThreadStatus(thread.status);
      setThreadReadOnly(readOnly);
      setDroppedWorkload(thread.workload);
      if (!readOnly) wasTrainingActive.current = false;
      if (!thread.artifact_root_present) {
        // Honest resume: the receipts live at artifact_root. Without them we
        // show the decision timeline from the saved flow and an inline notice
        // rather than pretending the card bodies still exist.
        setThreadArtifactMissing(thread.artifact_root);
        if (flow) setTrainingFlow(flow);
        return;
      }
      restoredFlowRef.current = flow;
      const requestGeneration = dropRequestGeneration.current + 1;
      dropRequestGeneration.current = requestGeneration;
      const inspectTable = shouldInspectDroppedTable(thread.workload);
      const inspectStructured = shouldInspectStructuredDataset(thread.workload);
      if (inspectStructured || inspectTable) {
        dispatchDrop({ type: "drop_received" });
        dispatchDrop({ type: "inspection_started" });
        try {
          if (inspectStructured) {
            try {
              await inspectTrainingRecipe(thread.workload, requestGeneration);
            } catch (error) {
              if (!inspectTable) throw error;
              await inspectCsvWorkload(thread.workload, requestGeneration);
            }
          } else {
            await inspectCsvWorkload(thread.workload, requestGeneration);
          }
        } catch (error) {
          restoredFlowRef.current = null;
          dispatchDrop({ type: "failed" });
          setErr(`This thread's workload could not be re-read: ${String(error)}`);
          if (flow) setTrainingFlow(flow);
        }
      } else {
        restoredFlowRef.current = null;
        dispatchDrop({ type: "drop_received" });
        dispatchDrop({ type: "succeeded" });
        if (flow) setTrainingFlow(flow);
      }
    } catch (error) {
      setNotice(`Training thread could not be opened: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (!requestedThread || observedThreadRequest.current === requestedThread.requestId) return;
    observedThreadRequest.current = requestedThread.requestId;
    void openTrainingThread(requestedThread.threadId);
  }, [requestedThread]);

  // Resuming a CSV thread past its plan decision: the group-isolated splits
  // are derived state, rebuilt once from the artifacts so the backend and
  // calibration cards are answerable again.
  useEffect(() => {
    if (
      !trainingThreadId
      || threadReadOnly
      || !trainingFlow
      || !csvInspection
      || classificationDataset
      || dropRunning
      || resumePrepareAttempted.current === trainingThreadId
    ) return;
    const planAnswered = trainingFlow.cards.some(
      (card) => card.kind === "plan" && card.status === "answered",
    );
    if (!planAnswered || !mappingLabelColumn || !mappingGroupColumn || mappingInputColumns.length === 0) return;
    resumePrepareAttempted.current = trainingThreadId;
    prepareDroppedClassification();
  }, [trainingThreadId, threadReadOnly, trainingFlow, csvInspection, classificationDataset, dropRunning, mappingLabelColumn, mappingGroupColumn, mappingInputColumns]);

  const setThinking = async (thinking: boolean) => {
    if (selectedChoice.route !== "local") return;
    setErr(null);
    setThinkingPending({ slotId: selectedChoice.slotId, thinking });
    setChoices((current) =>
      current.map((choice) =>
        choice.route === "local" && choice.slotId === selectedChoice.slotId
          ? { ...choice, thinking, loading: true, active: false, detail: choice.detail.replace(/ · loading$/, "") + " · loading" }
          : choice,
      ),
    );
    try {
      await invoke("set_slot_thinking", { slotId: selectedChoice.slotId, thinking });
      await refreshModels();
    } catch (e: unknown) {
      setErr(String(e));
      setThinkingPending(null);
    }
  };

  const personaLoading =
    selectedChoice.route === "local" &&
    (selectedChoice.loading || thinkingPending?.slotId === selectedChoice.slotId);

  const dropPersonaState = workloadDropPersonaState(dropPhase) as PersonaState | null;
  const personaState: PersonaState = dropPersonaState ?? (localTrainingActive
    ? "thinking"
    : droppedWorkload && !classificationDataset
    ? "listening"
    : personaLoading
    ? "thinking"
    : introThinking && messages.length === 0 && !input.trim()
    ? "thinking"
    : streaming
    ? assistantSpeaking
      ? "speaking"
      : "thinking"
    : input.trim()
      ? "listening"
      : "idle");
  const personaColor = dropPhase === "failed"
    ? PERSONA_ERROR
    : dropHovering || dropRunning || localTrainingActive || classificationDataset
      ? PERSONA_CYAN
      : activeTaskModel
        ? PERSONA_TASK
      : PERSONA_WHITE;
  const selectedTargetColumn = csvInspection?.columns.find((column) => column.name === mappingLabelColumn) ?? null;
  // Empty targets are dropped by prepare-classification and reported as
  // unusable_rows_removed; they only block when so widespread the mapping
  // itself is suspect.
  const selectedTargetEmptyShare = selectedTargetColumn && csvInspection!.row_count > 0
    ? selectedTargetColumn.empty_count / csvInspection!.row_count
    : 0;
  const selectedTargetBlockReason = !mappingLabelColumn || !selectedTargetColumn
    ? null
    : selectedTargetColumn.unique_count < 2
      ? "Choose a target with at least two repeated categories."
      : selectedTargetEmptyShare > 0.1
        ? `${selectedTargetColumn.empty_count} of ${csvInspection!.row_count} row(s) have no target value; this column looks unlabeled.`
        : selectedTargetColumn.unique_count === selectedTargetColumn.non_empty_count && csvInspection!.row_count >= 5
          ? "Every target value is unique; choose a reusable category rather than an identifier."
          : selectedTargetColumn.unique_ratio > 0.5
            ? "More than half of the target values are unique; choose a more reusable category."
            : null;
  const selectedTargetDropNotice = !selectedTargetBlockReason
    && selectedTargetColumn
    && selectedTargetColumn.empty_count > 0
    ? `${selectedTargetColumn.empty_count} row(s) without a target value will be dropped before training.`
    : null;
  const trainingPlanBlocked =
    !csvInspection ||
    !mappingLabelColumn ||
    !mappingGroupColumn ||
    mappingInputColumns.length === 0 ||
    mappingLabelColumn === mappingGroupColumn ||
    Boolean(selectedTargetBlockReason) ||
    csvInspection.training_readiness.status === "needs_data" ||
    csvInspection.training_readiness.status === "needs_cleanup";
  const latestSupervisorEvent = sidekickEvents.find(
    (event) => event.mode === "supervision",
  );
  const supervisionVisible =
    Boolean(latestSupervisorEvent) &&
    (streaming ||
      latestSupervisorEvent?.stage === "interrupt" ||
      latestSupervisorEvent?.stage === "nudge" ||
      latestSupervisorEvent?.stage === "stop" ||
      latestSupervisorEvent?.stage === "cloud_fallback_local" ||
      latestSupervisorEvent?.stage === "supervisor_fallback_local" ||
      latestSupervisorEvent?.stage === "student_interrupted" ||
      latestSupervisorEvent?.stage === "teacher_continuation");
  const transcriptRows = useMemo(
    () => messages.map((message, index) => ({
      id: `${sessionId}:message:${index}`,
      index,
      message,
    })),
    [messages, sessionId],
  );
  const turnAnchors = useMemo(
    () => transcriptRows
      .filter((row) => row.message.role === "user")
      .map((row, index) => ({
        id: row.id,
        label: row.message.content.replace(/\s+/g, " ").trim() || `Turn ${index + 1}`,
      })),
    [transcriptRows],
  );

  const datasetFocusMode = Boolean(
    trainingRecipe && droppedWorkload && !dropRunning,
  );

  const focusFlowKind: TrainingFlowCardKind | null =
    (trainingFlow ? activeFlowCard(trainingFlow)?.kind : null) ?? null;
  const structuredTargetField = trainingRecipe?.field_names.find(
    (field) => structuredFieldRole(field) === "target",
  );
  const structuredPredicting = trainingRecipe
    ? predictionStatement(
        trainingRecipe,
        structuredTargetChoice ?? structuredTargetField,
        goalDraft ?? environmentArchitect?.target_goal ?? null,
      )
    : null;
  const architectDraftTarget = streamedJsonString(environmentArchitectDraft, "target_goal");
  // Acceptable error: the plan's promotion gate, human-phrased and editable
  // within sane bounds. Plan preparation does not accept this input yet — the
  // edit is recorded on the card decision (see the decision details).
  const effectiveMinAccuracy = Math.min(
    0.99,
    Math.max(0.5, minAccuracyDraft ?? trainingGoalCard?.promotion.minimum_accuracy ?? 0.8),
  );
  // Disputed examples for the calibration card, sourced from what IS exposed
  // client-side: the inspection's row preview. The manifest only reports
  // counts (conflicted_group_rows_removed / unusable_rows_removed); row-level
  // conflicted examples are not exported by prepare yet, so this sample can
  // be empty even when the counts are not.
  const calibrationSamples = useMemo(() => {
    if (!csvInspection || !mappingLabelColumn || !mappingGroupColumn) return [];
    const byGroup = new Map<string, Map<string, Record<string, string>>>();
    for (const row of csvInspection.row_preview ?? []) {
      const group = (row.values[mappingGroupColumn] ?? "").trim().toLowerCase();
      const label = (row.values[mappingLabelColumn] ?? "").trim();
      if (!group || !label) continue;
      const labels = byGroup.get(group) ?? new Map<string, Record<string, string>>();
      if (!labels.has(label)) labels.set(label, row.values);
      byGroup.set(group, labels);
    }
    const samples: Array<{ group: string; label: string; text: string }> = [];
    for (const [group, labels] of byGroup) {
      if (labels.size < 2) continue;
      for (const [label, values] of labels) {
        const text = mappingInputColumns
          .map((column) => values[column])
          .filter((value) => value && value.trim())
          .join(" · ");
        samples.push({ group, label, text });
        if (samples.length >= 5) return samples;
      }
    }
    return samples;
  }, [csvInspection, mappingLabelColumn, mappingGroupColumn, mappingInputColumns]);
  const flowSummaries = useMemo(() => {
    const rows = trainingRecipe?.evidence.total_rows ?? csvInspection?.row_count ?? null;
    const targetField = trainingRecipe
      ? structuredTargetChoice
        ?? trainingRecipe.field_names.find((field) => structuredFieldRole(field) === "target")
      : mappingLabelColumn || null;
    const chosenBackend = trainingRecipe
      ? recipeBackend
      : csvBackend ?? "managed";
    return {
      data_profile: rows != null ? `Data confirmed · ${rows.toLocaleString()} rows` : "Data confirmed",
      prediction_target: targetField ? `Target · ${targetField}` : "Target confirmed",
      plan: `Plan approved · ${chosenBackend === "managed" ? "cloud" : "local"}`,
      calibration: classificationDataset
        ? `Excluded rows reviewed · ${((classificationDataset.conflicted_group_rows_removed ?? 0) + (classificationDataset.unusable_rows_removed ?? 0)).toLocaleString()}`
        : "Excluded rows reviewed",
      compile_gates: "Gates passed",
      backend: csvBackend === "managed" ? "Cloud training" : "Local training",
      consent: "Upload and spend approved",
      run: "Training running",
    } as Record<string, string>;
  }, [trainingRecipe, csvInspection, mappingLabelColumn, recipeBackend, csvBackend, structuredTargetChoice, classificationDataset]);

  // Condensed committed bodies for answered timeline cards. Display-only —
  // the timeline renders them inert; kinds whose active surface is a live,
  // effectful panel (consent, run, backend) stay summary-only.
  const renderCommittedStructuredCard = (card: TrainingFlowCard) => {
    if (!trainingRecipe || !droppedWorkload) return null;
    switch (card.kind) {
      case "data_profile":
        return <StructuredDataProfile sourceName={droppedWorkload.source_name} inspection={trainingRecipe} />;
      case "prediction_target":
        return (
          <PiDesignCards
            architect={environmentArchitect}
            progress={environmentArchitectProgress}
            draft={environmentArchitectDraft}
          />
        );
      case "plan":
        return (
          <StructuredTrainingPlan
            inspection={trainingRecipe}
            card={trainingGoalCard}
            targetGoal={goalDraft?.trim() || environmentArchitect?.target_goal || null}
            backend={recipeBackend}
            localAvailable={recipeLocalAvailable}
            onBackendChange={() => {}}
          />
        );
      case "compile_gates":
        return (
          <CustomTrainingCompileCard
            phases={customCompilePhases}
            busy={false}
            result={customCompileResult}
            error={customCompileError}
            onRetry={() => {}}
            waitingForMapping={false}
            onCompile={null}
          />
        );
      default:
        return null;
    }
  };
  const renderCommittedCsvCard = (card: TrainingFlowCard) => {
    if (!csvInspection || !droppedWorkload) return null;
    switch (card.kind) {
      case "data_profile":
        return (
          <CsvProfile
            sourceName={droppedWorkload.source_name}
            rowCount={csvInspection.row_count}
            columns={csvInspection.columns}
            highlightedColumn={mappingLabelColumn}
            onSelectColumn={() => {}}
          />
        );
      case "prediction_target":
        return (
          <div className="csv-analysis-proposal">
            <strong>{mappingLabelColumn ? `Predict ${mappingLabelColumn}` : "Target confirmed"}</strong>
          </div>
        );
      case "plan":
        return (
          <CsvTrainingPlan
            rowCount={csvInspection.row_count}
            labelCount={selectedTargetColumn?.unique_count ?? null}
            inputColumns={mappingInputColumns}
            labelColumn={mappingLabelColumn}
            groupColumn={mappingGroupColumn}
          />
        );
      case "calibration":
        return classificationDataset ? (
          <p className="csv-analysis-note">
            {((classificationDataset.conflicted_group_rows_removed ?? 0)
              + (classificationDataset.unusable_rows_removed ?? 0)).toLocaleString()} excluded
            row(s) reviewed — they stay out of training and evaluation.
          </p>
        ) : null;
      default:
        return null;
    }
  };

  // Focus mode: the dataset-review card is the whole surface. Expand the
  // window when the card needs more room; never shrink it.
  useEffect(() => {
    if (!datasetFocusMode || !isTauri()) return;
    // Measure the ACTIVE card region, not the whole timeline: answered
    // chapters scroll within the timeline; only the live question drives
    // window growth (capped as before, never shrinking).
    const card = document.querySelector(".training-flow-timeline-active")
      ?? document.querySelector(".structured-dataset-profile-page")
      ?? document.querySelector(".workload-analysis");
    if (!card) return;
    let lastRequested = 0;
    const grow = () => {
      const needed = Math.ceil(card.getBoundingClientRect().height) + 96;
      if (needed <= window.innerHeight || needed <= lastRequested) return;
      lastRequested = needed;
      void getCurrentWindow()
        .setSize(new LogicalSize(window.innerWidth, Math.min(needed, window.screen.availHeight - 24)))
        .catch((error) => console.warn("focus-mode window grow failed:", error));
    };
    grow();
    const observer = new ResizeObserver(grow);
    observer.observe(card);
    return () => observer.disconnect();
  }, [datasetFocusMode, trainingRecipe, datasetProfileConfirmed, focusFlowKind]);

  return (
    <div
      className={
        "chat ai-chat" +
        (messages.length > 0 ? " has-messages" : "") +
        (dropRunning || droppedWorkload ? " has-workload" : "") +
        (activeTaskModel ? " task-model-active" : "") +
        (dropPhase === "preparing_dataset" || classificationDataset || localTrainingActive || remoteTrainingView ? " is-training-flow" : "") +
        (streaming ? " is-streaming" : "") +
        (datasetFocusMode ? " dataset-focus-mode" : "")
      }
    >
      <div
        className={
          "persona-stage" +
          (personaReady ? " persona-ready" : "") +
          (dropHovering || dropRunning ? " workload-drop-active" : "") +
          ` workload-drop-${dropPhase}`
        }
        aria-busy={dropRunning || localTrainingActive || undefined}
      >
        <img
          key={`stamp-${personaCycle}`}
          className="persona-stamp"
          src="/brand/usl-stamp-bald-white-transparent.png"
          alt=""
          draggable={false}
        />
        {trainingHaloVisual ? (
          <TrainingHalo
            visual={trainingHaloVisual}
            onReady={() => setPersonaReady(true)}
          />
        ) : (
          <Persona
            key={personaCycle}
            variant="halo"
            state={personaState}
            color={personaColor}
            className={
              "persona-halo" +
              (streaming && latestSupervisorEvent ? " supervised" : "")
            }
            onReady={() => setPersonaReady(true)}
          />
        )}
        {dropStatus && (
          <div className="workload-drop-status" role="status" aria-live="polite">
            <strong>{dropStatus.title}</strong>
            <span>{dropStatus.detail}</span>
          </div>
        )}
        {activeTaskModel && !dropStatus && (
          <button
            type="button"
            className="active-task-model-badge"
            onClick={() => setClassifierLibraryOpen(true)}
            title="Open trained models"
          >
            <span />
            <strong>{activeTaskModel.name}</strong>
            <small>{activeTaskModel.base_ready ? "absorbed" : "absorbing…"}</small>
          </button>
        )}
      </div>
      {activeTaskModel && (
        <section className={"active-task-dropzone" + (dropHovering ? " is-hovering" : "")} aria-label="Test the active classifier">
          <div>
            <strong>Drop test data to score</strong>
            <span>CSV or JSONL · expected labels optional · review stays local</span>
          </div>
          {taskModelFileRun && (
            <button type="button" onClick={() => void revealItemInDir(taskModelFileRun.output_path)}>
              {taskModelFileRun.accuracy == null
                ? `${taskModelFileRun.rows.toLocaleString()} predictions`
                : `${(taskModelFileRun.accuracy * 100).toFixed(1)}% matched`}
              <small>Open review CSV</small>
            </button>
          )}
        </section>
      )}
      <MessageScrollerProvider
        key={`${sessionId}:${classificationDataset ? "training" : droppedWorkload ? "workload" : "chat"}`}
        autoScroll={!droppedWorkload}
        defaultScrollPosition="last-anchor"
        scrollEdgeThreshold={24}
        scrollMargin={droppedWorkload ? 24 : 0}
        scrollPreviousItemPeek={56}
      >
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-5 px-4 pb-12 pt-0">
          {messages.length > 0 &&
            transcriptRows.map(({ id: messageId, index: i, message: m }) => {
              const isLastAssistant = m.role === "assistant" && i === messages.length - 1;
              const isActiveAssistant = isLastAssistant && streaming;
              const isPacedAssistant = m.role === "assistant" && i === pacingMessageIndex && pacedRevealed !== null;
              const shownContent = isPacedAssistant ? m.content.slice(0, pacedRevealed) : m.content;
              const pacedBacklog = isPacedAssistant ? Math.max(0, m.content.length - pacedRevealed) : 0;
              const reasoningText = cleanReasoningText(m.reasoning ?? "");
              return (
                <MessageScrollerItem
                  key={messageId}
                  messageId={messageId}
                  scrollAnchor={m.role === "user"}
                  className={messageId === animatedMessageId ? "chat-message-enter" : undefined}
                  onAnimationEnd={() => {
                    if (messageId === animatedMessageId) setAnimatedMessageId(null);
                  }}
                >
                  <Message
                    from={m.role}
                    className={`chat-msg ${m.role} ${m.role === "user" ? "max-w-[80%]" : "max-w-[92%]"}`}
                  >
                    <div className="chat-role">{m.role === "assistant" ? m.model ?? "Assistant" : "You"}</div>
                    <MessageContent>
                      {m.role === "user" && m.attachments && m.attachments.length > 0 && (
                        <div className="chat-image-list">
                          {m.attachments.map((attachment) => (
                            <figure className="chat-image" key={attachment.id}>
                              {attachment.previewUrl ? (
                                <img src={attachment.previewUrl} alt={attachment.filename} />
                              ) : (
                                <div className="chat-image-unavailable">Preview unavailable</div>
                              )}
                              <figcaption>{attachment.filename}</figcaption>
                            </figure>
                          ))}
                        </div>
                      )}
                      {m.role === "assistant" && reasoningText && (
                        <ReasoningSubstream active={isActiveAssistant} text={reasoningText} />
                      )}
                      {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                        <div className="tool-trace-list">
                          {m.tools.map((tool, idx) => (
                            <ChatToolTrace key={`${tool.name}-${idx}`} tool={tool} />
                          ))}
                        </div>
                      )}
                      {m.role === "assistant" ? (
                        <div className="paced-answer">
                          <MessageResponse>{shownContent || (isActiveAssistant ? "..." : "")}</MessageResponse>
                          {pacedBacklog > SKIP_HINT_THRESHOLD && (
                            <button
                              type="button"
                              className="paced-answer-skip"
                              onClick={() => streamPacer.current?.skip()}
                            >
                              Show full answer
                            </button>
                          )}
                        </div>
                      ) : (
                        m.content
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })
          }
          {supervisionVisible && latestSupervisorEvent && (
            <MessageScrollerItem messageId={`${sessionId}:supervisor:${latestSupervisorEvent.id}`}>
              <div className="sidekick-active-card chat-sidekick-monitor">
                <div className="sidekick-orbit" aria-hidden="true" />
                <div className="sidekick-active-copy">
                  <div className="sidekick-active-kicker">Supervisor</div>
                  <div className="sidekick-active-title">
                    {latestSupervisorEvent.stage === "cloud_fallback_local"
                        ? "Cloud supervisor unavailable"
                      : latestSupervisorEvent.stage === "supervisor_fallback_local"
                        ? "Supervisor unavailable"
                      : latestSupervisorEvent.stage === "student_interrupted"
                        ? "Student interrupted"
                      : latestSupervisorEvent.stage === "teacher_continuation"
                        ? "Teacher continuing"
                      : latestSupervisorEvent.stage === "interrupt"
                        ? "Intervention requested"
                      : latestSupervisorEvent.stage === "nudge"
                        ? "Student nudged"
                      : latestSupervisorEvent.stage === "stop"
                        ? "Turn stopped"
                        : "Checking the smaller model"}
                  </div>
                  <div className="sidekick-active-task">{latestSupervisorEvent.detail}</div>
                </div>
              </div>
            </MessageScrollerItem>
          )}
          {(dropRunning || droppedWorkload) && (
            <MessageScrollerItem
              messageId={`${sessionId}:workload`}
              scrollAnchor
              className="workload-scroller-item"
            >
              <section
                className={`workload-analysis${classificationDataset ? " has-local-training" : ""}${remoteTrainingView ? " has-remote-training" : ""}`}
              >
              {(!droppedWorkload || (dropRunning && (!csvInspection || dropPhase === "preparing_dataset"))) ? (
                <DatasetAnalysisLoadingTemplate
                  message={dropPhase === "validating"
                    ? "Checking this file locally…"
                    : dropPhase === "inspecting"
                      ? "Reading its shape and columns…"
                      : dropPhase === "preparing_dataset"
                        ? "Creating group-isolated train, dev, and holdout splits…"
                        : "Understanding this file…"}
                />
              ) : threadArtifactMissing && droppedWorkload ? (
                <>
                  <div className="workload-generic-summary">
                    <strong title={threadArtifactMissing}>{droppedWorkload.source_name}</strong>
                    <small>
                      This thread&apos;s workload artifacts are no longer at{" "}
                      <code>{threadArtifactMissing}</code> — the decisions below are the saved
                      record, but their card bodies can&apos;t be re-rendered. Drop the data
                      again to start a new thread.
                    </small>
                  </div>
                  {trainingFlow && (
                    <TrainingFlowTimeline
                      flow={trainingFlow}
                      onNavigate={navigateTrainingFlowTo}
                    >
                      <ThreadReadOnlyNote status={trainingThreadStatus} />
                    </TrainingFlowTimeline>
                  )}
                  <button
                    type="button"
                    className="btn ghost workload-generic-dismiss"
                    onClick={resetDroppedWorkload}
                  >
                    Close
                  </button>
                </>
              ) : trainingRecipe && droppedWorkload && trainingFlow ? (
                <>
                  <TrainingFlowTimeline
                    flow={trainingFlow}
                    summaries={flowSummaries}
                    onNavigate={navigateTrainingFlowTo}
                    renderCommitted={renderCommittedStructuredCard}
                  >
                  {threadReadOnly ? (
                    <ThreadReadOnlyNote status={trainingThreadStatus} />
                  ) : focusFlowKind === "data_profile" ? (
                    <StructuredDatasetProfilePage
                      sourceName={droppedWorkload.source_name}
                      inspection={trainingRecipe}
                      card={trainingGoalCard}
                      ready={Boolean(trainingRecipe.row_preview.length > 0)}
                      onConfirm={() => {
                        setDatasetProfileConfirmed(true);
                        answerTrainingFlowCard(
                          "data_profile",
                          "yes",
                          "Does this look like the data you meant to train on?",
                        );
                      }}
                      onClose={dismissWorkloadThread}
                    />
                  ) : focusFlowKind === "prediction_target" ? (
                    <section
                      className="automatic-goal-card structured-dataset-analysis"
                      aria-label="Confirm the prediction target"
                    >
                      <div className="csv-analysis-step-label">2 · Understudy analysis</div>
                      <div className="csv-analysis-pi">
                        <AnalysisHeading
                          inspection={trainingRecipe}
                          card={trainingGoalCard}
                          architect={environmentArchitect}
                          architectProgress={environmentArchitectProgress}
                          architectError={environmentArchitectError}
                        />
                        <PiAnalysisRail
                          architect={environmentArchitect}
                          progress={environmentArchitectProgress}
                          error={environmentArchitectError}
                        />
                        <PiDesignCards
                          architect={environmentArchitect}
                          progress={environmentArchitectProgress}
                          draft={environmentArchitectDraft}
                          error={environmentArchitectError}
                          onRetry={retryEnvironmentArchitect}
                        />
                      </div>
                      <label className="training-flow-goal-edit">
                        <span>Goal — edit until it says what you actually want</span>
                        <textarea
                          value={goalDraft
                            ?? environmentArchitect?.target_goal
                            ?? structuredPredicting
                            ?? ""}
                          placeholder="Understudy is still inferring the goal…"
                          onChange={(event) => setGoalDraft(event.target.value)}
                        />
                      </label>
                      <label className="csv-analysis-group-choice">
                        <span>Target column</span>
                        <select
                          value={structuredTargetChoice ?? structuredTargetField ?? ""}
                          onChange={(event) => setStructuredTargetChoice(event.target.value)}
                        >
                          {trainingRecipe.field_names.map((field) => (
                            <option key={field} value={field}>{field}</option>
                          ))}
                        </select>
                      </label>
                      {structuredTargetChoice && structuredTargetChoice !== structuredTargetField && (
                        <p className="csv-analysis-note" role="status">
                          Recorded on this decision — recipe datasets don&apos;t re-derive their
                          fields yet, so the plan below still trains on {structuredTargetField}.
                        </p>
                      )}
                      <AcceptableErrorLine
                        minimumAccuracy={effectiveMinAccuracy}
                        onChange={setMinAccuracyDraft}
                      />
                      <FlowQuestion
                        question={structuredPredicting
                          ? `${structuredPredicting.replace(/\.$/, "")} — is that right?`
                          : "Is this the target you want the model to predict?"}
                        hint={environmentArchitect || architectDraftTarget
                          ? "Edit the goal or threshold above, then confirm to move on to the training plan."
                          : "Preparing the target… Understudy is still analyzing this dataset."}
                        yesLabel={environmentArchitect || architectDraftTarget
                          ? "Yes, that's the goal"
                          : "Preparing the target…"}
                        yesDisabled={!environmentArchitect && !architectDraftTarget}
                        onYes={() => answerTrainingFlowCard(
                          "prediction_target",
                          // The (possibly edited) goal IS the answer: changing
                          // it and confirming invalidates later steps.
                          goalDraft?.trim()
                            || environmentArchitect?.target_goal
                            || structuredPredicting
                            || "yes",
                          "What should the model learn to do?",
                          {
                            target_goal: goalDraft?.trim()
                              || environmentArchitect?.target_goal
                              || structuredPredicting
                              || null,
                            target_column: structuredTargetChoice ?? structuredTargetField ?? null,
                            target_column_applied: !structuredTargetChoice
                              || structuredTargetChoice === structuredTargetField,
                            minimum_accuracy: effectiveMinAccuracy,
                            // Plan preparation hardcodes 0.80 server-side; the
                            // edited gate is recorded here until it can flow in.
                            minimum_accuracy_applied: false,
                          },
                        )}
                        noLabel="No — dismiss"
                        onNo={dismissWorkloadThread}
                      />
                    </section>
                  ) : focusFlowKind === "plan" ? (
                    <section
                      className="automatic-goal-card structured-dataset-analysis"
                      aria-label="Confirm the training plan"
                    >
                      <div className="csv-analysis-step-label">3 · confirm the training plan</div>
                      <StructuredTrainingPlan
                        inspection={trainingRecipe}
                        card={trainingGoalCard}
                        targetGoal={goalDraft?.trim() || environmentArchitect?.target_goal || null}
                        backend={recipeBackend}
                        localAvailable={recipeLocalAvailable}
                        onBackendChange={setRecipeBackend}
                      />
                      <FlowQuestion
                        question="Is this the plan you want?"
                        hint="Switch Cloud or Local above before answering."
                        yesLabel="Yes, use this plan"
                        onYes={() => answerTrainingFlowCard(
                          "plan",
                          recipeBackend === "managed" ? "cloud" : "local",
                          "Is this the plan you want?",
                        )}
                        noLabel="No — change target"
                        onNo={() => navigateTrainingFlowTo("prediction_target")}
                      />
                    </section>
                  ) : focusFlowKind === "compile_gates" ? (
                    <section
                      className="automatic-goal-card structured-dataset-analysis"
                      aria-label="Compile gates"
                    >
                      <div className="csv-analysis-step-label">4 · compile gates</div>
                      <div className="csv-analysis-next">
                          {csvInspection && !customCompileBusy && !customCompileResult && (
                            <div className="custom-compile-mapping flex flex-wrap gap-3">
                              <label className="csv-analysis-group-choice">
                                <span>Target column</span>
                                <select
                                  value={mappingLabelColumn}
                                  onChange={(event) => {
                                    const label = event.target.value;
                                    setMappingLabelColumn(label);
                                    setMappingInputColumns(csvInspection.columns
                                      .filter((column) => column.name !== label && column.non_empty_count > 0)
                                      .map((column) => column.name));
                                  }}
                                >
                                  <option value="">Choose what to predict</option>
                                  {csvInspection.columns.map((column) => (
                                    <option key={column.name} value={column.name}>{column.name}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="csv-analysis-group-choice">
                                <span>Reference column</span>
                                <select
                                  value={mappingGroupColumn}
                                  onChange={(event) => setMappingGroupColumn(event.target.value)}
                                >
                                  <option value="">Keeps related rows in one split</option>
                                  {csvInspection.columns
                                    .filter((column) => column.name !== mappingLabelColumn && column.non_empty_count > 0)
                                    .map((column) => (
                                      <option key={column.name} value={column.name}>{column.name}</option>
                                    ))}
                                </select>
                              </label>
                            </div>
                          )}
                          <CustomTrainingCompileCard
                            phases={customCompilePhases}
                            busy={customCompileBusy}
                            result={customCompileResult}
                            error={customCompileError}
                            onRetry={compileCustomTrainingPlan}
                            waitingForMapping={Boolean(csvInspection && (
                              !mappingLabelColumn
                              || !mappingGroupColumn
                              || mappingInputColumns.length === 0
                              || mappingLabelColumn === mappingGroupColumn
                            ))}
                            onCompile={csvInspection ? compileCustomTrainingPlan : null}
                          />
                      </div>
                      <FlowQuestion
                        question="Did the compile gates pass?"
                        hint={customCompileResult?.environment_status === "executable"
                          ? "The plan compiled into an executable local environment."
                          : customCompileError
                            ? "Retry the compile above, or dismiss this dataset."
                            : "Compiling locally — no upload or spend has started."}
                        yesLabel={customCompileResult?.environment_status === "executable"
                          ? "Yes, continue to approval"
                          : "Waiting for the gates…"}
                        yesDisabled={customCompileResult?.environment_status !== "executable"}
                        onYes={() => answerTrainingFlowCard("compile_gates", "yes", "Did the compile gates pass?")}
                        noLabel="No — dismiss"
                        onNo={dismissWorkloadThread}
                      />
                    </section>
                  ) : (
                    <div className="csv-analysis-next">
                      {(trainingRecipe.ready || customCompileResult?.environment_status === "executable") && remoteRecipePlan ? <>
                        {recipeLocalAvailable && (
                          <div hidden={recipeBackend === "managed"}>
                            <LocalSftTrainingPanel
                              plan={remoteRecipePlan}
                              modelName={`${trainingUseCaseLabel(trainingRecipe.detected_use_case)} model`}
                              onTrainRemote={openManagedRecipeTraining}
                              onActiveChange={setLocalTrainingActive}
                              onVisualChange={setTrainingHaloVisual}
                            />
                          </div>
                        )}
                        {!recipeLocalAvailable && recipeBackend === "local" && (
                          <button type="button" className="btn primary" onClick={openManagedRecipeTraining}>
                            Try cloud
                          </button>
                        )}
                        {recipeBackend === "managed" && remoteRecipeEligibilityError && (
                          <div className="remote-training-state failed" role="alert">
                            <strong>Cloud training is not ready for this dataset</strong>
                            <small>{remoteRecipeEligibilityError}</small>
                          </div>
                        )}
                        {recipeBackend === "managed" && !remoteRecipeEligibilityError && remoteRecipePlan.maximum_spend_usd <= 0 && (
                          <div className="remote-training-state" role="status" aria-live="polite" aria-busy="true">
                            <strong>Checking cloud capacity</strong>
                            <small>Matching split sizes and a cost-efficient model before you approve an upload.</small>
                          </div>
                        )}
                        {recipeBackend === "managed" && !remoteRecipeEligibilityError && remoteRecipePlan.maximum_spend_usd > 0 && (
                          <RemoteTrainingPanel
                            preparedPlan={remoteRecipePlan}
                            modelName={`${trainingUseCaseLabel(trainingRecipe.detected_use_case)} model`}
                            onBack={recipeLocalAvailable ? () => setRecipeBackend("local") : undefined}
                            onActiveChange={setLocalTrainingActive}
                            onRunViewChange={setRemoteTrainingView}
                            onVisualChange={setTrainingHaloVisual}
                            trainingExamples={trainingRecipe.row_preview}
                          />
                        )}
                      </> : (
                        <div className="remote-training-state" role="status" aria-live="polite">
                          <strong>{environmentArchitectProgress ? "Understudy is checking the training plan" : `Preparing ${trainingUseCaseLabel(trainingRecipe.detected_use_case)}`}</strong>
                          <small>{(environmentArchitectProgress?.type === "phase"
                            ? environmentArchitectProgress.message
                            : environmentArchitectProgress?.text)
                            ?? "Profiling and splitting locally. No upload or spend has started."}</small>
                        </div>
                      )}
                    </div>
                  )}
                  </TrainingFlowTimeline>
                  <TrainingFlowStepper
                    flow={trainingFlow}
                    summaries={flowSummaries}
                    onNavigate={navigateTrainingFlowTo}
                  />
                  {!localTrainingActive && !remoteTrainingView && focusFlowKind !== "data_profile" && (
                    <button
                      type="button"
                      className="btn ghost workload-generic-dismiss"
                      onClick={dismissWorkloadThread}
                    >
                      {threadReadOnly ? "Close" : "Dismiss"}
                    </button>
                  )}
                </>
              ) : csvInspection && droppedWorkload && trainingFlow ? (
                <>
                  <TrainingFlowTimeline
                    flow={trainingFlow}
                    summaries={flowSummaries}
                    onNavigate={navigateTrainingFlowTo}
                    renderCommitted={renderCommittedCsvCard}
                  >
                  {threadReadOnly ? (
                    <ThreadReadOnlyNote status={trainingThreadStatus} />
                  ) : focusFlowKind === "data_profile" ? (
                    <>
                      <div className="csv-analysis-step-label csv-analysis-step-structure">1 · data structure</div>
                      <CsvProfile
                        sourceName={droppedWorkload.source_name}
                        rowCount={csvInspection.row_count}
                        columns={csvInspection.columns}
                        highlightedColumn={mappingLabelColumn}
                        onSelectColumn={(label) => {
                          const recommendedGroup = csvInspection.recommended_mapping.group_column;
                          const fallbackGroup = csvInspection.columns.find((column) =>
                            column.name !== label && column.profile_kind === "text")?.name ?? "";
                          setMappingLabelColumn(label);
                          setMappingInputColumns(csvInspection.columns
                            .filter((column) => column.name !== label && column.non_empty_count > 0)
                            .map((column) => column.name));
                          if (!mappingGroupColumn || mappingGroupColumn === label) {
                            setMappingGroupColumn(
                              recommendedGroup && recommendedGroup !== label ? recommendedGroup : fallbackGroup,
                            );
                          }
                          setClassificationDataset(null);
                        }}
                      />
                      <TableExampleCards
                        rows={csvInspection.row_preview ?? []}
                        inputColumns={mappingInputColumns}
                        labelColumn={mappingLabelColumn}
                      />
                      <FlowQuestion
                        question="Does this look like the data you meant to train on?"
                        hint="Confirming starts Understudy analysis and builds the training plan."
                        yesLabel="Yes, analyze this dataset"
                        onYes={() => {
                          setDatasetProfileConfirmed(true);
                          answerTrainingFlowCard(
                            "data_profile",
                            "yes",
                            "Does this look like the data you meant to train on?",
                          );
                        }}
                        noLabel="No — dismiss"
                        onNo={dismissWorkloadThread}
                      />
                    </>
                  ) : focusFlowKind === "prediction_target" ? (
                    <>
                      <div className="csv-analysis-step-label">2 · Understudy analysis</div>
                      <div className="csv-analysis-pi">
                        <PiAnalysisRail
                          architect={environmentArchitect}
                          progress={environmentArchitectProgress}
                          error={environmentArchitectError}
                        />
                        <PiDesignCards
                          architect={environmentArchitect}
                          progress={environmentArchitectProgress}
                          draft={environmentArchitectDraft}
                          error={environmentArchitectError}
                          onRetry={retryEnvironmentArchitect}
                        />
                      </div>
                      <div className="csv-analysis-next">
                      <div className="csv-analysis-proposal">
                        <strong>{mappingLabelColumn ? `Predict ${mappingLabelColumn}` : "Choose what to predict"}</strong>
                      </div>
                      <label className="csv-analysis-group-choice">
                        <span>Target column</span>
                        <select
                          value={mappingLabelColumn}
                          onChange={(event) => {
                            const label = event.target.value;
                            setMappingLabelColumn(label);
                            setMappingInputColumns(csvInspection.columns
                              .filter((column) => column.name !== label && column.non_empty_count > 0)
                              .map((column) => column.name));
                            setClassificationDataset(null);
                          }}
                        >
                          <option value="">Choose what to predict</option>
                          {csvInspection.columns.map((column) => (
                            <option key={column.name} value={column.name}>{column.name}</option>
                          ))}
                        </select>
                      </label>
                      {selectedTargetBlockReason ? (
                        <p className="csv-analysis-caution" role="status">
                          {selectedTargetBlockReason}
                        </p>
                      ) : selectedTargetDropNotice ? (
                        <p className="csv-analysis-note" role="status">
                          {selectedTargetDropNotice}
                        </p>
                      ) : (
                        csvInspection.training_readiness.status === "needs_data" ||
                        csvInspection.training_readiness.status === "needs_cleanup"
                      ) && csvInspection.training_readiness.reasons[0] ? (
                        <p className="csv-analysis-caution" role="status">
                          {csvInspection.training_readiness.reasons[0]}
                        </p>
                      ) : null}
                      {mappingLabelColumn && !mappingGroupColumn && (
                        <label className="csv-analysis-group-choice">
                          <span>Choose a reference column</span>
                          <select
                            value={mappingGroupColumn}
                            onChange={(event) => {
                              setMappingGroupColumn(event.target.value);
                              setClassificationDataset(null);
                            }}
                          >
                            <option value="">Keeps related rows in one split</option>
                            {csvInspection.columns
                              .filter((column) => column.name !== mappingLabelColumn && column.non_empty_count > 0)
                              .map((column) => (
                                <option key={column.name} value={column.name}>{column.name}</option>
                              ))}
                          </select>
                        </label>
                      )}
                      <AcceptableErrorLine
                        minimumAccuracy={effectiveMinAccuracy}
                        onChange={setMinAccuracyDraft}
                      />
                      </div>
                      <FlowQuestion
                        question={mappingLabelColumn
                          ? `Predict ${mappingLabelColumn} from ${mappingInputColumns.length.toLocaleString()} input column${mappingInputColumns.length === 1 ? "" : "s"} — is that right?`
                          : "What should the model predict?"}
                        hint="Change the target or reference column above before answering."
                        yesLabel="Yes, that's the target"
                        yesDisabled={trainingPlanBlocked}
                        onYes={() => answerTrainingFlowCard(
                          "prediction_target",
                          mappingLabelColumn,
                          `Predict ${mappingLabelColumn} — is that right?`,
                          {
                            target_column: mappingLabelColumn,
                            minimum_accuracy: effectiveMinAccuracy,
                            // Split preparation doesn't take a promotion gate;
                            // recorded here until it can flow into prepare.
                            minimum_accuracy_applied: false,
                          },
                        )}
                        noLabel="No — dismiss"
                        onNo={dismissWorkloadThread}
                      />
                    </>
                  ) : focusFlowKind === "plan" ? (
                    <>
                      <div className="csv-analysis-step-label">3 · confirm the training plan</div>
                      <div className="csv-analysis-next">
                      <CsvTrainingPlan
                        rowCount={csvInspection.row_count}
                        labelCount={selectedTargetColumn?.unique_count ?? null}
                        inputColumns={mappingInputColumns}
                        labelColumn={mappingLabelColumn}
                        groupColumn={mappingGroupColumn}
                      />
                      </div>
                      <FlowQuestion
                        question="Is this the plan you want?"
                        hint="Yes creates group-isolated train, dev, and holdout splits locally — no upload or spend."
                        yesLabel={mappingLabelColumn ? `Yes — train for ${mappingLabelColumn}` : "Choose a target first"}
                        yesDisabled={trainingPlanBlocked || dropRunning}
                        onYes={prepareDroppedClassification}
                        noLabel="No — change target"
                        onNo={() => navigateTrainingFlowTo("prediction_target")}
                      />
                    </>
                  ) : focusFlowKind === "calibration" && classificationDataset ? (
                    <CalibrationReviewCard
                      dataset={classificationDataset}
                      samples={calibrationSamples}
                      verdicts={calibrationVerdicts}
                      onVerdict={(verdict) => setCalibrationVerdicts((existing) => [...existing, verdict])}
                      onConfirm={(question, details) =>
                        answerTrainingFlowCard("calibration", { choice: "confirm" }, question, details)}
                      onChangeTarget={() => navigateTrainingFlowTo("prediction_target")}
                    />
                  ) : classificationDataset ? (
                    <div className={`workload-dataset-ready${localTrainingActive ? " is-active" : ""}`}>
                      {csvBackend === null ? (
                        <div className="remote-training-state" role="group" aria-label="Choose where to train">
                          <strong>Where should this train?</strong>
                          <small>
                            {classificationDataset.row_count.toLocaleString()} rows, {classificationDataset.mapping.label_column} —
                            local is free on this Mac; cloud is faster for large datasets and needs upload + spend approval.
                          </small>
                          {csvCloudError && (
                            <p className="csv-analysis-caution" role="alert">{csvCloudError}</p>
                          )}
                          <div className="csv-analysis-actions">
                            <button
                              type="button"
                              className={`btn ${classificationDataset.row_count < 5000 ? "primary" : "secondary"}`}
                              onClick={() => setCsvBackend("local")}
                            >
                              Train locally (ModernBERT)
                            </button>
                            <button
                              type="button"
                              className={`btn ${classificationDataset.row_count < 5000 ? "secondary" : "primary"}`}
                              onClick={() => void chooseCsvCloudTraining()}
                            >
                              Train in cloud (Understudy auto)
                            </button>
                          </div>
                        </div>
                      ) : csvBackend === "local" ? (
                        <LocalTrainingPanel
                          datasetManifestPath={classificationDataset.manifest_path}
                          modelName={trainedModelName(
                            droppedWorkload.source_name,
                            classificationDataset.mapping.label_column,
                          )}
                          autoStart
                          onActiveChange={setLocalTrainingActive}
                          onVisualChange={setTrainingHaloVisual}
                        />
                      ) : csvCloudCapabilities ? (
                        <RemoteTrainingPanel
                          datasetManifestPath={classificationDataset.manifest_path}
                          capabilities={csvCloudCapabilities}
                          onTrainLocal={() => setCsvBackend("local")}
                          modelName={trainedModelName(
                            droppedWorkload.source_name,
                            classificationDataset.mapping.label_column,
                          )}
                          onActiveChange={setLocalTrainingActive}
                          onRunViewChange={setRemoteTrainingView}
                          onVisualChange={setTrainingHaloVisual}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  </TrainingFlowTimeline>
                  <TrainingFlowStepper
                    flow={trainingFlow}
                    summaries={flowSummaries}
                    onNavigate={navigateTrainingFlowTo}
                  />
                </>
              ) : droppedWorkload ? (
                <>
                  <div className="workload-generic-summary">
                    <strong title={droppedWorkload.source_path}>{droppedWorkload.source_name}</strong>
                    <small>
                      {droppedWorkload.source_count} source{droppedWorkload.source_count === 1 ? "" : "s"} · {compactBytes(droppedWorkload.total_bytes)} · contents unread
                    </small>
                  </div>
                  <button
                    type="button"
                    className="btn ghost workload-generic-dismiss"
                    onClick={dismissWorkloadThread}
                  >
                    {threadReadOnly ? "Close" : "Dismiss"}
                  </button>
                </>
              ) : null}
              </section>
            </MessageScrollerItem>
          )}
          {err && (
            <MessageScrollerItem messageId={`${sessionId}:error`}>
              <div className="chat-err">{err}</div>
            </MessageScrollerItem>
          )}
          {notice && !err && (
            <MessageScrollerItem messageId={`${sessionId}:notice`}>
              <div className="chat-runtime-notice">{notice}</div>
            </MessageScrollerItem>
          )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <ChatScrollControls anchors={turnAnchors} streaming={streaming} />
        </MessageScroller>
      </MessageScrollerProvider>

      {(
        <div className="ai-chat-composer">
          <PromptInput
            accept="image/*"
            multiple
            maxFiles={4}
            maxFileSize={8 * 1024 * 1024}
            onError={(error) => setErr(error.message)}
            onSubmit={(message) => send(message.text, message.files)}
            className="border-rule bg-card"
          >
            <div className="composer-row">
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Add image" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments label="Add image" />
                  <PromptInputActionMenuItem onSelect={() => setClassifierLibraryOpen(true)}>
                    <LibraryBigIcon aria-hidden="true" />
                    Trained models
                  </PromptInputActionMenuItem>
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <ModelPicker
                choices={choices}
                selected={selectedChoice}
                activeTaskModel={activeTaskModel}
                onSelect={(id) => {
                  setActiveTaskModel(null);
                  window.localStorage.removeItem(ACTIVE_TASK_MODEL_KEY);
                  selectedModelUserOwned.current = true;
                  setSelectedModel(id);
                }}
                onConnectAnthropic={connectAnthropic}
                thinkingDisabled={streaming}
                thinkingLoading={
                  selectedChoice.route === "local" && thinkingPending?.slotId === selectedChoice.slotId
                }
                onThinkingToggle={setThinking}
              />
              {!activeTaskModel && <ModelCardDrawer
                modelId={selectedChoice.route === "local" ? selectedChoice.modelId : selectedChoice.id}
                label={selectedChoice.label}
                route={selectedChoice.route}
                runtime={{
                  slotId: selectedChoice.route === "local" ? selectedChoice.slotId : undefined,
                  active: selectedChoice.active,
                  loading: selectedChoice.route === "local" ? selectedChoice.loading : false,
                  thinking: selectedChoice.route === "local" ? selectedChoice.thinking : false,
                }}
              />}
              <PromptInputBody className="composer-row-body">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={activeTaskModel ? `Classify with ${activeTaskModel.name}…` : "Ask Understudy..."}
                  disabled={streaming}
                />
              </PromptInputBody>
              <PromptInputSubmit
                className="composer-submit"
                status={streaming ? "streaming" : err ? "error" : "ready"}
                onStop={stopStreaming}
                disabled={!streaming && (!input.trim() || (selectedChoice.route === "local" && !selectedChoice.active))}
              />
            </div>
          </PromptInput>
        </div>
      )}
      <LocalClassifierLibraryDialog open={classifierLibraryOpen} onOpenChange={setClassifierLibraryOpen} />
    </div>
  );
}

/**
 * Footer for a reopened, no-longer-editable training thread: the timeline
 * above it is the audit trail — every yes, the receipts, the outcome.
 */
function ThreadReadOnlyNote({ status }: { status: TrainingThreadStatus }) {
  return (
    <div className="workload-generic-summary training-thread-readonly" role="note">
      <strong>{status === "completed" ? "Completed training thread" : "Dismissed training thread"}</strong>
      <small>
        {status === "completed"
          ? "This run finished; the decisions above are the saved record. Drop new data to start another thread."
          : "This thread was dismissed before training; its decisions are kept for reference. Drop new data to start another thread."}
      </small>
    </div>
  );
}

function ModelPicker({
  choices,
  selected,
  activeTaskModel,
  onSelect,
  onConnectAnthropic,
  thinkingDisabled,
  thinkingLoading,
  onThinkingToggle,
}: {
  choices: ModelChoice[];
  selected: ModelChoice;
  activeTaskModel: ActiveTaskModel | null;
  onSelect: (id: string) => void;
  onConnectAnthropic: () => void;
  thinkingDisabled: boolean;
  thinkingLoading: boolean;
  onThinkingToggle: (thinking: boolean) => void;
}) {
  const anthropicChoices = choices.filter((choice) => choice.route === "anthropic");
  const thinkingBusy = selected.route === "local" && (selected.loading || thinkingLoading);
  return (
    <ModelSelector>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          className="ai-model-trigger"
          title={activeTaskModel ? `${activeTaskModel.name} · task model` : `${selected.label} · ${selected.route}`}
        >
          <span>{activeTaskModel?.name ?? selected.label}</span>
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {activeTaskModel && (
            <ModelSelectorGroup heading="Active task model">
              <ModelSelectorItem value={`task:${activeTaskModel.id}@${activeTaskModel.version}`}>
                <ModelSelectorName>{activeTaskModel.name}</ModelSelectorName>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {activeTaskModel.base_ready ? "Runs locally" : "Downloading base model"}
                </span>
              </ModelSelectorItem>
            </ModelSelectorGroup>
          )}
          <ModelSelectorGroup heading="Serving">
            {choices
              .filter((choice) => choice.route === "local")
              .map((choice) => (
                <ModelSelectorItem key={choice.id} value={choice.id} onSelect={() => onSelect(choice.id)}>
                  <ModelSelectorName>{choice.label}</ModelSelectorName>
                  <span className="max-w-[520px] truncate font-mono text-[11px] text-muted-foreground">{choice.detail}</span>
                </ModelSelectorItem>
              ))}
          </ModelSelectorGroup>
          <ModelSelectorGroup heading="Fallback">
            {choices
              .filter((choice) => choice.route === "cloud")
              .map((choice) => (
                <ModelSelectorItem key={choice.id} value={choice.id} onSelect={() => onSelect(choice.id)}>
                  <ModelSelectorName>{choice.label}</ModelSelectorName>
                  <span className="font-mono text-[11px] text-muted-foreground">{choice.detail}</span>
                </ModelSelectorItem>
              ))}
          </ModelSelectorGroup>
          <ModelSelectorGroup heading="Anthropic">
            {anthropicChoices.map((choice) => (
              <ModelSelectorItem key={choice.id} value={choice.id} onSelect={() => onSelect(choice.id)}>
                <ModelSelectorName>{choice.label}</ModelSelectorName>
                <span className="font-mono text-[11px] text-muted-foreground">{choice.detail}</span>
              </ModelSelectorItem>
            ))}
            {anthropicChoices.length === 0 && (
              <ModelSelectorItem
                key="anthropic:connect"
                value="anthropic:connect"
                onSelect={onConnectAnthropic}
              >
                <ModelSelectorName>Connect Anthropic…</ModelSelectorName>
                <span className="font-mono text-[11px] text-muted-foreground">
                  add an API key to chat with Claude
                </span>
              </ModelSelectorItem>
            )}
          </ModelSelectorGroup>
        </ModelSelectorList>
        {selected.route === "local" && (
          <div className="model-picker-controls">
            <div>
              <strong>Thinking</strong>
              <span>Reload this local model with extended reasoning.</span>
            </div>
            <button
              type="button"
              className={selected.thinking ? "active" : ""}
              disabled={thinkingDisabled || thinkingBusy}
              onClick={() => onThinkingToggle(!selected.thinking)}
            >
              {thinkingBusy ? "Loading…" : selected.thinking ? "On" : "Off"}
            </button>
          </div>
        )}
      </ModelSelectorContent>
    </ModelSelector>
  );
}
