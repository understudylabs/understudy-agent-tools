import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  EvalBuildCreatingStateSchema,
  EvalBuildStateSchema,
  EvalWorkloadBuildStateSchema,
  type CatalogResponse,
  type Cohort,
  type EvalBuildCreatingState,
  type EvalBuildIdentity,
  type EvalLegacyBuildState,
  type EvalBuildSelection,
  type EvalBuildState,
  type EvalWorkloadBuildState,
  type FrozenCohort,
} from "./contracts.js";

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createPrivateDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Private path must be a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export function replacePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writePrivateJson(temporary, value);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function initializeBuildCheckpoint(staging: string, state: EvalBuildState): void {
  if (pathExists(staging)) throw new Error(`Eval build checkpoint already exists: ${staging}`);
  const temporary = join(dirname(staging), `.${basename(staging)}.init-${randomUUID()}`);
  try {
    createPrivateDirectory(temporary);
    writePrivateJson(join(temporary, "build-state.json"), state);
    renameSync(temporary, staging);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readEvalBuildState(staging: string): EvalBuildState {
  const stagingStat = lstatSync(staging);
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
    throw new Error(`Eval build staging path must be a real directory: ${staging}`);
  }
  chmodSync(staging, 0o700);
  const statePath = join(staging, "build-state.json");
  const stateStat = lstatSync(statePath);
  if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
    throw new Error(`Eval build state must be a real file: ${statePath}`);
  }
  chmodSync(statePath, 0o600);
  return EvalBuildStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
}

export function creatingBuildState(
  name: string,
  description: string | undefined,
  identity: EvalBuildIdentity,
  catalog: CatalogResponse,
  selection: EvalBuildSelection,
  maxAgeDays: number,
  batchSize: number,
  now: Date,
): EvalBuildCreatingState {
  const operationId = randomUUID();
  return EvalBuildCreatingStateSchema.parse({
    schema_version: "understudy.eval-build-state.v1",
    status: "cohort_creating",
    created_at: now.toISOString(),
    name,
    identity,
    selection,
    create_request: {
      operation_id: operationId,
      name,
      selection: {
        source: "explicit_capture_references",
        ...(description === undefined ? {} : { description }),
        sampling_seed: catalog.selection.sample_seed,
      },
      captures: catalog.captures.map(({ capture_key, request_id, content_sha256 }) => ({ capture_key, request_id, content_sha256 })),
    },
    compile: { max_age_days: maxAgeDays, batch_size: batchSize },
  });
}

export function buildState(
  status: "cohort_frozen" | "complete",
  name: string,
  identity: EvalBuildIdentity,
  cohort: FrozenCohort,
  selection: EvalBuildSelection,
  maxAgeDays: number,
  batchSize: number,
  now: Date,
) {
  return {
    schema_version: "understudy.eval-build-state.v1" as const,
    status,
    created_at: now.toISOString(),
    name,
    identity,
    selection,
    cohort,
    compile: { max_age_days: maxAgeDays, batch_size: batchSize },
  };
}

export function assertBuildStateMatches(
  state: EvalBuildState,
  name: string,
  identity: EvalBuildIdentity,
  selection: EvalBuildSelection,
  maxAgeDays: number,
  batchSize: number,
): asserts state is EvalLegacyBuildState {
  if (state.schema_version !== "understudy.eval-build-state.v1") {
    throw new Error("Existing eval build state uses a different build workflow.");
  }
  if (state.status === "complete" || state.name !== name) {
    throw new Error("Existing eval build state does not match this resumable build.");
  }
  for (const key of ["org_id", "project_id", "workload_id"] as const) {
    if (state.identity[key] !== identity[key]) {
      throw new Error(`Existing eval build state does not match ${key}.`);
    }
  }
  if (state.compile.max_age_days !== maxAgeDays || state.compile.batch_size !== batchSize) {
    throw new Error("Existing eval build state does not match the compile options.");
  }
  if (JSON.stringify(state.selection) !== JSON.stringify(selection)) {
    throw new Error("Existing eval build state does not match the capture selection options.");
  }
}

export function creatingWorkloadBuildState(input: {
  name: string;
  identity: EvalBuildIdentity;
  source: EvalWorkloadBuildState["source"];
  maxAgeDays: number;
  batchSize: number;
  now: Date;
}): EvalWorkloadBuildState {
  return EvalWorkloadBuildStateSchema.parse({
    schema_version: "understudy.eval-build-state.v2",
    status: "downloading",
    created_at: input.now.toISOString(),
    name: input.name,
    identity: input.identity,
    source: input.source,
    compile: { max_age_days: input.maxAgeDays, batch_size: input.batchSize },
    transport: {
      resume_cursor: null,
      chain_id: null,
      next_segment_index: 0,
      previous_manifest_sha256: null,
      segment_manifest_sha256: [],
      cumulative_exported: 0,
      cumulative_total_bytes: 0,
      terminal_receipt: null,
      verified_files: [],
    },
  });
}

