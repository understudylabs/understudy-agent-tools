import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileTraceFoundry, type FoundryResult } from "./trace-foundry.js";

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
