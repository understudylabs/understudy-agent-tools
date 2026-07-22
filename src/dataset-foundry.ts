/**
 * dataset-foundry — the dataset entrance to the benchmark foundry.
 *
 * `understudy benchmarks from-dataset <file-or-dir>` turns a labeled dataset
 * (JSONL/CSV/TSV/XLSX) into a FULL benchmark directory on the same spine as
 * trace-derived benchmarks: tasks.jsonl (understudy.benchmark_task.v1), a
 * benchmark.json proposal (understudy.benchmark_proposal.v1, provenance.origin
 * "derived-from-dataset"), a generated verifiers environment, offline oracle
 * validation, born-accepted review semantics, run requests with trivial floor
 * arms (majority_class included by construction), rigor reports, Pareto — all
 * unchanged downstream.
 *
 * SCHEMA DECISION (recorded here so reviewers don't have to re-derive it):
 * the top-level manifest.json is a SIBLING schema,
 * `understudy.dataset_foundry.v1`, not an extension of
 * understudy.trace_foundry.v1. The trace manifest's counts/artifacts blocks
 * are capture-census-shaped (source DAG, capture ledger, freshness cutoffs)
 * and none of them are meaningful for dataset rows; forcing dataset builds
 * into that shape would make every field a lie ("0 captures, 0 edges").
 * The shared parts that DO matter — benchmark.json, tasks.jsonl, the
 * environment package, self_check, leakage_audit — are produced by the SAME
 * shared code (benchmarkManifestFrom, writeVerifiersEnvironment,
 * runFoundrySelfCheck), so the executable contract cannot fork. Readers key
 * on benchmark.json/tasks.jsonl, which are identical in kind.
 *
 * CURATION (the und-289 discipline, automated with an audit report instead of
 * questions):
 * - label-conflict quarantine: rows whose NORMALIZED input text appears with
 *   more than one distinct label are ALL quarantined (ambiguous gold);
 * - exact-duplicate removal: repeated (normalized input, label) rows beyond
 *   the first are removed;
 * - GROUPED splits: every row is assigned to a leakage group (the normalized
 *   group-column value when given, else the normalized input text) and each
 *   group lands in exactly one of train/dev/holdout — zero group overlap by
 *   construction, asserted before writing.
 * Every removal/quarantine is listed row-by-row in curation/*.jsonl and
 * summarized in curation-report.md + the manifest's machine-readable
 * `curation` block — a non-expert never gets silently wrong data OR twenty
 * questions.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { readCaptureDelimitedTable, inferTableMapping } from "./capture-import.js";
import { parseJsonlText, toPortablePath } from "./benchmark-artifacts.js";
import { benchmarkManifestFrom, runFoundrySelfCheck, writeVerifiersEnvironment } from "./trace-foundry.js";
import { validateBenchmarkManifest } from "./benchmark.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function writeJson(path: string, value: unknown): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function writeJsonl(path: string, rows: unknown[]): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), { mode: 0o600 }); }

export const DATASET_FOUNDRY_SCHEMA = "understudy.dataset_foundry.v1";
export const DATASET_CURATION_SCHEMA = "understudy.dataset_curation.v1";

/** Verifiers commit the generated environment pins (same as the trace foundry). */
const AUDITED_VERIFIERS_COMMIT = "cb9c84969186f8a0954b1027320f225e6b6b0afb";

/* ------------------------------------------------------------------ */
/* Normalization (the und-289 dedupe key)                              */
/* ------------------------------------------------------------------ */

/** NFKC + casefold + whitespace collapse — the exact-text dedupe/conflict key. */
export function normalizeDatasetText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export type DatasetTable = {
  source_path: string;
  source_sha256: string;
  format: "csv" | "jsonl";
  headers: string[];
  /** Every cell coerced to string (JSONL objects/arrays are JSON-stringified). */
  rows: string[][];
};

const DATA_EXTENSIONS = new Set([".csv", ".tsv", ".tab", ".xlsx", ".jsonl", ".ndjson"]);