export function assertWorkloadBuildStateMatches(
  state: EvalBuildState,
  name: string,
  identity: EvalBuildIdentity,
  maxAgeDays: number,
  batchSize: number,
): asserts state is EvalWorkloadBuildState {
  if (state.schema_version !== "understudy.eval-build-state.v2" || state.name !== name) {
    throw new Error("Existing eval build state does not match this resumable full-corpus build.");
  }
  for (const key of ["org_id", "project_id", "workload_id"] as const) {
    if (state.identity[key] !== identity[key]) {
      throw new Error(`Existing eval build state does not match ${key}.`);
    }
  }
  if (state.compile.max_age_days !== maxAgeDays || state.compile.batch_size !== batchSize) {
    throw new Error("Existing eval build state does not match the build options.");
  }
}

export function ensureUnderstudyGitExcluded(output: string): void {
  const absoluteOutput = resolve(output);
  let existing = resolve(output);
  while (!pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return;
    existing = parent;
  }
  const canonicalExisting = realpathSync(existing);
  const canonicalOutput = resolve(canonicalExisting, relative(existing, absoluteOutput));
  const rootResult = spawnSync("git", ["-C", canonicalExisting, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (rootResult.status !== 0) return;
  const root = rootResult.stdout.trim();
  const relativeOutput = relative(root, canonicalOutput);
  if (relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) return;
  if (relativeOutput === ".understudy") {
    throw new Error(`Eval build destination must be a child directory under ${join(root, ".understudy")}; the root itself is reserved.`);
  }
  if (relativeOutput !== ".understudy" && !relativeOutput.startsWith(`.understudy${sep}`)) {
    throw new Error(`Eval builds inside a Git repository must use a destination under ${join(root, ".understudy")}.`);
  }

  const excludeResult = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (excludeResult.status !== 0) return;
  const rawExcludePath = excludeResult.stdout.trim();
  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(root, rawExcludePath);
  mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  const current = pathExists(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (current.split(/\r?\n/).includes("/.understudy/")) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(excludePath, `${current}${separator}/.understudy/\n`, { encoding: "utf8", mode: 0o600 });
}

export function cohortFromResponse(cohort: Cohort): FrozenCohort {
  return { id: cohort.id, cohort_sha256: cohort.cohort_sha256, capture_count: cohort.capture_count };
}

interface LeaseOwner {
  token: string;
  pid: number;
  process_instance_id?: string;
  created_at: string;
}

function processInstanceId(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (!bootId || commandEnd === -1) return null;
      const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTimeTicks = fieldsAfterCommand[19];
      if (!/^\d+$/.test(startTimeTicks ?? "")) return null;
      return `linux-proc-v1:${pid}:${bootId}:${startTimeTicks}`;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", LANG: "C" },
      timeout: 1_000,
      maxBuffer: 1_024,
    });
    const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    return startedAt ? `darwin-ps-v1:${pid}:${startedAt}` : null;
  }

  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireEvalBuildLease(output: string): () => void {
  const leasePath = join(dirname(output), `.${basename(output)}.eval-build.lock`);
  mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(leasePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: LeaseOwner | null = null;
    try {
      owner = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as LeaseOwner;
    } catch {
      throw new Error(`Another eval build owns ${output}; lock metadata is incomplete at ${leasePath}.`);
    }
    if (Number.isInteger(owner.pid) && processIsAlive(owner.pid)) {
      const observedProcessInstanceId = processInstanceId(owner.pid);
      if (
        typeof owner.process_instance_id !== "string" ||
        observedProcessInstanceId === null ||
        owner.process_instance_id === observedProcessInstanceId
      ) {
        throw new Error(`Another eval build (pid ${owner.pid}) already owns ${output}.`);
      }
    }
    throw new Error(`A stale eval build lock remains at ${leasePath} (owner pid ${owner.pid}). Remove that exact lock directory, then rerun to resume.`);
  }
  const instanceId = processInstanceId(process.pid);
  const owner: LeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    ...(instanceId === null ? {} : { process_instance_id: instanceId }),
    created_at: new Date().toISOString(),
  };
  try {
    writePrivateJson(join(leasePath, "owner.json"), owner);
  } catch (error) {
    rmSync(leasePath, { recursive: true, force: true });
    throw error;
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as LeaseOwner;
      if (current.token === owner.token) rmSync(leasePath, { recursive: true, force: true });
    } catch {
      // A missing lock is already released; a replaced lock belongs to another process.
    }
  };
}
