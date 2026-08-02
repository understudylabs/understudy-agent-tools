import { createHash } from "node:crypto";

export const ANALYZER_FIXTURE = {
  fixture_id: "analyzer-verdict-offline-v1",
  split_seed: 7,
} as const;

export type Split = "train" | "dev" | "holdout";
export type AnalyzerBand = "single-signal" | "conflicting-signals" | "insufficient-evidence";
export type EvidenceItem = { id: string; kind: "note" | "event" | "record"; text: string };
export type AnalyzerStatus = "on_track" | "at_risk" | "blocked" | "insufficient_evidence";
export type AnalyzerSeverity = "none" | "low" | "medium" | "high";
export type AnalyzerSignal =
  | "no_signal"
  | "owner_unresponsive"
  | "scope_expanded"
  | "dependency_stalled"
  | "budget_exceeded"
  | "approval_pending"
  | "data_conflict";

export type AnalyzerVerdict = {
  status: AnalyzerStatus;
  severity: AnalyzerSeverity;
  primary_signal: AnalyzerSignal;
  citations: string[];
};

export type AnalyzerTask = {
  taskId: string;
  split: Split;
  band: AnalyzerBand;
  family: string;
  prompt: string;
  evidence: EvidenceItem[];
  gold: AnalyzerVerdict;
};

export const ANALYZER_STATUSES = ["on_track", "at_risk", "blocked", "insufficient_evidence"] as const;
export const ANALYZER_SEVERITIES = ["none", "low", "medium", "high"] as const;
export const ANALYZER_SIGNALS = [
  "no_signal",
  "owner_unresponsive",
  "scope_expanded",
  "dependency_stalled",
  "budget_exceeded",
  "approval_pending",
  "data_conflict",
] as const;
export const ANALYZER_VERDICT_KEYS = ["status", "severity", "primary_signal", "citations"] as const;

const SPLIT_BY_INSTANCE: Split[] = [
  "train", "train", "train", "train", "train", "train",
  "dev", "dev",
  "holdout", "holdout", "holdout", "holdout",
];

const FAMILIES: { family: string; band: AnalyzerBand }[] = [
  { family: "owner-unresponsive", band: "single-signal" },
  { family: "dependency-stalled", band: "single-signal" },
  { family: "budget-exceeded", band: "single-signal" },
  { family: "recency-conflict", band: "conflicting-signals" },
  { family: "severity-conflict", band: "conflicting-signals" },
  { family: "superseded-record", band: "conflicting-signals" },
  { family: "unrelated-chatter", band: "insufficient-evidence" },
  { family: "truncated-record", band: "insufficient-evidence" },
  { family: "ambiguous-owner", band: "insufficient-evidence" },
];

const PEOPLE = [
  "Avery Chen", "Morgan Iqbal", "Riley Santos", "Jordan Okafor",
  "Taylor Singh", "Casey Novak", "Drew Laurent", "Quinn Patel",
  "Sasha Kim", "Emery Brooks", "Robin Adeyemi", "Parker Silva",
];

