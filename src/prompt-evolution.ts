/**
 * GEPA-style prompt evolution over agentic benchmark run arms.
 *
 * `understudy benchmarks evolve <dir> --model <id>` runs the loop:
 *   propose (authoring model, fed journal-derived failure evidence)
 *   → queue ONE run with prompt_overrides arms (shared createRunRequest —
 *     this module NEVER executes models; `understudy runs execute --watch`
 *     must be running, or the user is told to start it)
 *   → wait for the request file to settle → score rows → next generation.
 *
 * Split discipline mirrors skills/optimize-workload: generations evolve on
 * the TRAIN split only, the cross-generation champion is selected on DEV,
 * and the sealed HOLDOUT split is touched exactly once — a final
 * champion-vs-bare run — without which no win may be reported.
 * Every generation is recorded in an evolution.jsonl sidecar
 * (understudy.prompt_evolution.v1): suffix text + sha256 + scores.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { readJsonlFile, parseJournalText, serializeJsonlLine } from "./benchmark-artifacts.js";
import {
  createRunRequest,
  liveJournalPath,
  promptSuffixHash,
  readRunRequest,
  runRequestPath,
  selectTasks,
  validateRunRequestInput,
  type PromptOverride,
  type RunRequest,
  type RunSplit,
} from "./run-executor.js";
import { gatewayClient, resolveDefaultModel, resolveGatewayAuth, type AuthorClient, type AuthorUsage } from "./trace-author.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/* ------------------------------------------------------------------ */
/* evolution.jsonl sidecar                                             */
/* ------------------------------------------------------------------ */

export const PROMPT_EVOLUTION_SCHEMA = "understudy.prompt_evolution.v1";
export const EVOLUTION_FILE = "evolution.jsonl";
/** Hard cap on a proposed suffix (a "prompt" that smuggles in an essay is a bug, not a candidate). */
export const MAX_SUFFIX_CHARS = 4_000;

export type EvolutionVariant = {
  arm_label: string;
  system_prompt_suffix: string;
  system_prompt_suffix_sha256: string;
  mean_score: number | null;
  rows: number;
};

export type EvolutionRecord = {
  schema_version: typeof PROMPT_EVOLUTION_SCHEMA;
  benchmark_id: string;
  /** 0 = bare baseline run; 1..N = evolution generations; "dev_select" and "holdout_final" close the loop. */
  generation: number | "dev_select" | "holdout_final";
  split: RunSplit;
  run_id: string;
  base_model: string;
  author_model: string | null;
  created_at: string;
  variants: EvolutionVariant[];
  /** The bare (no-suffix) arm of the same run, when present. */
  bare: { mean_score: number | null; rows: number } | null;
  /** arm_label of the best-scoring arm of this record (bare = the base model id). */
  champion: string | null;
  author_cost_estimate_usd?: number;
  verdict?: HoldoutVerdict | null;
};

export function evolutionPath(benchmarkDir: string): string {
  return join(resolve(benchmarkDir), EVOLUTION_FILE);
}

export function appendEvolutionRecord(benchmarkDir: string, record: EvolutionRecord): void {
  appendFileSync(evolutionPath(benchmarkDir), serializeJsonlLine(record), { mode: 0o600 });
}

export function readEvolutionRecords(benchmarkDir: string): EvolutionRecord[] {
  return readJsonlFile<EvolutionRecord>(evolutionPath(benchmarkDir)).items.filter(
    (r) => r?.schema_version === PROMPT_EVOLUTION_SCHEMA,
  );
}

/* ------------------------------------------------------------------ */
/* Failure evidence from live journals + rows                          */
/* ------------------------------------------------------------------ */

/**
 * Rejection classes of the generated world's `_validate` (trace-foundry's
 * world server): the exact strings the world replies with, classified so the
 * authoring model sees per-class counts instead of raw noise.
 */
export const REJECTION_CLASSES = [
  "unknown_tool",
  "missing_required_field",
  "missing_by_observation",
  "type_mismatch",
  "enum_by_observation",
  "other",
] as const;
export type RejectionClass = (typeof REJECTION_CLASSES)[number];

