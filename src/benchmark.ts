/**
 * understudy.benchmark.v1 support: manifest validation, trace-DAG branch
 * extraction, and projection of branches onto understudy.eval_result.v1 rows.
 *
 * The projection rule is the results contract of benchmark.v1: runs retain
 * the traces.jsonl message DAG as evidence, and each root-to-leaf branch
 * becomes exactly one eval row. Everything downstream (viewer scoreboards,
 * claim packets, sweeps) consumes rows, never DAGs.
 */

import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// "derived-from-dataset" is the dataset-foundry origin (labeled JSONL/CSV rows
// compiled into benchmark tasks) — additive to the trace-derived/imported/
// authored trio; old manifests never carried it, old readers fall through to
// their unknown-origin styling.
const PROVENANCE_ORIGINS = ["derived-from-traces", "derived-from-dataset", "imported", "authored"];
const IMPORT_FORMATS = ["verifiers.v1", "verifiers.v0", "harbor", "inspect_ai", "automationbench", "hf-dataset", "other"];
const TASK_GENESIS = ["replayed", "synthesized", "imported"];
const TASK_SPLITS = ["train", "dev", "holdout", "none"];
const GOLD_KINDS = ["final-state", "rubric", "reference"];
const ENV_FORMATS = ["verifiers.v1", "verifiers.v0"];
const VERIFIER_KINDS = ["final-state", "reward-fns", "rubric-judge"];

/**
 * Lightweight structural validation mirroring the JSON Schema, in the same
 * no-dependency style the repo's tests use for eval_result.v1. Returns a
 * list of human-readable errors; empty means valid.
 */
export function validateBenchmarkManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(manifest)) return ["manifest must be a JSON object"];

  if (manifest.schema_version !== "understudy.benchmark.v1") {
    errors.push("schema_version must be understudy.benchmark.v1");
  }
  if (!stringField(manifest, "benchmark_id")) errors.push("benchmark_id is required");

  const provenance = manifest.provenance;
  if (!isObject(provenance)) {
    errors.push("provenance is required");
  } else {
    if (!PROVENANCE_ORIGINS.includes(provenance.origin as string)) {
      errors.push(`provenance.origin outside enum: ${String(provenance.origin)}`);
    }
    const imported = provenance.imported_from;
    if (provenance.origin === "imported" && !isObject(imported)) {
      errors.push("provenance.imported_from is required when origin is imported");
    }
    if (isObject(imported)) {
      if (!IMPORT_FORMATS.includes(imported.format as string)) {
        errors.push(`provenance.imported_from.format outside enum: ${String(imported.format)}`);
      }
      if (!stringField(imported, "ref")) errors.push("provenance.imported_from.ref is required");
    }
  }

  const taxonomy = manifest.taxonomy;
  const categoryIds = new Set<string>();
  if (!Array.isArray(taxonomy)) {
    errors.push("taxonomy is required and must be an array");
  } else {
    for (const [i, category] of taxonomy.entries()) {
      if (!isObject(category) || !stringField(category, "category_id")) {
        errors.push(`taxonomy[${i}].category_id is required`);
        continue;
      }
      categoryIds.add(category.category_id as string);
    }
  }

  const tasks = manifest.tasks;
  if (!Array.isArray(tasks)) {
    errors.push("tasks is required and must be an array");
  } else {
    for (const [i, task] of tasks.entries()) {
      if (!isObject(task)) {
        errors.push(`tasks[${i}] must be an object`);
        continue;
      }
      if (!stringField(task, "task_id")) errors.push(`tasks[${i}].task_id is required`);
      const categoryId = stringField(task, "category_id");
      if (!categoryId) {
        errors.push(`tasks[${i}].category_id is required`);
      } else if (categoryIds.size > 0 && !categoryIds.has(categoryId)) {
        errors.push(`tasks[${i}].category_id not in taxonomy: ${categoryId}`);
      }
      if (!TASK_GENESIS.includes(task.genesis as string)) {
        errors.push(`tasks[${i}].genesis outside enum: ${String(task.genesis)}`);
      }
      if (!TASK_SPLITS.includes(task.split as string)) {
        errors.push(`tasks[${i}].split outside enum: ${String(task.split)}`);
      }
      const gold = task.gold;
      if (gold !== null && gold !== undefined) {
        if (!isObject(gold) || !GOLD_KINDS.includes(gold.kind as string) || !stringField(gold, "ref")) {
          errors.push(`tasks[${i}].gold must have kind (enum) and ref`);
        }
      }
    }
  }

  const environment = manifest.environment;
  if (!isObject(environment)) {
    errors.push("environment is required");
  } else {
    if (!ENV_FORMATS.includes(environment.format as string)) {
      errors.push(`environment.format outside enum: ${String(environment.format)}`);
    }
    if (!stringField(environment, "package_ref")) errors.push("environment.package_ref is required");
  }

  const verifier = manifest.verifier;
  if (!isObject(verifier)) {
    errors.push("verifier is required");
  } else {
    if (!VERIFIER_KINDS.includes(verifier.kind as string)) {
      errors.push(`verifier.kind outside enum: ${String(verifier.kind)}`);
    }
    if (!stringField(verifier, "strict_metric")) errors.push("verifier.strict_metric is required");
  }

  return errors;
}

