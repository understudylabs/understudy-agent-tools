import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EVENT_CATEGORIZER_SUBSET = {
  benchmark_id: "event-categorizer-offline",
  fixture_id: "event-categorizer-v1",
  split_seed: 7,
} as const;

export type Split = "train" | "dev" | "holdout";
export type EventTask = {
  task_id: string;
  question: string;
  gold: {
    category: string;
    priority: string;
    account_ref: string | null;
    reasoning: string;
  };
  accounts: Record<string, unknown>;
  split: Split;
};

export type EventCompletionMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
};

const SPLIT_BY_INDEX: Split[] = [
  "train", "train", "train", "train", "train", "train", "train", "train",
  "dev", "dev", "holdout", "holdout",
];
const CATEGORIES = new Set(["billing", "security", "usage", "support", "noise"]);
const PRIORITIES = new Set(["p0", "p1", "p2", "p3"]);
const REQUIRED_KEYS = ["category", "priority", "account_ref", "reasoning"] as const;
const PLAYBOOK_PATH = fileURLToPath(new URL("../skills/design-simulated-environment/examples/event-categorizer/playbook.md", import.meta.url));
const TASKS_PATH = fileURLToPath(new URL("../skills/design-simulated-environment/examples/event-categorizer/tasks.jsonl", import.meta.url));

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function loadTasks(): EventTask[] {
  const rows = readFileSync(TASKS_PATH, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Omit<EventTask, "split">);
  if (rows.length !== 12) throw new Error(`event categorizer fixture must contain 12 tasks, found ${rows.length}`);
  return rows.map((task, index) => ({ ...task, split: SPLIT_BY_INDEX[index]! }));
}

export const TASKS: EventTask[] = loadTasks();
export const PLAYBOOK = readFileSync(PLAYBOOK_PATH, "utf8");

export function splitCounts(): Record<Split, number> {
  return TASKS.reduce((counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }), {
    train: 0, dev: 0, holdout: 0,
  } as Record<Split, number>);
}

export function getTask(taskId: string): EventTask {
  const task = TASKS.find((candidate) => candidate.task_id === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

export function splitSha256(split: Split): string {
  return sha256(TASKS.filter((task) => task.split === split).map(({ split: _split, ...task }) => task));
}

export function fixtureSha256(): string {
  return sha256({
    subset: EVENT_CATEGORIZER_SUBSET,
    playbook: PLAYBOOK,
    tasks: TASKS.map(({ split: _split, ...task }) => task),
  });
}

export function taskContentHashes(taskId: string): { env_sha256: string; verifier_sha256: string } {
  const task = getTask(taskId);
  return {
    env_sha256: sha256({ prompt: task.question, playbook: PLAYBOOK, accounts: task.accounts }),
    verifier_sha256: sha256({ gold: task.gold }),
  };
}

export function taskPrompt(taskId: string): { system: string; user: string } {
  const task = getTask(taskId);
  return { system: PLAYBOOK, user: task.question };
}

export function parseFinalJson(completion: unknown): { value: Record<string, unknown> | null; bare: boolean } {
  const messages = Array.isArray(completion) ? completion : [completion];
  const last = [...messages].reverse().find((message) => message && typeof message === "object" && (message as EventCompletionMessage).role === "assistant") as EventCompletionMessage | undefined;
  const raw = typeof last?.content === "string" ? last.content.trim() : typeof completion === "string" ? completion.trim() : "";
  if (!raw) return { value: null, bare: false };
  try {
    const value = JSON.parse(raw) as unknown;
    return { value: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null, bare: true };
  } catch {
    const match = /^```[a-zA-Z]*\s*\n?(.*?)\n?```\s*$/s.exec(raw);
    if (!match) return { value: null, bare: false };
    try {
      const value = JSON.parse(match[1]!) as unknown;
      return { value: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null, bare: false };
    } catch {
      return { value: null, bare: false };
    }
  }
}

export function scoreCompletion(taskId: string, completion: unknown): {
  score: number;
  subscores: { category_correct: number; structured_output_ok: number; nonempty_ok: number };
} {
  const task = getTask(taskId);
  const parsed = parseFinalJson(completion);
  const value = parsed.value;
  const categoryCorrect = value?.category === task.gold.category ? 0.7 : 0;
  const priorityCorrect = value?.priority === task.gold.priority ? 0.3 : 0;
  const conformant = Boolean(value &&
    REQUIRED_KEYS.every((key) => key in value) &&
    typeof value.category === "string" && CATEGORIES.has(value.category) &&
    typeof value.priority === "string" && PRIORITIES.has(value.priority) &&
    (value.account_ref === null || typeof value.account_ref === "string") &&
    typeof value.reasoning === "string");
  return {
    score: Math.round((categoryCorrect + priorityCorrect) * 10_000) / 10_000,
    subscores: {
      category_correct: categoryCorrect + priorityCorrect,
      structured_output_ok: Number(parsed.bare && conformant),
      nonempty_ok: Number(Boolean(value || (typeof completion === "string" && completion.trim()))),
    },
  };
}

export type PoolOptions = { split: Split; frozenHoldoutSha256?: string };

export function taskPool(options: PoolOptions): EventTask[] {
  if (options.split === "holdout" && options.frozenHoldoutSha256 !== splitSha256("holdout")) {
    throw new Error("frozen-holdout refusal: event categorizer holdout requires the matching frozenHoldoutSha256");
  }
  return TASKS.filter((task) => task.split === options.split);
}
