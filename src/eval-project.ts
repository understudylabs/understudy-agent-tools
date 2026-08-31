import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileTraceFoundry, type FoundryResult } from "./trace-foundry.js";
import { createPrivateDirectory } from "./evals/build-state.js";
import { sourceIndexCommitmentSha256 } from "./evals/source-index.js";
import type { WorkloadEvalProject } from "./evals/authoring-contracts.js";
import type {
  EvalBuildIdentity,
  VerifiedWorkloadCaptureFile,
  VerifyWorkloadCaptureExportReceiptResponse,
  WorkloadCaptureExportScope,
} from "./evals/contracts.js";

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
    window: WorkloadCaptureExportScope;
    capture_count: number;
    size_bytes: number;
    index: string;
    index_sha256: string;
    export_proof: string;
    export_proof_sha256: string;
    exported_capture_count: number;
    exported_total_bytes: number;
    terminal_receipt_verified: true;
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
  canonicalScope: WorkloadCaptureExportScope;
  verifiedFiles: VerifiedWorkloadCaptureFile[];
  segmentManifestSha256: string[];
  terminalReceipt: string;
  verifiedReceipt: VerifyWorkloadCaptureExportReceiptResponse;
  now: Date;
}

export interface WorkloadEvalProjectBuildResult extends WorkloadEvalProjectManifest {
  project_file: string;
}

export function deriveWorkloadEvalId(input: {
  name: string;
  identity: EvalBuildIdentity;
  sourceWindow: WorkloadCaptureExportScope;
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
  if (options.verifiedReceipt.cumulative_exported === 0) {
    throw new Error("No captures were exported for the frozen workload window; refusing to create an empty eval project.");
  }
  const projectRoot = resolve(options.output);
  const sourceRoot = join(projectRoot, "source");
  createPrivateDirectory(sourceRoot);
  if (
    JSON.stringify(options.verifiedReceipt.canonical_scope) !== JSON.stringify(options.canonicalScope) ||
    options.verifiedReceipt.chain_id.length === 0 ||
    options.verifiedReceipt.manifest_sha256 !== options.segmentManifestSha256.at(-1)
  ) throw new Error("Verified export receipt does not match the materialized source chain.");

  const unique = new Map<string, VerifiedWorkloadCaptureFile>();
  for (const file of options.verifiedFiles) {
    const previous = unique.get(file.capture_key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(file)) {
      throw new Error(`Capture source ledger conflicts for ${file.capture_key}.`);
    }
    unique.set(file.capture_key, file);
  }
  const files = [...unique.values()];
  const uniqueTotalBytes = files.reduce((sum, file) => sum + file.size_bytes, 0);
  if (
    files.length !== options.verifiedReceipt.cumulative_exported ||
    uniqueTotalBytes !== options.verifiedReceipt.total_bytes
  ) {
    throw new Error("Verified export receipt totals do not match unique materialized captures.");
  }
  const indexBody = files.map((file) => JSON.stringify(file)).join("\n") + (files.length > 0 ? "\n" : "");
  const indexSha256 = sourceIndexCommitmentSha256(files);
  if (options.verifiedReceipt.local_index_sha256 !== indexSha256) {
    throw new Error("Verified export receipt source index commitment does not match materialized captures.");
  }
  const indexPath = join(sourceRoot, "index.jsonl");
  replacePrivateText(indexPath, indexBody);
  const proofPath = join(sourceRoot, "export-proof.json");
  const proofBody = `${JSON.stringify({
    schema_version: "understudy.eval-export-proof.v1",
    canonical_scope: options.canonicalScope,
    segment_manifest_sha256: options.segmentManifestSha256,
    terminal_receipt: options.terminalReceipt,
    verified_receipt: options.verifiedReceipt,
  }, null, 2)}\n`;
  replacePrivateText(proofPath, proofBody);

  const projectFile = join(projectRoot, "eval-project.json");
  const evalId = deriveWorkloadEvalId({
    name: options.name,
    identity: options.identity,
    sourceWindow: options.canonicalScope,
  });
  const project: WorkloadEvalProjectManifest = {
    schema_version: "understudy.eval-project.v2",
    eval_id: evalId,
    name: options.name,
    status: "source_materialized",
    created_at: options.now.toISOString(),
    identity: options.identity,
    source: {
      window: options.canonicalScope,
      capture_count: files.length,
      size_bytes: uniqueTotalBytes,
      index: portableRelative(projectRoot, indexPath),
      index_sha256: indexSha256,
      export_proof: portableRelative(projectRoot, proofPath),
      export_proof_sha256: createHash("sha256").update(proofBody).digest("hex"),
      exported_capture_count: options.verifiedReceipt.cumulative_exported,
      exported_total_bytes: options.verifiedReceipt.total_bytes,
      terminal_receipt_verified: true,
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

function replacePrivateText(path: string, body: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
