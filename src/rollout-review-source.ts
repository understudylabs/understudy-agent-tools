import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { searchWorkloadCaptures, type CaptureSearchInput, type CaptureSearchResult } from "./capture-search.js";
import { exportCapturesByRequestIds, writePrivateText, type CaptureBatchExportInput, type CaptureBatchExportSummary } from "./commands/captures.js";
import { acquireEvalBuildLease } from "./evals/build-state.js";
import { request, UnderstudyApiError } from "./internal/http.js";
import { WorkloadSchema } from "./internal/workloads.js";
import type { RolloutReviewInput } from "./rollout-review.js";

const DAY_MS = 86_400_000;
const SIDES = ["before", "after"] as const;
type Side = typeof SIDES[number];
const token = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const pointer = z.string().min(1).max(2048).refine(value => value.startsWith("/") && !/~(?:[^01]|$)/.test(value), "Selectors must be RFC 6901 JSON pointers.");
const utc = z.string().refine(value => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString() === value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
}).transform(value => new Date(value).toISOString());
const windowSchema = z.object({ workload_id: token, workload_name: token, from: utc, to: utc }).strict();
const specSchema = z.object({
  schema_version: z.literal("understudy.rollout-review-spec.v1"),
  org_id: token,
  project_id: token,
  before: windowSchema,
  after: windowSchema,
  selectors: z.object({ taskId: pointer, userId: pointer, environment: pointer, durationMs: pointer.optional() }).strict(),
  durationBasis: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((spec, context) => {
  for (const side of SIDES) {
    if (spec[side].from >= spec[side].to || Date.parse(spec[side].to) > Date.now()) {
      context.addIssue({ code: "custom", message: "Each window must be nonempty, chronological, and entirely in the past.", path: [side] });
    }
  }
  if (spec.before.to > spec.after.from) context.addIssue({ code: "custom", message: "Before must end at or before after starts; windows cannot overlap." });
  if (!!spec.selectors.durationMs !== !!spec.durationBasis) context.addIssue({ code: "custom", message: "durationMs and an explicit human-readable durationBasis are required together." });
});

export type RolloutReviewSpec = z.infer<typeof specSchema>;
const referenceSchema = z.object({ request_id: token, captured_at: z.string().datetime() }).strict();
const searchResultSchema = z.object({
  window: z.object({ from: utc, to: utc }).strict(),
  index_window: z.object({ from: utc, to: utc }).strict(),
  ingestion_cutoff: z.string().datetime(),
  captures: z.array(referenceSchema),
  scanned_count: z.number().int().nonnegative(),
  pages: z.number().int().positive(),
}).strict();
const partitionSchema = z.object({ side: z.enum(SIDES), result: searchResultSchema }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const inventorySchema = z.object({
  schema_version: z.literal("understudy.rollout-inventory.v1"),
  spec_sha256: digest,
  timestamp_basis: z.literal("request_start"),
  request_environment: z.literal("production"),
  complete: z.boolean(),
  partitions: z.array(partitionSchema),
}).strict();
type Inventory = z.infer<typeof inventorySchema>;
const artifactSchema = referenceSchema.extend({ path: z.string(), sha256: digest, bytes: z.number().int().positive() }).strict();
const receiptSchema = z.object({
  schema_version: z.literal("understudy.rollout-sources.v1"),
  spec_sha256: digest,
  inventory_sha256: digest,
  complete: z.boolean(),
  captures: z.object({ before: z.array(artifactSchema), after: z.array(artifactSchema) }).strict(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
type Artifact = z.infer<typeof artifactSchema>;

/** Injection points are for synthetic, offline acquisition tests. */
export interface RolloutSourceDependencies {
  search?: (input: CaptureSearchInput) => Promise<CaptureSearchResult>;
  exportBatch?: (input: CaptureBatchExportInput) => Promise<CaptureBatchExportSummary>;
  listWorkloads?: (spec: RolloutReviewSpec) => Promise<Array<{ id: string; name: string; project_id?: string }>>;
}

export function loadReviewSpec(path: string): RolloutReviewSpec {
  return parseSpec(readJson(path));
}

/** Freeze indexed request membership, then download and verify exactly that set. No inference or writes to hosted resources. */
export async function acquireRolloutSources(input: RolloutReviewSpec, outputDir: string, dependencies: RolloutSourceDependencies = {}): Promise<RolloutReviewInput> {
  const spec = parseSpec(input);
  const root = normalizePath(outputDir);
  privateDirectory(root);
  const release = acquireEvalBuildLease(join(root, "sources"));
  try {
    const paths = sourcePaths(root);
    privateDirectory(paths.directory);
    if (existsSync(paths.receipt)) {
      const receipt = readReceipt(spec, paths.receipt);
      if (receipt.complete) return readRolloutSources(spec, root);
    }
    await verifyWorkloads(spec, dependencies.listWorkloads ?? listWorkloads);
    const specHash = hash(canonical(spec));
    if (existsSync(paths.spec)) {
      if (canonical(parseSpec(readJson(paths.spec))) !== canonical(spec)) throw new Error("Existing source spec differs; use a new output directory.");
    } else privateJson(paths.spec, spec);
    const inventory: Inventory = existsSync(paths.inventory)
      ? parsePrivate(inventorySchema, paths.inventory, "inventory")
      : { schema_version: "understudy.rollout-inventory.v1", spec_sha256: specHash, timestamp_basis: "request_start", request_environment: "production", complete: false, partitions: [] };
    validateInventory(spec, inventory, false);
    const plans = partitions(spec);
    for (let index = inventory.partitions.length; index < plans.length; index++) {
      const plan = plans[index];
      const result = await retry(() => (dependencies.search ?? searchWorkloadCaptures)({
        orgId: spec.org_id, projectId: spec.project_id, workloadId: spec[plan.side].workload_id, from: plan.from, to: plan.to,
      }));
      const parsed = searchResultSchema.safeParse(result);
      if (!parsed.success) throw new Error("Capture search returned invalid inventory metadata.");
      inventory.partitions.push({ side: plan.side, result: parsed.data });
      validateInventory(spec, inventory, false);
      privateJson(paths.inventory, inventory);
    }
    inventory.complete = true;
    validateInventory(spec, inventory, true);
    privateJson(paths.inventory, inventory);
    const inventoryHash = hash(privateBytes(paths.inventory));
    const receipt: Receipt = existsSync(paths.receipt) ? readReceipt(spec, paths.receipt) : {
      schema_version: "understudy.rollout-sources.v1", spec_sha256: specHash, inventory_sha256: inventoryHash,
      complete: false, captures: { before: [], after: [] },
    };
    if (receipt.inventory_sha256 !== inventoryHash) throw new Error("Frozen inventory hash changed; use a new output directory.");
    verifyArtifacts(spec, root, inventory, receipt, false);
    privateJson(paths.receipt, receipt);
    for (const side of SIDES) {
      const completed = new Set(receipt.captures[side].map(row => row.request_id));
      const pending = references(inventory, side).filter(row => !completed.has(row.request_id));
      privateDirectory(join(paths.directory, side));
      for (let start = 0; start < pending.length; start += 1000) {
        const batch = pending.slice(start, start + 1000);
        // Isolated fresh staging avoids the generic exporter's nonempty-file resume heuristic.
        const stage = join(paths.directory, `.download-${randomUUID()}`);
        privateDirectory(stage);
        try {
          const summary = await (dependencies.exportBatch ?? exportCapturesByRequestIds)({
            orgId: spec.org_id, projectId: spec.project_id, workloadId: spec[side].workload_id,
            requestIds: batch.map(row => row.request_id), outputDirectory: stage, includePayload: true,
            concurrency: 4, retries: 2, resume: false,
          });
          if (!summary.ok || summary.failed !== 0 || summary.skipped !== 0 || summary.written !== batch.length || summary.unique_count !== batch.length || !summary.include_payload || summary.output_suffix !== ".payload.json") {
            throw new Error("Capture download is incomplete; rerun to retry the frozen inventory. No complete source receipt was written.");
          }
          const verified: Artifact[] = [];
          for (const reference of batch) {
            const bytes = privateBytes(join(stage, `${encodeURIComponent(reference.request_id)}.payload.json`));
            validateCapture(spec, side, reference.request_id, parseCapture(bytes));
            const artifact: Artifact = { ...reference, path: `sources/${side}/${hash(reference.request_id)}.payload.json`, sha256: hash(bytes), bytes: bytes.length };
            const target = artifactPath(root, artifact, side);
            // Orphaned files from an interrupted batch are never accepted as resume evidence.
            if (existsSync(target)) privateBytes(target);
            writePrivateText(target, bytes.toString("utf8"));
            verified.push(artifact);
          }
          receipt.captures[side].push(...verified);
          privateJson(paths.receipt, receipt);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      }
    }
    verifyArtifacts(spec, root, inventory, receipt, true);
    receipt.complete = true;
    privateJson(paths.receipt, receipt);
    return readRolloutSources(spec, root);
  } finally { release(); }
}

/** Offline read. Every build rechecks inventory commitment, identity, byte length and SHA-256; a completed receipt is immutable. */
export function readRolloutSources(input: RolloutReviewSpec, outputDir: string): RolloutReviewInput {
  const spec = parseSpec(input);
  const root = normalizePath(outputDir);
  const paths = sourcePaths(root);
  if (canonical(parseSpec(readJson(paths.spec))) !== canonical(spec)) throw new Error("Source spec does not match this review.");
  const inventory = parsePrivate(inventorySchema, paths.inventory, "inventory");
  validateInventory(spec, inventory, true);
  const receipt = readReceipt(spec, paths.receipt);
  if (!receipt.complete || receipt.inventory_sha256 !== hash(privateBytes(paths.inventory))) throw new Error("Source receipt is incomplete or its inventory hash changed.");
  const result = verifyArtifacts(spec, root, inventory, receipt, true);
  result.scope = {
    orgId: spec.org_id, projectId: spec.project_id,
    sourceManifest: { path: "sources/receipt.json", sha256: hash(privateBytes(paths.receipt)) },
    specSha256: receipt.spec_sha256, inventorySha256: receipt.inventory_sha256,
  };
  return result;
}

function parseSpec(value: unknown): RolloutReviewSpec {
  const parsed = specSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid rollout review spec: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

function partitions(spec: RolloutReviewSpec): Array<{ side: Side; from: string; to: string }> {
  return SIDES.flatMap(side => {
    const result = [];
    const end = Date.parse(spec[side].to);
    for (let at = Date.parse(spec[side].from); at < end; at += DAY_MS) result.push({ side, from: new Date(at).toISOString(), to: new Date(Math.min(at + DAY_MS, end)).toISOString() });
    return result;
  });
}

function validateInventory(spec: RolloutReviewSpec, inventory: Inventory, complete: boolean): void {
  const plans = partitions(spec);
  if (inventory.spec_sha256 !== hash(canonical(spec)) || inventory.partitions.length > plans.length || (complete && (!inventory.complete || inventory.partitions.length !== plans.length))) throw new Error("Inventory is incomplete or does not match the frozen spec.");
  const allIds = new Set<string>();
  inventory.partitions.forEach((partition, index) => {
    const plan = plans[index];
    const result = partition.result;
    if (partition.side !== plan.side || result.window.from !== plan.from || result.window.to !== plan.to ||
      Date.parse(result.index_window.from) > Date.parse(plan.from) || Date.parse(result.index_window.to) < Date.parse(plan.to) ||
      Date.parse(result.index_window.to) - Date.parse(result.index_window.from) !== DAY_MS ||
      Date.parse(result.ingestion_cutoff) < Date.parse(result.index_window.to) || Date.parse(result.ingestion_cutoff) > Date.now() + 60_000 || result.scanned_count < result.captures.length || result.captures.length > 100_000) throw new Error("Inventory partition scope or accounting is invalid.");
    for (const row of result.captures) {
      const at = Date.parse(row.captured_at);
      if (at < Date.parse(plan.from) || at >= Date.parse(plan.to) || allIds.has(row.request_id)) throw new Error("Inventory repeats a request or contains a request outside its exact window.");
      allIds.add(row.request_id);
    }
  });
}

function references(inventory: Inventory, side: Side) { return inventory.partitions.filter(partition => partition.side === side).flatMap(partition => partition.result.captures); }

function verifyArtifacts(spec: RolloutReviewSpec, root: string, inventory: Inventory, receipt: Receipt, requireComplete: boolean): RolloutReviewInput {
  const result = { selectors: spec.selectors, ...(spec.durationBasis ? { durationBasis: spec.durationBasis } : {}) } as RolloutReviewInput;
  for (const side of SIDES) {
    const expected = new Map(references(inventory, side).map(row => [row.request_id, row]));
    const seen = new Set<string>();
    const captures = receipt.captures[side].map(row => {
      if (!expected.has(row.request_id) || expected.get(row.request_id)!.captured_at !== row.captured_at || seen.has(row.request_id)) throw new Error("Source receipt membership differs from the frozen request inventory.");
      seen.add(row.request_id);
      const path = artifactPath(root, row, side);
      const bytes = privateBytes(path);
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error("A source capture changed after acquisition; restore the original file or use a new output directory.");
      const capture = parseCapture(bytes);
      validateCapture(spec, side, row.request_id, capture);
      return { capture, source: { path: row.path, sha256: row.sha256, request_started_at: row.captured_at } };
    });
    if (requireComplete && seen.size !== expected.size) throw new Error("Source capture count does not cover every frozen request ID.");
    result[side] = { captures, workload: spec[side].workload_id, workloadName: spec[side].workload_name, from: spec[side].from, to: spec[side].to };
  }
  return result;
}

function validateCapture(spec: RolloutReviewSpec, side: Side, requestId: string, value: unknown): void {
  const capture = value as Record<string, unknown>;
  if (!capture || typeof capture !== "object" || Array.isArray(capture) || capture.request_id !== requestId || capture.workos_org_id !== spec.org_id || capture.project_id !== spec.project_id ||
    (capture.workload_id ?? capture.placement_id) !== spec[side].workload_id ||
    (capture.workload_id != null && capture.placement_id != null && capture.workload_id !== capture.placement_id)) throw new Error("Capture identity does not match its frozen organization, project, workload and request ID.");
}

async function listWorkloads(spec: RolloutReviewSpec) {
  const schema = z.object({ workloads: z.array(WorkloadSchema), cursor: z.string().nullable().optional() }).passthrough();
  const workloads: z.infer<typeof WorkloadSchema>[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await retry(() => request({
      url: `/admin/v1/orgs/${encodeURIComponent(spec.org_id)}/projects/${encodeURIComponent(spec.project_id)}/workloads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      orgId: spec.org_id, signal: AbortSignal.timeout(60_000),
    }, schema));
    workloads.push(...response.data.workloads);
    cursor = response.data.cursor ?? null;
    if (cursor !== null) {
      if (!cursor || cursors.has(cursor) || response.data.workloads.length === 0) throw new Error("Workload listing returned an invalid continuation.");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return workloads;
}

async function verifyWorkloads(spec: RolloutReviewSpec, list: NonNullable<RolloutSourceDependencies["listWorkloads"]>): Promise<void> {
  const rows = await list(spec);
  for (const side of SIDES) {
    const matched = rows.filter(row => row.id === spec[side].workload_id);
    if (matched.length !== 1 || matched[0].name !== spec[side].workload_name || (matched[0].project_id !== undefined && matched[0].project_id !== spec.project_id)) throw new Error("Selected workload ID/name is absent, ambiguous, or outside the requested project.");
  }
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      const transient = error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") || (error instanceof UnderstudyApiError && ([408, 425, 429].includes(error.status) || error.status >= 500));
      if (!transient || attempt >= 2) throw error;
      await new Promise(done => setTimeout(done, 250 * 2 ** attempt));
    }
  }
}

function sourcePaths(root: string) { const directory = join(root, "sources"); return { directory, spec: join(directory, "spec.json"), inventory: join(directory, "inventory.json"), receipt: join(directory, "receipt.json") }; }
function readReceipt(spec: RolloutReviewSpec, path: string): Receipt { const value = parsePrivate(receiptSchema, path, "receipt"); if (value.spec_sha256 !== hash(canonical(spec))) throw new Error("Receipt spec hash differs; use a new output directory."); return value; }
function artifactPath(root: string, row: Artifact, side: Side): string { if (row.path !== `sources/${side}/${hash(row.request_id)}.payload.json` || isAbsolute(row.path)) throw new Error("Invalid capture artifact path."); return join(root, row.path); }
function parseCapture(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Capture payload is not a readable JSON object."); } }
function readJson(path: string): unknown { try { return JSON.parse(privateBytes(path).toString("utf8")); } catch { throw new Error("Cannot read valid private rollout JSON; check its path and file integrity."); } }
function parsePrivate<T>(schema: z.ZodType<T>, path: string, label: string): T { const parsed = schema.safeParse(readJson(path)); if (!parsed.success) throw new Error(`Invalid rollout source ${label}.`); return parsed.data; }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function normalizePath(path: string): string {
  const absolute = resolve(path);
  // macOS exposes its standard temporary roots through these OS-owned aliases.
  // Canonicalize only the known aliases, never arbitrary user/data symlinks.
  if (process.platform === "darwin") for (const alias of ["/tmp", "/var"]) {
    if (absolute === alias || absolute.startsWith(`${alias}/`)) {
      try { if (realpathSync(alias) === `/private${alias}`) return `/private${absolute}`; } catch { /* Normal validation below reports missing paths. */ }
    }
  }
  return absolute;
}
function assertNoSymlinks(path: string): void {
  let current = normalizePath(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Rollout paths cannot contain symlinks."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function privateDirectory(path: string): void { assertNoSymlinks(path); mkdirSync(path, { recursive: true, mode: 0o700 }); if (!lstatSync(path).isDirectory()) throw new Error("Rollout output must be a directory."); chmodSync(path, 0o700); }
function privateBytes(path: string): Buffer { assertNoSymlinks(path); const stat = lstatSync(path); if (!stat.isFile() || stat.nlink !== 1) throw new Error("Rollout source must be a regular unlinked file."); return readFileSync(path); }
function privateJson(path: string, value: unknown): void { privateDirectory(dirname(path)); assertNoSymlinks(path); writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`); }
