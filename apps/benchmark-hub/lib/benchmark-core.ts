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
