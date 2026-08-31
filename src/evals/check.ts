import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { z, type ZodType } from "zod";

import {
  EvalApprovalSchema,
  EvalCheckFixturesSchema,
  EvalCheckReportSchema,
  EvalCoverageSchema,
  EvalEnvironmentSchema,
  EvalExecutionIndexRowSchema,
  EvalExportProofSchema,
  EvalHarnessSchema,
  EvalMetricSchema,
  EvalSourceRowSchema,
  EvalSplitsSchema,
  WorkloadEvalProjectSchema,
  type EvalCheckFixtures,
  type EvalCheckReport,
} from "./authoring-contracts.js";
import { deriveWorkloadEvalId } from "../eval-project.js";
import { replacePrivateJson } from "./build-state.js";
import { canonicalJson, compareCodeUnits } from "./canonical.js";
import {
  runInProviderFreeSandbox,
  snapshotModuleTree,
  type ModuleTreeSnapshot,
} from "./module-sandbox.js";

type JsonObject = Record<string, unknown>;

export interface EvalCheckResult {
  status: "passed";
  publishable: boolean;
  report: EvalCheckReport;
  report_file: string;
  coverage: {
    lineage: { complete: number; ambiguous: number; unlinked: number };
    execution_modes: Array<{ name: string; observed_count: number; disposition: "covered" | "owner_accepted_uncovered" }>;
    failure_classes: Array<{ name: string; observed_count: number; disposition: "covered" | "owner_accepted_uncovered" }>;
  };
  hashes: {
    workload_profile_sha256: string;
    metric_sha256: string;
    eval_set_sha256: string;
    coverage_sha256: string;
    environment_sha256: string;
    verifier_sha256: string;
    check_report_sha256: string;
  };
}

export interface RunEvalCheckOptions {
  now?: Date;
}

const BenchmarkTaskSchema = z.object({
  schema_version: z.literal("understudy.benchmark_task.v1"),
  task_id: z.string().min(1),
  execution_group: z.string().min(1),
  title: z.string().min(1),
  split: z.enum(["construction", "fit", "heldout"]),
  outcome_contract: z.object({
    required: z.array(z.unknown()).min(1),
    forbidden: z.array(z.unknown()),
  }).passthrough(),
}).passthrough();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(path: string, schema: ZodType<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${root}${sep}..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function existingProjectPath(projectRoot: string, value: string, label: string): string {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.split("/").includes("..")) {
    throw new Error(`${label} artifact path must remain inside the eval project.`);
  }
  const candidate = resolve(projectRoot, value);
  if (!inside(projectRoot, candidate)) throw new Error(`${label} artifact path must remain inside the eval project.`);
  let cursor = projectRoot;
  for (const component of relative(projectRoot, candidate).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} artifact path cannot traverse symbolic links.`);
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  const real = realpathSync(candidate);
  if (!inside(projectRoot, real)) throw new Error(`${label} artifact path must remain inside the eval project.`);
  return real;
}

function reportPath(projectRoot: string, value: string): string {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.split("/").includes("..")) {
    throw new Error("check report artifact path must remain inside the eval project.");
  }
  const candidate = resolve(projectRoot, value);
  if (!inside(projectRoot, candidate)) throw new Error("check report artifact path must remain inside the eval project.");
  const parent = dirname(candidate);
  let cursor = projectRoot;
  for (const component of relative(projectRoot, parent).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error("check report artifact path cannot traverse symbolic links.");
      if (!stat.isDirectory()) throw new Error("check report parent must contain only directories.");
      if (!inside(projectRoot, realpathSync(cursor))) throw new Error("check report artifact path must remain inside the eval project.");
      continue;
    }
    mkdirSync(cursor, { mode: 0o700 });
    chmodSync(cursor, 0o700);
  }
  if (!inside(projectRoot, realpathSync(parent))) throw new Error("check report artifact path must remain inside the eval project.");
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    throw new Error("check report artifact path cannot be a symbolic link.");
  }
  return candidate;
}

function regularFile(path: string, label: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  return readFileSync(path);
}

function readJsonl(path: string, schema: ZodType): unknown[] {
  const text = regularFile(path, "tasks").toString("utf8");
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) { throw new Error(`Invalid tasks JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid task at line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
  if (rows.length === 0) throw new Error("Eval task set is empty.");
  return rows;
}