/**
 * One node of a rollout message DAG, normalized from a traces.jsonl record.
 * Field names in verifiers 0.2.0 traces.jsonl are adapter-mapped in
 * normalizeTraceRecord — the mapping must stay pinned by a golden fixture
 * generated from a real `uv run eval` run, not by reading upstream docs.
 */
export type TraceNode = {
  id: string;
  parents: string[];
  taskId: string | null;
  reward: number | null;
  metrics: Record<string, number>;
};

export type Branch = {
  taskId: string | null;
  /** Node ids from root to leaf. */
  path: string[];
  /** Reward of the deepest node on the path that carries one. */
  reward: number | null;
  /** Metrics of the deepest node on the path that carries any. */
  metrics: Record<string, number>;
};

const ID_KEYS = ["id", "message_id", "node_id"];
const PARENT_KEYS = ["parents", "parent_ids", "predecessors", "prev_ids"];
const TASK_KEYS = ["task_id", "task"];

/** Normalize one traces.jsonl record into a TraceNode; null if it has no usable id. */
export function normalizeTraceRecord(record: unknown): TraceNode | null {
  if (!isObject(record)) return null;
  let id: string | null = null;
  for (const key of ID_KEYS) {
    id = stringField(record, key);
    if (id) break;
  }
  if (!id) return null;

  let parents: string[] = [];
  for (const key of PARENT_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      parents = value.filter((p): p is string => typeof p === "string");
      break;
    }
    if (typeof value === "string") {
      parents = [value];
      break;
    }
  }

  let taskId: string | null = null;
  for (const key of TASK_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      taskId = value;
      break;
    }
    if (isObject(value)) {
      taskId = stringField(value, "id") ?? stringField(value, "task_id");
      if (taskId) break;
    }
  }

  const reward = typeof record.reward === "number" && Number.isFinite(record.reward) ? record.reward : null;
  const metrics: Record<string, number> = {};
  if (isObject(record.metrics)) {
    for (const [key, value] of Object.entries(record.metrics)) {
      if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
    }
  }

  return { id, parents, taskId, reward, metrics };
}

/**
 * Extract every root-to-leaf branch from a message DAG. Cycle-safe (a node
 * is never revisited on its own path) and deterministic: roots and children
 * are traversed in input order. Edges to unknown parent ids are dropped, so
 * an orphaned subtree becomes its own root rather than vanishing.
 */
export function extractBranches(nodes: TraceNode[]): Branch[] {
  const byId = new Map<string, TraceNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  const children = new Map<string, string[]>();
  const hasKnownParent = new Set<string>();
  for (const node of byId.values()) {
    for (const parent of node.parents) {
      if (!byId.has(parent) || parent === node.id) continue;
      hasKnownParent.add(node.id);
      const list = children.get(parent) ?? [];
      list.push(node.id);
      children.set(parent, list);
    }
  }

  const branches: Branch[] = [];
  const visited = new Set<string>();
  const walk = (id: string, path: string[]) => {
    visited.add(id);
    const nextPath = [...path, id];
    const kids = (children.get(id) ?? []).filter((kid) => !nextPath.includes(kid));
    if (kids.length === 0) {
      let reward: number | null = null;
      let metrics: Record<string, number> = {};
      let taskId: string | null = null;
      for (const nodeId of nextPath) {
        const node = byId.get(nodeId)!;
        if (node.reward !== null) reward = node.reward;
        if (Object.keys(node.metrics).length > 0) metrics = node.metrics;
        if (node.taskId !== null) taskId = node.taskId;
      }
      branches.push({ taskId, path: nextPath, reward, metrics });
      return;
    }
    for (const kid of kids) walk(kid, nextPath);
  };

  for (const node of byId.values()) {
    if (!hasKnownParent.has(node.id)) walk(node.id, []);
  }
  // A cycle with no external entry point has no root; sweep any node the
  // root walks never reached so malformed traces surface rather than vanish.
  for (const node of byId.values()) {
    if (!visited.has(node.id)) walk(node.id, []);
  }
  return branches;
}