/** Resolve <file-or-dir> to the ONE dataset file (a dir must contain exactly one data file). */
export function resolveDatasetFile(sourceInput: string): string {
  const source = resolve(sourceInput);
  if (!existsSync(source)) throw new Error(`Dataset source does not exist: ${source}`);
  if (statSync(source).isFile()) return source;
  const candidates = readdirSync(source)
    .filter((name) => DATA_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(source, name));
  if (candidates.length === 0) throw new Error(`No dataset file (.jsonl/.csv/.tsv/.xlsx) found in ${source}`);
  if (candidates.length > 1) throw new Error(`Ambiguous dataset dir — ${candidates.length} data files found; pass the file itself:\n${candidates.map((c) => `  ${c}`).join("\n")}`);
  return candidates[0];
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

/** Load a dataset file into one uniform table (JSONL keys become headers in first-seen order). */
export function loadDatasetTable(fileInput: string): DatasetTable {
  const file = resolve(fileInput);
  const ext = extname(file).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") {
    const bytes = readFileSync(file);
    const { items, skipped } = parseJsonlText<Obj>(bytes.toString("utf8"));
    const objects = items.map(asObject).filter((row) => Object.keys(row).length > 0);
    if (objects.length === 0) throw new Error(`No JSON object rows in ${file}${skipped > 0 ? ` (${skipped} malformed line(s))` : ""}`);
    const headers: string[] = [];
    for (const row of objects) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
    return {
      source_path: file,
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "jsonl",
      headers,
      rows: objects.map((row) => headers.map((key) => cell(row[key]))),
    };
  }
  const { bytes, headers, rows } = readCaptureDelimitedTable(file);
  return { source_path: file, source_sha256: createHash("sha256").update(bytes).digest("hex"), format: "csv", headers, rows };
}

/** Load an optional label-taxonomy file: JSON array of strings, or one label per line. */
export function loadTaxonomyLabels(fileInput: string): string[] {
  const text = readFileSync(resolve(fileInput), "utf8");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return [...new Set(parsed.map(String).map((s) => s.trim()).filter(Boolean))];
    if (parsed !== null && typeof parsed === "object") return [...new Set(Object.keys(parsed as Obj).map((s) => s.trim()).filter(Boolean))];
  } catch { /* newline-delimited */ }
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")))];
}

/* ------------------------------------------------------------------ */
/* Curation                                                            */
/* ------------------------------------------------------------------ */

export type DatasetExample = {
  /** 1-based data-row number in the source file (header excluded for CSV). */
  row_number: number;
  text: string;
  label: string;
  group_key: string;
  normalized_text: string;
};

export type CurationResult = {
  kept: DatasetExample[];
  /** Rows with an empty input or empty label (never silently dropped — counted + listed). */
  unusable: { row_number: number; reason: string }[];
  /** Exact-duplicate rows removed (same normalized input + same label beyond the first). */
  duplicates: { row_number: number; kept_row_number: number; label: string; normalized_text: string }[];
  /** Label-conflict rows quarantined (same normalized input, different labels — ALL members). */
  conflicts: { row_number: number; label: string; conflicting_labels: string[]; normalized_text: string }[];
};

/**
 * The und-289 curation pass, in its order: conflicts are computed over the
 * full pool FIRST (every member of a conflicted input is quarantined), then
 * exact duplicates are removed among the non-conflicted rows. On the und-289
 * Shopper pool this reproduces their published 3 quarantined / 18 removed /
 * 5377 kept exactly.
 */
