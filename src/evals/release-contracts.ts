import { z } from "zod";

import { compareCodeUnits } from "./canonical.js";

export const EVAL_RELEASE_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const EVAL_RELEASE_MAX_FILES = 1_024;
export const EVAL_RELEASE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const EVAL_RELEASE_MAX_MANIFEST_BYTES = 512 * 1024;

export const EvalReleaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const EvalReleaseIdSchema = z.string().regex(/^release_[a-f0-9]{24}$/);
export const EvalReleasePrincipalSchema = z.string().max(300).regex(/^(?:user|api_key):[^\s:][^\s]*$/);
export const EvalIdSchema = z.string().regex(/^eval_[a-f0-9]{24}$/);
const EvalReleaseTimestampSchema = z.string().datetime();

export const EvalReleaseArtifactPathSchema = z.string().min(1).max(240).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "artifact paths must be normalized, project-relative paths",
);

export const EvalReleaseSourceSchema = z.object({
  from: EvalReleaseTimestampSchema,
  to: EvalReleaseTimestampSchema,
  ingestion_cutoff: EvalReleaseTimestampSchema,
  capture_count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  local_index_sha256: EvalReleaseSha256Schema,
  export_proof_sha256: EvalReleaseSha256Schema,
  source_attestation: z.string().min(1).max(8_192),
}).strict().superRefine((source, context) => {
  if (Date.parse(source.to) - Date.parse(source.from) !== 7 * 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["to"], message: "the source window must be exactly seven days" });
  }
  if (Date.parse(source.ingestion_cutoff) < Date.parse(source.to)) {
    context.addIssue({ code: "custom", path: ["ingestion_cutoff"], message: "the frozen ingestion cutoff must be at or after the source window end" });
  }
});

export const EvalReleaseArtifactHashesSchema = z.object({
  eval_set_sha256: EvalReleaseSha256Schema,
  coverage_sha256: EvalReleaseSha256Schema,
  environment_sha256: EvalReleaseSha256Schema,
  verifier_sha256: EvalReleaseSha256Schema,
  check_report_sha256: EvalReleaseSha256Schema,
  approval_sha256: EvalReleaseSha256Schema,
  bundle_sha256: EvalReleaseSha256Schema,
  bundle_r2_key: z.string().min(1).max(240),
}).strict().superRefine((artifacts, context) => {
  if (artifacts.bundle_r2_key !== `eval-release-bundles/${artifacts.bundle_sha256}.tar.gz`) {
    context.addIssue({ code: "custom", path: ["bundle_r2_key"], message: "bundle_r2_key must be derived from bundle_sha256" });
  }
});

export const EvalReleaseRuntimeSchema = z.object({
  format: z.literal("local_module.v1"),
  environment_entrypoint: EvalReleaseArtifactPathSchema,
  verifier_entrypoint: EvalReleaseArtifactPathSchema,
}).strict();

export const EvalReleaseSkillSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(120),
}).strict();

export const EvalReleaseApprovalSchema = z.object({
  schema_version: z.literal("understudy.eval-approval.v1"),
  approver: z.string().min(1).max(240),
  intent_confirmed_at: EvalReleaseTimestampSchema,
  workload_profile_sha256: EvalReleaseSha256Schema,
  metric_sha256: EvalReleaseSha256Schema,
  approved_at: EvalReleaseTimestampSchema,
  eval_set_sha256: EvalReleaseSha256Schema,
  coverage_sha256: EvalReleaseSha256Schema,
  environment_sha256: EvalReleaseSha256Schema,
  verifier_sha256: EvalReleaseSha256Schema,
  check_report_sha256: EvalReleaseSha256Schema,
}).strict().superRefine((approval, context) => {
  if (Date.parse(approval.approved_at) <= Date.parse(approval.intent_confirmed_at)) {
    context.addIssue({ code: "custom", path: ["approved_at"], message: "final approval must follow intent confirmation" });
  }
});

const EvalReleaseFixtureArtifactSchema = z.object({
  candidate: EvalReleaseArtifactPathSchema,
  state: EvalReleaseArtifactPathSchema.optional(),
}).strict();

export const EvalReleaseArtifactLayoutSchema = z.object({
  workload_profile: EvalReleaseArtifactPathSchema,
  coverage: EvalReleaseArtifactPathSchema,
  harness: EvalReleaseArtifactPathSchema,
  environment: EvalReleaseArtifactPathSchema,
  metric: EvalReleaseArtifactPathSchema,
  splits: EvalReleaseArtifactPathSchema,
  tasks: EvalReleaseArtifactPathSchema,
  check_fixtures: EvalReleaseArtifactPathSchema,
  approval: EvalReleaseArtifactPathSchema,
  check_report: EvalReleaseArtifactPathSchema,
  fixtures: z.object({
    representative: EvalReleaseFixtureArtifactSchema,
    known_good: EvalReleaseFixtureArtifactSchema,
    intentionally_wrong: EvalReleaseFixtureArtifactSchema,
  }).strict(),
  environment_root: EvalReleaseArtifactPathSchema,
  verifier_root: EvalReleaseArtifactPathSchema,
}).strict();

export const EvalReleaseBundleFileSchema = z.object({
  path: EvalReleaseArtifactPathSchema,
  size_bytes: z.number().int().nonnegative().max(EVAL_RELEASE_MAX_FILE_BYTES),
  sha256: EvalReleaseSha256Schema,
}).strict();

