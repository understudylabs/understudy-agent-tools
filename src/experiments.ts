import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const captureEvidenceDir = ".understudy/capture-evidence";
const experimentsDir = ".understudy/experiments";
const activePointer = join(experimentsDir, "active");

const evidenceArtifacts = [
  "harness.json",
  "environment.json",
  "metric.json",
  "splits.json",
  "baseline.json",
] as const;

const pinnedArtifacts = ["harness.json", "metric.json", "splits.json"] as const;

export type ExperimentPins = {
  harness_sha256: string | null;
  metric_sha256: string | null;
  splits_sha256: string | null;
};

export type ExperimentOutcome = "success" | "partial" | "abandoned";
export type RouteDecision = "ship-local" | "local-as-router" | "hybrid" | "remote";

export type ExperimentResult = {
  claim_ref: string | null;
  quality_delta: number | null;
  p50_latency_delta_ms: number | null;
  cost_per_1k_delta_usd: number | null;
};

export type Experiment = {
  schema_version: "understudy.experiment.v1";
  experiment_id: string;
  workload: string;
  objective: string | null;
  hypothesis: string | null;
  created_at: string;
  pins: ExperimentPins;
  incumbent_model: string | null;
  candidate_model: string | null;
  result: ExperimentResult;
  outcome: ExperimentOutcome | null;
  route_decision: RouteDecision | null;
};

export type NewExperimentOptions = {
  id?: string;
  workload?: string;
  objective?: string;
  hypothesis?: string;
  incumbent?: string;
  candidate?: string;
};

export type LoopStep =
  | "capture-evidence"
  | "open-experiment"
  | "re-baseline"
  | "optimize"
  | "claim"
  | "decide"
  | "route";

export type NextState = {
  schema_version: "understudy.next.v1";
  repo: string;
  step: LoopStep;
  experiment_id: string | null;
  evidence: { present: string[]; missing: string[] };
  pins_match: boolean | null;
  summary: string;
  next_command: string;
};

export type ExperimentSummary = {
  experiment_id: string;
  workload: string;
  outcome: ExperimentOutcome | null;
  candidate_model: string | null;
  active: boolean;
};

const VALID_OUTCOMES: readonly ExperimentOutcome[] = ["success", "partial", "abandoned"];
const VALID_ROUTES: readonly RouteDecision[] = ["ship-local", "local-as-router", "hybrid", "remote"];

function ensureRepo(repoInput: string): string {
  const repo = resolve(repoInput);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new Error(`Repo path does not exist or is not a directory: ${repoInput}`);
  }
  return repo;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 of an artifact's raw bytes, or null if it is absent. */
function hashArtifact(repo: string, artifact: string): string | null {
  const path = join(repo, captureEvidenceDir, artifact);
  if (!existsSync(path)) {
    return null;
  }
  return sha256(readFileSync(path, "utf8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function experimentDir(repo: string, id: string): string {
  return join(repo, experimentsDir, id);
}

function experimentRecordPath(repo: string, id: string): string {
  return join(experimentDir(repo, id), "experiment.json");
}

/** List experiment ids in `exp-NNN` order. */
export function listExperimentIds(repo: string): string[] {
  const root = join(repo, experimentsDir);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(experimentRecordPath(repo, name)))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function nextExperimentId(repo: string): string {
  const ids = listExperimentIds(repo);
  let max = 0;
  for (const id of ids) {
    const match = /^exp-(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number.parseInt(match[1]!, 10));
    }
  }
  return `exp-${String(max + 1).padStart(3, "0")}`;
}

export function readActiveId(repo: string): string | null {
  const path = join(repo, activePointer);
  if (!existsSync(path)) {
    return null;
  }
  const id = readFileSync(path, "utf8").trim();
  return id.length > 0 && existsSync(experimentRecordPath(repo, id)) ? id : null;
}

export function setActiveId(repoInput: string, id: string): void {
  const repo = ensureRepo(repoInput);
  if (!existsSync(experimentRecordPath(repo, id))) {
    throw new Error(`Unknown experiment: ${id}. Run \`understudy experiments list\`.`);
  }
  const path = join(repo, activePointer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`, "utf8");
}

export function readExperiment(repo: string, id: string): Experiment {
  const path = experimentRecordPath(repo, id);
  if (!existsSync(path)) {
    throw new Error(`Unknown experiment: ${id}. Run \`understudy experiments list\`.`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Experiment;
  return parsed;
}

/** Copy the baseline.json hash-chain into a pins object (nulls if absent). */
function pinsFromBaseline(repo: string): ExperimentPins {
  const path = join(repo, captureEvidenceDir, "baseline.json");
  const empty: ExperimentPins = { harness_sha256: null, metric_sha256: null, splits_sha256: null };
  if (!existsSync(path)) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  if (!isObject(parsed)) {
    return empty;
  }
  return {
    harness_sha256: optionalString(parsed.harness_sha256),
    metric_sha256: optionalString(parsed.metric_sha256),
    splits_sha256: optionalString(parsed.splits_sha256),
  };
}

export function createExperiment(repoInput: string, options: NewExperimentOptions = {}): Experiment {
  const repo = ensureRepo(repoInput);
  const id = options.id ?? nextExperimentId(repo);
  if (!/^exp-\d+$/.test(id) && options.id === undefined) {
    throw new Error(`Generated an invalid experiment id: ${id}`);
  }
  if (existsSync(experimentRecordPath(repo, id))) {
    throw new Error(`Experiment ${id} already exists.`);
  }
  const experiment: Experiment = {
    schema_version: "understudy.experiment.v1",
    experiment_id: id,
    workload: options.workload ?? "workload-001",
    objective: options.objective ?? null,
    hypothesis: options.hypothesis ?? null,
    created_at: new Date().toISOString(),
    pins: pinsFromBaseline(repo),
    incumbent_model: options.incumbent ?? null,
    candidate_model: options.candidate ?? null,
    result: {
      claim_ref: null,
      quality_delta: null,
      p50_latency_delta_ms: null,
      cost_per_1k_delta_usd: null,
    },
    outcome: null,
    route_decision: null,
  };
  writeJson(experimentRecordPath(repo, id), experiment);
  setActiveId(repo, id);
  return experiment;
}

export function recordOutcome(
  repoInput: string,
  outcome: ExperimentOutcome,
  options: { id?: string; route?: RouteDecision } = {},
): Experiment {
  const repo = ensureRepo(repoInput);
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}". Use one of: ${VALID_OUTCOMES.join(", ")}.`);
  }
  if (options.route !== undefined && !VALID_ROUTES.includes(options.route)) {
    throw new Error(`Invalid route "${options.route}". Use one of: ${VALID_ROUTES.join(", ")}.`);
  }
  const id = options.id ?? readActiveId(repo);
  if (!id) {
    throw new Error("No active experiment. Run `understudy experiments new` first.");
  }
  const experiment = readExperiment(repo, id);
  experiment.outcome = outcome;
  if (options.route !== undefined) {
    experiment.route_decision = options.route;
  }
  const claimPath = join(experimentDir(repo, id), "claim.json");
  if (existsSync(claimPath)) {
    experiment.result.claim_ref = "claim.json";
  }
  writeJson(experimentRecordPath(repo, id), experiment);
  return experiment;
}

