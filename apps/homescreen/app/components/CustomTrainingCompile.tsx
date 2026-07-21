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

const COMPILE_STAGES = [
  { phase: "inspecting", label: "Inspect source", detail: "Local read only" },
  { phase: "preparing_splits", label: "Prepare splits", detail: "Leakage-safe" },
  { phase: "planning", label: "Write plan", detail: "Immutable · $0" },
  { phase: "compiling", label: "Compile environment", detail: "Goal Card" },
] as const;

type StageState = "pending" | "active" | "complete" | "error";

function stageStates(
  phases: CustomCompileEvent[],
  done: boolean,
  errored: boolean,
): StageState[] {
  const highest = phases.reduce((max, event) => Math.max(max, event.current), 0);
  return COMPILE_STAGES.map((_, index) => {
    const number = index + 1;
    if (done || number < highest) return "complete";
    if (number === highest) return errored ? "error" : "active";
    return "pending";
  });
}

/**
 * Environment validation gates, derived truthfully from compile output.
 * A gate is green only when the data proves it: split evidence comes from the
 * Goal Card itself; the executable gates are green only when the deterministic
 * validator reported `environment.status === "executable"`.
 */
function environmentGates(result: CustomCompileSummary) {
  const executable = result.environment_status === "executable";
  const splits = result.goal_card.splits;
  return [
    {
      id: "split-hashes",
      label: "Split hashes computed",
      detail: splits.hash
        ? `${splits.train.toLocaleString()} train · ${splits.validation.toLocaleString()} validation · ${splits.heldout.toLocaleString()} held-out · ${splits.hash.slice(0, 12)}`
        : "The Goal Card did not report a split hash.",
      passed: Boolean(splits.hash),
    },
    {
      id: "group-leakage",
      label: "Group-leakage guard",
      detail: splits.strategy.replaceAll("-", " ").replaceAll("_", " "),
      passed: /group/i.test(splits.strategy),
    },
    {
      id: "oracle",
      label: "Deterministic oracle scored 1.0",
      detail: executable
        ? `${result.goal_card.evaluator.replaceAll("_", " ")} reproduced the expected targets`
        : "Verified only once the environment is executable.",
      passed: executable,
    },
    {
      id: "sentinels",
      label: "Sentinels rejected",
      detail: executable
        ? "Wrong and malformed answers scored 0"
        : "Verified only once the environment is executable.",
      passed: executable,
    },
    {
      id: "parser",
      label: "Parser contract verified",
      detail: executable
        ? "Model output parses deterministically"
        : "Verified only once the environment is executable.",
      passed: executable,
    },
  ];
}

/**
 * The live compile card that replaces the old dead-end banner: a four-phase
 * checklist while `compile_custom_training_plan` streams, environment gates
 * once the Goal Card lands, and an actionable error with retry on failure.
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
  const started = busy || phases.length > 0 || Boolean(result) || Boolean(error);
  const states = stageStates(phases, Boolean(result), Boolean(error));
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
      {started && (
        <ol className="automatic-goal-card-stages" aria-label="Compilation progress">
          {COMPILE_STAGES.map((stage, index) => (
            <li
              key={stage.phase}
              data-state={states[index]}
              aria-current={states[index] === "active" ? "step" : undefined}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{stage.label}</strong>
                <small>
                  {phases.find((event) => event.phase === stage.phase)?.message
                    ?? stage.detail}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
      {result && (
        <ul
          className="custom-compile-gates mt-3 grid list-none gap-1.5 p-0"
          aria-label="Environment validation gates"
        >
          {environmentGates(result).map((gate) => (
            <li key={gate.id} className="flex items-baseline gap-2 text-[12px]">
              <span
                aria-hidden="true"
                className={gate.passed ? "text-[color:var(--mb-mint,#9edbd3)]" : "text-muted-foreground"}
              >
                {gate.passed ? "✓" : "○"}
              </span>
              <span className="flex-1">
                <strong className="font-medium">{gate.label}</strong>
                <small className="ml-2 text-muted-foreground">{gate.detail}</small>
                <span className="sr-only">{gate.passed ? " · verified" : " · not verified yet"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
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