export type ProjectionOptions = {
  runId: string;
  model?: string | null;
  route?: string | null;
};

type ManifestTask = { split: string; goldPresent: boolean; categoryId: string | null };

/**
 * Project branches onto understudy.eval_result.v1 rows: one row per branch.
 * benchmark_id / category_id / trace_ref ride along as extension fields
 * (eval_result.v1 allows producer extras; consumers ignore unknown fields).
 * A reward outside 0..1 is preserved raw in subscores and clamped for score,
 * because eval_result.v1 pins score to 0..1.
 */
export function projectBranchesToEvalRows(
  manifest: JsonObject,
  branches: Branch[],
  options: ProjectionOptions,
): JsonObject[] {
  const benchmarkId = stringField(manifest, "benchmark_id") ?? "unknown-benchmark";
  const strictMetric = isObject(manifest.verifier) ? stringField(manifest.verifier, "strict_metric") : null;
  const denseMetric = isObject(manifest.verifier) ? stringField(manifest.verifier, "dense_metric") : null;

  const tasksById = new Map<string, ManifestTask>();
  if (Array.isArray(manifest.tasks)) {
    for (const task of manifest.tasks) {
      if (!isObject(task)) continue;
      const taskId = stringField(task, "task_id");
      if (!taskId) continue;
      tasksById.set(taskId, {
        split: TASK_SPLITS.includes(task.split as string) ? (task.split as string) : "none",
        goldPresent: isObject(task.gold),
        categoryId: stringField(task, "category_id"),
      });
    }
  }

  return branches.map((branch, index) => {
    const manifestTask = branch.taskId ? tasksById.get(branch.taskId) : undefined;
    const strict = strictMetric !== null && strictMetric in branch.metrics ? branch.metrics[strictMetric] : branch.reward;
    const scored = strict !== null && strict !== undefined;
    const subscores: Record<string, number> = {};
    if (denseMetric && denseMetric in branch.metrics) subscores[denseMetric] = branch.metrics[denseMetric];
    if (scored && (strict < 0 || strict > 1)) subscores.raw_reward = strict;

    return {
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: branch.taskId ?? `branch-${index}`,
      split: manifestTask?.split ?? "none",
      score: scored ? Math.min(1, Math.max(0, strict)) : null,
      subscores: Object.keys(subscores).length > 0 ? subscores : null,
      status: scored ? "ok" : manifestTask?.goldPresent ? "error" : "unscored",
      model: options.model ?? null,
      route: options.route ?? null,
      benchmark_id: benchmarkId,
      category_id: manifestTask?.categoryId ?? null,
      trace_ref: { branch_leaf: branch.path[branch.path.length - 1], branch_depth: branch.path.length },
    };
  });
}

/* ------------------------------------------------------------------------- *
 * Task versioning: content hashes and the rerun/regrade/reuse contract.
 *
 * Each task's fields partition into three groups, each hashed separately
 * over canonical JSON (sorted keys, stable encoding):
 *   env      — anything the candidate sees or runs in. Change => MAJOR => rerun.
 *   verifier — gold refs, verifier/contract/rubric/metric config.
 *              Change => MINOR => regrade existing traces.
 *   meta     — title, docs, everything else. Change => PATCH => reuse.
 * Unknown extra fields default to the env group (conservative: forces rerun).
 * The versioning bookkeeping fields themselves (version, content_hashes) are
 * excluded from all groups so hashes are not self-referential.
 * ------------------------------------------------------------------------- */

