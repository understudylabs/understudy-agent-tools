"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  workloadDropPersonaState,
  workloadDropReducer,
  workloadDropStatus,
} from "../lib/workload-drop-state.mjs";
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
const PERSONA_ERROR: PersonaColor = { red: 248, green: 113, blue: 113 };

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
        <div><span>Understudy environment</span><strong>Target and verifier</strong></div>
        <small>
          {error
            ? "Analysis stopped"
            : phaseProgress?.message
              ?? (architect
                ? architect.plan_check.status === "passed"
                  ? "Required decisions checked"
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
}: {
  sourceName: string;
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  ready: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="automatic-goal-card structured-dataset-profile-page" aria-label="Review dataset profile">
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

function StructuredTrainingPlan({
  inspection,
  card,
  backend,
  localAvailable,
  onBackendChange,
}: {
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  backend: "local" | "managed";
  localAvailable: boolean;
  onBackendChange: (backend: "local" | "managed") => void;
}) {
  const planned = proposedSplitCounts(inspection.evidence.total_rows);
  const splits = card?.splits ?? planned;
  const evaluator = card?.evaluator ?? inspection.evaluator ?? "Understudy verifier draft";
  const targetField = inspection.field_names.find((field) => structuredFieldRole(field) === "target");
  return (
    <div className="csv-training-plan structured-training-plan" role="list" aria-label="Proposed training plan">
      <div className="csv-training-plan-step" role="listitem">
        <span>Understand</span>
        <strong>{trainingUseCaseLabel(inspection.detected_use_case)}</strong>
        <small>{inspection.evidence.total_rows.toLocaleString()} rows · {inspection.field_names.length.toLocaleString()} fields</small>
        {targetField && <em className="training-target-badge">Target · {targetField}</em>}
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
        <strong>{evaluator.replaceAll("_", " ")}</strong>
        <small>{splits.heldout.toLocaleString()} held-out examples · compare with base</small>
      </div>
    </div>
  );
}

function AutomaticGoalCard({
  inspection,
  card,
  architect,
  architectProgress,
  architectDraft,
  architectError,
  onRetryArchitect,
  analysisModelLabel,
  trainingBackend,
  localTrainingAvailable,
  onTrainingBackendChange,
}: {
  inspection: TrainingRecipeInspection;
  card: TrainingGoalCard | null;
  architect: PiEnvironmentArchitectResult | null;
  architectProgress: PiDatasetAnalysisEvent | null;
  architectDraft: string;
  architectError: string | null;
  onRetryArchitect: () => void;
  analysisModelLabel: string;
  trainingBackend: "local" | "managed";
  localTrainingAvailable: boolean;
  onTrainingBackendChange: (backend: "local" | "managed") => void;
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
    <section
      className="automatic-goal-card structured-dataset-analysis"
      aria-label="Dataset understanding and training plan"
      aria-busy={analysisIsLive}
    >
      <div className="csv-analysis-step-label">2 · Understudy analysis</div>
      <div className="csv-analysis-pi">
        <div className="automatic-goal-card-heading structured-analysis-heading">
          <div>
            <span>{analysisModelLabel} · live analysis</span>
            <strong>{trainingUseCaseLabel(inspection.detected_use_case)}</strong>
          </div>
          <em data-status={environmentStatus}>
            {analysisIsLive && <i aria-hidden="true" />}
            {statusLabel}
          </em>
        </div>
        <PiAnalysisRail architect={architect} progress={architectProgress} error={architectError} />
        <PiDesignCards
          architect={architect}
          progress={architectProgress}
          draft={architectDraft}
          error={architectError}
          onRetry={onRetryArchitect}
        />
      </div>
      <div className="csv-analysis-step-label">3 · confirm the training plan</div>
      <StructuredTrainingPlan
        inspection={inspection}
        card={card}
        backend={trainingBackend}
        localAvailable={localTrainingAvailable}
        onBackendChange={onTrainingBackendChange}
      />
      {inspection.evidence.duplicate_input_rows > 0 && (
        <p className="automatic-goal-card-note">
          Data cleanup · {inspection.evidence.duplicate_input_rows} repeated inputs grouped · {inspection.evidence.conflicting_target_rows} conflicting rows excluded
        </p>
      )}
    </section>
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
  onSessionChange,
  onHistoryChanged,
  onStreamingChange,
  onTrainingChange,
  onNeedsSignIn,
}: {
  resetToken: number;
  activeSessionId: string | null;
  requestedSession: ChatSessionRequest | null;
  onSessionChange?: (sessionId: string) => void;
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
  const [remoteRecipeEligibilityError, setRemoteRecipeEligibilityError] = useState<string | null>(null);
  const [trainingGoalCard, setTrainingGoalCard] = useState<TrainingGoalCard | null>(null);
  const [environmentArchitect, setEnvironmentArchitect] = useState<PiEnvironmentArchitectResult | null>(null);
  const [environmentArchitectProgress, setEnvironmentArchitectProgress] = useState<PiDatasetAnalysisEvent | null>(null);
  const [environmentArchitectDraft, setEnvironmentArchitectDraft] = useState("");
  const [environmentArchitectError, setEnvironmentArchitectError] = useState<string | null>(null);
  const [environmentArchitectRetry, setEnvironmentArchitectRetry] = useState(0);
  const [recipeBackend, setRecipeBackend] = useState<"local" | "managed">("managed");
  const [recipeLocalAvailable, setRecipeLocalAvailable] = useState(false);
  const [mappingInputColumns, setMappingInputColumns] = useState<string[]>([]);
  const [mappingLabelColumn, setMappingLabelColumn] = useState("");
  const [mappingGroupColumn, setMappingGroupColumn] = useState("");
  const [classificationDataset, setClassificationDataset] = useState<ClassificationDataset | null>(null);
  const [localTrainingActive, setLocalTrainingActive] = useState(false);
  const [remoteTrainingView, setRemoteTrainingView] = useState(false);
  const [trainingHaloVisual, setTrainingHaloVisual] = useState<TrainingHaloVisual | null>(null);
  const [classifierLibraryOpen, setClassifierLibraryOpen] = useState(false);
  const [pacingMessageIndex, setPacingMessageIndex] = useState<number | null>(null);
  const [pacedRevealed, setPacedRevealed] = useState<number | null>(null);
  const [animatedMessageId, setAnimatedMessageId] = useState<string | null>(null);
  const observedResetToken = useRef(false);
  const observedSessionRequest = useRef<number | null>(null);
  const dropInFlight = useRef(false);
  const dropRequestGeneration = useRef(0);
  const environmentArchitectAttempted = useRef<string | null>(null);
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
    setDroppedWorkload(null);
    setCsvInspection(null);
    setTrainingRecipe(null);
    setRemoteRecipePlan(null);
    setDatasetProfileConfirmed(false);
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
    setLocalTrainingActive(false);
    setRemoteTrainingView(false);
    setTrainingHaloVisual(null);
    dispatchDrop({ type: "reset" });
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
    if (!remoteRecipePlan && trainingRecipe?.ready) prepareDetectedRecipe();
  }, [prepareDetectedRecipe, remoteRecipePlan, trainingRecipe?.ready]);

  const openManagedRecipeTraining = useCallback(() => {
    setRecipeBackend("managed");
    if (remoteRecipeEligibilityError) setErr(remoteRecipeEligibilityError);
  }, [remoteRecipeEligibilityError]);

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
        dropInFlight.current = true;
        const requestGeneration = dropRequestGeneration.current + 1;
        dropRequestGeneration.current = requestGeneration;
        setDroppedWorkload(null);
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
          path: paths[0],
          onEvent: channel,
        })
          .then(async (result) => {
            if (disposed || dropRequestGeneration.current !== requestGeneration) return;
            setDroppedWorkload(result);
            const inspectTable = shouldInspectDroppedTable(result);
            const inspectStructured = shouldInspectStructuredDataset(result);
            if (inspectStructured) {
              dispatchDrop({ type: "inspection_started" });
              try {
                await inspectTrainingRecipe(result, requestGeneration);
              } catch (error) {
                if (!inspectTable) throw error;
                await inspectCsvWorkload(result, requestGeneration);
              }
            } else if (inspectTable) {
              dispatchDrop({ type: "inspection_started" });
              try {
                await inspectCsvWorkload(result, requestGeneration);
              } catch (error) {
                const extensionless = !result.source_name.includes(".");
                if (!extensionless) throw error;
                dispatchDrop({ type: "succeeded" });
                setNotice("Workload draft created locally; this extensionless file is not a supported table.");
              }
            } else {
              dispatchDrop({ type: "succeeded" });
              setNotice(
                result.truncated
                  ? "Workload draft created at the safety limit; no file contents were read."
                  : "Workload draft created locally; no file contents were read.",
              );
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
  }, [classifierLibraryOpen]);

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

  const send = async (text: string, files: FileUIPart[] = []) => {
    const clean = text.trim();
    if ((!clean && files.length === 0) || streaming) return;
    setErr(null);
    setNotice(null);

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
      : PERSONA_WHITE;
  const selectedTargetColumn = csvInspection?.columns.find((column) => column.name === mappingLabelColumn) ?? null;
  const selectedTargetBlockReason = !mappingLabelColumn || !selectedTargetColumn
    ? null
    : selectedTargetColumn.unique_count < 2
      ? "Choose a target with at least two repeated categories."
      : selectedTargetColumn.empty_count > 0
        ? `${selectedTargetColumn.empty_count} row(s) have no target value.`
        : selectedTargetColumn.unique_count === selectedTargetColumn.non_empty_count && csvInspection!.row_count >= 5
          ? "Every target value is unique; choose a reusable category rather than an identifier."
          : selectedTargetColumn.unique_ratio > 0.5
            ? "More than half of the target values are unique; choose a more reusable category."
            : null;
  const trainingPlanVisible = Boolean(
    csvInspection && droppedWorkload && !classificationDataset && !dropRunning,
  );
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

  return (
    <div
      className={
        "chat ai-chat" +
        (messages.length > 0 ? " has-messages" : "") +
        (dropRunning || droppedWorkload ? " has-workload" : "") +
        (dropPhase === "preparing_dataset" || classificationDataset || localTrainingActive || remoteTrainingView ? " is-training-flow" : "") +
        (streaming ? " is-streaming" : "")
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
      </div>
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
              ) : trainingRecipe && droppedWorkload ? (
                <>
                  {!datasetProfileConfirmed ? (
                    <StructuredDatasetProfilePage
                      sourceName={droppedWorkload.source_name}
                      inspection={trainingRecipe}
                      card={trainingGoalCard}
                      ready={Boolean(trainingRecipe.row_preview.length > 0)}
                      onConfirm={() => setDatasetProfileConfirmed(true)}
                    />
                  ) : <>
                    {!remoteTrainingView && <button
                      type="button"
                      className="btn ghost dataset-flow-back"
                      onClick={() => setDatasetProfileConfirmed(false)}
                    >Back to data profile</button>}
                    {!remoteTrainingView && <AutomaticGoalCard
                      inspection={trainingRecipe}
                      card={trainingGoalCard}
                      architect={environmentArchitect}
                      architectProgress={environmentArchitectProgress}
                      architectDraft={environmentArchitectDraft}
                      architectError={environmentArchitectError}
                      onRetryArchitect={retryEnvironmentArchitect}
                      analysisModelLabel={selectedChoice.label}
                      trainingBackend={recipeBackend}
                      localTrainingAvailable={recipeLocalAvailable}
                      onTrainingBackendChange={setRecipeBackend}
                    />}
                    <div className="csv-analysis-next">
                      {trainingRecipe.ready && remoteRecipePlan ? <>
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
                            : environmentArchitectProgress?.text) ?? (environmentArchitect
                            ? "The verifier draft is ready, but this task still needs an executable portable recipe. No upload or spend has started."
                            : "Profiling and splitting locally. No upload or spend has started.")}</small>
                        </div>
                      )}
                    </div>
                  </>}
                  {!localTrainingActive && !remoteTrainingView && (
                    <button type="button" className="btn ghost workload-generic-dismiss" onClick={resetDroppedWorkload}>
                      Dismiss
                    </button>
                  )}
                </>
              ) : csvInspection && droppedWorkload ? (
                <>
                  {!classificationDataset ? (
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
                      <div className="csv-analysis-step-label">3 · confirm the training plan</div>
                      <div className="csv-analysis-next">
                      <CsvTrainingPlan
                        rowCount={csvInspection.row_count}
                        labelCount={selectedTargetColumn?.unique_count ?? null}
                        inputColumns={mappingInputColumns}
                        labelColumn={mappingLabelColumn}
                        groupColumn={mappingGroupColumn}
                      />
                      <div className="csv-analysis-proposal">
                        <strong>{mappingLabelColumn ? `Predict ${mappingLabelColumn}` : "Choose what to predict"}</strong>
                      </div>
                      {selectedTargetBlockReason ? (
                        <p className="csv-analysis-caution" role="status">
                          {selectedTargetBlockReason}
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
                      </div>
                    </>
                  ) : (
                    <div className={`workload-dataset-ready${localTrainingActive ? " is-active" : ""}`}>
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
                    </div>
                  )}
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
                    onClick={resetDroppedWorkload}
                  >
                    Dismiss
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

      {trainingPlanVisible ? (
        <div className="ai-chat-composer training-plan-action">
          <button
            type="button"
            className="btn primary training-plan-submit"
            disabled={trainingPlanBlocked}
            onClick={prepareDroppedClassification}
          >
            {mappingLabelColumn ? `Train for ${mappingLabelColumn}` : "Choose a target"}
          </button>
        </div>
      ) : (
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
                onSelect={(id) => {
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
              <ModelCardDrawer
                modelId={selectedChoice.route === "local" ? selectedChoice.modelId : selectedChoice.id}
                label={selectedChoice.label}
                route={selectedChoice.route}
                runtime={{
                  slotId: selectedChoice.route === "local" ? selectedChoice.slotId : undefined,
                  active: selectedChoice.active,
                  loading: selectedChoice.route === "local" ? selectedChoice.loading : false,
                  thinking: selectedChoice.route === "local" ? selectedChoice.thinking : false,
                }}
              />
              <PromptInputBody className="composer-row-body">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask Understudy..."
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

function ModelPicker({
  choices,
  selected,
  onSelect,
  onConnectAnthropic,
  thinkingDisabled,
  thinkingLoading,
  onThinkingToggle,
}: {
  choices: ModelChoice[];
  selected: ModelChoice;
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
          title={`${selected.label} · ${selected.route}`}
        >
          <span>{selected.label}</span>
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
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
