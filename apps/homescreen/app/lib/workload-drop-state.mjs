export const INITIAL_WORKLOAD_DROP_PHASE = "idle";

// Extensions that are clearly not tabular data: media, binaries/archives,
// source code, and prose documents. Everything else is worth one local
// inspection attempt — the CLI reader is the source of truth for which table
// formats actually parse, and ChatPane falls back to the metadata-only
// Workload Card when inspection fails.
const NON_TABULAR_EXTENSIONS = new Set([
  // media
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "heic", "bmp", "tiff",
  "mp3", "wav", "aiff", "flac", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  // binaries and archives
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg", "iso",
  "exe", "dll", "so", "dylib", "bin", "wasm", "app", "sqlite", "db",
  // code and config
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "kt",
  "c", "h", "cpp", "hpp", "cc", "swift", "rb", "php", "sh", "zsh", "bash",
  "css", "scss", "html", "htm", "yaml", "yml", "toml", "ini", "lock",
  // prose documents
  "md", "markdown", "rst", "pdf", "doc", "docx", "ppt", "pptx", "rtf",
]);

export function shouldInspectDroppedTable(workload) {
  if (!workload || workload.source_type !== "file") return false;
  if ((workload.source_kinds?.["csv-data"] ?? 0) === 1) return true;
  const name = String(workload.source_name ?? "").trim().toLowerCase();
  if (name.length === 0) return false;
  // Several public datasets ship as extensionless tab-delimited files, and
  // table formats keep multiplying; any single dropped file that is not
  // clearly non-tabular gets one local inspection attempt. Files the CLI
  // cannot read fall back to the generic metadata-only Workload Card.
  const dot = name.lastIndexOf(".");
  if (dot < 0) return true;
  return !NON_TABULAR_EXTENSIONS.has(name.slice(dot + 1));
}

export function shouldInspectStructuredDataset(workload) {
  if (!workload || workload.source_type !== "file") return false;
  const name = String(workload.source_name ?? "").trim().toLowerCase();
  return /\.(?:csv|tsv|tab|txt|json|jsonl|ndjson|xls|xlsx|xlsb|xlsm|ods)$/.test(name)
    || (name.length > 0 && !name.includes("."));
}

// Compatibility alias for older Desktop lineage checks and integrations.
export const shouldInspectTrainingRecipe = shouldInspectStructuredDataset;

/**
 * The chat message that hands a non-inspectable drop (a directory, or a file
 * with no deterministic training flow) to the in-chat agent, which carries
 * the benchmark-lab profile_workload / from_dataset tools. The prompt states
 * the contract explicitly: profile → discuss → user confirms → proposed
 * benchmark in the review inbox — the agent never queues a run from a drop.
 */
export function workloadHandoffPrompt(workload) {
  const path = String(workload?.source_path ?? "").trim();
  const kind = workload?.source_type === "directory" ? "folder" : "file";
  const scanned = Number(workload?.scanned_file_count ?? 0);
  const scannedNote = scanned > 0 ? ` (${scanned} file${scanned === 1 ? "" : "s"} scanned locally, contents unread)` : "";
  return (
    `I dropped the ${kind} \`${path}\` into the chat${scannedNote}. ` +
    "Profile it with profile_workload and tell me what this workload appears to be and which labeled dataset files you found. " +
    "Then help me pick the right dataset and columns, and once I confirm, compile it with from_dataset into a proposed benchmark " +
    "so I can review its tasks and start a benchmark run. Don't queue any runs until I've reviewed the proposal."
  );
}

const BUSY_PHASES = new Set(["validating", "compiling", "inspecting", "preparing_dataset"]);

/**
 * One explicit lifecycle owns the drop affordance. UI motion and copy derive
 * from these real phases instead of maintaining independent hover/loading
 * booleans that can disagree with the native compiler.
 */
export function workloadDropReducer(phase, action) {
  switch (action.type) {
    case "drag_enter":
      return BUSY_PHASES.has(phase) ? phase : "hovering";
    case "drag_leave":
      return phase === "hovering" ? "idle" : phase;
    case "drop_received":
    case "validation_started":
      return "validating";
    case "compilation_started":
      return phase === "validating" || phase === "compiling" ? "compiling" : phase;
    case "inspection_started":
      // "validating" is the thread-restore path: it re-runs inspection with
      // no compile step in between, so the phase must advance from there too
      // or the pane wedges on the "Checking this file locally…" skeleton.
      return phase === "validating" || phase === "compiling" || phase === "ready" || phase === "failed"
        ? "inspecting"
        : phase;
    case "inspection_succeeded":
      return phase === "inspecting" ? "ready" : phase;
    case "dataset_started":
      return phase === "ready" || phase === "failed" ? "preparing_dataset" : phase;
    case "dataset_succeeded":
      return phase === "preparing_dataset" ? "ready" : phase;
    case "succeeded":
      return BUSY_PHASES.has(phase) ? "ready" : phase;
    case "failed":
      return BUSY_PHASES.has(phase) ? "failed" : phase;
    case "reset":
      return INITIAL_WORKLOAD_DROP_PHASE;
    default:
      return phase;
  }
}

export function isWorkloadDropBusy(phase) {
  return BUSY_PHASES.has(phase);
}

export function workloadDropPersonaState(phase) {
  if (phase === "hovering") return "listening";
  if (BUSY_PHASES.has(phase)) return "thinking";
  return null;
}

export function workloadDropStatus(phase) {
  switch (phase) {
    case "hovering":
      return {
        title: "Drop to begin",
        detail: "One file or folder · stays on this Mac",
      };
    case "validating":
      return {
        title: "Checking this item",
        detail: "Validating one local path…",
      };
    case "compiling":
      return {
        title: "Preparing your workload",
        detail: "Indexing metadata locally · contents remain unread",
      };
    case "inspecting":
      return {
        title: "Analyzing this dataset",
        detail: "Decoding locally · Understudy is inferring the task",
      };
    case "preparing_dataset":
      return {
        title: "Preparing local dataset",
        detail: "Writing deterministic train, dev, and holdout examples on this Mac",
      };
    default:
      return null;
  }
}
