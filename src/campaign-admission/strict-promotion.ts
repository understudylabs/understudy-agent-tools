import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type JsonObject = Record<string, unknown>;
export type StrictPromotionResult = { decision: "PROMOTE" | "HOLD"; errors: string[]; candidate_strict_exact: number; parent_strict_exact: Record<string, number>; paired: Record<string, { wins: number; losses: number; ties: number }> };
export type StrictPromotionArtifacts = {
  trustedScorerContract: Buffer;
  expectedTrustedScorerContractSha256: string;
  namedPreimages: Record<"taskset" | "harness" | "scorer" | "terminal" | "export" | "promotion" | "model" | "checkpoint" | "dspy", Buffer>;
  expectedNamedPreimageSha256: Record<"taskset" | "harness" | "scorer" | "terminal" | "export" | "promotion" | "model" | "checkpoint" | "dspy", string>;
  rowPreimages: Record<string, { canonical: Buffer; physical: Buffer }>;
};

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: Record<string, unknown>) => { compile: (schema: unknown) => ((value: unknown) => boolean) & { errors?: { instancePath: string; message?: string; keyword: string }[] | null } };
const schema = JSON.parse(readFileSync(new URL("../../schemas/understudy.strict_promotion.v1.schema.json", import.meta.url), "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export function validateStrictPromotion(evidence: unknown, artifacts: StrictPromotionArtifacts): StrictPromotionResult {
  const value = object(evidence);
  const errors = validateSchema(value) ? [] : (validateSchema.errors ?? []).map((error) => `schema${error.instancePath || "/"}: ${error.message ?? error.keyword}`);
  const scorerHash = sha(artifacts.trustedScorerContract);
  if (value.trusted_scorer_contract_sha256 !== scorerHash || scorerHash !== artifacts.expectedTrustedScorerContractSha256) errors.push("trusted scorer contract hash does not match independently expected scorer-contract preimage");
  const declared = object(value.named_preimages);
  for (const [name, bytes] of Object.entries(artifacts.namedPreimages)) if (declared[name] !== sha(bytes) || sha(bytes) !== artifacts.expectedNamedPreimageSha256[name as keyof typeof artifacts.expectedNamedPreimageSha256]) errors.push(`named preimage ${name} hash mismatch`);
  let expectedTasks: string[] = [];
  try {
    const taskset = object(JSON.parse(artifacts.namedPreimages.taskset.toString("utf8")));
    expectedTasks = Array.isArray(taskset.dev_task_ids) ? taskset.dev_task_ids.filter((item): item is string => typeof item === "string").sort() : [];
  } catch { errors.push("taskset preimage must be valid JSON with dev_task_ids"); }
  if (expectedTasks.length === 0 || new Set(expectedTasks).size !== expectedTasks.length) errors.push("taskset preimage must name a unique non-empty complete dev task set");
  for (const name of ["model", "checkpoint", "dspy"] as const) {
    try {
      const identity = object(JSON.parse(artifacts.namedPreimages[name].toString("utf8")));
      if (identity.kind !== name || typeof identity.id !== "string" || identity.id.length === 0 || typeof identity.revision !== "string" || identity.revision.length === 0) errors.push(`${name} preimage lacks exact kind/id/revision identity`);
    } catch { errors.push(`${name} preimage must be valid identity JSON`); }
  }
  if (value.scorer_exception_count !== 0) errors.push("scorer_exception_count must equal zero");

  const candidate = typeof value.candidate_id === "string" ? value.candidate_id : "";
  const parents = Array.isArray(value.parent_ids) ? value.parent_ids.filter((item): item is string => typeof item === "string") : [];
  const rows = Array.isArray(value.rows) ? value.rows.map(object) : [];
  const byCandidate = new Map<string, Map<string, JsonObject>>();
  for (const row of rows) {
    const id = typeof row.candidate_id === "string" ? row.candidate_id : "";
    const task = typeof row.task_id === "string" ? row.task_id : "";
    const tasks = byCandidate.get(id) ?? new Map<string, JsonObject>();
    if (tasks.has(task)) errors.push(`duplicate task ${task} for candidate ${id}`);
    tasks.set(task, row); byCandidate.set(id, tasks);
    if (row.candidate_prompt_sha256 !== row.evaluated_prompt_sha256) errors.push(`prompt hash mismatch for ${id}/${task}`);
    const rowPreimage = artifacts.rowPreimages[`${id}/${task}`];
    if (!rowPreimage || row.canonical_row_sha256 !== sha(rowPreimage.canonical) || row.physical_row_sha256 !== sha(rowPreimage.physical)) errors.push(`canonical/physical row hashes do not match supplied preimages for ${id}/${task}`);
  }
  const candidateTasks = byCandidate.get(candidate) ?? new Map<string, JsonObject>();
  if (candidateTasks.size === 0) errors.push("candidate has no complete dev rows");
  const candidateTaskIds = [...candidateTasks.keys()].sort();
  if (JSON.stringify(candidateTaskIds) !== JSON.stringify(expectedTasks)) errors.push("candidate does not contain the exact complete dev taskset from the trusted taskset preimage");
  const strictCount = [...candidateTasks.values()].filter((row) => row.strict_exact === true).length;
  const parentCounts: Record<string, number> = {};
  const paired: StrictPromotionResult["paired"] = {};
  for (const parent of parents) {
    const parentTasks = byCandidate.get(parent) ?? new Map<string, JsonObject>();
    if (JSON.stringify([...parentTasks.keys()].sort()) !== JSON.stringify(candidateTaskIds)) errors.push(`parent ${parent} does not have the same complete dev task IDs exactly once`);
    let wins = 0, losses = 0, ties = 0;
    for (const task of candidateTaskIds) {
      const left = candidateTasks.get(task)?.strict_exact === true ? 1 : 0;
      const right = parentTasks.get(task)?.strict_exact === true ? 1 : 0;
      if (left > right) wins++; else if (left < right) losses++; else ties++;
    }
    parentCounts[parent] = [...parentTasks.values()].filter((row) => row.strict_exact === true).length;
    paired[parent] = { wins, losses, ties };
    if (strictCount <= parentCounts[parent]) errors.push(`candidate strict-exact count must exceed parent ${parent}`);
  }
  for (const id of byCandidate.keys()) if (id !== candidate && !parents.includes(id)) errors.push(`unexpected candidate rows for ${id}`);
  const privateArtifacts = Array.isArray(value.prompt_bearing_artifacts) ? value.prompt_bearing_artifacts.map(object) : [];
  if (!privateArtifacts.some((item) => item.name === "evaluation_evidence")) errors.push("evaluation_evidence must be classified as prompt-bearing private CAS");
  if (!privateArtifacts.some((item) => item.name === "candidate_persistence_payload")) errors.push("candidate_persistence_payload must be classified as prompt-bearing private CAS");
  for (const item of privateArtifacts) if (item.classification !== "private_cas" || item.contains_prompt !== true || item.externalized !== false) errors.push(`prompt-bearing artifact ${String(item.name)} must remain private CAS and not externalize`);
  return { decision: errors.length === 0 ? "PROMOTE" : "HOLD", errors, candidate_strict_exact: strictCount, parent_strict_exact: parentCounts, paired };
}
