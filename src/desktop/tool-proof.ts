import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { packagePath } from "../internal/package-root.js";

export interface ToolProofCandidate {
  label: string;
  slotId: number;
}

export interface RunToolProofOptions {
  candidates: ToolProofCandidate[];
  suite: "core" | "hard";
  repetitions: number;
  maxTokens: number;
  timeoutMs: number;
  outputRoot?: string;
  taskIds?: string[];
  manageResidency: boolean;
  executionMode?: "direct-pi" | "desktop-api";
  onProgress?: (line: string) => void;
}

export interface ToolProofCandidateSummary {
  slot_id: number | null;
  model_id: string | null;
  runtime_backend: string | null;
  strict_passes: number;
  attempts: number;
  strict_accuracy: number;
  exact_call_count_rate: number;
  exact_name_rate: number;
  exact_arguments_rate: number;
  successful_result_rate: number;
  exact_output_rate: number;
  parse_errors: number;
  terminal_errors: number;
  orphan_results: number;
  mean_latency_ms: number;
  total_tokens: number;
  failures: Array<Record<string, unknown>>;
}

export interface ToolProofSummary {
  format: "understudy.desktop_tool_proof.v3";
  proof_id: string;
  suite: "core" | "hard";
  source_task_file: string;
  suite_sha256: string;
  started_at: string;
  completed_at: string;
  api_version: string;
  event_schema: string;
  task_count: number;
  repetitions: number;
  run_count: number;
  timeout_ms: number;
  execution_mode: string;
  residency_mode: string;
  release_cohort_eligible: false;
  tool_schema_sha256: string | null;
  candidates: Record<string, ToolProofCandidateSummary>;
}

export interface ToolProofResult {
  output_dir: string;
  summary: ToolProofSummary;
  evidence: ToolProofEvidenceAudit;
}

export interface ToolProofEvidenceAudit {
  private_files: boolean;
  suite_hash_matches: boolean;
  result_rows: number;
  event_files: number;
  expected_rows: number;
  complete: boolean;
}

export interface ToolProofImprovementResult {
  path: string;
  packet: {
    format: "understudy.desktop_tool_improvement.v1";
    proof_id: string;
    suite: "core" | "hard";
    suite_sha256: string;
    tool_schema_sha256: string | null;
    objective: "maximize_strict_tool_correctness";
    recommended_method: "gepa_prompt_policy_first" | "no_repair_needed";
    failure_count: number;
    failures: Array<Record<string, unknown>>;
    uploads_performed: false;
  };
}

type RunnerModule = {
  runProof(options: Record<string, unknown>): Promise<{
    outputDir: string;
    rows: Array<Record<string, unknown>>;
    summary: ToolProofSummary;
  }>;
};

export const DEFAULT_TOOL_PROOF_ROOT = join(
  homedir(),
  ".understudy",
  "proofs",
  "tool-correctness",
);

function validateCandidates(candidates: ToolProofCandidate[]): void {
  if (candidates.length < 1) throw new Error("provide at least one tool-proof candidate");
  const labels = new Set<string>();
  const slots = new Set<number>();
  for (const candidate of candidates) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(candidate.label) || labels.has(candidate.label)) {
      throw new Error(`candidate label must be unique and URL-safe: ${candidate.label}`);
    }
    if (!Number.isInteger(candidate.slotId) || candidate.slotId <= 0 || slots.has(candidate.slotId)) {
      throw new Error(`candidate slot must be a unique positive integer: ${candidate.slotId}`);
    }
    labels.add(candidate.label);
    slots.add(candidate.slotId);
  }
}

export async function runDesktopToolProof(options: RunToolProofOptions): Promise<ToolProofResult> {
  validateCandidates(options.candidates);
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) {
    throw new Error("repetitions must be an integer from 1 to 20");
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 16 || options.maxTokens > 2_048) {
    throw new Error("maxTokens must be an integer from 16 to 2048");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 300_000) {
    throw new Error("timeoutMs must be an integer from 1000 to 300000");
  }
  const runnerUrl = pathToFileURL(
    packagePath("experiments", "desktop-tool-proof", "run.mjs"),
  );
  const runner = await import(runnerUrl.href) as RunnerModule;
  const result = await runner.runProof({
    candidates: options.candidates,
    suite: options.suite,
    repetitions: options.repetitions,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    outputRoot: resolve(options.outputRoot ?? DEFAULT_TOOL_PROOF_ROOT),
    taskIds: options.taskIds ?? [],
    executionMode: options.executionMode ?? "direct-pi",
    manageResidency: options.manageResidency,
    onProgress: options.onProgress,
    reportResult: false,
  });
  return auditToolProof(result.outputDir, result.summary);
}

function isSummary(value: unknown): value is ToolProofSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.format === "understudy.desktop_tool_proof.v3"
    && typeof row.proof_id === "string"
    && (row.suite === "core" || row.suite === "hard")
    && typeof row.suite_sha256 === "string"
    && typeof row.completed_at === "string"
    && row.candidates != null
    && typeof row.candidates === "object";
}