export function summarizeExperiments(repoInput: string): ExperimentSummary[] {
  const repo = ensureRepo(repoInput);
  const active = readActiveId(repo);
  return listExperimentIds(repo).map((id) => {
    const experiment = readExperiment(repo, id);
    return {
      experiment_id: id,
      workload: experiment.workload,
      outcome: experiment.outcome,
      candidate_model: experiment.candidate_model,
      active: id === active,
    };
  });
}

function evidenceState(repo: string): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const artifact of evidenceArtifacts) {
    if (existsSync(join(repo, captureEvidenceDir, artifact))) {
      present.push(artifact);
    } else {
      missing.push(artifact);
    }
  }
  return { present, missing };
}

/** True only when every pinned hash is set and equals the artifact on disk. */
function pinsMatchDisk(repo: string, pins: ExperimentPins): boolean {
  for (const artifact of pinnedArtifacts) {
    const field = `${artifact.replace(/\.json$/, "")}_sha256` as keyof ExperimentPins;
    const pinned = pins[field];
    if (!pinned || hashArtifact(repo, artifact) !== pinned) {
      return false;
    }
  }
  return true;
}

/**
 * Derive where the improvement loop stands purely from artifacts on disk plus
 * the active experiment's pins — no stored step counter. This is `understudy
 * next`.
 */
export function deriveNext(repoInput: string): NextState {
  const repo = ensureRepo(repoInput);
  const evidence = evidenceState(repo);
  const base = {
    schema_version: "understudy.next.v1" as const,
    repo,
    evidence,
  };

  if (evidence.missing.length > 0) {
    return {
      ...base,
      step: "capture-evidence",
      experiment_id: readActiveId(repo),
      pins_match: null,
      summary: `Workload evidence incomplete — missing ${evidence.missing.join(", ")}.`,
      next_command: "understudy capture-evidence check --repo .",
    };
  }

  const activeId = readActiveId(repo);
  if (!activeId) {
    return {
      ...base,
      step: "open-experiment",
      experiment_id: null,
      pins_match: null,
      summary: "Evidence is present but no experiment is open.",
      next_command: "understudy experiments new --repo .",
    };
  }

  const experiment = readExperiment(repo, activeId);
  const dir = experimentDir(repo, activeId);
  const pinsMatch = pinsMatchDisk(repo, experiment.pins);

  if (!pinsMatch) {
    return {
      ...base,
      step: "re-baseline",
      experiment_id: activeId,
      pins_match: false,
      summary: `Experiment ${activeId} pins do not match the evidence on disk — re-baseline before optimizing.`,
      next_command: "understudy capture-evidence check --repo .",
    };
  }

  if (!existsSync(join(dir, "candidate.json"))) {
    return {
      ...base,
      step: "optimize",
      experiment_id: activeId,
      pins_match: true,
      summary: `Experiment ${activeId} is baselined — run the optimizer and freeze a candidate.`,
      next_command: "understudy optimize-workload check --repo .",
    };
  }

  if (!existsSync(join(dir, "claim.json"))) {
    return {
      ...base,
      step: "claim",
      experiment_id: activeId,
      pins_match: true,
      summary: `Experiment ${activeId} has a candidate but no claim — run holdout and write claim.json.`,
      next_command: "understudy optimize-workload check --repo .",
    };
  }

  if (experiment.outcome === null) {
    return {
      ...base,
      step: "decide",
      experiment_id: activeId,
      pins_match: true,
      summary: `Experiment ${activeId} has a claim — compare and record the outcome.`,
      next_command: "understudy experiments outcome <success|partial|abandoned> --repo .",
    };
  }

  return {
    ...base,
    step: "route",
    experiment_id: activeId,
    pins_match: true,
    summary: `Experiment ${activeId} outcome is ${experiment.outcome} — implement the route or promote a lab-note.`,
    next_command: "understudy route-decision plan --workload-card .understudy/workload-discovery/workload-card.json",
  };
}