export function classifyRejection(error: string): RejectionClass {
  const text = String(error);
  if (text.startsWith("unknown tool")) return "unknown_tool";
  if (text.includes("required by observed usage")) {
    return text.includes("must be one of") ? "enum_by_observation" : "missing_by_observation";
  }
  if (text.startsWith("missing required field")) return "missing_required_field";
  if (/^field '.*' must be /.test(text)) return "type_mismatch";
  return "other";
}

/**
 * Pull the rejection error string out of a journal `result` entry's content.
 * The world mirrors the tool family's production shape: {"ok":false,"error"},
 * {"success":false,"error"}, or a plain "ERROR: ..." string.
 */
export function extractRejectionError(content: unknown): string | null {
  if (typeof content !== "string" || !content) return null;
  if (content.startsWith("ERROR:")) return content.slice("ERROR:".length).trim();
  try {
    const parsed = asObject(JSON.parse(content));
    if (typeof parsed.error === "string" && (parsed.ok === false || parsed.success === false || parsed.error)) {
      return parsed.error;
    }
  } catch {
    /* not an envelope */
  }
  return null;
}

export type RejectionEvidence = {
  /** Total journaled tool calls and how many the world rejected. */
  calls: number;
  rejected: number;
  by_class: Partial<Record<RejectionClass, number>>;
  /** Up to `maxExamples` distinct `tool: error` example strings. */
  examples: string[];
};

/** Per-class rejection counts from one arm's live-journal text. */
export function journalRejections(journalText: string, maxExamples = 8): RejectionEvidence {
  const { lines } = parseJournalText(journalText);
  const byClass: Partial<Record<RejectionClass, number>> = {};
  const examples: string[] = [];
  const seen = new Set<string>();
  let calls = 0;
  let rejected = 0;
  let lastCallTool = "";
  for (const line of lines) {
    if (line.kind === "call") {
      calls += 1;
      lastCallTool = String(line.tool ?? "");
      continue;
    }
    if (line.kind !== "result" || line.status !== "error") continue;
    const error = extractRejectionError(line.content);
    if (error === null) continue;
    rejected += 1;
    const cls = classifyRejection(error);
    byClass[cls] = (byClass[cls] ?? 0) + 1;
    const example = `${String(line.tool ?? lastCallTool)}: ${error}`;
    if (!seen.has(example) && examples.length < maxExamples) {
      seen.add(example);
      examples.push(example);
    }
  }
  return { calls, rejected, by_class: byClass, examples };
}

export type FailedTaskEvidence = {
  task_id: string;
  mean_score: number | null;
  /** Compact summaries of the task's required contract entries — the obligations a failing arm left unmet. */
  required: string[];
};

/** One arm's evidence packet: journal rejections + failing tasks with their obligations. */
export type ArmEvidence = {
  arm_label: string;
  mean_score: number | null;
  rows: number;
  rejections: RejectionEvidence;
  failed_tasks: FailedTaskEvidence[];
};

/** Compact one-line summary of a contract entry for the authoring prompt. */
export function contractEntrySummary(rule: Obj): string {
  const type = String(rule.type ?? "state_effect");
  if (type === "response_obligation") return `response_obligation(${String(rule.kind ?? "?")}${rule.expected ? `: ${String(rule.expected).slice(0, 80)}` : ""})`;
  if (type === "value_propagation") return `value_propagation(${String(rule.value ?? "").slice(0, 60)} → ${String(asObject(rule.must_reach).kind ?? asObject(rule.must_reach).tool ?? "?")})`;
  return `${type}(${String(rule.tool ?? "?")})`;
}

/** task_id → outcome_contract from the benchmark dir's tasks*.jsonl sidecars. */
export function loadTaskContracts(benchmarkDir: string): Map<string, Obj> {
  const dir = resolve(benchmarkDir);
  const out = new Map<string, Obj>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^tasks.*\.jsonl$/.test(f)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    for (const item of readJsonlFile<Obj>(join(dir, f)).items) {
      if (typeof item?.task_id === "string" && !out.has(item.task_id)) out.set(item.task_id, asObject(item.outcome_contract));
    }
  }
  return out;
}