export type TaskContentHashes = {
  env_sha256: string;
  verifier_sha256: string;
  meta_sha256: string;
};

export type BumpKind = "major" | "minor" | "patch" | "none";

const ENV_FIELDS = new Set([
  "instruction",
  "prompt",
  "prompt_ref",
  "system_prompt",
  "inputs",
  "input_ref",
  "fixtures",
  "fixtures_ref",
  "environment",
  "environment_ref",
  "package_ref",
  "tool_surface",
  "tools",
  "seed",
  "genesis",
  "generator_ref",
]);

const VERIFIER_FIELDS = new Set([
  "gold",
  "gold_ref",
  "verifier",
  "verifier_ref",
  "contract",
  "rubric",
  "rubric_ref",
  "metric",
  "metrics",
  "metric_config",
  "checks",
  "reward",
  "reward_fns",
]);

const META_FIELDS = new Set([
  "task_id",
  "category_id",
  "split",
  "title",
  "name",
  "description",
  "docs",
  "notes",
  "tags",
  "created_at",
  // Review/provenance bookkeeping on manifest tasks: a review-decision flip
  // or incumbent re-attribution changes neither what candidates see nor how
  // they are graded — never a rerun. (task_hash stays in the env default:
  // it only moves when real content moved, so conservative-major is right.)
  "status",
  "incumbent",
  "capability_fit",
]);

/** Bookkeeping fields never hashed into any group. */
const VERSIONING_FIELDS = new Set(["version", "content_hashes"]);

/** Canonical JSON: recursively sorted object keys, JSON string encoding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ComputeTaskContentHashesOptions = {
  /** Extra field names to force into the env group. */
  envFields?: string[];
  /** Extra field names to force into the verifier group. */
  verifierFields?: string[];
  /** Extra field names to force into the meta group. */
  metaFields?: string[];
};

/**
 * Deterministic canonical-JSON sha256 over the three declared field groups.
 * Options take precedence over the built-in partition; unknown fields not
 * claimed by any group land in env (conservative: forces rerun).
 */
export function computeTaskContentHashes(
  task: JsonObject,
  opts: ComputeTaskContentHashesOptions = {},
): TaskContentHashes {
  const envExtra = new Set(opts.envFields ?? []);
  const verifierExtra = new Set(opts.verifierFields ?? []);
  const metaExtra = new Set(opts.metaFields ?? []);

  const env: JsonObject = {};
  const verifier: JsonObject = {};
  const meta: JsonObject = {};
  for (const [key, value] of Object.entries(task)) {
    if (value === undefined) continue;
    if (envExtra.has(key)) env[key] = value;
    else if (verifierExtra.has(key)) verifier[key] = value;
    else if (metaExtra.has(key)) meta[key] = value;
    else if (VERSIONING_FIELDS.has(key)) continue;
    else if (VERIFIER_FIELDS.has(key)) verifier[key] = value;
    else if (META_FIELDS.has(key)) meta[key] = value;
    else env[key] = value; // ENV_FIELDS and unknown extras alike
  }
  void ENV_FIELDS; // documented partition; env is also the default bucket

  return {
    env_sha256: sha256(canonicalJson(env)),
    verifier_sha256: sha256(canonicalJson(verifier)),
    meta_sha256: sha256(canonicalJson(meta)),
  };
}

export type TaskChange = {
  bump: BumpKind;
  /** Which hash groups changed: subset of ["env", "verifier", "meta"]. */
  changed: string[];
};

/** The task's STAMPED content_hashes when complete (all three shas), else null. */
export function stampedTaskContentHashes(task: JsonObject): TaskContentHashes | null {
  const hashes = task.content_hashes;
  if (!isObject(hashes)) return null;
  const env = stringField(hashes, "env_sha256");
  const verifier = stringField(hashes, "verifier_sha256");
  const meta = stringField(hashes, "meta_sha256");
  return env && verifier && meta ? { env_sha256: env, verifier_sha256: verifier, meta_sha256: meta } : null;
}

