import {
  AUTOMATIONBENCH_SUBSET,
  RESET_SEED,
  TASKS,
  assertionSatisfied,
  authorFamilyCase,
  auditObservationLeakage,
  clearAugmentedTasks,
  familySlugs,
  finish,
  getTask,
  parseToolCalls,
  registerAugmentedTasks,
  reset,
  rollout,
  sentinelPolicy,
  sha256,
  splitCounts,
  splitSha256,
  step,
  taskBands,
  taskContentSha256,
  type Task,
  type ToolCall,
} from "./automationbench-offline.js";

export type AugmentOptions = {
  variantsPerFamily?: number;
  trajectoriesPerTask?: number;
  version?: string;
};

export type Trajectory = {
  task_id: string;
  split: "train";
  variant: number;
  score: number;
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: string[] }[];
};

type ReadCall = ToolCall;

const FROZEN_TRAIN = TASKS.filter((task) => task.split === "train");
const FROZEN_DEV = TASKS.filter((task) => task.split === "dev");
const FROZEN_HOLDOUT = TASKS.filter((task) => task.split === "holdout");

function cloneCall(call: ToolCall): ToolCall {
  return JSON.parse(JSON.stringify(call)) as ToolCall;
}

function isWrite(call: ToolCall): boolean {
  return call.name === "api_fetch" && String(call.arguments.method ?? "GET").toUpperCase() !== "GET";
}

function trajectoryCalls(task: Task, variant: number): ToolCall[] {
  const oracle = task.oracle.map(cloneCall);
  if (variant === 0) return oracle;
  const prefix: ReadCall = { name: "api_search", arguments: { query: "crm contacts mail endpoints" } };
  if (variant === 1) return [prefix, ...oracle];
  if (variant === 2) {
    const firstWrite = oracle.findIndex(isWrite);
    const listing: ReadCall = { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } };
    return firstWrite < 0 ? [...oracle, listing] : [...oracle.slice(0, firstWrite), listing, ...oracle.slice(firstWrite)];
  }
  throw new Error(`unsupported trajectory variant: ${variant}`);
}

function replay(task: Task, calls: ToolCall[]): { score: number; forbiddenEffects: string[] } {
  const { handle } = reset(task.taskId);
  for (const call of calls) {
    const result = step(handle, call);
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: 0, info: { forbidden_effects: handle.forbiddenEffects } } : finish(handle);
  return { score: terminal.reward, forbiddenEffects: terminal.info.forbidden_effects as string[] };
}

function encodeTrajectory(task: Task, variant: number): Trajectory {
  const calls = trajectoryCalls(task, variant);
  const replayed = replay(task, calls);
  if (replayed.score !== 1 || replayed.forbiddenEffects.length > 0) {
    throw new Error(`trajectory gate failed for ${task.taskId} variant ${variant}`);
  }
  const { handle, obs } = reset(task.taskId);
  const messages: Trajectory["messages"] = obs.messages.map((message) => ({ ...message }));
  for (const call of calls) {
    const assistantCall = JSON.stringify({ name: call.name, arguments: JSON.stringify(call.arguments) });
    messages.push({ role: "assistant", content: "", tool_calls: [assistantCall] });
    const result = step(handle, call);
    const toolMessage = result.obs.messages.at(-1);
    if (!toolMessage || toolMessage.role !== "tool") throw new Error(`missing tool result for ${task.taskId}`);
    messages.push({ role: "tool", content: toolMessage.content });
  }
  return { task_id: task.taskId, split: "train", variant, score: replayed.score, messages };
}

function reachable(task: Task): boolean {
  const { handle, obs } = reset(task.taskId);
  const reads = [
    { name: "api_search", arguments: { query: "crm contacts mail drafts messages" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } },
    { name: "api_fetch", arguments: { method: "GET", url: "/mail/messages" } },
  ];
  let text = JSON.stringify(obs.messages);
  for (const call of reads) text += step(handle, call).obs.messages.at(-1)?.content ?? "";
  for (const call of task.oracle) {
    if (typeof call.arguments.url === "string") {
      const segments = call.arguments.url.split("/").filter(Boolean);
      if (segments.length > 2 && !text.includes(segments[2])) return false;
    }
    for (const value of Object.values(call.arguments.body ?? {})) {
      if (typeof value === "string" && !text.includes(value)) return false;
    }
  }
  return true;
}

function assertTaskGates(task: Task): void {
  const solved = rollout(task.taskId, (obs) => task.oracle[obs.step] ?? null);
  if (solved.reward !== 1 || solved.forbiddenEffects.length > 0) {
    throw new Error(`oracle gate failed for ${task.taskId}`);
  }
  const sentinel = rollout(task.taskId, sentinelPolicy());
  if (sentinel.reward !== 0) throw new Error(`sentinel gate failed for ${task.taskId}`);
  const { obs } = reset(task.taskId);
  if (auditObservationLeakage(obs, task).length > 0) throw new Error(`leakage gate failed for ${task.taskId}`);
  const initial = reset(task.taskId).handle.state;
  if (task.assertions.every((assertion) => assertionSatisfied(initial, assertion))) {
    throw new Error(`reset has no unsatisfied assertion for ${task.taskId}`);
  }
  if (!reachable(task)) throw new Error(`reachability gate failed for ${task.taskId}`);
  if (task.allowedWrites.some((path) => path === "crm.contacts.c-0" || path.startsWith("crm.contacts.c-0."))) {
    throw new Error(`guard contact is writable for ${task.taskId}`);
  }
}