export function curateExamples(examples: DatasetExample[]): CurationResult {
  const labelsByText = new Map<string, Set<string>>();
  for (const example of examples) {
    if (!example.text.trim() || !example.label.trim()) continue;
    const set = labelsByText.get(example.normalized_text) ?? new Set<string>();
    set.add(example.label);
    labelsByText.set(example.normalized_text, set);
  }
  const conflictedTexts = new Set([...labelsByText.entries()].filter(([, labels]) => labels.size > 1).map(([text]) => text));

  const kept: DatasetExample[] = [];
  const unusable: CurationResult["unusable"] = [];
  const duplicates: CurationResult["duplicates"] = [];
  const conflicts: CurationResult["conflicts"] = [];
  const firstKeptByText = new Map<string, number>();
  for (const example of examples) {
    if (!example.text.trim()) { unusable.push({ row_number: example.row_number, reason: "empty input text" }); continue; }
    if (!example.label.trim()) { unusable.push({ row_number: example.row_number, reason: "empty label" }); continue; }
    if (conflictedTexts.has(example.normalized_text)) {
      conflicts.push({ row_number: example.row_number, label: example.label, conflicting_labels: [...labelsByText.get(example.normalized_text)!].sort(), normalized_text: example.normalized_text });
      continue;
    }
    const priorRow = firstKeptByText.get(example.normalized_text);
    if (priorRow !== undefined) {
      duplicates.push({ row_number: example.row_number, kept_row_number: priorRow, label: example.label, normalized_text: example.normalized_text });
      continue;
    }
    firstKeptByText.set(example.normalized_text, example.row_number);
    kept.push(example);
  }
  return { kept, unusable, duplicates, conflicts };
}

/* ------------------------------------------------------------------ */
/* Grouped splits (zero group overlap by construction)                 */
/* ------------------------------------------------------------------ */

export type SplitRatios = { train: number; dev: number; holdout: number };
export const DEFAULT_SPLIT_RATIOS: SplitRatios = { train: 0.8, dev: 0.1, holdout: 0.1 };

/**
 * Deterministic GROUPED split: rows sharing a group key (the leakage key)
 * always land in the same split. Groups are ranked by a source-salted hash,
 * then greedily assigned to the split with the largest remaining relative
 * deficit — the same allocation shape as capture-import's
 * prepare-classification, applied globally. Returns split by group key.
 */