function validateCoverageTaskIds(
  coverage: ReturnType<typeof EvalCoverageSchema.parse>,
  taskIds: Set<string>,
  failureTaxonomy: string[],
): void {
  for (const [label, entries] of [["execution mode", coverage.execution_modes], ["failure class", coverage.failure_classes]] as const) {
    if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
      throw new Error(`Coverage ${label} names must be unique.`);
    }
  }
  for (const entry of [...coverage.execution_modes, ...coverage.failure_classes]) {
    for (const taskId of entry.task_ids) {
      if (!taskIds.has(taskId)) throw new Error(`Coverage references unknown task ${taskId}.`);
    }
  }
  const modeTaskIds = new Set(coverage.execution_modes.flatMap((entry) => entry.task_ids));
  for (const taskId of taskIds) {
    if (!modeTaskIds.has(taskId)) throw new Error(`Coverage execution modes do not account for eval task ${taskId}.`);
  }
  const failureClassNames = new Set(coverage.failure_classes.map((entry) => entry.name));
  for (const failure of failureTaxonomy) {
    if (!failureClassNames.has(failure)) throw new Error(`Coverage does not account for metric failure class ${failure}.`);
  }
}

function validateSplitTaskIds(splits: ReturnType<typeof EvalSplitsSchema.parse>, tasks: Map<string, JsonObject>): void {
  const listed = [...splits.construction, ...splits.fit, ...splits.heldout];
  if (new Set(listed).size !== listed.length) throw new Error("Eval splits contain duplicate task ids.");
  for (const [section, ids] of Object.entries(splits).filter(([name]) => name !== "schema_version") as ["construction" | "fit" | "heldout", string[]][]) {
    for (const taskId of ids) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Eval splits reference unknown task ${taskId}.`);
      if (task.split !== section) throw new Error(`Eval task ${taskId} declares split ${String(task.split)} but splits.json places it in ${section}.`);
    }
  }
  for (const taskId of tasks.keys()) if (!listed.includes(taskId)) throw new Error(`Eval task ${taskId} is missing from splits.json.`);
}

interface CheckExecutionTree {
  environment: ModuleTreeSnapshot;
  verifier: ModuleTreeSnapshot;
}

async function runFixture(
  projectRoot: string,
  fixture: EvalCheckFixtures["representative"] | EvalCheckFixtures["intentionally_wrong"],
  tasks: Map<string, unknown>,
  execution: CheckExecutionTree,
  timeoutMs: number,
): Promise<{ passed: boolean; feedback: string; candidateSha256: string; stateSha256: string | null; replaySha256: string }> {
  const task = tasks.get(fixture.task_id);
  if (!task) throw new Error(`Check fixture references unknown task ${fixture.task_id}.`);
  const candidatePath = existingProjectPath(projectRoot, fixture.candidate, "fixture candidate");
  const candidateBytes = regularFile(candidatePath, "fixture candidate");
  const candidate = JSON.parse(candidateBytes.toString("utf8")) as unknown;
  const statePath = fixture.state === undefined ? null : existingProjectPath(projectRoot, fixture.state, "fixture state");
  const stateBytes = statePath === null ? null : regularFile(statePath, "fixture state");
  const state = stateBytes === null ? undefined : JSON.parse(stateBytes.toString("utf8")) as unknown;
  const childResult = await runInProviderFreeSandbox(execution.environment, execution.verifier, { task, candidate, state }, timeoutMs);
  const repeatedResult = await runInProviderFreeSandbox(execution.environment, execution.verifier, { task, candidate, state }, timeoutMs);
  if (canonicalJson(childResult) !== canonicalJson(repeatedResult)) {
    throw new Error("Local environment and verifier produced different results for the same fixture input.");
  }
  const replayed = childResult.replay;
  const replayObject = z.record(z.string(), z.unknown()).safeParse(replayed);
  if (!replayObject.success) throw new Error(`Local environment replay returned an invalid result: ${z.prettifyError(replayObject.error)}`);
  const raw = childResult.verification;
  const parsed = z.object({ passed: z.boolean(), feedback: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) throw new Error(`Local verifier returned an invalid result: ${z.prettifyError(parsed.error)}`);
  return {
    ...parsed.data,
    candidateSha256: sha256(candidateBytes),
    stateSha256: stateBytes === null ? null : sha256(stateBytes),
    replaySha256: sha256(canonicalJson(replayObject.data)),
  };
}

export function descriptorHash(entries: { path: string; sha256: string }[]): string {
  return sha256(canonicalJson([...entries].sort((left, right) => compareCodeUnits(left.path, right.path))));
}

function sameReport(left: EvalCheckReport, right: EvalCheckReport): boolean {
  const { checked_at: _leftAt, ...leftStable } = left;
  const { checked_at: _rightAt, ...rightStable } = right;
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertExactSourceProof(
  project: ReturnType<typeof WorkloadEvalProjectSchema.parse>,
  proof: ReturnType<typeof EvalExportProofSchema.parse>,
  proofSha256: string,
): void {
  const windowStart = new Date(project.source.window.from).valueOf();
  const windowEnd = new Date(project.source.window.to).valueOf();
  if (windowEnd - windowStart !== 7 * 86_400_000) throw new Error("Eval source window must be exactly seven days.");
  if (project.source.window.ingestion_cutoff !== project.source.window.to) {
    throw new Error("Eval source ingestion cutoff must equal the frozen window end.");
  }
  for (const key of ["org_id", "project_id", "workload_id"] as const) {
    if (project.source.window[key] !== project.identity[key]) {
      throw new Error(`Eval source window ${key} does not match project identity.`);
    }
  }
  if (proofSha256 !== project.source.export_proof_sha256) throw new Error("Export proof hash does not match eval-project.json.");
  if (!sameJson(proof.canonical_scope, project.source.window)) throw new Error("Export proof canonical scope does not match eval-project.json.");
  if (!sameJson(proof.verified_receipt.canonical_scope, proof.canonical_scope)) {
    throw new Error("Verified export receipt canonical scope does not match its proof.");
  }
  const receipt = proof.verified_receipt;
  const expectedScopeHash = sha256(JSON.stringify(proof.canonical_scope));
  if (receipt.scope_hash !== expectedScopeHash) {
    throw new Error("Verified export receipt scope hash does not match the canonical scope.");
  }
  if (proof.segment_manifest_sha256.length !== receipt.segment_index + 1) {
    throw new Error("Export proof manifest chain length does not match the verified terminal segment.");
  }
  if (new Set(proof.segment_manifest_sha256).size !== proof.segment_manifest_sha256.length) {
    throw new Error("Export proof manifest chain contains duplicate segment hashes.");
  }
  if (proof.segment_manifest_sha256.at(-1) !== receipt.manifest_sha256) {
    throw new Error("Export proof terminal manifest does not match the verified receipt.");
  }
  const expectedPrevious = receipt.segment_index === 0 ? null : proof.segment_manifest_sha256.at(-2) ?? null;
  if (receipt.previous_manifest_sha256 !== expectedPrevious) {
    throw new Error("Export proof previous manifest does not match the verified receipt chain.");
  }
  if (
    receipt.cumulative_exported !== project.source.exported_capture_count ||
    receipt.total_bytes !== project.source.exported_total_bytes
  ) throw new Error("Verified export receipt totals do not match eval-project.json.");
  if (
    project.source.capture_count !== project.source.exported_capture_count ||
    project.source.size_bytes !== project.source.exported_total_bytes
  ) throw new Error("Local eval source totals do not match the verified export totals.");
}

export async function runEvalCheck(projectInput: string, options: RunEvalCheckOptions = {}): Promise<EvalCheckResult> {
  const projectRoot = realpathSync(resolve(projectInput));
  if (!lstatSync(projectRoot).isDirectory()) throw new Error("Eval project must be a directory.");
  const project = parseJson(existingProjectPath(projectRoot, "eval-project.json", "eval project"), WorkloadEvalProjectSchema, "eval-project.json");
  if (!project.authoring.semantic_preparation_performed || project.status === "source_materialized") {
    throw new Error("Eval project contains only source material; the coding agent must author the semantic artifacts before checking.");
  }
  const expectedEvalId = deriveWorkloadEvalId({ name: project.name, identity: project.identity, sourceWindow: project.source.window });
  if (project.eval_id !== expectedEvalId) throw new Error("Eval id does not match the project name, identity, and frozen source window.");
  const declaredPaths = [project.source.index, project.source.export_proof, ...Object.values(project.artifacts)];
  if (new Set(declaredPaths).size !== declaredPaths.length) throw new Error("Eval project artifact paths must be unique; duplicate aliases are not allowed.");

  const indexPath = existingProjectPath(projectRoot, project.source.index, "source index");
  const indexBytes = regularFile(indexPath, "source index");
  if (sha256(indexBytes) !== project.source.index_sha256) throw new Error("Source index hash does not match eval-project.json.");
  const sourceRows = indexBytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) { throw new Error(`Invalid source index line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    const parsed = EvalSourceRowSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid source index line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
  if (sourceRows.length !== project.source.capture_count) throw new Error("Source index capture count does not match eval-project.json.");
  if (sourceRows.reduce((sum, row) => sum + row.size_bytes, 0) !== project.source.size_bytes) throw new Error("Source index byte count does not match eval-project.json.");
  const sourcePaths = new Set<string>();
  const sourceCaptureKeys = new Set<string>();
  const sourceRowsByPath = new Map<string, (typeof sourceRows)[number]>();
  const sourceCapturePaths: string[] = [];
  for (const row of sourceRows) {
    if (sourcePaths.has(row.local_path)) throw new Error(`Source index contains duplicate local path ${row.local_path}.`);
    if (sourceCaptureKeys.has(row.capture_key)) throw new Error(`Source index contains duplicate capture key ${row.capture_key}.`);
    sourcePaths.add(row.local_path);
    sourceCaptureKeys.add(row.capture_key);
    sourceRowsByPath.set(row.local_path, row);
    const capturePath = existingProjectPath(projectRoot, row.local_path, "source capture");
    sourceCapturePaths.push(capturePath);
    const capture = regularFile(capturePath, "source capture");
    if (capture.byteLength !== row.size_bytes || sha256(capture) !== row.content_sha256) {
      throw new Error(`Source capture integrity check failed for request ${row.request_id}.`);
    }
  }
  const proofPath = existingProjectPath(projectRoot, project.source.export_proof, "export proof");
  const proofBytes = regularFile(proofPath, "export proof");
  const proof = parseJson(proofPath, EvalExportProofSchema, "export-proof.json");
  const exportProofSha256 = sha256(proofBytes);
  assertExactSourceProof(project, proof, exportProofSha256);

  const profilePath = existingProjectPath(projectRoot, project.artifacts.workload_profile, "workload profile");
  const profileBytes = regularFile(profilePath, "workload profile");
  if (profileBytes.toString("utf8").trim().length < 20) throw new Error("Workload profile is missing or too short to record confirmed intent.");
  const metricPath = existingProjectPath(projectRoot, project.artifacts.metric, "metric");
  const metricBytes = regularFile(metricPath, "metric");
  const metric = parseJson(metricPath, EvalMetricSchema, "metric.json");
  const approvalPath = existingProjectPath(projectRoot, project.artifacts.approval, "approval");
  const approval = parseJson(approvalPath, EvalApprovalSchema, "approval.json");
  const workloadProfileSha256 = sha256(profileBytes);
  const metricSha256 = sha256(metricBytes);
  if (approval.workload_profile_sha256 !== workloadProfileSha256) throw new Error("Intent approval does not match the current workload profile hash.");
  if (approval.metric_sha256 !== metricSha256) throw new Error("Intent approval does not match the current metric hash.");
  if (approval.approver !== metric.approved_by) throw new Error("Metric approval and workload intent must be confirmed by the same owner identity.");
  const checkTime = options.now ?? new Date();
  const createdAt = new Date(project.created_at).valueOf();
  const metricApprovedAt = new Date(metric.approved_at).valueOf();
  const intentConfirmedAt = new Date(approval.intent_confirmed_at).valueOf();
  if (createdAt > metricApprovedAt) throw new Error("Metric approval cannot occur before eval project creation.");
  if (metricApprovedAt > intentConfirmedAt) throw new Error("Intent confirmation cannot occur before metric approval.");
  if (intentConfirmedAt > checkTime.valueOf()) throw new Error("Intent confirmation cannot occur after the eval check.");

  const tasksPath = existingProjectPath(projectRoot, project.artifacts.tasks, "tasks");
  const tasksBytes = regularFile(tasksPath, "tasks");
  const taskRows = readJsonl(tasksPath, BenchmarkTaskSchema) as JsonObject[];
  const taskIds = new Set(taskRows.map((task) => String(task.task_id)));
  if (taskIds.size !== taskRows.length) throw new Error("Eval task ids must be unique.");
  const taskMap = new Map(taskRows.map((task) => [String(task.task_id), task]));

  const coveragePath = existingProjectPath(projectRoot, project.artifacts.coverage, "coverage");
  const coverageBytes = regularFile(coveragePath, "coverage");
  const coverage = parseJson(coveragePath, EvalCoverageSchema, "coverage.json");
  validateCoverageTaskIds(coverage, taskIds, metric.failure_taxonomy);
  const executionIndexPath = existingProjectPath(projectRoot, project.artifacts.execution_index, "execution index");
  const executionIndexBytes = regularFile(executionIndexPath, "execution index");
  if (sha256(executionIndexBytes) !== coverage.lineage.execution_index_sha256) throw new Error("Coverage lineage hash does not match the execution index.");
  const executionRows = readJsonl(executionIndexPath, EvalExecutionIndexRowSchema) as ReturnType<typeof EvalExecutionIndexRowSchema.parse>[];
  const lineageCounts = { complete: 0, ambiguous: 0, unlinked: 0 };
  const completeTaskIds = new Set<string>();
  const completeTaskGroups = new Map<string, string>();
  const executionGroups = new Set<string>();
  const indexedSourceFiles = new Set<string>();
  let indexedCaptureCount = 0;
  let executionCount = 0;
  for (const row of executionRows) {
    if (row.source_status === "included") {
      executionCount += 1;
      const executionGroup = row.execution_group;
      if (executionGroups.has(executionGroup)) throw new Error(`Execution index contains duplicate execution group ${executionGroup}.`);
      executionGroups.add(executionGroup);
      const status = row.lineage_status;
      lineageCounts[status] += 1;
      if (typeof row.task_id === "string" && !taskIds.has(row.task_id)) {
        throw new Error(`Execution index references unknown eval task ${row.task_id}.`);
      }
      if (status !== "complete" && row.task_id !== null) throw new Error(`Uncertain lineage ${row.execution_group} cannot become an eval task.`);
      if (status === "complete" && typeof row.task_id === "string") {
        const task = taskMap.get(row.task_id);
        if (task?.execution_group !== row.execution_group) {
          throw new Error(`Eval task ${row.task_id} does not match complete execution group ${row.execution_group}.`);
        }
        const priorGroup = completeTaskGroups.get(row.task_id);
        if (priorGroup !== undefined && priorGroup !== row.execution_group) {
          throw new Error(`Eval task ${row.task_id} is bound to more than one complete execution group.`);
        }
        completeTaskGroups.set(row.task_id, row.execution_group);
        completeTaskIds.add(row.task_id);
      }
    }
    if (row.capture_count !== row.source_files.length) {
      throw new Error("Execution index capture count does not match its bound source files.");
    }
    indexedCaptureCount += row.capture_count;
    for (const sourceFile of row.source_files) {
      if (indexedSourceFiles.has(sourceFile.local_path)) {
        throw new Error(`Execution index binds source file ${sourceFile.local_path} more than once.`);
      }
      indexedSourceFiles.add(sourceFile.local_path);
      const sourceRow = sourceRowsByPath.get(sourceFile.local_path);
      if (!sourceRow || sourceRow.content_sha256 !== sourceFile.content_sha256) {
        throw new Error(`Execution index source binding ${sourceFile.local_path} is not present in source/index.jsonl.`);
      }
    }
  }
  if (indexedCaptureCount !== project.source.capture_count) throw new Error("Execution index capture total does not match the frozen source index.");
  if (indexedSourceFiles.size !== sourceRows.length || sourceRows.some((row) => !indexedSourceFiles.has(row.local_path))) {
    throw new Error("Execution index does not account for every frozen source file exactly once.");
  }
  const observedExecutionCount = coverage.execution_modes.reduce((sum, entry) => sum + entry.observed_count, 0);
  if (observedExecutionCount !== executionCount) {
    throw new Error("Coverage execution-mode observed counts do not match the execution index.");
  }
  if (JSON.stringify(lineageCounts) !== JSON.stringify(coverage.lineage.counts)) throw new Error("Coverage lineage counts do not match the execution index.");
  for (const taskId of taskIds) if (!completeTaskIds.has(taskId)) throw new Error(`Eval task ${taskId} lacks a complete execution lineage row.`);
  const analysisPath = existingProjectPath(projectRoot, project.artifacts.analysis, "analysis");
  if (regularFile(analysisPath, "analysis").toString("utf8").trim().length === 0) throw new Error("Trace analysis is empty.");
  const splitsPath = existingProjectPath(projectRoot, project.artifacts.splits, "splits");
  const splitsBytes = regularFile(splitsPath, "splits");
  const splits = parseJson(splitsPath, EvalSplitsSchema, "splits.json");
  validateSplitTaskIds(splits, taskMap);

  const harnessPath = existingProjectPath(projectRoot, project.artifacts.harness, "harness");
  const harnessBytes = regularFile(harnessPath, "harness");
  const harness = parseJson(harnessPath, EvalHarnessSchema, "harness.json");
  const environmentPath = existingProjectPath(projectRoot, project.artifacts.environment, "environment");
  const environmentBytes = regularFile(environmentPath, "environment");
  const environment = parseJson(environmentPath, EvalEnvironmentSchema, "environment.json");
  if (environment.provider_calls !== false) throw new Error("Eval checking must remain provider-free.");
  if (metric.validator.entrypoint !== harness.verifier_entrypoint) throw new Error("Metric and harness must name the same local verifier entrypoint.");
  if (environment.adapter !== harness.environment_entrypoint) throw new Error("Environment and harness must name the same local replay adapter.");
  const verifierRoot = existingProjectPath(projectRoot, project.artifacts.verifier, "verifier");
  const verifierEntrypoint = existingProjectPath(projectRoot, harness.verifier_entrypoint, "verifier entrypoint");
  if (!inside(verifierRoot, verifierEntrypoint)) throw new Error("Verifier entrypoint must be inside the verifier artifact directory.");
  const environmentEntrypoint = existingProjectPath(projectRoot, harness.environment_entrypoint, "environment entrypoint");
  const environmentRoot = dirname(environmentEntrypoint);
  if (environmentRoot === projectRoot || verifierRoot === projectRoot) {
    throw new Error("Environment and verifier modules must use dedicated project-local directories.");
  }
  if (pathsOverlap(environmentRoot, verifierRoot)) {
    throw new Error("Environment and verifier module directories must be disjoint and cannot contain one another.");
  }
  const fixturePath = existingProjectPath(projectRoot, environment.fixtures, "check fixtures");
  const fixtureBytes = regularFile(fixturePath, "check fixtures");
  const fixtures = parseJson(fixturePath, EvalCheckFixturesSchema, "check fixtures (independent correctness evidence is required)");
  const fixtureDataPaths = [fixturePath];
  for (const fixture of [fixtures.representative, fixtures.known_good, fixtures.intentionally_wrong]) {
    fixtureDataPaths.push(existingProjectPath(projectRoot, fixture.candidate, "fixture candidate"));
    if (fixture.state !== undefined) fixtureDataPaths.push(existingProjectPath(projectRoot, fixture.state, "fixture state"));
  }
  const protectedPaths = [
    indexPath,
    proofPath,
    ...sourceCapturePaths,
    ...fixtureDataPaths,
    resolve(projectRoot, project.artifacts.check_report),
  ];
  for (const protectedPath of protectedPaths) {
    if (inside(environmentRoot, protectedPath) || inside(verifierRoot, protectedPath)) {
      throw new Error("Source, fixture, state, candidate, and report paths must remain outside executable module trees.");
    }
  }
  const execution: CheckExecutionTree = {
    environment: snapshotModuleTree(environmentRoot, environmentEntrypoint, "Environment module tree"),
    verifier: snapshotModuleTree(verifierRoot, verifierEntrypoint, "Verifier module tree"),
  };

  const representative = await runFixture(projectRoot, fixtures.representative, taskMap, execution, harness.timeout_ms);
  if (!representative.passed) throw new Error(`Representative provider-free replay failed: ${representative.feedback}`);
  const oracle = await runFixture(projectRoot, fixtures.known_good, taskMap, execution, harness.timeout_ms);
  if (!oracle.passed) throw new Error(`Known-good fixture was rejected: ${oracle.feedback}`);
  const wrong = await runFixture(projectRoot, fixtures.intentionally_wrong, taskMap, execution, harness.timeout_ms);
  if (wrong.passed) throw new Error(`Intentionally wrong fixture was accepted: ${wrong.feedback}`);

  const evalSetSha256 = descriptorHash([
    { path: project.artifacts.tasks, sha256: sha256(tasksBytes) },
    { path: project.artifacts.harness, sha256: sha256(harnessBytes) },
    { path: project.artifacts.metric, sha256: metricSha256 },
    { path: project.artifacts.splits, sha256: sha256(splitsBytes) },
  ]);
  const coverageSha256 = sha256(coverageBytes);
  const environmentInputs = [
    { path: project.artifacts.environment, sha256: sha256(environmentBytes) },
    { path: `${relative(projectRoot, environmentRoot).split(sep).join("/")}/`, sha256: execution.environment.sha256 },
    { path: environment.fixtures, sha256: sha256(fixtureBytes) },
  ];
  for (const fixture of [fixtures.representative, fixtures.known_good, fixtures.intentionally_wrong]) {
    if (fixture.state !== undefined && !environmentInputs.some((entry) => entry.path === fixture.state)) {
      environmentInputs.push({ path: fixture.state, sha256: sha256(regularFile(existingProjectPath(projectRoot, fixture.state, "fixture state"), "fixture state")) });
    }
  }
  const environmentSha256 = descriptorHash(environmentInputs);
  const verifierSha256 = execution.verifier.sha256;
  const sourceBinding = {
    scope: project.source.window,
    scope_sha256: proof.verified_receipt.scope_hash,
    index_sha256: project.source.index_sha256,
    export_proof_sha256: exportProofSha256,
    capture_count: project.source.capture_count,
    size_bytes: project.source.size_bytes,
  };
  const checkInputSha256 = sha256(canonicalJson({
    source: sourceBinding,
    workload_profile_sha256: workloadProfileSha256,
    metric_sha256: metricSha256,
    eval_set_sha256: evalSetSha256,
    coverage_sha256: coverageSha256,
    execution_index_sha256: sha256(executionIndexBytes),
    environment_sha256: environmentSha256,
    verifier_sha256: verifierSha256,
    fixtures_sha256: sha256(fixtureBytes),
    fixture_files: [representative, oracle, wrong].map((outcome) => ({ candidate_sha256: outcome.candidateSha256, state_sha256: outcome.stateSha256 })),
    intent: { approver: approval.approver, intent_confirmed_at: approval.intent_confirmed_at, workload_profile_sha256: approval.workload_profile_sha256, metric_sha256: approval.metric_sha256 },
  }));
  const candidateReport = EvalCheckReportSchema.parse({
    schema_version: "understudy.eval-check.v1",
    checked_at: checkTime.toISOString(),
    status: "passed",
    task_count: taskRows.length,
    representative_replay: {
      task_id: fixtures.representative.task_id,
      input_provenance: fixtures.representative.input_provenance,
      evidence: fixtures.representative.correctness_evidence,
      result: "passed",
      feedback: representative.feedback,
      provider_called: false,
      candidate_sha256: representative.candidateSha256,
      state_sha256: representative.stateSha256,
      replay_sha256: representative.replaySha256,
    },
    oracle_fixture: {
      task_id: fixtures.known_good.task_id,
      input_provenance: fixtures.known_good.input_provenance,
      evidence: fixtures.known_good.correctness_evidence,
      result: "passed",
      feedback: oracle.feedback,
      candidate_sha256: oracle.candidateSha256,
      state_sha256: oracle.stateSha256,
      replay_sha256: oracle.replaySha256,
    },
    wrong_fixture: {
      task_id: fixtures.intentionally_wrong.task_id,
      input_provenance: fixtures.intentionally_wrong.input_provenance,
      evidence: fixtures.intentionally_wrong.incorrectness_evidence,
      result: "rejected",
      feedback: wrong.feedback,
      candidate_sha256: wrong.candidateSha256,
      state_sha256: wrong.stateSha256,
      replay_sha256: wrong.replaySha256,
    },
    source: sourceBinding,
    check_input_sha256: checkInputSha256,
    eval_set_sha256: evalSetSha256,
    coverage_sha256: coverageSha256,
    environment_sha256: environmentSha256,
    verifier_sha256: verifierSha256,
  });
  const checkReportPath = reportPath(projectRoot, project.artifacts.check_report);
  let report = candidateReport;
  try {
    const existing = parseJson(checkReportPath, EvalCheckReportSchema, "checks/report.json");
    if (sameReport(existing, candidateReport)) report = existing;
    else replacePrivateJson(checkReportPath, candidateReport);
  } catch (error) {
    if (lstatExists(checkReportPath)) throw error;
    replacePrivateJson(checkReportPath, candidateReport);
  }
  const checkReportSha256 = sha256(readFileSync(checkReportPath));
  const hashes = {
    workload_profile_sha256: workloadProfileSha256,
    metric_sha256: metricSha256,
    eval_set_sha256: evalSetSha256,
    coverage_sha256: coverageSha256,
    environment_sha256: environmentSha256,
    verifier_sha256: verifierSha256,
    check_report_sha256: checkReportSha256,
  };
  if (new Date(approval.intent_confirmed_at).valueOf() > new Date(report.checked_at).valueOf()) {
    throw new Error("Intent confirmation must occur on or before the current check report.");
  }
  if (report.coverage_sha256 !== hashes.coverage_sha256) throw new Error("Check report does not bind the current coverage map.");

  let publishable = false;
  if (approval.approved_at !== undefined) {
    for (const [key, value] of Object.entries({
      eval_set_sha256: approval.eval_set_sha256,
      coverage_sha256: approval.coverage_sha256,
      environment_sha256: approval.environment_sha256,
      verifier_sha256: approval.verifier_sha256,
      check_report_sha256: approval.check_report_sha256,
    })) {
      if (value !== hashes[key as keyof typeof hashes]) throw new Error(`Final owner approval is stale for ${key}.`);
    }
    if (new Date(approval.approved_at).valueOf() <= new Date(report.checked_at).valueOf()) {
      throw new Error("Final owner approval must occur after the current check report.");
    }
    if (new Date(approval.approved_at).valueOf() > checkTime.valueOf()) {
      throw new Error("Final owner approval cannot occur after the eval check.");
    }
    publishable = true;
  }
  return {
    status: "passed",
    publishable,
    report,
    report_file: checkReportPath,
    coverage: {
      lineage: coverage.lineage.counts,
      execution_modes: coverage.execution_modes.map(({ name, observed_count, disposition }) => ({ name, observed_count, disposition })),
      failure_classes: coverage.failure_classes.map(({ name, observed_count, disposition }) => ({ name, observed_count, disposition })),
    },
    hashes,
  };
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