function buildCandidateTasks(variantsPerFamily: number): Task[] {
  const frozenIds = new Set(TASKS.map((task) => task.taskId));
  const frozenHashes = new Set(TASKS.map(taskContentSha256));
  const frozenPrompts = new Set(TASKS.map((task) => task.prompt));
  const acceptedIds = new Set<string>();
  const acceptedHashes = new Set<string>();
  const acceptedPrompts = new Set<string>();
  const tasks: Task[] = [];
  familySlugs().forEach((slug, familyIndex) => {
    for (let cycle = 0; cycle < variantsPerFamily; cycle += 1) {
      const instance = cycle % 6;
      const offset = (familyIndex * 7 + instance * 5 + (cycle + 1) * RESET_SEED) % 24;
      const authored = authorFamilyCase(slug, instance, offset);
      const task: Task = {
        taskId: `simple-api-${slug}-aug-${String(cycle + 1).padStart(3, "0")}`,
        split: "train",
        prompt: `${authored.prompt}\nUse the seeded records for this request (phrasing variant ${String(cycle + 1).padStart(2, "0")}, persona rotation ${String(offset).padStart(2, "0")}).`,
        initialState: authored.state,
        assertions: authored.assertions,
        allowedWrites: authored.allowedWrites,
        oracle: authored.oracle,
      };
      const hash = taskContentSha256(task);
      if (frozenIds.has(task.taskId) || acceptedIds.has(task.taskId)) continue;
      if (frozenHashes.has(hash) || acceptedHashes.has(hash) || frozenPrompts.has(task.prompt) || acceptedPrompts.has(task.prompt)) continue;
      tasks.push(task);
      acceptedIds.add(task.taskId);
      acceptedHashes.add(hash);
      acceptedPrompts.add(task.prompt);
    }
  });
  return tasks;
}

export function buildAugmentedTrainSet(options: AugmentOptions = {}): {
  version: string;
  manifest: Record<string, unknown>;
  tasks: Task[];
  trajectories: Trajectory[];
  contamination: Record<string, unknown>;
} {
  const variantsPerFamily = options.variantsPerFamily ?? 24;
  const trajectoriesPerTask = options.trajectoriesPerTask ?? 3;
  const version = options.version ?? "v1";
  if (!Number.isInteger(variantsPerFamily) || variantsPerFamily < 0) throw new Error("variantsPerFamily must be a non-negative integer");
  if (trajectoriesPerTask !== 3) throw new Error("trajectoriesPerTask must be 3 for the deterministic v1 emission");
  clearAugmentedTasks();
  const augmented = buildCandidateTasks(variantsPerFamily);
  registerAugmentedTasks(augmented);
  const trainTasks = [...FROZEN_TRAIN, ...augmented];
  for (const task of augmented) assertTaskGates(task);
  const trajectories = trainTasks.flatMap((task) => Array.from({ length: trajectoriesPerTask }, (_, variant) => encodeTrajectory(task, variant)));
  const devHashes = new Set(FROZEN_DEV.map(taskContentSha256));
  const holdoutHashes = new Set(FROZEN_HOLDOUT.map(taskContentSha256));
  const trainIds = trainTasks.map((task) => task.taskId);
  const trainHashes = trainTasks.map(taskContentSha256);
  const devIds = FROZEN_DEV.map((task) => task.taskId);
  const holdoutIds = FROZEN_HOLDOUT.map((task) => task.taskId);
  const contamination = {
    train_vs_dev_ids: trainIds.filter((id) => devIds.includes(id)),
    train_vs_holdout_ids: trainIds.filter((id) => holdoutIds.includes(id)),
    train_vs_dev_content_hashes: trainHashes.filter((hash) => devHashes.has(hash)),
    train_vs_holdout_content_hashes: trainHashes.filter((hash) => holdoutHashes.has(hash)),
    holdout_hash_expected: "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
    holdout_hash_actual: splitSha256("holdout"),
    holdout_hash_equal: splitSha256("holdout") === "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
  };
  const manifest = {
    schema_version: "understudy.automationbench_train_augment.v1",
    version,
    benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
    counts: { before: splitCounts().train, augmented: augmented.length, after: trainTasks.length, trajectories: trajectories.length },
    task_content_sha256: trainHashes,
    augmented_train_sha256: sha256(trainTasks),
    frozen_split_hashes: { train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") },
    generator: { reset_seed: RESET_SEED, variants_per_family: variantsPerFamily, trajectories_per_task: trajectoriesPerTask, family_bands: taskBands() },
    provenance: { origin: "synthetic", network: false, model_spend_usd: 0, source: `fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}` },
  };
  return { version, manifest, tasks: trainTasks, trajectories, contamination };
}

export function trajectoryToolCalls(trajectory: Trajectory): ToolCall[] {
  return trajectory.messages.flatMap((message) => (message.role === "assistant" ? parseToolCalls(message) : []));
}
