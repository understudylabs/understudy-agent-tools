import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { z, type ZodType } from "zod";

import { PACKAGE_NAME } from "../config/defaults.js";
import { deriveWorkloadEvalId } from "../eval-project.js";
import { request } from "../internal/http.js";
import {
  EvalCheckFixturesSchema,
  EvalCheckReportSchema,
  EvalEnvironmentSchema,
  EvalExportProofSchema,
  EvalHarnessSchema,
  EvalSourceRowSchema,
  WorkloadEvalProjectSchema,
} from "./authoring-contracts.js";
import { canonicalJson, compareCodeUnits } from "./canonical.js";
import { descriptorHash, runEvalCheck } from "./check.js";
import {
  EVAL_RELEASE_MAX_COMPRESSED_BYTES,
  EVAL_RELEASE_MAX_FILE_BYTES,
  EVAL_RELEASE_MAX_FILES,
  EVAL_RELEASE_MAX_MANIFEST_BYTES,
  EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES,
  EvalPublicationSchema,
  EvalReleaseApprovalSchema,
  EvalReleaseArtifactPathSchema,
  EvalReleaseIdSchema,
  EvalReleaseSchema,
  type EvalPublication,
  type EvalRelease,
} from "./release-contracts.js";

interface BundleEntry {
  path: string;
  bytes: Buffer;
  sha256: string;
}

interface ModuleTree {
  root: string;
  entries: BundleEntry[];
  sha256: string;
}

const MAX_MODULE_FILES = 256;
const MAX_MODULE_FILE_BYTES = 256 * 1024;
const MAX_MODULE_TREE_BYTES = 2 * 1024 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface PreparedEvalPublication {
  publication: EvalPublication;
  bundle: Buffer;
  localOnly: {
    policy: string;
    explicitlyExcluded: string[];
  };
}

export interface EvalPublicationPreview {
  schema_version: "understudy.eval-publication-preview.v1";
  upload_performed: false;
  expected_release_id: string;
  manifest: EvalPublication;
  manifest_sha256: string;
  manifest_size_bytes: number;
  bundle: {
    content_type: "application/gzip";
    filename: string;
    sha256: string;
    size_bytes: number;
    r2_key: string;
    files: EvalPublication["bundle_files"];
  };
  local_only: {
    policy: string;
    explicitly_excluded: string[];
  };
}

export interface PublishEvalReleaseOptions {
  expectedReleaseId: string;
}

export interface PrepareEvalPublicationOptions {
  /** Test seam used to prove post-check mutation is detected by the release snapshot. */
  afterCheck?: () => void;
}