/** All eval rows for one run (scans rows-*.jsonl at the dir root, filtered by run_id). */
export function readRunRows(benchmarkDir: string, runId: string): Obj[] {
  const dir = resolve(benchmarkDir);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^rows-.*\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const rows: Obj[] = [];
  for (const f of files) {
    for (const row of readJsonlFile<Obj>(join(dir, f)).items) {
      if (row?.run_id === runId) rows.push(row);
    }
  }
  return rows;
}

/** Mean score of scoreable (status ok, non-anomalous) rows; null when none. */
export function meanScore(rows: Obj[]): { mean: number | null; rows: number } {
  const scored = rows.filter((r) => r.status === "ok" && r.anomaly == null && typeof r.score === "number");
  if (scored.length === 0) return { mean: null, rows: 0 };
  return { mean: scored.reduce((sum, r) => sum + (r.score as number), 0) / scored.length, rows: scored.length };
}

/** Build one arm's evidence packet from its rows and (optional) live-journal text. */
export function collectArmEvidence(
  armLabel: string,
  armRows: Obj[],
  journalText: string | null,
  contracts: Map<string, Obj>,
): ArmEvidence {
  const { mean, rows } = meanScore(armRows);
  const byTask = new Map<string, Obj[]>();
  for (const row of armRows) {
    const id = String(row.task_id ?? "");
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id)!.push(row);
  }
  const failed: FailedTaskEvidence[] = [];
  for (const [taskId, taskRows] of byTask) {
    const stat = meanScore(taskRows);
    if (stat.mean !== null && stat.mean >= 1) continue;
    const required = (asObject(contracts.get(taskId)).required ?? []) as Obj[];
    failed.push({ task_id: taskId, mean_score: stat.mean, required: required.map((rule) => contractEntrySummary(asObject(rule))) });
  }
  failed.sort((a, b) => a.task_id.localeCompare(b.task_id));
  return {
    arm_label: armLabel,
    mean_score: mean,
    rows,
    rejections: journalText === null ? { calls: 0, rejected: 0, by_class: {}, examples: [] } : journalRejections(journalText),
    failed_tasks: failed,
  };
}

/* ------------------------------------------------------------------ */
/* Proposal step (authoring model via the trace-author gateway client) */
/* ------------------------------------------------------------------ */

export type PopulationMember = { system_prompt_suffix: string; mean_score: number | null; arm_label: string };

/**
 * The authoring prompt: failure evidence in, N candidate suffixes out.
 * Deterministic text so tests can fixture it; the ONLY model-facing surface.
 */
export function buildProposalPrompt(input: {
  benchmarkId: string;
  baseModel: string;
  generation: number;
  variants: number;
  bare: ArmEvidence | null;
  population: PopulationMember[];
  evidence: ArmEvidence[];
}): { role: string; content: string }[] {
  const lines: string[] = [
    `You are optimizing the system prompt of an agentic tool-calling model (${input.baseModel}) on benchmark ${input.benchmarkId}.`,
    `Each candidate is a SHORT system-prompt SUFFIX appended to the task's existing system prompt at rollout time; the base prompt is fixed.`,
    ``,
    `Scores are the fraction of tasks whose full outcome contract was satisfied (0..1, higher is better).`,
  ];
  const describe = (evidence: ArmEvidence, title: string) => {
    lines.push(``, `## ${title} — mean score ${evidence.mean_score === null ? "n/a" : evidence.mean_score.toFixed(3)} over ${evidence.rows} rows`);
    const classes = Object.entries(evidence.rejections.by_class).map(([cls, count]) => `${cls}=${count}`);
    lines.push(`Tool-call rejections by the simulated world: ${evidence.rejections.rejected}/${evidence.rejections.calls} calls${classes.length ? ` (${classes.join(", ")})` : ""}.`);
    for (const example of evidence.rejections.examples) lines.push(`- rejection: ${example}`);
    if (evidence.failed_tasks.length > 0) {
      lines.push(`Failing tasks and the contract obligations they must satisfy:`);
      for (const task of evidence.failed_tasks.slice(0, 12)) {
        lines.push(`- ${task.task_id} (score ${task.mean_score === null ? "n/a" : task.mean_score.toFixed(2)}): ${task.required.join("; ") || "(no contract sidecar found)"}`);
      }
    }
  };
  if (input.bare) describe(input.bare, `Bare model (no suffix)`);
  for (const evidence of input.evidence) describe(evidence, `Candidate arm ${evidence.arm_label}`);
  if (input.population.length > 0) {
    lines.push(``, `## Current population (best first)`);
    for (const member of input.population) {
      lines.push(`- [${member.mean_score === null ? "n/a" : member.mean_score.toFixed(3)}] ${member.arm_label}:`, member.system_prompt_suffix, ``);
    }
  }
  lines.push(
    ``,
    `Propose exactly ${input.variants} NEW system-prompt suffixes for generation ${input.generation}.`,
    `Rules: each under ${MAX_SUFFIX_CHARS} characters; address the observed rejection classes and unmet obligations concretely (name required fields, enum values, response format obligations); mutate/recombine the best population members rather than restarting; no two proposals may be near-duplicates.`,
    `Respond with ONLY a JSON array of ${input.variants} objects: [{"system_prompt_suffix": "..."}].`,
  );
  return [
    { role: "system", content: "You are a careful prompt-optimization engine. You reply with strictly valid JSON and nothing else." },
    { role: "user", content: lines.join("\n") },
  ];
}

