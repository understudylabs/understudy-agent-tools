/**
 * A deterministic, synthetic single-shot grounded-answer fixture.
 *
 * This is deliberately smaller than a production workspace context. It tests
 * fact coverage and fabrication resistance without importing customer traces,
 * provider clients, clocks, or randomness.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./benchmark.js";

export type Split = "train" | "dev" | "holdout";
export type Band = "lookup" | "synthesis" | "aggregation" | "unanswerable";
export type Fact = string | { regex: string; flags?: string };

export type GroundedChatTask = {
  taskId: string;
  split: Split;
  band: Band;
  context: string;
  question: string;
  gold: {
    required_facts: Fact[];
    forbidden_facts: Fact[];
  };
  max_answer_chars: number;
};

export const GROUNDED_CHAT_FIXTURE = {
  fixture_id: "grounded-chat-offline-v1",
  rubric_version: "1.1",
  benchmark_id: "grounded-chat-offline",
  split_seed: 7,
  task_count: 100,
  split_counts: { train: 60, dev: 20, holdout: 20 },
  fixture_sha256: "e0953bd8487e0665729921ecb71ec3eb106016c21243bc4b8d64cb5d4c62c12e",
  train_sha256: "3560630887f4d432cd460422cca83e2c3251c37d3b3cfddef343f503d655bd0f",
  dev_sha256: "1c670bb1fe990552f5b2ba21144b5fbf49db6bbbd27e4e20074e92b7959f77c0",
  holdout_sha256: "b1a7f5a49f7d90a0cca13a4ec5357fc1cc3eed839299453317ad192663a02850",
  splits_sha256: "1ba08287e0d93446bc72c6f0f4858ac672854ffd1249ee8bafa779819b1390f7",
} as const;

const RESET_SEED = GROUNDED_CHAT_FIXTURE.split_seed;
const SPLITS: Split[] = [
  ...Array<Split>(60).fill("train"),
  ...Array<Split>(20).fill("dev"),
  ...Array<Split>(20).fill("holdout"),
];
const BANDS: Band[] = ["lookup", "synthesis", "aggregation", "unanswerable"];
const CONTACTS = [
  ["Ari Quill", "navigator", "ari.quill@example.test"],
  ["Bex Nori", "archivist", "bex.nori@example.test"],
  ["Cato Vale", "reviewer", "cato.vale@example.test"],
  ["Dara Wren", "coordinator", "dara.wren@example.test"],
  ["Eli Sable", "planner", "eli.sable@example.test"],
  ["Fia Moss", "auditor", "fia.moss@example.test"],
  ["Gio Rook", "scribe", "gio.rook@example.test"],
  ["Hana Pike", "curator", "hana.pike@example.test"],
  ["Ivo Reed", "facilitator", "ivo.reed@example.test"],
  ["Juno Birch", "scheduler", "juno.birch@example.test"],
  ["Kira Flint", "editor", "kira.flint@example.test"],
  ["Lio Fern", "moderator", "lio.fern@example.test"],
  ["Mara Glen", "mapper", "mara.glen@example.test"],
  ["Nia Hollow", "cataloger", "nia.hollow@example.test"],
  ["Oren Slate", "forecaster", "oren.slate@example.test"],
  ["Pia Crest", "verifier", "pia.crest@example.test"],
  ["Quin Alder", "indexer", "quin.alder@example.test"],
  ["Rhea Stone", "steward", "rhea.stone@example.test"],
  ["Soren Vale", "convener", "soren.vale@example.test"],
  ["Tala Brook", "chronicler", "tala.brook@example.test"],
  ["Uma Frost", "allocator", "uma.frost@example.test"],
  ["Vera Cloud", "liaison", "vera.cloud@example.test"],
  ["Wes Rowan", "cartographer", "wes.rowan@example.test"],
  ["Xara Field", "recorder", "xara.field@example.test"],
  ["Yara Slate", "inspector", "yara.slate@example.test"],
  ["Zane Birch", "host", "zane.birch@example.test"],
  ["Asha Rill", "ledgerer", "asha.rill@example.test"],
] as const;
const PROJECTS = ["Mica", "Pollen", "Trellis", "Orbit", "Cinder", "Harbor", "Lumen", "Nectar", "Quarry"];
const STATUSES = ["queued", "in review", "blocked", "ready", "paused", "approved", "deferred"];
const NEXT_STEPS = [
  "send the outline",
  "check the source list",
  "confirm the date",
  "close the open task",
  "draft the summary",
  "assign the reviewer",
  "archive the thread",
  "compare the notes",
  "request a second look",
];
const DATES = [
  "2027-01-14",
  "2027-02-18",
  "2027-03-22",
  "2027-04-09",
  "2027-05-13",
  "2027-06-17",
  "2027-07-21",
  "2027-08-26",
  "2027-09-30",
  "2027-10-12",
  "2027-11-16",
];

function factText(fact: Fact): string {
  return typeof fact === "string" ? fact : `/${fact.regex}/${fact.flags ?? ""}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function regexFact(pattern: string): Fact {
  return { regex: pattern, flags: "i" };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flexibleDate(value: string): string {
  return escaped(value).replace(/-/g, "[-‑–]");
}

function matchesFact(answer: string, fact: Fact): boolean {
  if (typeof fact === "string") return normalize(answer).includes(normalize(fact));
  try {
    return new RegExp(fact.regex, fact.flags).test(answer);
  } catch {
    return false;
  }
}

function contact(index: number) {
  return CONTACTS[(index * 5 + 1) % CONTACTS.length];
}

function contextFor(index: number): string {
  const target = contact(index);
  const project = PROJECTS[(index * 3 + 2) % PROJECTS.length];
  const status = STATUSES[(index * 5 + 1) % STATUSES.length];
  const nextStep = NEXT_STEPS[(index * 7 + 3) % NEXT_STEPS.length];
  const date = DATES[(index * 9 + 1) % DATES.length];
  const other = contact(index + 1);
  const count = 2 + (index % 3);
  const secondDate = DATES[((index + 1) * 9 + 1) % DATES.length];
  const referenceNotes = Array.from({ length: 18 }, (_, noteIndex) => {
    const noteContact = contact(index + noteIndex + 2);
    const noteProject = PROJECTS[(index + noteIndex + 1) % PROJECTS.length];
    const noteDate = DATES[(index + noteIndex + 2) % DATES.length];
    return `- Reference card R-${String(index * 18 + noteIndex + 1).padStart(4, "0")}: topic ${noteProject} / ${noteContact[0]}; logged ${noteDate}; marker ${["blue", "green", "amber", "violet"][noteIndex % 4]}; summary says the record is synthetic and archived for workspace search calibration.`;
  });
  return [
    "Synthetic workspace: Pebble Lantern (fictional test data only).",
    "Contacts:",
    ...CONTACTS.map(([name, role, email]) => `- ${name}; role: ${role}; email: ${email}.`),
    "Meeting notes:",
    `- ${date}: ${target[0]} discussed ${project} and recorded status: ${status}.`,
    `- ${secondDate}: ${other[0]} reviewed the ${project} outline; next step: ${NEXT_STEPS[((index + 1) * 7 + 3) % NEXT_STEPS.length]}.`,
    "Email-thread summaries:",
    `- Thread ${project}-${String(index + 1).padStart(3, "0")}: owner: ${target[0]}; status: ${status}; next step: ${nextStep}.`,
    `- Thread decoy-${String(index + 1).padStart(3, "0")}: owner: ${other[0]}; status: ${STATUSES[((index + 1) * 5 + 1) % STATUSES.length]}; next step: ${NEXT_STEPS[((index + 1) * 7 + 3) % NEXT_STEPS.length]}.`,
    `- Distractor note: renewal review date for ${other[0]} is ${date}; this note does not answer questions about another contact.`,
    "Open tasks:",
    `- ${count} open ${project.toLowerCase()} tasks; earliest due date is ${date}.`,
    `- One closed ${project.toLowerCase()} task was completed on ${secondDate}.`,
    `- Archived snapshot (stale): ${count + 1} open ${project.toLowerCase()} tasks; earliest due date is ${secondDate}.`,
    "Reference cards:",
    ...referenceNotes,
  ].join("\n");
}

function makeTask(index: number): GroundedChatTask {
  const band = BANDS[index % BANDS.length];
  const split = SPLITS[index];
  const target = contact(index);
  const other = contact(index + 1);
  const project = PROJECTS[(index * 3 + 2) % PROJECTS.length];
  const status = STATUSES[(index * 5 + 1) % STATUSES.length];
  const nextStep = NEXT_STEPS[(index * 7 + 3) % NEXT_STEPS.length];
  const date = DATES[(index * 9 + 1) % DATES.length];
  const count = 2 + (index % 3);
  let question: string;
  let required: Fact[];
  let forbidden: Fact[];

  if (band === "lookup") {
    question = `What role is listed for ${target[0]}?`;
    required = [target[1]];
    forbidden = [other[1]];
  } else if (band === "synthesis") {
    question = `Summarize the ${project} thread's owner, status, and next step.`;
    required = [
      regexFact(`(?:owner|owned by)\\s*:?\\s*${escaped(target[0])}`),
      regexFact(`status\\s*(?:is|:)\\s*${escaped(status)}`),
      regexFact(`next step\\s*(?:is|:)\\s*${escaped(nextStep)}`),
    ];
    forbidden = [
      `owner: ${other[0]}`,
      `status: ${STATUSES[((index + 1) * 5 + 1) % STATUSES.length]}`,
    ];
  } else if (band === "aggregation") {
    question = `How many open ${project.toLowerCase()} tasks are there, and what is the earliest due date?`;
    const countWords = ["zero", "one", "two", "three", "four", "five"];
    required = [
      regexFact(`\\b(?:${count}|${countWords[count]})\\s+open\\s+${escaped(project.toLowerCase())}\\s+tasks\\b`),
      regexFact(`earliest due date(?:\\s+among\\s+(?:them|these tasks))?\\s+is\\s+${flexibleDate(date)}`),
    ];
    forbidden = [
      `${count + 1} open ${project.toLowerCase()} tasks`,
      `earliest due date is ${DATES[((index + 1) * 9 + 1) % DATES.length]}`,
    ];
  } else {
    question = `What is the renewal review date for ${target[0]}?`;
    required = [
      target[0],
      {
        regex: "(?:not available|not provided|not listed|not specified|not mentioned|no record|not in the (?:workspace|context)|cannot find|does not appear|unavailable|no information)",
        flags: "i",
      },
    ];
    forbidden = [`renewal review date for ${other[0]} is ${date}`];
  }

  const task: GroundedChatTask = {
    taskId: `chat-${band}-${String(index + 1).padStart(3, "0")}`,
    split,
    band,
    context: contextFor(index),
    question,
    gold: { required_facts: required, forbidden_facts: forbidden },
    max_answer_chars: 4000,
  };
  if (band === "unanswerable" && task.context.toLowerCase().includes(`renewal review date for ${target[0].toLowerCase()}`)) {
    throw new Error(`unanswerable context contains the asked-about fact: ${task.taskId}`);
  }
  return task;
}

export const TASKS: GroundedChatTask[] = Array.from({ length: 100 }, (_, index) => makeTask(index));

export function fixtureSha256(): string {
  return sha256(TASKS);
}

export function splitSha256(split: Split): string {
  return sha256(TASKS.filter((task) => task.split === split));
}

export function splitsSha256(): string {
  return sha256({
    train: splitSha256("train"),
    dev: splitSha256("dev"),
    holdout: splitSha256("holdout"),
  });
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function splitCounts(): Record<Split, number> {
  return {
    train: TASKS.filter((task) => task.split === "train").length,
    dev: TASKS.filter((task) => task.split === "dev").length,
    holdout: TASKS.filter((task) => task.split === "holdout").length,
  };
}

export function taskPool(options: { split: Split; frozenHoldoutSha256?: string }): GroundedChatTask[] {
  if (options.split === "holdout" && options.frozenHoldoutSha256 !== splitSha256("holdout")) {
    throw new Error("frozen-holdout refusal: exact holdout split hash is required");
  }
  return TASKS.filter((task) => task.split === options.split);
}

export function reset(taskId: string, seed = RESET_SEED): GroundedChatTask {
  if (seed !== RESET_SEED) throw new Error(`seed ${seed} is not the pinned seed ${RESET_SEED}`);
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown grounded-chat task: ${taskId}`);
  return JSON.parse(JSON.stringify(task)) as GroundedChatTask;
}

export type ScoreResult = {
  score: number;
  requiredRecall: number;
  fabrication: boolean;
  overBudget: boolean;
  matchedRequiredFacts: string[];
  answer: string;
};

export function scoreAnswer(task: GroundedChatTask, answer: string): ScoreResult {
  const text = String(answer ?? "");
  const matchedRequiredFacts = task.gold.required_facts
    .filter((fact) => matchesFact(text, fact))
    .map(factText);
  const fabrication = task.gold.forbidden_facts.some((fact) => matchesFact(text, fact));
  const overBudget = text.length > task.max_answer_chars;
  const requiredRecall = task.gold.required_facts.length === 0
    ? 1
    : matchedRequiredFacts.length / task.gold.required_facts.length;
  return {
    score: fabrication || overBudget ? 0 : requiredRecall,
    requiredRecall,
    fabrication,
    overBudget,
    matchedRequiredFacts,
    answer: text,
  };
}

export function oracleAnswer(taskId: string): string {
  const task = reset(taskId);
  if (task.band === "unanswerable") {
    return `${task.gold.required_facts[0]}: the requested information is not available in the workspace.`;
  }
  return task.gold.required_facts
    .map((fact) => {
      if (typeof fact === "string") return fact;
      const match = new RegExp(fact.regex, fact.flags).exec(task.context);
      return match?.[0] ?? "the requested fact is available";
    })
    .join("; ");
}

export function nullAnswer(taskId: string): string {
  reset(taskId);
  return "";
}

export function evaluateTask(taskId: string, answer: string): ScoreResult {
  return scoreAnswer(reset(taskId), answer);
}

export function auditTask(task: GroundedChatTask): string[] {
  const failures: string[] = [];
  const context = normalize(task.context);
  if (task.gold.required_facts.some((fact) => task.band !== "unanswerable" && matchesFact(task.question, fact))) {
    failures.push(`${task.taskId}: required fact leaked into question`);
  }
  if (task.band !== "unanswerable" && task.gold.required_facts.some((fact) => !matchesFact(task.context, fact))) {
    failures.push(`${task.taskId}: required fact is unreachable from context`);
  }
  if (task.gold.forbidden_facts.some((fact) => !matchesFact(task.context, fact))) {
    failures.push(`${task.taskId}: forbidden distractor is not present in context`);
  }
  if (task.band === "unanswerable" && context.includes(`renewal review date for ${task.gold.required_facts[0].toString().toLowerCase()}`)) {
    failures.push(`${task.taskId}: unanswerable asked-about fact appears in context`);
  }
  return failures;
}

export function normalizedTaskSignature(task: GroundedChatTask): string {
  return canonicalJson({
    question: normalize(task.question),
    gold: task.gold,
  });
}

export function duplicateTaskFailures(tasks: GroundedChatTask[] = TASKS): string[] {
  const failures: string[] = [];
  const seen = new Map<string, GroundedChatTask>();
  for (const task of tasks) {
    const signature = normalizedTaskSignature(task);
    const previous = seen.get(signature);
    if (previous) {
      const scope = previous.split === task.split ? "duplicate" : "cross-split near-duplicate";
      failures.push(`${task.taskId}: ${scope} of ${previous.taskId} (question+gold)`);
    } else {
      seen.set(signature, task);
    }
  }
  return failures;
}

export function validateFixture(): string[] {
  const failures = [...new Set([...TASKS.flatMap(auditTask), ...duplicateTaskFailures()])];
  const ids = new Set(TASKS.map((task) => task.taskId));
  if (ids.size !== TASKS.length) failures.push("duplicate task ids");
  if (JSON.stringify(splitCounts()) !== JSON.stringify(GROUNDED_CHAT_FIXTURE.split_counts)) {
    failures.push("split counts do not match fixture pin");
  }
  return failures;
}