const packageVersion = (() => {
  const value = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as unknown;
  return z.object({ name: z.literal(PACKAGE_NAME), version: z.string().min(1).max(120) }).parse(value).version;
})();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return fatalUtf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function parseJson<T>(bytes: Buffer, schema: ZodType<T>, label: string): T {
  const text = decodeUtf8(bytes, label);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function normalizeArtifactPath(value: string): string {
  return EvalReleaseArtifactPathSchema.parse(value);
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function resolveProjectArtifact(projectRoot: string, artifactPath: string, label: string): string {
  const normalized = normalizeArtifactPath(artifactPath);
  const candidate = resolve(projectRoot, ...normalized.split("/"));
  if (!inside(projectRoot, candidate)) throw new Error(`${label} must remain inside the eval project.`);
  let cursor = projectRoot;
  for (const component of normalized.split("/")) {
    cursor = resolve(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symbolic link.`);
  }
  const real = realpathSync(candidate);
  if (!inside(projectRoot, real)) throw new Error(`${label} must remain inside the eval project.`);
  return real;
}

function readStableFile(
  projectRoot: string,
  artifactPath: string,
  label: string,
  maxBytes: number | null = EVAL_RELEASE_MAX_FILE_BYTES,
): BundleEntry {
  const normalized = normalizeArtifactPath(artifactPath);
  const path = resolveProjectArtifact(projectRoot, normalized, label);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
    if (maxBytes !== null && before.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte release file limit.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error(`${label} changed while its release snapshot was being read.`);
    }
    return { path: normalized, bytes, sha256: sha256(bytes) };
  } finally {
    closeSync(descriptor);
  }
}

function snapshotModuleTree(projectRoot: string, rootPath: string, label: string): ModuleTree {
  const root = normalizeArtifactPath(rootPath);
  const absoluteRoot = resolveProjectArtifact(projectRoot, root, label);
  if (!lstatSync(absoluteRoot).isDirectory()) throw new Error(`${label} must be a directory.`);
  const entries: BundleEntry[] = [];
  let totalBytes = 0;

  const visit = (directory: string, relativeDirectory: string): void => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links.`);
      const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const childPath = resolve(directory, child.name);
      if (child.isDirectory()) {
        visit(childPath, childRelative);
        continue;
      }
      if (!child.isFile()) throw new Error(`${label} can contain only regular JavaScript modules and directories.`);
      if (![".js", ".mjs"].includes(extname(child.name))) {
        throw new Error(`${label} can contain only .js and .mjs modules.`);
      }
      if (entries.length >= MAX_MODULE_FILES) throw new Error(`${label} exceeds the ${MAX_MODULE_FILES}-file module limit.`);
      const module = readStableFile(projectRoot, `${root}/${childRelative}`, `${label} module ${childRelative}`);
      if (module.bytes.byteLength > MAX_MODULE_FILE_BYTES) {
        throw new Error(`${label} module ${childRelative} exceeds the ${MAX_MODULE_FILE_BYTES}-byte module limit.`);
      }
      totalBytes += module.bytes.byteLength;
      if (totalBytes > MAX_MODULE_TREE_BYTES) throw new Error(`${label} exceeds the ${MAX_MODULE_TREE_BYTES}-byte module-tree limit.`);
      entries.push(module);
    }
  };
  visit(absoluteRoot, "");
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  if (entries.length === 0) throw new Error(`${label} is empty.`);

  const digest = createHash("sha256");
  for (const entry of entries) {
    const modulePath = entry.path.slice(root.length + 1);
    digest.update(modulePath).update("\0").update(entry.sha256).update("\n");
  }
  return { root, entries, sha256: digest.digest("hex") };
}

function parseSourcePaths(index: BundleEntry): Set<string> {
  const paths = new Set<string>();
  for (const [position, line] of decodeUtf8(index.bytes, "source index").split(/\r?\n/).filter(Boolean).entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid source index line ${position + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = EvalSourceRowSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid source index line ${position + 1}: ${z.prettifyError(parsed.error)}`);
    paths.add(normalizeArtifactPath(parsed.data.local_path));
  }
  return paths;
}

function assertNotPrivateSource(path: string, forbiddenPaths: Set<string>): void {
  const privateRoots = [".understudy", "source", "traces", "captures"];
  if (privateRoots.some((root) => path === root || path.startsWith(`${root}/`)) || forbiddenPaths.has(path)) {
    throw new Error(`Release artifact ${path} is source or mutable authoring evidence and cannot be published.`);
  }
}

function addEntry(entries: Map<string, BundleEntry>, entry: BundleEntry): void {
  const existing = entries.get(entry.path);
  if (existing !== undefined && (existing.sha256 !== entry.sha256 || !existing.bytes.equals(entry.bytes))) {
    throw new Error(`Release artifact ${entry.path} changed between snapshot reads.`);
  }
  entries.set(entry.path, existing ?? entry);
}

function splitUstarPath(path: string): { name: Buffer; prefix: Buffer } {
  const full = Buffer.from(path, "utf8");
  if (full.byteLength <= 100) return { name: full, prefix: Buffer.alloc(0) };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index).reverse();
  for (const index of separators) {
    const prefix = Buffer.from(path.slice(0, index), "utf8");
    const name = Buffer.from(path.slice(index + 1), "utf8");
    if (prefix.byteLength <= 155 && name.byteLength <= 100) return { name, prefix };
  }
  throw new Error(`Release artifact path is too long for deterministic USTAR: ${path}`);
}

function writeTarString(header: Buffer, offset: number, length: number, value: Buffer | string): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "ascii") : value;
  if (bytes.byteLength > length) throw new Error("USTAR header field overflow.");
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error("USTAR numeric field overflow.");
  writeTarString(header, offset, length, `${octal.padStart(length - 1, "0")}\0`);
}

function createUstar(entries: BundleEntry[]): Buffer {
  const expectedByteLength = deterministicUstarByteLength(entries.map((entry) => entry.bytes.byteLength));
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const path = splitUstarPath(entry.path);
    writeTarString(header, 0, 100, path.name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    writeTarString(header, 345, 155, path.prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  const archive = Buffer.concat(chunks);
  if (archive.byteLength !== expectedByteLength) throw new Error("Deterministic USTAR size calculation did not match the encoded archive.");
  return archive;
}

export function deterministicUstarByteLength(fileSizes: readonly number[]): number {
  let byteLength = 1_024;
  for (const size of fileSizes) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("USTAR file sizes must be non-negative safe integers.");
    byteLength += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(byteLength)) throw new Error("USTAR archive size exceeds JavaScript's safe integer range.");
  }
  return byteLength;
}

function assertHash(label: string, actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`${label} changed after the passing eval check.`);
}

export async function prepareEvalPublication(
  projectDirectory: string,
  options: PrepareEvalPublicationOptions = {},
): Promise<PreparedEvalPublication> {
  const projectRoot = realpathSync(resolve(projectDirectory));
  const projectBeforeCheck = readStableFile(projectRoot, "eval-project.json", "eval project manifest");
  const projectSnapshot = parseJson(projectBeforeCheck.bytes, WorkloadEvalProjectSchema, "eval-project.json");
  const approvalBeforeCheck = readStableFile(projectRoot, projectSnapshot.artifacts.approval, "final approval");
  const checked = await runEvalCheck(projectRoot);
  if (!checked.publishable) {
    throw new Error("Eval publication requires final owner approval bound to the passing check report.");
  }
  options.afterCheck?.();

  const projectEntry = readStableFile(projectRoot, "eval-project.json", "eval project manifest");
  if (projectEntry.sha256 !== projectBeforeCheck.sha256 || !projectEntry.bytes.equals(projectBeforeCheck.bytes)) {
    throw new Error("Eval project manifest changed while the final publication check was running.");
  }
  const project = parseJson(projectEntry.bytes, WorkloadEvalProjectSchema, "eval-project.json");
  const expectedEvalId = deriveWorkloadEvalId({ name: project.name, identity: project.identity, sourceWindow: project.source.window });
  if (project.eval_id !== expectedEvalId) throw new Error("Eval id does not match the stable project identity, name, and source window.");
  const harnessEntry = readStableFile(projectRoot, project.artifacts.harness, "eval harness");
  const harness = parseJson(harnessEntry.bytes, EvalHarnessSchema, "harness.json");
  const environmentEntry = readStableFile(projectRoot, project.artifacts.environment, "eval environment");
  const environment = parseJson(environmentEntry.bytes, EvalEnvironmentSchema, "environment.json");
  const fixturesEntry = readStableFile(projectRoot, environment.fixtures, "check fixtures");
  const fixtures = parseJson(fixturesEntry.bytes, EvalCheckFixturesSchema, "check fixtures");
  const approvalEntry = readStableFile(projectRoot, project.artifacts.approval, "final approval");
  if (approvalEntry.sha256 !== approvalBeforeCheck.sha256 || !approvalEntry.bytes.equals(approvalBeforeCheck.bytes)) {
    throw new Error("Final owner approval changed while the publication check was running.");
  }
  const approval = parseJson(approvalEntry.bytes, EvalReleaseApprovalSchema, "approval.json");

  const environmentRoot = normalizeArtifactPath(dirname(harness.environment_entrypoint).split(sep).join("/"));
  const verifierRoot = normalizeArtifactPath(project.artifacts.verifier);
  const environmentModules = snapshotModuleTree(projectRoot, environmentRoot, "environment module tree");
  const verifierModules = snapshotModuleTree(projectRoot, verifierRoot, "verifier module tree");
  const sourceIndexEntry = readStableFile(projectRoot, project.source.index, "source index", null);
  assertHash("Source index", sourceIndexEntry.sha256, project.source.index_sha256);
  const exportProofEntry = readStableFile(projectRoot, project.source.export_proof, "export proof", null);
  assertHash("Export proof", exportProofEntry.sha256, project.source.export_proof_sha256);
  const exportProof = parseJson(exportProofEntry.bytes, EvalExportProofSchema, "source/export-proof.json");
  const sourceAttestation = exportProof.verified_receipt.source_attestation;
  const sourceAttestationSha256 = sha256(sourceAttestation);
  const sourcePaths = parseSourcePaths(sourceIndexEntry);
  const forbiddenPaths = new Set([
    "eval-project.json",
    project.source.index,
    project.source.export_proof,
    project.artifacts.execution_index,
    project.artifacts.analysis,
    ...sourcePaths,
  ].map(normalizeArtifactPath));

  const primaryPaths = [
    project.artifacts.workload_profile,
    project.artifacts.coverage,
    project.artifacts.harness,
    project.artifacts.environment,
    project.artifacts.metric,
    project.artifacts.splits,
    project.artifacts.tasks,
    environment.fixtures,
    project.artifacts.approval,
    project.artifacts.check_report,
  ];
  const fixturePaths = [
    fixtures.representative.candidate,
    fixtures.representative.state,
    fixtures.known_good.candidate,
    fixtures.known_good.state,
    fixtures.intentionally_wrong.candidate,
    fixtures.intentionally_wrong.state,
  ].filter((path): path is string => path !== undefined);

  const entries = new Map<string, BundleEntry>();
  for (const entry of [harnessEntry, environmentEntry, fixturesEntry, approvalEntry]) {
    assertNotPrivateSource(entry.path, forbiddenPaths);
    addEntry(entries, entry);
  }
  for (const path of [...primaryPaths, ...fixturePaths]) {
    const normalized = normalizeArtifactPath(path);
    assertNotPrivateSource(normalized, forbiddenPaths);
    addEntry(entries, readStableFile(projectRoot, normalized, `release artifact ${normalized}`));
  }
  for (const module of [...environmentModules.entries, ...verifierModules.entries]) {
    assertNotPrivateSource(module.path, forbiddenPaths);
    addEntry(entries, module);
  }

  const sortedEntries = [...entries.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (sortedEntries.length > EVAL_RELEASE_MAX_FILES) {
    throw new Error(`Eval release exceeds the ${EVAL_RELEASE_MAX_FILES}-file limit.`);
  }
  for (const entry of sortedEntries) decodeUtf8(entry.bytes, `Release artifact ${entry.path}`);
  const totalBytes = sortedEntries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (totalBytes > EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`Eval release exceeds the ${EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES}-byte uncompressed limit.`);
  }

  const entriesByPath = new Map(sortedEntries.map((entry) => [entry.path, entry]));
  const requiredEntry = (path: string): BundleEntry => {
    const entry = entriesByPath.get(path);
    if (entry === undefined) throw new Error(`Release artifact ${path} was not snapshotted.`);
    return entry;
  };
  const profileEntry = requiredEntry(project.artifacts.workload_profile);
  const coverageEntry = requiredEntry(project.artifacts.coverage);
  const metricEntry = requiredEntry(project.artifacts.metric);
  const splitsEntry = requiredEntry(project.artifacts.splits);
  const tasksEntry = requiredEntry(project.artifacts.tasks);
  const checkReportEntry = requiredEntry(project.artifacts.check_report);
  const checkReport = parseJson(checkReportEntry.bytes, EvalCheckReportSchema, "checks/report.json");
  assertHash("Checked workload profile", profileEntry.sha256, checked.hashes.workload_profile_sha256);
  assertHash("Checked metric", metricEntry.sha256, checked.hashes.metric_sha256);
  assertHash("Approved workload profile", profileEntry.sha256, approval.workload_profile_sha256);
  assertHash("Approved metric", metricEntry.sha256, approval.metric_sha256);
  assertHash("Eval set", descriptorHash([
    { path: project.artifacts.tasks, sha256: tasksEntry.sha256 },
    { path: project.artifacts.harness, sha256: harnessEntry.sha256 },
    { path: project.artifacts.metric, sha256: metricEntry.sha256 },
    { path: project.artifacts.splits, sha256: splitsEntry.sha256 },
  ]), checked.hashes.eval_set_sha256);
  assertHash("Coverage", coverageEntry.sha256, checked.hashes.coverage_sha256);
  const environmentInputs = [
    { path: project.artifacts.environment, sha256: environmentEntry.sha256 },
    { path: `${environmentRoot}/`, sha256: environmentModules.sha256 },
    { path: environment.fixtures, sha256: fixturesEntry.sha256 },
  ];
  for (const state of [fixtures.representative.state, fixtures.known_good.state, fixtures.intentionally_wrong.state]) {
    if (state !== undefined && !environmentInputs.some((entry) => entry.path === state)) {
      environmentInputs.push({ path: state, sha256: requiredEntry(state).sha256 });
    }
  }
  assertHash("Environment", descriptorHash(environmentInputs), checked.hashes.environment_sha256);
  assertHash("Verifier", verifierModules.sha256, checked.hashes.verifier_sha256);
  assertHash("Check report", checkReportEntry.sha256, checked.hashes.check_report_sha256);
  if (canonicalJson(checkReport) !== canonicalJson(checked.report)) {
    throw new Error("Snapshotted check report does not match the passing eval check.");
  }
  assertHash("Checked source attestation", checkReport.source.export_proof_sha256, sourceAttestationSha256);

  const assertFixtureBinding = (
    label: string,
    fixture: { task_id: string; input_provenance: string; candidate: string; state?: string },
    outcome: { task_id: string; input_provenance: string; evidence: unknown; candidate_sha256: string; state_sha256: string | null },
    evidence: unknown,
  ): void => {
    if (fixture.task_id !== outcome.task_id || fixture.input_provenance !== outcome.input_provenance) {
      throw new Error(`${label} fixture identity changed after the passing eval check.`);
    }
    if (canonicalJson(evidence) !== canonicalJson(outcome.evidence)) {
      throw new Error(`${label} fixture evidence changed after the passing eval check.`);
    }
    assertHash(`${label} candidate`, requiredEntry(fixture.candidate).sha256, outcome.candidate_sha256);
    const stateSha256 = fixture.state === undefined ? null : requiredEntry(fixture.state).sha256;
    if (stateSha256 !== outcome.state_sha256) throw new Error(`${label} fixture state changed after the passing eval check.`);
  };
  assertFixtureBinding("Representative", fixtures.representative, checkReport.representative_replay, fixtures.representative.correctness_evidence);
  assertFixtureBinding("Known-good", fixtures.known_good, checkReport.oracle_fixture, fixtures.known_good.correctness_evidence);
  assertFixtureBinding("Intentionally-wrong", fixtures.intentionally_wrong, checkReport.wrong_fixture, fixtures.intentionally_wrong.incorrectness_evidence);

  const tarByteLength = deterministicUstarByteLength(sortedEntries.map((entry) => entry.bytes.byteLength));
  if (tarByteLength > EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`Eval release exceeds the ${EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES}-byte uncompressed USTAR limit.`);
  }
  const tar = createUstar(sortedEntries);
  const bundle = gzipSync(tar, { level: 9 });
  bundle.writeUInt32LE(0, 4);
  bundle[9] = 255;
  if (bundle.byteLength > EVAL_RELEASE_MAX_COMPRESSED_BYTES) {
    throw new Error(`Eval release exceeds the ${EVAL_RELEASE_MAX_COMPRESSED_BYTES}-byte compressed limit.`);
  }
  const bundleSha256 = sha256(bundle);
  const publication = EvalPublicationSchema.parse({
    schema_version: "understudy.eval-publication.v1",
    org_id: project.identity.org_id,
    project_id: project.identity.project_id,
    workload_id: project.identity.workload_id,
    eval_id: project.eval_id,
    name: project.name,
    source: {
      from: project.source.window.from,
      to: project.source.window.to,
      ingestion_cutoff: project.source.window.ingestion_cutoff,
      capture_count: project.source.capture_count,
      total_bytes: project.source.size_bytes,
      local_index_sha256: project.source.index_sha256,
      export_proof_sha256: sourceAttestationSha256,
      source_attestation: sourceAttestation,
    },
    artifacts: {
      eval_set_sha256: checked.hashes.eval_set_sha256,
      coverage_sha256: checked.hashes.coverage_sha256,
      environment_sha256: checked.hashes.environment_sha256,
      verifier_sha256: checked.hashes.verifier_sha256,
      check_report_sha256: checked.hashes.check_report_sha256,
      approval_sha256: approvalEntry.sha256,
      bundle_sha256: bundleSha256,
      bundle_r2_key: `eval-release-bundles/${bundleSha256}.tar.gz`,
    },
    runtime: {
      format: harness.format,
      environment_entrypoint: harness.environment_entrypoint,
      verifier_entrypoint: harness.verifier_entrypoint,
    },
    skills: [{ name: "capture-evidence", version: packageVersion }],
    approval,
    artifact_layout: {
      workload_profile: project.artifacts.workload_profile,
      coverage: project.artifacts.coverage,
      harness: project.artifacts.harness,
      environment: project.artifacts.environment,
      metric: project.artifacts.metric,
      splits: project.artifacts.splits,
      tasks: project.artifacts.tasks,
      check_fixtures: environment.fixtures,
      approval: project.artifacts.approval,
      check_report: project.artifacts.check_report,
      fixtures: {
        representative: { candidate: fixtures.representative.candidate, ...(fixtures.representative.state === undefined ? {} : { state: fixtures.representative.state }) },
        known_good: { candidate: fixtures.known_good.candidate, ...(fixtures.known_good.state === undefined ? {} : { state: fixtures.known_good.state }) },
        intentionally_wrong: { candidate: fixtures.intentionally_wrong.candidate, ...(fixtures.intentionally_wrong.state === undefined ? {} : { state: fixtures.intentionally_wrong.state }) },
      },
      environment_root: environmentRoot,
      verifier_root: verifierRoot,
    },
    bundle_files: sortedEntries.map((entry) => ({ path: entry.path, size_bytes: entry.bytes.byteLength, sha256: entry.sha256 })),
  });
  const manifestBytes = Buffer.byteLength(JSON.stringify(publication));
  if (manifestBytes > EVAL_RELEASE_MAX_MANIFEST_BYTES) {
    throw new Error(`Eval publication manifest exceeds the ${EVAL_RELEASE_MAX_MANIFEST_BYTES}-byte limit.`);
  }
  const explicitlyExcluded = [
    ".understudy/",
    "captures/",
    "eval-project.json",
    project.artifacts.analysis,
    project.artifacts.execution_index,
    project.source.export_proof,
    project.source.index,
    "source/",
    "traces/",
  ].filter((path, index, all) => all.indexOf(path) === index)
    .sort(compareCodeUnits)
    .filter((path, index, all) => !all.slice(0, index).some((root) => root.endsWith("/") && path.startsWith(root)));
  return {
    publication,
    bundle,
    localOnly: {
      policy: "Exactly two objects are uploaded: the shown publication manifest and one gzip bundle containing exactly manifest.bundle_files; every other file in the eval project stays local.",
      explicitlyExcluded,
    },
  };
}

function publicationPreview(prepared: PreparedEvalPublication): EvalPublicationPreview {
  const manifestJson = JSON.stringify(prepared.publication);
  return {
    schema_version: "understudy.eval-publication-preview.v1",
    upload_performed: false,
    expected_release_id: deriveEvalReleaseId(prepared.publication),
    manifest: prepared.publication,
    manifest_sha256: sha256(manifestJson),
    manifest_size_bytes: Buffer.byteLength(manifestJson),
    bundle: {
      content_type: "application/gzip",
      filename: `${prepared.publication.eval_id}.tar.gz`,
      sha256: prepared.publication.artifacts.bundle_sha256,
      size_bytes: prepared.bundle.byteLength,
      r2_key: prepared.publication.artifacts.bundle_r2_key,
      files: prepared.publication.bundle_files,
    },
    local_only: {
      policy: prepared.localOnly.policy,
      explicitly_excluded: prepared.localOnly.explicitlyExcluded,
    },
  };
}

export async function previewEvalPublication(projectDirectory: string): Promise<EvalPublicationPreview> {
  return publicationPreview(await prepareEvalPublication(projectDirectory));
}

function assertReleaseMatchesPublication(release: EvalRelease, publication: EvalPublication): void {
  const {
    schema_version: _releaseSchema,
    release_id: _releaseId,
    release_number: _releaseNumber,
    sealed_by_user_id: _sealedBy,
    sealed_at: _sealedAt,
    ...releasePayload
  } = release;
  const { schema_version: _publicationSchema, ...publicationPayload } = publication;
  if (canonicalJson(releasePayload) !== canonicalJson(publicationPayload)) {
    throw new Error("Published eval release does not match the submitted publication.");
  }
  if (release.release_id !== deriveEvalReleaseId(publication)) {
    throw new Error("Published eval release id does not match the submitted publication identity.");
  }
}

export function deriveEvalReleaseId(publicationInput: EvalPublication): string {
  const publication = EvalPublicationSchema.parse(publicationInput);
  const { schema_version: _schemaVersion, ...payload } = publication;
  return `release_${sha256(canonicalJson({ schema_version: "understudy.eval-release-identity.v1", publication: payload })).slice(0, 24)}`;
}

export async function publishEvalRelease(
  projectDirectory: string,
  options: PublishEvalReleaseOptions,
): Promise<EvalRelease> {
  const prepared = await prepareEvalPublication(projectDirectory);
  const expectedReleaseId = EvalReleaseIdSchema.parse(options.expectedReleaseId);
  const actualReleaseId = deriveEvalReleaseId(prepared.publication);
  if (actualReleaseId !== expectedReleaseId) {
    throw new Error(
      `Prepared eval release ${actualReleaseId} does not match the approved preview ${expectedReleaseId}; nothing was uploaded. Run --preview again and obtain fresh permission.`,
    );
  }
  const form = new FormData();
  form.append("manifest", new Blob([JSON.stringify(prepared.publication)], { type: "application/json" }), "manifest.json");
  form.append("bundle", new Blob([new Uint8Array(prepared.bundle)], { type: "application/gzip" }), `${prepared.publication.eval_id}.tar.gz`);
  const response = await request({
    method: "POST",
    url:
      `/admin/v1/orgs/${encodeURIComponent(prepared.publication.org_id)}` +
      `/projects/${encodeURIComponent(prepared.publication.project_id)}` +
      `/workloads/${encodeURIComponent(prepared.publication.workload_id)}/eval-releases`,
    orgId: prepared.publication.org_id,
    rawBody: form,
  }, EvalReleaseSchema);
  assertReleaseMatchesPublication(response.data, prepared.publication);
  return response.data;
}