/** Parse the authoring model's reply into up to `variants` distinct suffixes. */
export function parseProposedSuffixes(content: string, variants: number): string[] {
  const text = String(content ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const suffix = typeof entry === "string" ? entry : asObject(entry).system_prompt_suffix;
    if (typeof suffix !== "string") continue;
    const trimmed = suffix.trim().slice(0, MAX_SUFFIX_CHARS);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= variants) break;
  }
  return out;
}

/** Leaderboard/rows-file-safe arm label for generation g, variant i (1-based). */
export function evolutionArmLabel(baseModel: string, generation: number, index: number): string {
  return `${baseModel}+evo-g${generation}v${index}`;
}

/* ------------------------------------------------------------------ */
/* Queueing + waiting (queue only — NEVER execute)                     */
/* ------------------------------------------------------------------ */

export type QueueEvolutionRunInput = {
  baseModel: string;
  split: RunSplit;
  overrides?: PromptOverride[];
  rolloutsPerTask: number;
  /** "evolve" runs are hard-blocked from holdout/"all"; only "final" may touch holdout. */
  purpose: "evolve" | "final";
};

/**
 * Validate + queue ONE run request through the SHARED run-executor writer
 * (createRunRequest). Split sealing is enforced here: an evolve-purpose run
 * can never carry the holdout split (or "all", which contains it).
 */
export function queueEvolutionRun(benchmarkDir: string, input: QueueEvolutionRunInput): RunRequest {
  if (input.purpose === "evolve" && (input.split === "holdout" || input.split === "all")) {
    throw new Error(`split sealing violation: evolution runs may only use train/dev, got "${input.split}" — the holdout is touched exactly once by the final champion-vs-bare run`);
  }
  const dir = resolve(benchmarkDir);
  const manifest = asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")));
  if (manifest.schema_version !== "understudy.benchmark.v1" || typeof manifest.benchmark_id !== "string") {
    throw new Error(`${join(dir, "benchmark.json")} is not a promoted understudy.benchmark.v1 manifest — promote the benchmark before evolving`);
  }
  const knownTaskIds = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map((t: Obj) => String(asObject(t).task_id));
  const body = {
    benchmark_id: String(manifest.benchmark_id),
    models: [input.baseModel],
    split: input.split,
    tasks: "all" as const,
    rollouts_per_task: input.rolloutsPerTask,
    ...(input.overrides && input.overrides.length > 0 ? { prompt_overrides: input.overrides } : {}),
  };
  const errors = validateRunRequestInput(body, knownTaskIds);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (selectTasks(manifest, { split: input.split, tasks: "all" }).length === 0) {
    throw new Error(`no tasks in split "${input.split}" — freeze train/dev/holdout splits before evolving`);
  }
  return createRunRequest(dir, body);
}

