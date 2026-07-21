"use client";

/** Phase events streamed by the `compile_custom_training_plan` Tauri command. */
export type CustomCompileEvent = {
  type: "phase";
  phase: "inspecting" | "preparing_splits" | "planning" | "compiling";
  current: number;
  total: number;
  message: string;
};

/** The Goal Card fields this card reads. Structural subset of the full
 *  `understudy.training.goal_card.v1` payload owned by ChatPane. */
export type CustomCompileGoalCard = {
  evaluator: string;
  splits: {
    strategy: string;
    hash: string;
    train: number;
    validation: number;
    heldout: number;
  };
  environment: { proposal_path: string; status: string };
};

/** Result of `compile_custom_training_plan` (custom_compile.v1). */
export type CustomCompileSummary = {
  schema_version: "understudy.remote_training.custom_compile.v1";
  task_kind: string;
  recipe_id: string;
  goal_card: CustomCompileGoalCard;
  environment_proposal_path: string;
  environment_status: string;
  dataset_manifest_path: string | null;
  mapping: {
    input_columns: string[];
    label_column: string;
    group_column: string;
  } | null;
  local_only: true;
  uploads: false;
  provider_called: false;
  spend_usd: number;
};

/**
 * The live compile card that replaces the old dead-end banner: streamed local
 * compilation status while `compile_custom_training_plan` runs, and an
 * actionable error with retry on failure — never a bare Dismiss.
 */
export function CustomTrainingCompileCard({
  phases,
  busy,
  result,
  error,
  onRetry,
  waitingForMapping,
  onCompile,
}: {
  phases: CustomCompileEvent[];
  busy: boolean;
  result: CustomCompileSummary | null;
  error: string | null;
  onRetry: () => void;
  /** True when a confirmed tabular mapping is still being chosen above. */
  waitingForMapping?: boolean;
  /** Present when compilation waits on an explicit user action. */
  onCompile?: (() => void) | null;
}) {
  const latest = phases.at(-1) ?? null;
  const executable = result?.environment_status === "executable";
  return (
    <section
      className="remote-training-state custom-compile-card w-full text-left"
      role={error ? "alert" : "status"}
      aria-live="polite"
      aria-busy={busy || undefined}
    >
      <strong>
        {error
          ? "Custom training compilation stopped"
          : result
            ? executable
              ? "Executable portable recipe compiled"
              : "Portable recipe compiled — environment not executable yet"
            : busy
              ? "Compiling a portable training recipe"
              : "Ready to compile a portable training recipe"}
      </strong>
      <small>
        {error
          ? error
          : result
            ? executable
              ? "Everything below was verified locally. Nothing has been uploaded and no spend has started."
              : `Environment status: ${result.environment_status.replaceAll("_", " ")}. The plan is written locally; the verifier is not executable, so no upload or spend can start.`
            : latest?.message
              ?? (busy
                ? "Working locally. Nothing uploads during compilation."
                : waitingForMapping
                  ? "Confirm the column mapping above, then compile. Everything runs locally."
                  : "Compilation runs entirely on this Mac.")}
      </small>
      {(error || (onCompile && !busy && !result)) && (
        <div className="remote-training-actions mt-3">
          {error ? (
            <button type="button" className="btn primary" onClick={onRetry}>
              Retry compilation
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={waitingForMapping}
              onClick={() => onCompile?.()}
            >
              Compile training plan
            </button>
          )}
        </div>
      )}
    </section>
  );
}
