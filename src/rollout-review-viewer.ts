/** Private offline presentation of an already-built, metadata-only rollout report. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packagePath } from "./internal/package-root.js";
import type { RolloutReviewReport } from "./rollout-review.js";

type ObjectValue = Record<string, unknown>;
export type RolloutReviewViewerResult = {
  schema_version: "understudy.rollout_review_viewer.v1";
  output_dir: string;
  counts: { tasks: number; requests: number; ungrouped: number; comparable_groups: number };
  artifacts: { viewer: string; data: string; report: string; request_ids: string; manifest: string };
  privacy: { local_only: true; upload_performed: false; raw_payloads_included: false; contains_private_identifiers: true; must_not_commit: true };
};

const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => array(value).filter((item): item is string => typeof item === "string");
function scalars(value: unknown, keys: string[]): ObjectValue {
  const source = object(value);
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).flatMap(key => {
    const field = source[key];
    return field === null || typeof field === "string" || typeof field === "boolean" || typeof field === "number" && Number.isFinite(field) ? [[key, field]] : [];
  }));
}
const summary = (value: unknown): ObjectValue => scalars(value, ["n", "mean", "median", "p90", "min", "max"]);
function source(value: unknown): ObjectValue {
  const result = scalars(value, ["path", "line", "sha256", "request_started_at"]);
  if (typeof result.path !== "string" || /^[\\/]/.test(result.path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(result.path) || result.path.split(/[\\/]/).includes("..")) delete result.path;
  return result;
}
function request(value: unknown): ObjectValue {
  const row = object(value);
  return {
    ...scalars(row, ["recordId", "side", "requestId", "taskId", "userId", "environment", "workload", "timestamp", "timestampSource", "statusCode", "requestedModel", "observedModel", "modelSource", "durationMs", "format", "observedTerminal", "httpError", "nativeToolErrors", "disposition", "groupId", "duplicateOf"]),
    toolEvents: array(row.toolEvents).map(event => scalars(event, ["kind", "callId", "name", "fingerprint", "contentFingerprint", "isError", "argumentValidation", "origin"])),
    // This report is metadata-only even if an untyped caller supplies payload fields.
    finalText: null,
    source: source(row.source), flags: strings(row.flags), reasons: strings(row.reasons),
  };
}
function metrics(value: unknown): ObjectValue | null {
  if (value === null || value === undefined) return null;
  const row = object(value);
  return {
    ...scalars(row, ["tasks", "requests", "observedTerminalTasks", "httpErrorRequests", "nativeToolErrorTasks", "nativeToolErrors", "argumentValidationErrorTasks", "argumentValidationErrors", "censoredTasks", "mixedModelTasks", "missingDurationRequests", "unsupportedResponseRequests"]),
    requestsPerTask: summary(row.requestsPerTask), requestDurationSumMs: summary(row.requestDurationSumMs), requestDurationMs: summary(row.requestDurationMs),
    observedModels: Object.fromEntries(Object.entries(object(row.observedModels)).filter(([, count]) => typeof count === "number" && Number.isFinite(count))),
    topSlowRequests: array(row.topSlowRequests).map(item => scalars(item, ["recordId", "requestId", "taskId", "side", "durationMs"])),
    maxDropSensitivity: {
      requestsPerTask: summary(object(row.maxDropSensitivity).requestsPerTask),
      requestDurationSumMs: summary(object(row.maxDropSensitivity).requestDurationSumMs),
    },
  };
}

/** Keep exports as narrow as the UI. Never forward unknown raw envelope fields. */
function viewerReport(input: RolloutReviewReport): RolloutReviewReport {
  if (input?.schema_version !== "understudy.rollout-review.v1" || !Array.isArray(input.requests) || !Array.isArray(input.tasks) || !Array.isArray(input.comparableGroups) || input.privacy?.raw_payloads_included !== false) {
    throw new Error("Rollout viewer requires a metadata-only understudy.rollout-review.v1 report.");
  }
  const scope = object(object(input).scope);
  return {
    schema_version: input.schema_version,
    selectors: scalars(input.selectors, ["taskId", "userId", "environment", "durationMs"]),
    durationBasis: typeof input.durationBasis === "string" ? input.durationBasis : null,
    scope: { ...scalars(scope, ["orgId", "projectId", "specSha256", "inventorySha256"]), ...(scope.sourceManifest ? { sourceManifest: source(scope.sourceManifest) } : {}) },
    sides: Object.fromEntries(["before", "after"].map(side => [side, scalars(object(input.sides)[side], ["workload", "workloadName", "from", "to"])])),
    requests: input.requests.map(request),
    tasks: input.tasks.map(row => ({
      ...scalars(row, ["id", "taskId", "side", "userId", "environment", "workload", "orgId", "projectId", "requestCount", "observedTerminal", "httpErrorRequests", "nativeToolErrors", "argumentValidationErrors", "durationSumMs", "observedDurationSumMs", "durationObservedRequests", "comparisonEligible"]),
      requestRecordIds: strings(row.requestRecordIds), requestIds: strings(row.requestIds), observedModels: strings(row.observedModels), flags: strings(row.flags),
    })),
    ungrouped: array(input.ungrouped).map(request),
    comparableGroups: input.comparableGroups.map(row => ({ ...scalars(row, ["key", "userId", "environment", "status"]), before: metrics(row.before), after: metrics(row.after) })),
    accounting: scalars(input.accounting, ["inputRecords", "groupedRecords", "ungroupedRecords", "excludedRecords", "duplicateRecords", "uniqueRequestIds", "tasks", "reconciled"]),
    caveats: strings(input.caveats),
    privacy: { local_only: true, provider_called: false, raw_payloads_included: false, contains_private_identifiers: true },
  } as RolloutReviewReport;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function assertRegularTarget(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Rollout viewer refuses a non-regular output file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writePrivate(path: string, content: string): void {
  assertRegularTarget(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** No downloads, uploads, inference, raw payload inclusion, or remote assets. */
export function renderRolloutReview(report: RolloutReviewReport, outputDir: string): RolloutReviewViewerResult {
  const projected = viewerReport(report);
  const template = readFileSync(packagePath("skills", "ramp-and-verify", "templates", "rollout-review", "index.html"), "utf8");
  const output = resolve(outputDir);
  try {
    const stat = lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Rollout viewer output must be a real directory, not a symlink.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const artifacts = {
    viewer: join(output, "index.html"), data: join(output, "rollout-data.js"), report: join(output, "report.json"),
    request_ids: join(output, "request-ids.json"), manifest: join(output, "manifest.json"),
  };
  Object.values(artifacts).forEach(assertRegularTarget);
  const result: RolloutReviewViewerResult = {
    schema_version: "understudy.rollout_review_viewer.v1", output_dir: output,
    counts: { tasks: projected.tasks.length, requests: projected.requests.length, ungrouped: projected.ungrouped.length, comparable_groups: projected.comparableGroups.filter(group => group.status === "comparable").length },
    artifacts,
    privacy: { local_only: true, upload_performed: false, raw_payloads_included: false, contains_private_identifiers: true, must_not_commit: true },
  };
  const requestIds = {
    schema_version: "understudy.rollout_review_request_ids.v1",
    before: [...new Set(projected.requests.filter(row => row.side === "before").map(row => row.requestId).filter(id => id !== null))],
    after: [...new Set(projected.requests.filter(row => row.side === "after").map(row => row.requestId).filter(id => id !== null))],
    records: projected.requests.map(row => ({ recordId: row.recordId, side: row.side, requestId: row.requestId, taskId: row.taskId, disposition: row.disposition })),
    privacy: result.privacy,
  };
  writePrivate(artifacts.viewer, template);
  // JSON.parse preserves literal keys such as __proto__ without object-literal semantics.
  writePrivate(artifacts.data, `window.ROLLOUT_REVIEW = JSON.parse(${json(JSON.stringify(projected))});\n`);
  writePrivate(artifacts.report, `${json(projected)}\n`);
  writePrivate(artifacts.request_ids, `${json(requestIds)}\n`);
  writePrivate(artifacts.manifest, `${json(result)}\n`);
  return result;
}