export type WaitOptions = {
  pollMs?: number;
  maxPollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once if the request sits unclaimed — no executor is watching the queue. */
  onIdle?: (request: RunRequest) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll the run request file with backoff until it settles (done / failed /
 * cancelled). Queue-only discipline: if nothing claims the request, the user
 * is told (once) to start `understudy runs execute --watch` — this process
 * never spawns an executor.
 */
export async function waitForRun(benchmarkDir: string, runId: string, options: WaitOptions = {}): Promise<RunRequest> {
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 4 * 60 * 60 * 1000;
  const maxPollMs = options.maxPollMs ?? 30_000;
  let pollMs = options.pollMs ?? 2_000;
  const started = Date.now();
  let idleWarned = false;
  let unclaimedPolls = 0;
  for (;;) {
    const request = readRunRequest(runRequestPath(benchmarkDir, runId));
    if (!request) throw new Error(`run request ${runId} disappeared from ${benchmarkDir}`);
    if (request.status === "done" || request.status === "failed" || request.status === "cancelled") return request;
    if (request.status === "queued" && !request.claimed_by) {
      unclaimedPolls += 1;
      if (unclaimedPolls >= 3 && !idleWarned) {
        idleWarned = true;
        options.onIdle?.(request);
      }
    } else {
      unclaimedPolls = 0;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for run ${runId} (status ${request.status})`);
    await sleep(pollMs);
    pollMs = Math.min(Math.round(pollMs * 1.5), maxPollMs);
  }
}

/* ------------------------------------------------------------------ */
/* Holdout verdict                                                     */
/* ------------------------------------------------------------------ */

export type HoldoutVerdict = {
  champion_arm: string;
  champion_mean: number | null;
  bare_mean: number | null;
  paired_tasks: number;
  mean_diff: number | null;
  ci95: [number, number] | null;
  /** "win" only when the 95% CI of the paired per-task diff excludes zero from below. */
  verdict: "win" | "no_win" | "inconclusive" | "unverified";
};

/** Paired per-task champion-vs-bare comparison with a normal-approximation 95% CI. */
export function pairedVerdict(championArm: string, championRows: Obj[], bareRows: Obj[]): HoldoutVerdict {
  const perTask = (rows: Obj[]) => {
    const byTask = new Map<string, number[]>();
    for (const row of rows) {
      if (row.status !== "ok" || row.anomaly != null || typeof row.score !== "number") continue;
      const id = String(row.task_id ?? "");
      if (!byTask.has(id)) byTask.set(id, []);
      byTask.get(id)!.push(row.score as number);
    }
    return new Map([...byTask].map(([id, scores]) => [id, scores.reduce((a, b) => a + b, 0) / scores.length]));
  };
  const champion = perTask(championRows);
  const bare = perTask(bareRows);
  const diffs: number[] = [];
  for (const [taskId, score] of champion) {
    const bareScore = bare.get(taskId);
    if (bareScore !== undefined) diffs.push(score - bareScore);
  }
  const championMean = meanScore(championRows).mean;
  const bareMean = meanScore(bareRows).mean;
  if (diffs.length === 0) {
    return { champion_arm: championArm, champion_mean: championMean, bare_mean: bareMean, paired_tasks: 0, mean_diff: null, ci95: null, verdict: "inconclusive" };
  }
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / Math.max(diffs.length - 1, 1);
  const half = 1.96 * Math.sqrt(variance / diffs.length);
  const ci: [number, number] = [meanDiff - half, meanDiff + half];
  const verdict: HoldoutVerdict["verdict"] = ci[0] > 0 ? "win" : ci[1] < 0 ? "no_win" : "inconclusive";
  return { champion_arm: championArm, champion_mean: championMean, bare_mean: bareMean, paired_tasks: diffs.length, mean_diff: meanDiff, ci95: ci, verdict };
}

/* ------------------------------------------------------------------ */
/* The evolution driver                                                */
/* ------------------------------------------------------------------ */

/** IO seams so the loop is testable without a gateway or executor. */
export type EvolveIo = {
  queue: (input: QueueEvolutionRunInput) => RunRequest;
  wait: (runId: string) => Promise<RunRequest>;
  rows: (runId: string) => Obj[];
  journal: (runId: string, armLabel: string) => string | null;
  client: AuthorClient;
  log: (line: string) => void;
  now: () => Date;
};

export type EvolveOptions = {
  model: string;
  authorModel?: string;
  generations?: number;
  variants?: number;
  rolloutsPerTask?: number;
  /** Hard cap on runs queued by this invocation (baseline + generations + dev select + holdout final). */
  budgetRuns?: number;
  /** Skip the final holdout run; the result is then explicitly "unverified" — never a win. */
  final?: boolean;
  io?: Partial<EvolveIo>;
};

export type EvolveResult = {
  benchmark_id: string;
  base_model: string;
  author_model: string;
  runs_queued: number;
  generations: number;
  champion: PopulationMember | null;
  verdict: HoldoutVerdict;
  evolution_file: string;
};

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function defaultIo(benchmarkDir: string): EvolveIo {
  let client: AuthorClient | null = null;
  return {
    queue: (input) => queueEvolutionRun(benchmarkDir, input),
    wait: (runId) =>
      waitForRun(benchmarkDir, runId, {
        onIdle: () =>
          console.error(
            `[evolve] run request is queued but unclaimed — start an executor in another terminal:\n  understudy runs execute --benchmark ${resolve(benchmarkDir)} --watch`,
          ),
      }),
    rows: (runId) => readRunRows(benchmarkDir, runId),
    journal: (runId, armLabel) => {
      const file = liveJournalPath(benchmarkDir, runId, armLabel);
      try {
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      } catch {
        return null;
      }
    },
    client: (request) => {
      if (!client) {
        const auth = resolveGatewayAuth();
        client = gatewayClient(auth.baseUrl, auth.apiKey);
      }
      return client(request);
    },
    log: (line) => console.error(line),
    now: () => new Date(),
  };
}

const authorCost = (usage: AuthorUsage | undefined): number =>
  (((usage?.prompt_tokens ?? 0) * 1 + (usage?.completion_tokens ?? 0) * 4) / 1_000_000); // conservative default-rate estimate

export async function evolvePrompts(benchmarkDirInput: string, options: EvolveOptions): Promise<EvolveResult> {
  const benchmarkDir = resolve(benchmarkDirInput);
  const io: EvolveIo = { ...defaultIo(benchmarkDir), ...options.io };
  const generations = clamp(options.generations ?? 2, 1, 6);
  const variants = clamp(options.variants ?? 3, 2, 4); // small and honest — runs are expensive
  const rollouts = clamp(options.rolloutsPerTask ?? 1, 1, 20);
  const wantFinal = options.final !== false;
  const budget = options.budgetRuns ?? generations + (wantFinal ? 3 : 2);
  const contracts = loadTaskContracts(benchmarkDir);

  let authorModel = options.authorModel ?? null;
  if (!authorModel) {
    const auth = resolveGatewayAuth();
    authorModel = await resolveDefaultModel(auth.baseUrl, auth.apiKey);
  }

  let runsQueued = 0;
  const spendRun = (label: string): void => {
    runsQueued += 1;
    if (runsQueued > budget) throw new Error(`--budget-runs exhausted (${budget}) before ${label}; raise the budget or lower --generations`);
  };

  const armEvidenceFor = (runId: string, rows: Obj[], armLabel: string): ArmEvidence =>
    collectArmEvidence(armLabel, rows.filter((r) => r.model === armLabel), io.journal(runId, armLabel), contracts);

  const variantRecord = (rows: Obj[], override: PromptOverride): EvolutionVariant => {
    const stat = meanScore(rows.filter((r) => r.model === override.arm_label));
    return {
      arm_label: override.arm_label,
      system_prompt_suffix: override.system_prompt_suffix,
      system_prompt_suffix_sha256: promptSuffixHash(override.system_prompt_suffix),
      mean_score: stat.mean,
      rows: stat.rows,
    };
  };

  // Generation 0: bare baseline on TRAIN — the evidence the first proposal feeds on.
  spendRun("the train baseline run");
  io.log(`[evolve] generation 0: bare ${options.model} on train`);
  const baselineRun = io.queue({ baseModel: options.model, split: "train", rolloutsPerTask: rollouts, purpose: "evolve" });
  const baselineDone = await io.wait(baselineRun.run_id);
  if (baselineDone.status !== "done") throw new Error(`baseline run ${baselineRun.run_id} ended ${baselineDone.status}${baselineDone.error ? `: ${baselineDone.error.message}` : ""}`);
  const baselineRows = io.rows(baselineRun.run_id);
  let bareEvidence = armEvidenceFor(baselineRun.run_id, baselineRows, options.model);
  const benchmarkId = String(baselineRun.benchmark_id);
  appendEvolutionRecord(benchmarkDir, {
    schema_version: PROMPT_EVOLUTION_SCHEMA,
    benchmark_id: benchmarkId,
    generation: 0,
    split: "train",
    run_id: baselineRun.run_id,
    base_model: options.model,
    author_model: null,
    created_at: io.now().toISOString(),
    variants: [],
    bare: { mean_score: bareEvidence.mean_score, rows: bareEvidence.rows },
    champion: options.model,
  });

  // Evolution generations on TRAIN only.
  let population: PopulationMember[] = [];
  let lastEvidence: ArmEvidence[] = [];
  for (let generation = 1; generation <= generations; generation += 1) {
    spendRun(`generation ${generation}`);
    const messages = buildProposalPrompt({
      benchmarkId,
      baseModel: options.model,
      generation,
      variants,
      bare: bareEvidence,
      population,
      evidence: lastEvidence,
    });
    const reply = await io.client({ model: authorModel, messages });
    const cost = authorCost(reply.usage);
    const suffixes = parseProposedSuffixes(reply.content, variants);
    if (suffixes.length === 0) throw new Error(`authoring model ${authorModel} returned no parseable suffix proposals in generation ${generation}`);
    const overrides: PromptOverride[] = suffixes.map((suffix, i) => ({
      arm_label: evolutionArmLabel(options.model, generation, i + 1),
      model: options.model,
      system_prompt_suffix: suffix,
    }));
    io.log(`[evolve] generation ${generation}: ${overrides.length} variant arms on train`);
    const run = io.queue({ baseModel: options.model, split: "train", overrides, rolloutsPerTask: rollouts, purpose: "evolve" });
    const done = await io.wait(run.run_id);
    if (done.status !== "done") throw new Error(`generation ${generation} run ${run.run_id} ended ${done.status}${done.error ? `: ${done.error.message}` : ""}`);
    const rows = io.rows(run.run_id);
    const recorded = overrides.map((override) => variantRecord(rows, override));
    const bareStat = meanScore(rows.filter((r) => r.model === options.model));
    lastEvidence = overrides.map((override) => armEvidenceFor(run.run_id, rows, override.arm_label));
    // Each generation run also carries the bare arm (models: [baseModel]);
    // refresh the bare evidence from the freshest run.
    if (bareStat.rows > 0) bareEvidence = armEvidenceFor(run.run_id, rows, options.model);

    population = [...population, ...recorded.map((v) => ({ system_prompt_suffix: v.system_prompt_suffix, mean_score: v.mean_score, arm_label: v.arm_label }))]
      .sort((a, b) => (b.mean_score ?? -1) - (a.mean_score ?? -1))
      .slice(0, 2); // parents for the next proposal — small and honest
    const best = recorded.slice().sort((a, b) => (b.mean_score ?? -1) - (a.mean_score ?? -1))[0] ?? null;
    appendEvolutionRecord(benchmarkDir, {
      schema_version: PROMPT_EVOLUTION_SCHEMA,
      benchmark_id: benchmarkId,
      generation,
      split: "train",
      run_id: run.run_id,
      base_model: options.model,
      author_model: authorModel,
      created_at: io.now().toISOString(),
      variants: recorded,
      bare: bareStat.rows > 0 ? { mean_score: bareStat.mean, rows: bareStat.rows } : null,
      champion: best && (best.mean_score ?? -1) >= (bareEvidence.mean_score ?? -1) ? best.arm_label : options.model,
      author_cost_estimate_usd: cost,
    });
  }

  const trainChampion = population[0] ?? null;
  if (!trainChampion) {
    return { benchmark_id: benchmarkId, base_model: options.model, author_model: authorModel, runs_queued: runsQueued, generations, champion: null, verdict: { champion_arm: options.model, champion_mean: null, bare_mean: null, paired_tasks: 0, mean_diff: null, ci95: null, verdict: "unverified" }, evolution_file: evolutionPath(benchmarkDir) };
  }

  // DEV selection: champion vs bare on the dev split (still evolve-purpose — holdout stays sealed).
  spendRun("the dev selection run");
  const devOverride: PromptOverride = { arm_label: `${trainChampion.arm_label}+dev`, model: options.model, system_prompt_suffix: trainChampion.system_prompt_suffix };
  io.log(`[evolve] dev selection: ${trainChampion.arm_label} vs bare ${options.model}`);
  const devRun = io.queue({ baseModel: options.model, split: "dev", overrides: [devOverride], rolloutsPerTask: rollouts, purpose: "evolve" });
  const devDone = await io.wait(devRun.run_id);
  if (devDone.status !== "done") throw new Error(`dev selection run ${devRun.run_id} ended ${devDone.status}${devDone.error ? `: ${devDone.error.message}` : ""}`);
  const devRows = io.rows(devRun.run_id);
  const devVariant = variantRecord(devRows, devOverride);
  const devBare = meanScore(devRows.filter((r) => r.model === options.model));
  const devWin = (devVariant.mean_score ?? -1) > (devBare.mean ?? -1);
  appendEvolutionRecord(benchmarkDir, {
    schema_version: PROMPT_EVOLUTION_SCHEMA,
    benchmark_id: benchmarkId,
    generation: "dev_select",
    split: "dev",
    run_id: devRun.run_id,
    base_model: options.model,
    author_model: authorModel,
    created_at: io.now().toISOString(),
    variants: [devVariant],
    bare: { mean_score: devBare.mean, rows: devBare.rows },
    champion: devWin ? devVariant.arm_label : options.model,
  });

  const champion: PopulationMember = { ...trainChampion };
  let verdict: HoldoutVerdict = { champion_arm: champion.arm_label, champion_mean: null, bare_mean: null, paired_tasks: 0, mean_diff: null, ci95: null, verdict: "unverified" };

  if (!devWin) {
    io.log(`[evolve] champion did not beat bare on dev — holdout stays sealed; no win to verify`);
    verdict = { ...verdict, verdict: "no_win", champion_mean: devVariant.mean_score, bare_mean: devBare.mean };
  } else if (!wantFinal) {
    io.log(`[evolve] --no-final: holdout untouched. The result is UNVERIFIED — do not report a win without the heldout run.`);
  } else {
    // HOLDOUT — touched exactly once: champion vs bare, then the verdict.
    spendRun("the holdout final run");
    const finalOverride: PromptOverride = { arm_label: `${champion.arm_label}+holdout`, model: options.model, system_prompt_suffix: champion.system_prompt_suffix };
    io.log(`[evolve] holdout final: ${champion.arm_label} vs bare ${options.model}`);
    const finalRun = io.queue({ baseModel: options.model, split: "holdout", overrides: [finalOverride], rolloutsPerTask: rollouts, purpose: "final" });
    const finalDone = await io.wait(finalRun.run_id);
    if (finalDone.status !== "done") throw new Error(`holdout run ${finalRun.run_id} ended ${finalDone.status}${finalDone.error ? `: ${finalDone.error.message}` : ""}`);
    const finalRows = io.rows(finalRun.run_id);
    verdict = pairedVerdict(
      finalOverride.arm_label,
      finalRows.filter((r) => r.model === finalOverride.arm_label),
      finalRows.filter((r) => r.model === options.model),
    );
    appendEvolutionRecord(benchmarkDir, {
      schema_version: PROMPT_EVOLUTION_SCHEMA,
      benchmark_id: benchmarkId,
      generation: "holdout_final",
      split: "holdout",
      run_id: finalRun.run_id,
      base_model: options.model,
      author_model: authorModel,
      created_at: io.now().toISOString(),
      variants: [variantRecord(finalRows, finalOverride)],
      bare: (() => {
        const stat = meanScore(finalRows.filter((r) => r.model === options.model));
        return { mean_score: stat.mean, rows: stat.rows };
      })(),
      champion: verdict.verdict === "win" ? finalOverride.arm_label : options.model,
      verdict,
    });
  }

  return {
    benchmark_id: benchmarkId,
    base_model: options.model,
    author_model: authorModel,
    runs_queued: runsQueued,
    generations,
    champion,
    verdict,
    evolution_file: evolutionPath(benchmarkDir),
  };
}