const PROJECTS = [
  "Northstar", "Harbor", "Juniper", "Atlas", "Cobalt", "Meadow",
  "Summit", "Lattice", "Orchid", "Beacon", "Willow", "Keystone",
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function dateFor(instance: number, offset: number): string {
  return `${MONTHS[(instance + offset) % MONTHS.length]} ${10 + ((instance * 3 + offset) % 17)}, 2026`;
}

function orderedConflictDates(instance: number, offset: number): [string, string] {
  const month = MONTHS[(instance + offset) % MONTHS.length];
  const day = 10 + ((instance * 3 + offset) % 12);
  return [`${month} ${day}, 2026`, `${month} ${day + 5}, 2026`];
}

const DISTRACTOR_TEMPLATES = [
  (project: string, person: string, date: string) => `The ${project} status meeting on ${date} covered agenda items, assigned a note-taking rotation to ${person}, and moved the next review to the existing calendar slot. The recap contains no decision about the requested assessment.`,
  (project: string, person: string, date: string) => `A documentation review for ${project} was logged on ${date}. ${person} checked headings, links, and examples, then left a follow-up for the next editing pass. The document review is separate from the requested assessment.`,
  (project: string, person: string, date: string) => `The ${project} tooling channel recorded an infrastructure housekeeping update on ${date}. ${person} rotated a test workspace and confirmed that routine monitoring continued. No workstream judgment was made in this exchange.`,
  (project: string, person: string, date: string) => `An onboarding note dated ${date} says ${person} joined a walkthrough for the ${project} materials. The note covers introductions, access orientation, and a plan to read the background guide. It does not establish the current work situation.`,
  (project: string, person: string, date: string) => `The ${project} archive marks a small housekeeping item as resolved and closed on ${date}. ${person} confirmed that the old checklist was filed and the reference link still opens. This closed item is not a judgment about the requested work.`,
  (project: string, person: string, date: string) => `A scheduling message from ${person} on ${date} moved a routine ${project} sync by one day because of calendar overlap. The meeting remains on the plan, and the reschedule does not describe a substantive change.`,
  (project: string, person: string, date: string) => `The ${project} metrics summary dated ${date} reports ordinary activity counts and a stable review cadence. ${person} asked that the next reading use the same measurement window. The summary contains context but no disposition.`,
  (project: string, person: string, date: string) => `A vendor renewal note for ${project} from ${date} lists a quote review with ${person}. It mentions a routine amount comparison and a later procurement check, but it does not say that the requested work changed or stopped.`,
  (project: string, person: string, date: string) => `The ${project} planning board shows ${person} waiting for a routine calendar confirmation on ${date}. The waiting item concerns meeting logistics only; the entry does not identify a dependency or a current project disposition.`,
  (project: string, person: string, date: string) => `A finance worksheet for ${project} dated ${date} compares two ordinary projection rows and asks ${person} to verify a rounding difference. The worksheet is a near-match for budget language but does not state that any ceiling was crossed.`,
];

function evidenceItem(index: number, instance: number, offset: number): EvidenceItem {
  const project = PROJECTS[(instance + offset + index) % PROJECTS.length];
  const person = PEOPLE[(instance * 2 + offset + index) % PEOPLE.length];
  const date = dateFor(instance + index, offset);
  const kind = (["note", "event", "record"] as const)[index % 3];
  return {
    id: `ev-${String(index + 1).padStart(2, "0")}`,
    kind,
    text: DISTRACTOR_TEMPLATES[index % DISTRACTOR_TEMPLATES.length](project, person, date),
  };
}

function signalText(family: string, instance: number, offset: number): string {
  const project = PROJECTS[(instance + offset) % PROJECTS.length];
  const person = PEOPLE[(instance + offset * 2) % PEOPLE.length];
  const date = dateFor(instance, offset);
  switch (family) {
    case "owner-unresponsive":
      return `The ${project} action owner ${person} has not replied to three follow-ups since ${date}; the handoff is waiting on that owner and the next checkpoint cannot proceed.`;
    case "dependency-stalled":
      return `A required upstream package for ${project} has not arrived by ${date}. The dependent work cannot start until that package is delivered, and no workaround is recorded.`;
    case "budget-exceeded":
      return `The ${project} ledger dated ${date} shows committed spend above the approved ceiling by 18 percent. The finance note says additional work must pause until the variance is resolved.`;
    case "unrelated-chatter":
      return `The only item that addresses the requested ${project} assessment is a short note saying the owner and next action are not identified; the remaining notes discuss unrelated planning topics.`;
    case "truncated-record":
      return `The relevant ${project} record ends after the phrase "current disposition:" and omits the disposition and supporting details. The record is too incomplete to determine the situation.`;
    case "ambiguous-owner":
      return `The relevant ${project} note names two possible owners and does not identify which person accepted the work. No other item resolves the ambiguity, so the responsible owner cannot be determined.`;
    default:
      return `The ${project} update dated ${date} was recorded by ${person}.`;
  }
}

const SHARED_PROMPT = `Review the evidence for the {workstream} workstream and return exactly one JSON object with the keys "status", "severity", "primary_signal", and "citations". Use only these status values: "on_track", "at_risk", "blocked", "insufficient_evidence"; only these severity values: "none", "low", "medium", "high"; and only these primary_signal values: "no_signal", "owner_unresponsive", "scope_expanded", "dependency_stalled", "budget_exceeded", "approval_pending", "data_conflict". The most recent dated item supersedes earlier ones. A replacement record supersedes the record it replaces. An approval item outranks a scheduling concern. If the evidence cannot establish a current situation, use the insufficient-evidence outcome and cite the one item that makes it insufficient. Cite only evidence actually used. Do not add commentary.`;

function promptFor(instance: number, offset: number): string {
  return SHARED_PROMPT.replace("{workstream}", PROJECTS[(instance + offset) % PROJECTS.length]);
}

function goldFor(family: string, instance: number, citations: string[]): AnalyzerVerdict {
  switch (family) {
    case "owner-unresponsive":
      return { status: "at_risk", severity: "low", primary_signal: "owner_unresponsive", citations };
    case "dependency-stalled":
      return { status: "blocked", severity: "high", primary_signal: "dependency_stalled", citations };
    case "budget-exceeded":
      return { status: "at_risk", severity: "medium", primary_signal: "budget_exceeded", citations };
    case "recency-conflict":
      return { status: "on_track", severity: "none", primary_signal: "no_signal", citations };
    case "severity-conflict":
      return { status: "blocked", severity: "high", primary_signal: "approval_pending", citations };
    case "superseded-record":
      return { status: "at_risk", severity: "low", primary_signal: "scope_expanded", citations };
    case "unrelated-chatter":
    case "truncated-record":
    case "ambiguous-owner":
      return { status: "insufficient_evidence", severity: "none", primary_signal: "no_signal", citations };
    default:
      throw new Error(`unknown family ${family} at ${instance}`);
  }
}

function buildTasks(): AnalyzerTask[] {
  const tasks: AnalyzerTask[] = [];
  FAMILIES.forEach(({ family, band }, familyIndex) => {
    for (let instance = 0; instance < 12; instance += 1) {
      const offset = (familyIndex * 3 + instance * 5) % PEOPLE.length;
      const itemCount = band === "single-signal" ? 18 : band === "conflicting-signals" ? 24 : 20;
      const evidence = Array.from({ length: itemCount }, (_, index) => evidenceItem(index, instance, offset));
      const firstIndex = (familyIndex * 7 + instance * 11) % (band === "conflicting-signals" ? Math.floor(itemCount / 2) : itemCount);
      const citations = [`ev-${String(firstIndex + 1).padStart(2, "0")}`];
      if (band === "conflicting-signals") {
        const secondIndex = firstIndex + Math.floor(itemCount / 2);
        citations.push(`ev-${String(secondIndex + 1).padStart(2, "0")}`);
        const [earlierDate, laterDate] = orderedConflictDates(instance, offset);
        const project = PROJECTS[(instance + offset) % PROJECTS.length];
        if (family === "recency-conflict") {
          evidence[firstIndex] = { id: citations[0], kind: "event", text: `The ${project} delivery note dated ${earlierDate} records a missed handoff and asks for a revised estimate.` };
          evidence[secondIndex] = { id: citations[1], kind: "event", text: `The ${project} checkpoint note dated ${laterDate} says the team completed the review and resumed the planned sequence.` };
        } else if (family === "severity-conflict") {
          evidence[firstIndex] = { id: citations[0], kind: "note", text: `A ${project} scheduling note dated ${earlierDate} asks for a later meeting because two calendars overlap.` };
          evidence[secondIndex] = { id: citations[1], kind: "record", text: `The ${project} release record dated ${laterDate} says a required approval has not yet been recorded.` };
        } else {
          evidence[firstIndex] = { id: citations[0], kind: "record", text: `The original ${project} record dated ${earlierDate} says the planned scope was limited to the first delivery.` };
          evidence[secondIndex] = { id: citations[1], kind: "record", text: `The replacement ${project} record dated ${laterDate} says additional review work was added and the delivery estimate should be revisited.` };
        }
      } else {
        evidence[firstIndex] = { id: citations[0], kind: "record", text: signalText(family, instance, offset) };
      }
      tasks.push({
        taskId: `analyzer-${family}-${String(instance + 1).padStart(2, "0")}`,
        split: SPLIT_BY_INSTANCE[instance],
        band,
        family,
        prompt: promptFor(instance, offset),
        evidence,
        gold: goldFor(family, instance, citations),
      });
    }
  });
  return tasks;
}

export const ANALYZER_TASKS: AnalyzerTask[] = buildTasks();

const TASK_BY_ID = new Map(ANALYZER_TASKS.map((task) => [task.taskId, task]));

export function analyzerTaskBands(): Record<string, AnalyzerBand> {
  return Object.fromEntries(FAMILIES.map(({ family, band }) => [family, band]));
}

export function analyzerSplitSha256(split: Split): string {
  return sha256(ANALYZER_TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, gold: task.gold })));
}