const EvalReleasePayloadSchema = z.object({
  org_id: z.string().min(1).max(240),
  project_id: z.string().min(1).max(240),
  workload_id: z.string().min(1).max(240),
  eval_id: EvalIdSchema,
  name: z.string().min(1).max(120),
  source: EvalReleaseSourceSchema,
  artifacts: EvalReleaseArtifactHashesSchema,
  runtime: EvalReleaseRuntimeSchema,
  skills: z.array(EvalReleaseSkillSchema).min(1).max(32),
  approval: EvalReleaseApprovalSchema,
  artifact_layout: EvalReleaseArtifactLayoutSchema,
  bundle_files: z.array(EvalReleaseBundleFileSchema).min(1).max(EVAL_RELEASE_MAX_FILES),
}).strict();

function isInside(root: string, path: string): boolean {
  return path.startsWith(`${root}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateEvalReleasePayload(
  payload: z.infer<typeof EvalReleasePayloadSchema>,
  context: z.RefinementCtx,
): void {
  for (const field of ["eval_set_sha256", "coverage_sha256", "environment_sha256", "verifier_sha256", "check_report_sha256"] as const) {
    if (payload.approval[field] !== payload.artifacts[field]) {
      context.addIssue({ code: "custom", path: ["approval", field], message: `${field} must match artifacts.${field}` });
    }
  }

  const skillNames = payload.skills.map((skill) => skill.name);
  if (new Set(skillNames).size !== skillNames.length) {
    context.addIssue({ code: "custom", path: ["skills"], message: "skill names must be unique" });
  }
  if (skillNames.some((name, index) => index > 0 && compareCodeUnits(skillNames[index - 1]!, name) >= 0)) {
    context.addIssue({ code: "custom", path: ["skills"], message: "skills must be sorted by name" });
  }

  const layout = payload.artifact_layout;
  const corePaths = [
    layout.workload_profile,
    layout.coverage,
    layout.harness,
    layout.environment,
    layout.metric,
    layout.splits,
    layout.tasks,
    layout.check_fixtures,
    layout.approval,
    layout.check_report,
  ];
  if (new Set(corePaths).size !== corePaths.length) {
    context.addIssue({ code: "custom", path: ["artifact_layout"], message: "core artifact layout paths must be unique" });
  }
  const fixturePaths = Object.values(layout.fixtures).flatMap((fixture) =>
    fixture.state === undefined ? [fixture.candidate] : [fixture.candidate, fixture.state],
  );
  if ([...corePaths, ...fixturePaths].some((path) => pathsOverlap(layout.environment_root, path) || pathsOverlap(layout.verifier_root, path))) {
    context.addIssue({ code: "custom", path: ["artifact_layout"], message: "data artifacts must remain outside both executable roots" });
  }
  if (
    layout.environment_root === layout.verifier_root ||
    isInside(layout.environment_root, layout.verifier_root) ||
    isInside(layout.verifier_root, layout.environment_root)
  ) {
    context.addIssue({ code: "custom", path: ["artifact_layout"], message: "environment and verifier roots must be disjoint" });
  }
  if (!isInside(layout.environment_root, payload.runtime.environment_entrypoint)) {
    context.addIssue({ code: "custom", path: ["runtime", "environment_entrypoint"], message: "environment entrypoint must be inside environment_root" });
  }
  if (!isInside(layout.verifier_root, payload.runtime.verifier_entrypoint)) {
    context.addIssue({ code: "custom", path: ["runtime", "verifier_entrypoint"], message: "verifier entrypoint must be inside verifier_root" });
  }

  const paths = payload.bundle_files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["bundle_files"], message: "bundle file paths must be unique" });
  }
  if (paths.some((path, index) => index > 0 && compareCodeUnits(paths[index - 1]!, path) >= 0)) {
    context.addIssue({ code: "custom", path: ["bundle_files"], message: "bundle files must be sorted by path" });
  }
  const required = new Set([
    ...corePaths,
    layout.fixtures.representative.candidate,
    layout.fixtures.known_good.candidate,
    layout.fixtures.intentionally_wrong.candidate,
    layout.fixtures.representative.state,
    layout.fixtures.known_good.state,
    layout.fixtures.intentionally_wrong.state,
    payload.runtime.environment_entrypoint,
    payload.runtime.verifier_entrypoint,
  ].filter((path): path is string => path !== undefined));
  for (const path of required) {
    if (!paths.includes(path)) {
      context.addIssue({ code: "custom", path: ["bundle_files"], message: `bundle files are missing required artifact ${path}` });
    }
  }
  for (const path of paths) {
    if (required.has(path)) continue;
    const inModuleTree = isInside(layout.environment_root, path) || isInside(layout.verifier_root, path);
    if (!inModuleTree || !/\.(?:m?js)$/.test(path)) {
      context.addIssue({ code: "custom", path: ["bundle_files"], message: `bundle file ${path} is outside the release allowlist` });
    }
  }
}

export const EvalPublicationSchema = EvalReleasePayloadSchema.extend({
  schema_version: z.literal("understudy.eval-publication.v1"),
}).superRefine(validateEvalReleasePayload);
export type EvalPublication = z.infer<typeof EvalPublicationSchema>;

export const EvalReleaseSchema = EvalReleasePayloadSchema.extend({
  schema_version: z.literal("understudy.eval-release.v1"),
  release_id: EvalReleaseIdSchema,
  release_number: z.number().int().positive(),
  sealed_by_user_id: EvalReleasePrincipalSchema,
  sealed_at: EvalReleaseTimestampSchema,
}).superRefine(validateEvalReleasePayload);
export type EvalRelease = z.infer<typeof EvalReleaseSchema>;
