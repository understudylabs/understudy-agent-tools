import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileTraceFoundry, type FoundryResult } from "./trace-foundry.js";
import type { WorkloadEvalProject } from "./evals/authoring-contracts.js";
import type { EvalBuildIdentity } from "./evals/contracts.js";
import { replacePrivateText } from "./evals/build-state.js";
import type { WorkloadTraceExportResult, WorkloadTraceExportScope } from "./workload-trace-export.js";

export interface EvalProjectIdentity {
  orgId: string;
  projectId: string;
  workloadId: string;
  workloadName: string;
}

export interface EvalProjectCohort {
  id: string;
  cohortSha256: string;
  captureCount: number;
  materializationManifest: string;
}

export interface BuildEvalProjectOptions {
  output: string;
  identity: EvalProjectIdentity;
  cohort: EvalProjectCohort;
  maxAgeDays: number;
  batchSize: number;
  now?: Date;
}

export interface EvalProjectManifest {
  schema_version: "understudy.eval-project.v1";
  status: "local_draft";
  created_at: string;
  identity: {
    org_id: string;
    project_id: string;
    workload_id: string;
    workload_name: string;
  };
  cohort: {
    id: string;
    cohort_sha256: string;
    capture_count: number;
    materialization_manifest: string;
  };
  foundry: {
    status: FoundryResult["status"];
    output: string;
    manifest: string;
    artifacts: Record<string, string>;
    counts: FoundryResult["counts"];
  };
  privacy: {
    local_only: true;
    contains_customer_payloads: true;
    upload_performed: false;
    provider_called: false;
  };
}

export interface EvalProjectBuildResult extends EvalProjectManifest {
  project_file: string;
}

export interface WorkloadEvalProjectManifest {
  schema_version: "understudy.eval-project.v2";
  eval_id: string;
  name: string;
  status: WorkloadEvalProject["status"];
  created_at: string;
  identity: EvalBuildIdentity;
  source: {
    window: WorkloadTraceExportScope;
    requested_count: number;
    materialized_count: number;
    skipped_count: number;
    skipped_index: string;
    capture_count: number;
    size_bytes: number;
    index: string;
    index_sha256: string;
  };
  artifacts: WorkloadEvalProject["artifacts"];
  authoring: {
    owner: "coding_agent";
    semantic_preparation_performed: false;
  };
  privacy: EvalProjectManifest["privacy"];
}

export interface BuildWorkloadEvalProjectOptions {
  output: string;
  name: string;
  identity: EvalBuildIdentity;
  source: WorkloadTraceExportResult;
  now: Date;
}

export interface WorkloadEvalProjectBuildResult extends WorkloadEvalProjectManifest {
  project_file: string;
}

export function deriveWorkloadEvalId(input: {
  name: string;
  identity: EvalBuildIdentity;
  sourceWindow: WorkloadTraceExportScope;
}): string {
  return `eval_${createHash("sha256").update(JSON.stringify({
    schema_version: "understudy.eval-identity.v1",
    name: input.name,
    identity: {
      org_id: input.identity.org_id,
      project_id: input.identity.project_id,
      workload_id: input.identity.workload_id,
      workload_name: input.identity.workload_name,
    },
    source_window: {
      schema_version: input.sourceWindow.schema_version,
      selector: input.sourceWindow.selector,
      org_id: input.sourceWindow.org_id,
      project_id: input.sourceWindow.project_id,
      workload_id: input.sourceWindow.workload_id,
      from: input.sourceWindow.from,
      to: input.sourceWindow.to,
      ingestion_cutoff: input.sourceWindow.ingestion_cutoff,
    },
  })).digest("hex").slice(0, 24)}`;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`Eval project artifact must remain inside ${root}.`);
  }
  return value.split(sep).join("/");
}

function foundryArtifactPath(projectRoot: string, benchmarkRoot: string, value: string): string {
  const absolute = isAbsolute(value) ? value : resolve(benchmarkRoot, value);
  return portableRelative(projectRoot, absolute);
}

/**
 * Compile already-materialized, workload-scoped captures into the existing
 * trace-foundry proposal and bind both artifacts in one small local manifest.
 * This function performs no upload and no provider call.
 */