export function listDesktopToolProofs(
  root = DEFAULT_TOOL_PROOF_ROOT,
  limit = 20,
): ToolProofResult[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw cause;
  }
  return entries.flatMap((entry) => {
    const outputDir = join(root, entry);
    const path = join(outputDir, "summary.json");
    try {
      const metadata = statSync(path);
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return [];
      const summary = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isSummary(summary) ? [auditToolProof(outputDir, summary)] : [];
    } catch {
      return [];
    }
  }).sort((left, right) =>
    right.summary.completed_at.localeCompare(left.summary.completed_at)
  ).slice(0, limit);
}

function isPrivateFile(path: string): boolean {
  try {
    const metadata = statSync(path);
    return metadata.isFile() && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

function auditToolProof(outputDir: string, summary: ToolProofSummary): ToolProofResult {
  const summaryPath = join(outputDir, "summary.json");
  const resultsPath = join(outputDir, "results.jsonl");
  const tasksPath = join(outputDir, "tasks.json");
  const requiredFiles = [summaryPath, resultsPath, tasksPath];
  let rows: Array<Record<string, unknown>> = [];
  let suiteHashMatches = false;
  try {
    const taskBytes = readFileSync(tasksPath);
    suiteHashMatches = createHash("sha256").update(taskBytes).digest("hex") === summary.suite_sha256;
    rows = readFileSync(resultsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    rows = [];
  }
  let eventFiles: string[] = [];
  try {
    eventFiles = readdirSync(outputDir)
      .filter((entry) => entry.endsWith(".events.jsonl"))
      .map((entry) => join(outputDir, entry));
  } catch {
    eventFiles = [];
  }
  const expectedRows = Number.isInteger(summary.run_count) ? summary.run_count : 0;
  const rowsConsistent = expectedRows > 0
    && rows.length === expectedRows
    && rows.every((row) =>
      row.proof_id === summary.proof_id
      && row.suite === summary.suite
      && row.suite_sha256 === summary.suite_sha256
      && typeof row.canonical_event_count === "number"
      && row.canonical_event_count > 0,
    );
  const privateFiles = [...requiredFiles, ...eventFiles].every(isPrivateFile);
  const complete = privateFiles
    && suiteHashMatches
    && rowsConsistent
    && eventFiles.length === expectedRows
    && typeof summary.tool_schema_sha256 === "string"
    && summary.tool_schema_sha256.length === 64;
  return {
    output_dir: outputDir,
    summary,
    evidence: {
      private_files: privateFiles,
      suite_hash_matches: suiteHashMatches,
      result_rows: rows.length,
      event_files: eventFiles.length,
      expected_rows: expectedRows,
      complete,
    },
  };
}

export function prepareDesktopToolProofImprovement(
  proofId: string,
  root = DEFAULT_TOOL_PROOF_ROOT,
): ToolProofImprovementResult {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(proofId)) {
    throw new Error("proof id is invalid");
  }
  const outputDir = join(resolve(root), proofId);
  const summaryPath = join(outputDir, "summary.json");
  const resultsPath = join(outputDir, "results.jsonl");
  const tasksPath = join(outputDir, "tasks.json");
  const summaryMetadata = statSync(summaryPath);
  const resultsMetadata = statSync(resultsPath);
  const tasksMetadata = statSync(tasksPath);
  if (
    process.platform !== "win32"
    && (
      (summaryMetadata.mode & 0o077) !== 0
      || (resultsMetadata.mode & 0o077) !== 0
      || (tasksMetadata.mode & 0o077) !== 0
    )
  ) {
    throw new Error("proof evidence permissions are broader than 0600");
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
  if (!isSummary(summary) || summary.proof_id !== proofId) {
    throw new Error("proof summary is invalid or does not match its directory");
  }
  if (!auditToolProof(outputDir, summary).evidence.complete) {
    throw new Error("proof evidence is incomplete or does not match its immutable hashes");
  }
  const rows = readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`proof result ${index + 1} is not an object`);
      }
      return value as Record<string, unknown>;
    });
  const taskOutputById = new Map<string, unknown>();
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as unknown;
  if (!Array.isArray(tasks)) throw new Error("proof tasks are invalid");
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const candidate = task as Record<string, unknown>;
    if (typeof candidate.id === "string") {
      taskOutputById.set(candidate.id, candidate.expected_output ?? null);
    }
  }
  const failures = rows.filter((row) => row.strict_pass !== true).map((row) => ({
    candidate: row.candidate,
    model_id: row.model_id,
    repetition: row.repetition,
    task_id: row.task_id,
    expected_calls: row.expected_calls,
    observed_call_sequence: row.call_sequence,
    expected_output: row.expected_output ?? taskOutputById.get(String(row.task_id)) ?? null,
    observed_output: row.output,
    checks: row.checks,
    terminal_error: row.terminal_error,
  }));
  const packet: ToolProofImprovementResult["packet"] = {
    format: "understudy.desktop_tool_improvement.v1",
    proof_id: summary.proof_id,
    suite: summary.suite,
    suite_sha256: summary.suite_sha256,
    tool_schema_sha256: summary.tool_schema_sha256,
    objective: "maximize_strict_tool_correctness",
    recommended_method: failures.length ? "gepa_prompt_policy_first" : "no_repair_needed",
    failure_count: failures.length,
    failures,
    uploads_performed: false,
  };
  const path = join(outputDir, "improvement.json");
  try {
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const metadata = statSync(path);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("improvement evidence permissions are broader than 0600");
    }
    const existing = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify(packet)) {
      throw new Error("refusing to replace immutable improvement evidence");
    }
  }
  return { path, packet };
}