export function assignGroupedSplits(
  groups: Map<string, number>,
  ratios: SplitRatios,
  salt: string,
): Map<string, "train" | "dev" | "holdout"> {
  const total = [...groups.values()].reduce((a, b) => a + b, 0);
  const names = ["train", "dev", "holdout"] as const;
  const targets = { train: total * ratios.train, dev: total * ratios.dev, holdout: total * ratios.holdout };
  const assigned = { train: 0, dev: 0, holdout: 0 };
  const ranked = [...groups.entries()].sort((left, right) =>
    hash(`${salt}\0${left[0]}`).localeCompare(hash(`${salt}\0${right[0]}`)),
  );
  const out = new Map<string, "train" | "dev" | "holdout">();
  ranked.forEach(([key, size], index) => {
    // Seed each split with one group so tiny datasets still get all three.
    const split = index < names.length
      ? names[index]
      : [...names].sort((a, b) => (targets[b] - assigned[b]) / Math.max(targets[b], 1) - (targets[a] - assigned[a]) / Math.max(targets[a], 1))[0];
    out.set(key, split);
    assigned[split] += size;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

/** Derived classification system prompt: one exact label, JSON-only output, taxonomy listed (so gold is benign-by-inputs in the leakage audit). */
export function derivedSystemPrompt(name: string, labels: string[]): string {
  return [
    `You are a precise classifier for the "${name}" workload.`,
    `Read the input and choose EXACTLY ONE label from the list below — the label text must match verbatim.`,
    `Respond with ONLY a JSON object of the form {"label": "<label>"} and nothing else.`,
    ``,
    `Labels:`,
    ...labels.map((label) => `- ${label}`),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Compile                                                             */
/* ------------------------------------------------------------------ */

export type DatasetFoundryOptions = {
  name?: string;
  labelColumn?: string;
  inputColumns?: string[];
  /** Leakage-group column; default: the normalized input text itself. */
  groupColumn?: string;
  taxonomyFile?: string;
  /** Literal system prompt or @file is resolved by the CLI before calling. */
  systemPrompt?: string;
  /** Optional docs dir recorded as provenance context (never parsed, never model input). */
  docsDir?: string;
  ratios?: SplitRatios;
  now?: Date;
};

export type DatasetFoundryResult = Obj;

export function compileDatasetFoundry(sourceInput: string, outputInput: string, options: DatasetFoundryOptions = {}): DatasetFoundryResult {
  const now = options.now ?? new Date();
  const output = resolve(outputInput);
  const file = resolveDatasetFile(sourceInput);
  const table = loadDatasetTable(file);
  const ratios = options.ratios ?? DEFAULT_SPLIT_RATIOS;
  const ratioSum = ratios.train + ratios.dev + ratios.holdout;
  if (!(ratios.train > 0 && ratios.dev > 0 && ratios.holdout > 0) || Math.abs(ratioSum - 1) > 1e-6) {
    throw new Error(`Split ratios must be positive and sum to 1 (got ${ratios.train}/${ratios.dev}/${ratios.holdout})`);
  }

  // Column mapping: capture-import's shared inference, flag-overridable.
  const inferred = inferTableMapping(table.headers, table.rows);
  const findHeader = (wanted: string, kind: string): string => {
    const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const match = table.headers.find((header) => norm(header) === norm(wanted));
    if (!match) throw new Error(`Unknown ${kind} column "${wanted}"; headers: ${table.headers.join(", ")}`);
    return match;
  };
  const labelColumn = options.labelColumn ? findHeader(options.labelColumn, "label") : inferred.label_column;
  if (!labelColumn) throw new Error(`Could not infer a label column from ${basename(file)} — pass --label-column. Headers: ${table.headers.join(", ")}`);
  const inputColumns = (options.inputColumns && options.inputColumns.length > 0
    ? options.inputColumns.map((column) => findHeader(column, "input"))
    : inferred.input_columns.filter((column) => column !== labelColumn));
  if (inputColumns.length === 0) throw new Error("No input columns — pass --input-column at least once.");
  if (inputColumns.includes(labelColumn)) throw new Error("The label column cannot also be an input column.");
  const groupColumn = options.groupColumn ? findHeader(options.groupColumn, "group") : null;

  const labelIndex = table.headers.indexOf(labelColumn);
  const groupIndex = groupColumn === null ? -1 : table.headers.indexOf(groupColumn);
  const inputIndexes = inputColumns.map((column) => table.headers.indexOf(column));

  const examples: DatasetExample[] = table.rows.map((row, index) => {
    const text = inputIndexes.length === 1
      ? (row[inputIndexes[0]] ?? "").trim()
      : inputIndexes
          .map((columnIndex) => ({ name: table.headers[columnIndex], value: (row[columnIndex] ?? "").trim() }))
          .filter(({ value }) => value.length > 0)
          .map(({ name, value }) => `${name}: ${value}`)
          .join("\n");
    const label = (row[labelIndex] ?? "").trim();
    const normalized = normalizeDatasetText(text);
    const groupRaw = groupIndex >= 0 ? normalizeDatasetText(row[groupIndex] ?? "") : "";
    return { row_number: index + 1, text, label, normalized_text: normalized, group_key: groupRaw || normalized };
  });

  // Curation (dedupe + conflict quarantine), then GROUPED splits.
  const curation = curateExamples(examples);
  if (curation.kept.length === 0) throw new Error("Curation kept zero rows — check the label/input column mapping.");
  const groups = new Map<string, number>();
  for (const example of curation.kept) groups.set(example.group_key, (groups.get(example.group_key) ?? 0) + 1);
  const splitByGroup = assignGroupedSplits(groups, ratios, table.source_sha256);
  // Zero-overlap assertion: one split per group key by construction — verify anyway.
  const seenSplitByGroup = new Map<string, string>();
  for (const example of curation.kept) {
    const split = splitByGroup.get(example.group_key)!;
    const prior = seenSplitByGroup.get(example.group_key);
    if (prior !== undefined && prior !== split) throw new Error(`Internal split error: group assigned to both ${prior} and ${split}`);
    seenSplitByGroup.set(example.group_key, split);
  }

  // Labels + taxonomy.
  const observedLabels = [...new Set(curation.kept.map((example) => example.label))].sort((a, b) => a.localeCompare(b));
  const taxonomyLabels = options.taxonomyFile ? loadTaxonomyLabels(options.taxonomyFile) : null;
  const unknownLabels = taxonomyLabels === null ? [] : observedLabels.filter((label) => !taxonomyLabels.includes(label));
  if (unknownLabels.length > 0) {
    throw new Error(`${unknownLabels.length} observed label(s) are not in the taxonomy file: ${unknownLabels.slice(0, 10).join(" | ")}${unknownLabels.length > 10 ? " …" : ""}`);
  }
  const allLabels = taxonomyLabels ?? observedLabels;
  const missingTaxonomyLabels = taxonomyLabels === null ? [] : taxonomyLabels.filter((label) => !observedLabels.includes(label)).sort((a, b) => a.localeCompare(b));

  const name = options.name ?? basename(file).replace(/\.[^.]+$/, "");
  const systemPrompt = options.systemPrompt ?? derivedSystemPrompt(name, allLabels);

  // Tasks + synthetic gold captures. The gold final response is the und-289
  // training format ({"label": "<exact label>"}); the outcome contract is
  // EXACTLY ONE contains_category response obligation so the task is
  // classification-shaped (the majority_class floor arm recognizes it) and is
  // scored through the shared fenced-JSON-tolerant response path.
  const splitName = (example: DatasetExample): "train" | "dev" | "holdout" => splitByGroup.get(example.group_key)!;
  const foundrySplit = { train: "construction", dev: "fit", holdout: "heldout" } as const;
  const tasks: Obj[] = [];
  const captures: Obj[] = [];
  const sourceContext = new Map<string, Obj>();
  for (const example of curation.kept) {
    const rowHash = hash({ source: table.source_sha256, row: example.row_number, text: example.text, label: example.label });
    const taskId = `task-${rowHash.slice(0, 16)}`;
    const captureKey = `dataset-${rowHash.slice(0, 32)}`;
    const gold = JSON.stringify({ label: example.label });
    const messages = [{ role: "user", content: example.text }];
    captures.push({
      capture_id: captureKey,
      capture_key: captureKey,
      captured_at: now.toISOString(),
      source: { pointer: `${basename(file)}#L${example.row_number}`, sha256: rowHash },
      request: { system: systemPrompt, messages },
      response: { body: { choices: [{ message: { role: "assistant", content: gold } }] } },
    });
    const task: Obj = {
      schema_version: "understudy.benchmark_task.v1",
      task_id: taskId,
      // Display title deliberately differs from the prompt: the foundry
      // self-check treats prompt===title as the display-title-instead-of-
      // full-prompt failure class, but a short dataset row IS its own prompt.
      title: `Label row ${example.row_number}: ${example.text.replace(/\s+/g, " ").trim().slice(0, 140)}`,
      status: "machine_proposed",
      split: foundrySplit[splitName(example)],
      candidate_boundary: captureKey,
      machine_confidence: "high",
      close_call: false,
      tool_surface: [],
      tool_definitions: [],
      source: { node_ids: [captureKey], edges: [], captures: [{ capture_key: captureKey, capture_id: captureKey, pointer: `${basename(file)}#L${example.row_number}`, sha256: rowHash }], dataset_row: example.row_number },
      world_model: { status: "machine_proposed", initial_state: { source: "dataset_row", materialized: false, observations: [] }, transitions: [] },
      outcome_contract: {
        status: "machine_proposed",
        required: [{ type: "response_obligation", kind: "contains_category", expected: example.label, provenance: "dataset_gold" }],
        preserved: [],
        forbidden: [],
        grading: "final_state_and_obligations",
      },
      claims: [{ kind: "observed", claim: `dataset row ${example.row_number} carries gold label ${JSON.stringify(example.label)}`, provenance: "dataset_gold" }],
      sentinels: ["noop", "wrong_value"],
      review: { decision: "pending_final_judgment" },
      capability_fit: { classification: "new_instance" },
      incumbent: null,
    };
    task.task_hash = hash({ title: task.title, contract: task.outcome_contract, source: task.source });
    tasks.push(task);
    sourceContext.set(taskId, { system: systemPrompt, messages });
  }

  // Artifacts (shared writers; normalized-captures.jsonl carries the gold so
  // the SAME oracle runner + offline validation verify response obligations
  // against real gold — score 1.0 by construction).
  mkdirSync(output, { recursive: true });
  writeJsonl(join(output, "normalized-captures.jsonl"), captures);
  writeJsonl(join(output, "tasks.jsonl"), tasks);
  const environment = writeVerifiersEnvironment(output, tasks, sourceContext, AUDITED_VERIFIERS_COMMIT, captures);
  const selfCheck = runFoundrySelfCheck(output, tasks);

  const splitCounts = { train: 0, dev: 0, holdout: 0 };
  for (const example of curation.kept) splitCounts[splitName(example)] += 1;
  const groupCounts = { train: 0, dev: 0, holdout: 0 };
  for (const split of splitByGroup.values()) groupCounts[split] += 1;

  const benchmarkId = `dataset-${hash({ source: table.source_sha256, labelColumn, inputColumns }).slice(0, 16)}`;
  const promotionBlockers = ["human_final_judgment", ...(!environment.oracle_pass ? ["oracle_failed"] : []), ...(!environment.sentinel_pass ? ["sentinel_tests"] : [])];
  const benchmark = benchmarkManifestFrom(tasks, {
    schemaVersion: "understudy.benchmark_proposal.v1",
    benchmarkId,
    name: `${name} dataset benchmark`,
    description: `Compiled from labeled dataset ${basename(file)} (${curation.kept.length} rows kept after curation). Classification contract: one exact gold label per task, fenced-JSON-tolerant response scoring.`,
    createdAt: now.toISOString(),
    sourceRefs: [basename(file), "curation-report.md"],
    packageSha256: environment.package_sha256 as string | null,
    auditedCommit: String(environment.audited_commit ?? AUDITED_VERIFIERS_COMMIT),
    heldoutNovel: false,
    status: "machine_compiled_review_pending",
    executable: false,
    promotionBlockers,
    origin: "derived-from-dataset",
    genesis: "imported",
    splitsBoundary: `grouped by ${groupColumn ? `normalized ${groupColumn}` : "normalized input text"}: zero group overlap; ratios ${ratios.train}/${ratios.dev}/${ratios.holdout}`,
  });
  const manifestErrors = validateBenchmarkManifest({ ...benchmark, schema_version: "understudy.benchmark.v1" });
  if (manifestErrors.length > 0) throw new Error(`Generated benchmark manifest is invalid: ${manifestErrors.join("; ")}`);
  writeJson(join(output, "benchmark.json"), benchmark);

  // Class support + imbalance (surfaced, never silently fatal).
  const supportByLabel = new Map<string, { rows: number; train: number; dev: number; holdout: number }>();
  for (const label of allLabels) supportByLabel.set(label, { rows: 0, train: 0, dev: 0, holdout: 0 });
  for (const example of curation.kept) {
    const support = supportByLabel.get(example.label)!;
    support.rows += 1;
    support[splitName(example)] += 1;
  }
  const labelSupport = [...supportByLabel.entries()]
    .map(([label, support]) => ({ label, ...support }))
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label));
  const majority = labelSupport[0];
  const majorityShare = majority.rows / Math.max(curation.kept.length, 1);

  // Machine-readable curation block + row-listed sidecars.
  writeJsonl(join(output, "curation", "duplicates.jsonl"), curation.duplicates);
  writeJsonl(join(output, "curation", "conflicts.jsonl"), curation.conflicts);
  writeJsonl(join(output, "curation", "unusable.jsonl"), curation.unusable);
  const curationBlock = {
    schema_version: DATASET_CURATION_SCHEMA,
    source_rows: table.rows.length,
    kept_rows: curation.kept.length,
    unusable_removed: curation.unusable.length,
    duplicates_removed: curation.duplicates.length,
    conflict_rows_quarantined: curation.conflicts.length,
    conflict_inputs: new Set(curation.conflicts.map((c) => c.normalized_text)).size,
    dedupe_key: "normalized input text (NFKC, casefold, whitespace-collapsed)",
    group_key: groupColumn ? `normalized ${groupColumn}` : "normalized input text",
    labels_observed: observedLabels.length,
    taxonomy_labels: taxonomyLabels?.length ?? null,
    taxonomy_labels_without_examples: missingTaxonomyLabels,
    majority: { label: majority.label, rows: majority.rows, share: Number(majorityShare.toFixed(4)) },
    label_support: labelSupport,
    artifacts: { report: "curation-report.md", duplicates: "curation/duplicates.jsonl", conflicts: "curation/conflicts.jsonl", unusable: "curation/unusable.jsonl" },
  };

  // The recommended first run: the majority_class floor arm is auto-included —
  // the imbalanced-classifier trap must be measured before any model claim.
  const recommendedRun = {
    split: "dev",
    models: [] as string[],
    trivial_arms: ["null_agent", "majority_class"],
    rollouts_per_task: 1,
    note: "queue with `understudy runs …` or the hub; add candidate model arms alongside the floors",
  };

  const docsDir = options.docsDir ? resolve(options.docsDir) : null;
  const contextDocs = docsDir !== null && existsSync(docsDir) && statSync(docsDir).isDirectory()
    ? readdirSync(docsDir).filter((f) => statSync(join(docsDir, f)).isFile()).sort().map((f) => join(docsDir, f))
    : [];

  const result: Obj = {
    schema_version: DATASET_FOUNDRY_SCHEMA,
    source: table.source_path,
    source_sha256: table.source_sha256,
    output_dir: output,
    benchmark_id: benchmarkId,
    mapping: { format: table.format, label_column: labelColumn, input_columns: inputColumns, group_column: groupColumn, inference_confidence: options.labelColumn ? "caller-provided" : inferred.confidence },
    system_prompt: { chars: systemPrompt.length, authored: options.systemPrompt !== undefined, sha256: createHash("sha256").update(systemPrompt).digest("hex") },
    counts: { source_rows: table.rows.length, tasks: tasks.length, labels: observedLabels.length },
    splits: {
      policy: "grouped-deterministic-deficit-greedy-v1",
      ratios,
      rows: splitCounts,
      groups: groupCounts,
      no_group_overlap: true,
      splits_sha256: asObject(benchmark.splits).splits_sha256,
    },
    curation: curationBlock,
    recommended_run: recommendedRun,
    context_docs: contextDocs,
    artifacts: {
      tasks: "tasks.jsonl",
      benchmark: "benchmark.json",
      environment: toPortablePath(output, String(environment.path)),
      normalized: "normalized-captures.jsonl",
      curation_report: "curation-report.md",
    },
    privacy: { local_only: true, contains_customer_payloads: true, upload_performed: false, provider_called: false },
    self_check: selfCheck,
    leakage_audit: environment.leakage_audit,
    oracle_pass: environment.oracle_pass,
    sentinel_pass: environment.sentinel_pass,
    experiment_linkage: {
      note: "A training run on this dataset should record experiments.jsonl data_selection.splits_sha256 = splits.splits_sha256 (the frozen split assignment).",
      splits_sha256: asObject(benchmark.splits).splits_sha256,
    },
  };
  writeFileSync(join(output, "curation-report.md"), renderCurationReport(result), { mode: 0o600 });
  writeJson(join(output, "manifest.json"), result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Curation report (Derek-readable)                                    */
/* ------------------------------------------------------------------ */

export function renderCurationReport(result: Obj): string {
  const curation = asObject(result.curation);
  const splits = asObject(result.splits);
  const rows = asObject(splits.rows);
  const majority = asObject(curation.majority);
  const support = (Array.isArray(curation.label_support) ? curation.label_support : []).map(asObject);
  const missing = (Array.isArray(curation.taxonomy_labels_without_examples) ? curation.taxonomy_labels_without_examples : []).map(String);
  const thin = support.filter((s) => Number(s.rows) > 0 && Number(s.rows) < 5);
  const lines: string[] = [];
  lines.push(`# Dataset curation report — ${result.benchmark_id}`);
  lines.push("");
  lines.push(`Source: \`${basename(String(result.source))}\` (sha256 \`${String(result.source_sha256).slice(0, 12)}…\`), ${curation.source_rows} data row(s).`);
  lines.push("");
  lines.push(`Everything below was applied AUTOMATICALLY and recorded — no silent drops, no questions. Quarantined/removed rows are listed line-by-line in \`curation/*.jsonl\`.`);
  lines.push("");
  lines.push("## What happened to your rows");
  lines.push("");
  lines.push("| Step | Rows | Why |");
  lines.push("| --- | ---: | --- |");
  lines.push(`| Source rows | ${curation.source_rows} | as loaded |`);
  lines.push(`| Unusable removed | ${curation.unusable_removed} | empty input text or empty label (curation/unusable.jsonl) |`);
  lines.push(`| Label conflicts quarantined | ${curation.conflict_rows_quarantined} | ${curation.conflict_inputs} input text(s) carry more than one label — ambiguous gold (curation/conflicts.jsonl) |`);
  lines.push(`| Exact duplicates removed | ${curation.duplicates_removed} | identical normalized input + label beyond the first (curation/duplicates.jsonl) |`);
  lines.push(`| **Kept** | **${curation.kept_rows}** | one benchmark task per row |`);
  lines.push("");
  lines.push("## Splits (grouped — leakage prevention)");
  lines.push("");
  lines.push(`Group key: ${curation.group_key}. Rows sharing a group NEVER straddle splits (zero group overlap, asserted at build time).`);
  lines.push("");
  lines.push(`- train: ${rows.train} row(s)`);
  lines.push(`- dev: ${rows.dev} row(s)`);
  lines.push(`- holdout: ${rows.holdout} row(s) — sealed for final validation`);
  lines.push("");
  lines.push(`Frozen split hash (record it as \`data_selection.splits_sha256\` in experiments.jsonl for any training run): \`${splits.splits_sha256}\``);
  lines.push("");
  lines.push("## Class balance");
  lines.push("");
  lines.push(`${curation.labels_observed} label(s) observed${curation.taxonomy_labels ? ` of ${curation.taxonomy_labels} in the taxonomy` : ""}. Majority label: ${JSON.stringify(majority.label)} — ${majority.rows} row(s), ${(Number(majority.share) * 100).toFixed(1)}% of the data.`);
  lines.push("");
  lines.push(`Because of this imbalance, the recommended first run INCLUDES the majority_class floor arm: any model must beat ${(Number(majority.share) * 100).toFixed(1)}% before its accuracy means anything.`);
  if (missing.length > 0) {
    lines.push("");
    lines.push(`${missing.length} taxonomy label(s) have NO examples in this dataset (a trained model cannot learn them from it):`);
    for (const label of missing.slice(0, 25)) lines.push(`- ${label}`);
    if (missing.length > 25) lines.push(`- … ${missing.length - 25} more (see manifest.json curation.taxonomy_labels_without_examples)`);
  }
  if (thin.length > 0) {
    lines.push("");
    lines.push(`${thin.length} label(s) have fewer than 5 examples — results on them are anecdotal:`);
    for (const s of thin.slice(0, 25)) lines.push(`- ${s.label} (${s.rows})`);
    if (thin.length > 25) lines.push(`- … ${thin.length - 25} more`);
  }
  lines.push("");
  lines.push("## Top labels");
  lines.push("");
  lines.push("| Label | Rows | Train | Dev | Holdout |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const s of support.slice(0, 20)) lines.push(`| ${s.label} | ${s.rows} | ${s.train} | ${s.dev} | ${s.holdout} |`);
  if (support.length > 20) lines.push(`| … ${support.length - 20} more (manifest.json curation.label_support) | | | | |`);
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push("1. `understudy benchmarks rigor <dir>` after the first run — floors + per-class accuracy land in rigor-report.md.");
  lines.push("2. Queue the recommended run (null_agent + majority_class floors alongside your candidate models).");
  lines.push("3. Training? Record the frozen split hash above in experiments.jsonl before any provider spend.");
  lines.push("");
  return lines.join("\n");
}