export function buildEvalProject(options: BuildEvalProjectOptions): EvalProjectBuildResult {
  const now = options.now ?? new Date();
  const projectRoot = resolve(options.output);
  const capturesRoot = join(projectRoot, "captures");
  const benchmarkRoot = join(projectRoot, "benchmark");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });

  const foundry = compileTraceFoundry(
    capturesRoot,
    benchmarkRoot,
    options.maxAgeDays,
    now,
    { workload: options.identity.workloadId, batchSize: options.batchSize },
  );
  if (foundry.counts.captures !== options.cohort.captureCount || foundry.counts.stale_filtered !== 0) {
    throw new Error(
      `Compiled capture count ${foundry.counts.captures} does not match frozen cohort count ${options.cohort.captureCount}.`,
    );
  }
  const projectFile = join(projectRoot, "eval-project.json");
  const project: EvalProjectManifest = {
    schema_version: "understudy.eval-project.v1",
    status: "local_draft",
    created_at: now.toISOString(),
    identity: {
      org_id: options.identity.orgId,
      project_id: options.identity.projectId,
      workload_id: options.identity.workloadId,
      workload_name: options.identity.workloadName,
    },
    cohort: {
      id: options.cohort.id,
      cohort_sha256: options.cohort.cohortSha256,
      capture_count: options.cohort.captureCount,
      materialization_manifest: portableRelative(projectRoot, resolve(options.cohort.materializationManifest)),
    },
    foundry: {
      status: foundry.status,
      output: portableRelative(projectRoot, benchmarkRoot),
      manifest: portableRelative(projectRoot, join(benchmarkRoot, "manifest.json")),
      artifacts: Object.fromEntries(
        Object.entries(foundry.artifacts).map(([name, path]) => [
          name,
          foundryArtifactPath(projectRoot, benchmarkRoot, path),
        ]),
      ),
      counts: foundry.counts,
    },
    privacy: {
      local_only: true,
      contains_customer_payloads: true,
      upload_performed: false,
      provider_called: false,
    },
  };
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { ...project, project_file: projectFile };
}

export function buildWorkloadEvalProject(options: BuildWorkloadEvalProjectOptions): WorkloadEvalProjectBuildResult {
  if (options.source.captureCount === 0) {
    throw new Error("No captures were exported for the frozen workload window; refusing to create an empty eval project.");
  }
  if (options.source.requestedCount !== options.source.captureCount + options.source.skippedCount) {
    throw new Error("Raw trace source requested count must equal its materialized and skipped capture counts.");
  }
  const projectRoot = resolve(options.output);
  const scope = options.source.canonicalScope;
  if (
    scope.org_id !== options.identity.org_id ||
    scope.project_id !== options.identity.project_id ||
    scope.workload_id !== options.identity.workload_id
  ) throw new Error("Raw trace source scope does not match the eval project identity.");
  const indexPath = resolve(options.source.indexPath);
  if (indexPath !== join(projectRoot, "source", "index.jsonl")) {
    throw new Error("Raw trace source index must be source/index.jsonl inside the eval project.");
  }

  const projectFile = join(projectRoot, "eval-project.json");
  const evalId = deriveWorkloadEvalId({
    name: options.name,
    identity: options.identity,
    sourceWindow: scope,
  });
  const project: WorkloadEvalProjectManifest = {
    schema_version: "understudy.eval-project.v2",
    eval_id: evalId,
    name: options.name,
    status: "source_materialized",
    created_at: options.now.toISOString(),
    identity: options.identity,
    source: {
      window: scope,
      requested_count: options.source.requestedCount,
      materialized_count: options.source.captureCount,
      skipped_count: options.source.skippedCount,
      skipped_index: portableRelative(projectRoot, join(projectRoot, "source", "skipped.jsonl")),
      capture_count: options.source.captureCount,
      size_bytes: options.source.sizeBytes,
      index: portableRelative(projectRoot, indexPath),
      index_sha256: options.source.indexSha256,
    },
    artifacts: {
      workload_profile: "workload-profile.md",
      coverage: "coverage.json",
      harness: "harness.json",
      environment: "environment.json",
      metric: "metric.json",
      splits: "splits.json",
      tasks: "benchmark/tasks.jsonl",
      execution_index: "benchmark/execution-index.jsonl",
      analysis: "benchmark/analysis.md",
      verifier: "verifier",
      approval: "approval.json",
      check_report: "checks/report.json",
    },
    authoring: { owner: "coding_agent", semantic_preparation_performed: false },
    privacy: {
      local_only: true,
      contains_customer_payloads: true,
      upload_performed: false,
      provider_called: false,
    },
  };
  replacePrivateText(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  return { ...project, project_file: projectFile };
}