/**
 * Compare two task objects by their three content hashes.
 *
 * When BOTH sides carry stamped `content_hashes` (born-versioned tasks — the
 * foundry stamps them over the FULL tasks.jsonl content), the stamps are
 * compared directly. This matters for benchmark-manifest tasks: manifest
 * tasks are references (gold.ref points into tasks.jsonl, instructions and
 * contracts are not inlined), so rehashing their surface fields cannot see a
 * gold/instruction edit — only the stamped hashes carry that signal. Only
 * when either side is unstamped do we fall back to rehashing the surface
 * fields (legacy manifests; conservative — unknown fields land in env).
 */
export function classifyTaskChange(
  oldTask: JsonObject,
  newTask: JsonObject,
  opts: ComputeTaskContentHashesOptions = {},
): TaskChange {
  const oldStamped = stampedTaskContentHashes(oldTask);
  const newStamped = stampedTaskContentHashes(newTask);
  const before = oldStamped && newStamped ? oldStamped : computeTaskContentHashes(oldTask, opts);
  const after = oldStamped && newStamped ? newStamped : computeTaskContentHashes(newTask, opts);
  const changed: string[] = [];
  if (before.env_sha256 !== after.env_sha256) changed.push("env");
  if (before.verifier_sha256 !== after.verifier_sha256) changed.push("verifier");
  if (before.meta_sha256 !== after.meta_sha256) changed.push("meta");
  const bump: BumpKind = changed.includes("env")
    ? "major"
    : changed.includes("verifier")
      ? "minor"
      : changed.includes("meta")
        ? "patch"
        : "none";
  return { bump, changed };
}

/** Bump a MAJOR.MINOR.PATCH string; non-semver input restarts at a base. */
export function bumpVersion(semver: string, bump: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(semver.trim());
  const [major, minor, patch] = match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : [1, 0, 0];
  if (!match && bump === "none") return "1.0.0";
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return `${major}.${minor}.${patch}`;
  }
}

export type BenchmarkDiff = {
  /** task_ids present only in the new manifest (always rerun). */
  added: string[];
  /** task_ids present only in the old manifest (noted, not planned). */
  removed: string[];
  perTask: { task_id: string; bump: BumpKind }[];
  plan: {
    rerun: string[];
    regrade: string[];
    reuse: string[];
  };
  benchmarkBump: BumpKind;
};

const BUMP_RANK: Record<BumpKind, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function maxBump(a: BumpKind, b: BumpKind): BumpKind {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

function tasksById(manifest: JsonObject): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  if (Array.isArray(manifest.tasks)) {
    for (const task of manifest.tasks) {
      if (!isObject(task)) continue;
      const id = stringField(task, "task_id");
      if (id && !map.has(id)) map.set(id, task);
    }
  }
  return map;
}

/**
 * Diff two benchmark manifests into a rerun/regrade/reuse plan.
 * Added tasks => rerun and count as a MAJOR benchmark bump; removed tasks
 * are reported and count as MINOR (existing traces stay valid but the
 * aggregate changes shape). Benchmark-level bump = max across all changes.
 */
export function diffBenchmarkManifests(
  oldManifest: JsonObject,
  newManifest: JsonObject,
  opts: ComputeTaskContentHashesOptions = {},
): BenchmarkDiff {
  const oldTasks = tasksById(oldManifest);
  const newTasks = tasksById(newManifest);

  const added: string[] = [];
  const removed: string[] = [];
  const perTask: { task_id: string; bump: BumpKind }[] = [];
  const plan = { rerun: [] as string[], regrade: [] as string[], reuse: [] as string[] };
  let benchmarkBump: BumpKind = "none";

  for (const [taskId, newTask] of newTasks) {
    const oldTask = oldTasks.get(taskId);
    if (!oldTask) {
      added.push(taskId);
      plan.rerun.push(taskId);
      benchmarkBump = maxBump(benchmarkBump, "major");
      continue;
    }
    const { bump } = classifyTaskChange(oldTask, newTask, opts);
    perTask.push({ task_id: taskId, bump });
    benchmarkBump = maxBump(benchmarkBump, bump);
    if (bump === "major") plan.rerun.push(taskId);
    else if (bump === "minor") plan.regrade.push(taskId);
    else plan.reuse.push(taskId); // patch and none both reuse results
  }
  for (const taskId of oldTasks.keys()) {
    if (!newTasks.has(taskId)) {
      removed.push(taskId);
      benchmarkBump = maxBump(benchmarkBump, "minor");
    }
  }

  return { added, removed, perTask, plan, benchmarkBump };
}
