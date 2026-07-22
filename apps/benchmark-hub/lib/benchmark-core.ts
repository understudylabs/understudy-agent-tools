/**
 * COPIED from the repo's source of truth: `src/benchmark.ts` at the repo root
 * (understudy.benchmark.v1 support). The root package is not built as a
 * workspace dependency of this app, so the minimal trace-DAG functions are
 * vendored verbatim here. If `src/benchmark.ts` changes, re-copy — do not
 * fork the logic.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const PROVENANCE_ORIGINS = ["derived-from-traces", "imported", "authored"];
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

/** One node of a rollout message DAG, normalized from a traces.jsonl record. */
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
 * Extract every root-to-leaf branch from a message DAG. Cycle-safe and
 * deterministic; orphaned subtrees become their own roots.
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

type ManifestTaskLite = { split: string; goldPresent: boolean; categoryId: string | null };

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

  const tasksById = new Map<string, ManifestTaskLite>();
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