export function analyzerFixtureSha256(): string {
  return sha256({ fixture: ANALYZER_FIXTURE, tasks: ANALYZER_TASKS });
}

export type AnalyzerPoolOptions = { split: Split; frozenHoldoutSha256?: string };

export function analyzerTaskPool(options: AnalyzerPoolOptions): AnalyzerTask[] {
  if (options.split === "holdout") {
    const expected = analyzerSplitSha256("holdout");
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the analyzer holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: analyzer holdout hash mismatch (expected ${expected})`);
  }
  return ANALYZER_TASKS.filter((task) => task.split === options.split);
}

function extractJsonObject(rawModelText: string): { payload: string; parsed: unknown; preambleStripped: boolean } | null {
  const raw = String(rawModelText ?? "").trim();
  let last: { payload: string; parsed: unknown } | null = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{" && depth === 0) {
      start = index;
      depth = 1;
    } else if (character === "{" && depth > 0) {
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const payload = raw.slice(start, index + 1);
        try {
          last = { payload, parsed: JSON.parse(payload) };
        } catch {
          // Continue scanning in case a later balanced object is valid.
        }
        start = -1;
      }
    }
  }
  if (!last) return null;
  return { ...last, preambleStripped: last.payload !== raw };
}

function parseVerdict(rawModelText: string): { verdict: AnalyzerVerdict; preambleStripped: boolean; strictFormat: boolean } | null {
  const extracted = extractJsonObject(rawModelText);
  if (!extracted) return null;
  const { parsed, preambleStripped } = extracted;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...ANALYZER_VERDICT_KEYS].sort().join("|")) return null;
  if (!ANALYZER_STATUSES.includes(record.status as AnalyzerStatus)) return null;
  if (!ANALYZER_SEVERITIES.includes(record.severity as AnalyzerSeverity)) return null;
  if (!ANALYZER_SIGNALS.includes(record.primary_signal as AnalyzerSignal)) return null;
  if (!Array.isArray(record.citations) || !record.citations.every((citation) => typeof citation === "string")) return null;
  return { verdict: record as AnalyzerVerdict, preambleStripped, strictFormat: !preambleStripped };
}

export type AnalyzerScoreFlags = {
  parse_error?: string;
  key_set_error?: boolean;
  vocabulary_error?: boolean;
  hallucinated_citation?: boolean;
  over_claim?: boolean;
  matched_fields?: string[];
  preamble_stripped?: boolean;
  strict_format?: boolean;
};

export type AnalyzerScore = { score: number; forbidden: string[]; flags: AnalyzerScoreFlags };

export function scoreVerdict(task: AnalyzerTask, rawModelText: string): AnalyzerScore {
  const extracted = extractJsonObject(rawModelText);
  const formatFlags = extracted
    ? { ...(extracted.preambleStripped ? { preamble_stripped: true } : {}), strict_format: !extracted.preambleStripped }
    : {};
  const parsedResult = parseVerdict(rawModelText);
  if (!parsedResult) {
    return { score: 0, forbidden: ["invalid_output"], flags: { parse_error: "expected exactly one JSON object with the four verdict keys", ...formatFlags } };
  }
  const parsed = parsedResult.verdict;
  const evidenceIds = new Set(task.evidence.map((item) => item.id));
  const goldCitations = new Set(task.gold.citations);
  if (parsed.citations.some((citation) => !evidenceIds.has(citation))) {
    return { score: 0, forbidden: ["hallucinated_citation"], flags: { hallucinated_citation: true, ...formatFlags } };
  }
  if (parsed.citations.some((citation) => !goldCitations.has(citation))) {
    return { score: 0, forbidden: ["over_claim"], flags: { over_claim: true, ...formatFlags } };
  }
  const matched: string[] = [];
  if (parsed.status === task.gold.status) matched.push("status");
  if (parsed.severity === task.gold.severity) matched.push("severity");
  if (parsed.primary_signal === task.gold.primary_signal) matched.push("primary_signal");
  if (new Set(parsed.citations).size === goldCitations.size && parsed.citations.every((citation) => goldCitations.has(citation))) matched.push("citations");
  return {
    score: matched.length / 4,
    forbidden: [],
    flags: {
      matched_fields: matched,
      ...(parsedResult.preambleStripped ? { preamble_stripped: true } : {}),
      strict_format: parsedResult.strictFormat,
    },
  };
}

export type AnalyzerPolicy = (task: AnalyzerTask) => string;

export function oraclePolicy(taskId: string): AnalyzerPolicy {
  const task = TASK_BY_ID.get(taskId);
  if (!task) throw new Error(`unknown analyzer task_id: ${taskId}`);
  return () => JSON.stringify(task.gold);
}

export function sentinelPolicy(): AnalyzerPolicy {
  return (task) => {
    const citation = task.evidence.find((item) => !task.gold.citations.includes(item.id))?.id;
    if (!citation) throw new Error(`no non-gold evidence item for ${task.taskId}`);
    return JSON.stringify({ status: "on_track", severity: "none", primary_signal: "no_signal", citations: [citation] });
  };
}

export function nullPolicy(): AnalyzerPolicy {
  return () => "";
}

export function constantPolicy(verdict: AnalyzerVerdict): AnalyzerPolicy {
  const encoded = JSON.stringify(verdict);
  return () => encoded;
}
