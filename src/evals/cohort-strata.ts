/**
 * Execution-derived eval cohort strata (issue #281, phase 1).
 *
 * The hosted catalog flow can only filter on request-level metadata (model,
 * status, tool presence, structured output), so a random recent sample can
 * miss rare or high-consequence behaviors whose complexity is only visible
 * after the execution finishes. This module derives configurable strata from
 * the LOCAL materialized trace artifacts (`execution-index.jsonl` +
 * `tasks.jsonl` produced by the trace foundry) and selects a deterministic,
 * stratified cohort toward decision-sized per-stratum targets.
 *
 * Hard privacy contract: the module only ever reads metadata fields
 * (execution ids, lineage status, capture counts, tool names, user-supplied
 * tags). Payload-derived fields such as task titles, prompts, or completions
 * are never read, and the plan artifact contains ids, labels, and counts
 * only — it is safe to discuss in a review without redaction.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { isMutatingTool } from "../trace-foundry.js";

export const COHORT_STRATA_PLAN_SCHEMA_VERSION = "understudy.eval-cohort-strata-plan.v1";
export const DEFAULT_STRATA_SEED = "understudy-cohort-strata-v1";

export const STRATA_AXES = ["outcome", "mode", "turns", "confidence", "tag"] as const;
export type StrataAxis = (typeof STRATA_AXES)[number];

const ExecutionIndexRowSchema = z
  .object({
    schema_version: z.literal("understudy.eval-execution-index-row.v1"),
    source_status: z.enum(["included", "excluded"]).optional(),
    execution_group: z.string().min(1).nullable(),
    lineage_status: z.enum(["complete", "ambiguous", "unlinked"]).nullable(),
    capture_count: z.number().int().nonnegative(),
    task_id: z.string().min(1).nullable(),
    exclusion_reasons: z.array(z.string()).optional(),
  })
  .passthrough();

/** Metadata-only task fields. `title` and other payload-derived fields are intentionally not read. */
const TaskRowSchema = z
  .object({
    task_id: z.string().min(1),
    execution_group: z.string().min(1),
    tool_surface: z.array(z.string()).optional(),
    machine_confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .passthrough();

export interface StrataPlanOptions {
  /** Deterministic selection seed. Same seed + same pool ⇒ byte-identical plan. */
  seed?: string;
  /** Per-stratum selection target. Pilot sizes are minimums, never caps. */
  targetPerStratum?: number;
  /** Strata with at most this many available executions are saturated (all included). */
  rareThreshold?: number;
  /** Axes to derive, in greedy priority order. Default: outcome, mode, turns, confidence. */
  axes?: StrataAxis[];
  /** Human-guided tags per execution group. Tags are never inferred. */
  tags?: Record<string, string[]>;
  /** Tag values whose entire stratum is always saturated (high-consequence cases). */
  highConsequenceTags?: string[];
  now?: Date;
}

export interface PoolExclusion {
  reason:
    | "source_excluded"
    | "missing_execution_group"
    | "lineage_ambiguous"
    | "lineage_unlinked"
    | "missing_task"
    | "duplicate_execution_group";
  count: number;
}

export interface StratumReport {
  axis: StrataAxis;
  value: string;
  available: number;
  target: number;
  selected: number;
  rule: "saturated_rare" | "saturated_high_consequence" | "saturated" | "sampled" | "uncovered";
}

export interface StrataPlan {
  schema_version: typeof COHORT_STRATA_PLAN_SCHEMA_VERSION;
  created_at: string;
  seed: string;
  inputs: {
    execution_index: string;
    execution_index_sha256: string;
    tasks: string | null;
  };
  config: {
    axes: StrataAxis[];
    target_per_stratum: number;
    rare_threshold: number;
    high_consequence_tags: string[];
  };
  pool: {
    index_rows: number;
    eligible: number;
    excluded: PoolExclusion[];
  };
  strata: StratumReport[];
  selection: Array<{
    execution_group: string;
    task_id: string;
    strata: string[];
    frozen: boolean;
  }>;
  coverage: {
    uncovered_strata: Array<{ axis: StrataAxis; value: string }>;
    underfilled_strata: Array<{ axis: StrataAxis; value: string; available: number; target: number }>;
  };
  /**
   * Phase-1 readiness signal: false when any underfilled high-consequence or
   * rare stratum remains, so later gates can block a whole-workload-ready
   * status on machine-readable evidence.
   */
  ready: boolean;
  blocking: string[];
  expansion_of: string | null;
  stability: {
    status: "not_applicable" | "stable" | "unstable";
    tolerance: number;
    moved: Array<{ axis: StrataAxis; value: string; before: number; after: number }>;
  };
  privacy: {
    local_only: true;
    payload_fields_read: false;
    upload_performed: false;
  };
}

export const CohortStrataPlanSchema = z
  .object({
    schema_version: z.literal(COHORT_STRATA_PLAN_SCHEMA_VERSION),
    created_at: z.string().datetime(),
    seed: z.string().min(1),
    inputs: z.object({
      execution_index: z.string().min(1),
      execution_index_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      tasks: z.string().min(1).nullable(),
    }),
    config: z.object({
      axes: z.array(z.enum(STRATA_AXES)).min(1),
      target_per_stratum: z.number().int().positive(),
      rare_threshold: z.number().int().nonnegative(),
      high_consequence_tags: z.array(z.string()),
    }),
    pool: z.object({
      index_rows: z.number().int().nonnegative(),
      eligible: z.number().int().nonnegative(),
      excluded: z.array(
        z.object({
          reason: z.enum([
            "source_excluded",
            "missing_execution_group",
            "lineage_ambiguous",
            "lineage_unlinked",
            "missing_task",
            "duplicate_execution_group",
          ]),
          count: z.number().int().nonnegative(),
        }),
      ),
    }),
    strata: z.array(
      z.object({
        axis: z.enum(STRATA_AXES),
        value: z.string().min(1),
        available: z.number().int().nonnegative(),
        target: z.number().int().positive(),
        selected: z.number().int().nonnegative(),
        rule: z.enum([
          "saturated_rare",
          "saturated_high_consequence",
          "saturated",
          "sampled",
          "uncovered",
        ]),
      }),
    ),
    selection: z.array(
      z.object({
        execution_group: z.string().min(1),
        task_id: z.string().min(1),
        strata: z.array(z.string().min(1)),
        frozen: z.boolean(),
      }),
    ),
    coverage: z.object({
      uncovered_strata: z.array(z.object({ axis: z.enum(STRATA_AXES), value: z.string().min(1) })),
      underfilled_strata: z.array(
        z.object({
          axis: z.enum(STRATA_AXES),
          value: z.string().min(1),
          available: z.number().int().nonnegative(),
          target: z.number().int().positive(),
        }),
      ),
    }),
    ready: z.boolean(),
    blocking: z.array(z.string()),
    expansion_of: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    stability: z.object({
      status: z.enum(["not_applicable", "stable", "unstable"]),
      tolerance: z.number().nonnegative(),
      moved: z.array(
        z.object({
          axis: z.enum(STRATA_AXES),
          value: z.string().min(1),
          before: z.number(),
          after: z.number(),
        }),
      ),
    }),
    privacy: z.object({
      local_only: z.literal(true),
      payload_fields_read: z.literal(false),
      upload_performed: z.literal(false),
    }),
  })
  .strict();

interface EligibleExecution {
  execution_group: string;
  task_id: string;
  lineage_status: "complete";
  capture_count: number;
  tool_surface: string[];
  machine_confidence: "high" | "medium" | "low" | null;
  tags: string[];
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function readJsonlRows(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

/**
 * Parse the materialized trace artifacts into an eligible pool plus
 * exclusion accounting. Metadata-only by construction.
 */
export function buildEligiblePool(
  executionIndexPath: string,
  tasksPath: string | null,
  tags: Record<string, string[]>,
): { eligible: EligibleExecution[]; excluded: PoolExclusion[]; indexRowCount: number } {
  const indexRows = readJsonlRows(executionIndexPath).map((row, index) => {
    const parsed = ExecutionIndexRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Invalid execution-index row ${index + 1} in ${executionIndexPath}.`);
    }
    return parsed.data;
  });

  const tasksByGroup = new Map<string, z.infer<typeof TaskRowSchema>>();
  if (tasksPath !== null) {
    for (const [index, raw] of readJsonlRows(tasksPath).entries()) {
      const parsed = TaskRowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid tasks row ${index + 1} in ${tasksPath}.`);
      }
      tasksByGroup.set(parsed.data.execution_group, parsed.data);
    }
  }

  const excludedCounts = new Map<PoolExclusion["reason"], number>();
  const bump = (reason: PoolExclusion["reason"]) => excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);

  const seen = new Set<string>();
  const eligible: EligibleExecution[] = [];
  for (const row of indexRows) {
    if (row.source_status === "excluded") {
      bump("source_excluded");
      continue;
    }
    if (!row.execution_group) {
      bump("missing_execution_group");
      continue;
    }
    if (row.lineage_status === "ambiguous") {
      bump("lineage_ambiguous");
      continue;
    }
    if (row.lineage_status === "unlinked" || row.lineage_status === null) {
      bump("lineage_unlinked");
      continue;
    }
    if (!row.task_id) {
      bump("missing_task");
      continue;
    }
    if (seen.has(row.execution_group)) {
      bump("duplicate_execution_group");
      continue;
    }
    seen.add(row.execution_group);
    const task = tasksByGroup.get(row.execution_group) ?? null;
    eligible.push({
      execution_group: row.execution_group,
      task_id: row.task_id,
      lineage_status: "complete",
      capture_count: row.capture_count,
      tool_surface: task?.tool_surface ?? [],
      machine_confidence: task?.machine_confidence ?? null,
      tags: [...(tags[row.execution_group] ?? [])].sort(),
    });
  }

  const excluded: PoolExclusion[] = [...excludedCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => left.reason.localeCompare(right.reason));
  return { eligible, excluded, indexRowCount: indexRows.length };
}

function turnsBucket(captureCount: number): string {
  if (captureCount <= 1) return "single";
  if (captureCount <= 5) return "short";
  return "long";
}

function modeBucket(toolSurface: string[]): string {
  if (toolSurface.length === 0) return "no-tools";
  return toolSurface.some((name) => isMutatingTool(name)) ? "write" : "read-only";
}

/**
 * Derive every stratum label for one execution. Labels are `{axis}:{value}`
 * strings; an execution can belong to several strata (one per axis, plus one
 * per user-supplied tag).
 */
export function deriveStrata(execution: EligibleExecution, axes: StrataAxis[]): string[] {
  const labels = new Set<string>();
  for (const axis of axes) {
    switch (axis) {
      case "outcome":
        labels.add(`outcome:${execution.lineage_status}`);
        break;
      case "mode":
        labels.add(`mode:${modeBucket(execution.tool_surface)}`);
        break;
      case "turns":
        labels.add(`turns:${turnsBucket(execution.capture_count)}`);
        break;
      case "confidence":
        labels.add(`confidence:${execution.machine_confidence ?? "unknown"}`);
        break;
      case "tag":
        for (const tag of execution.tags) labels.add(`tag:${tag}`);
        break;
    }
  }
  return [...labels].sort();
}

function selectionPriority(seed: string, executionGroup: string): string {
  return sha256(`${seed}|${executionGroup}`);
}

interface StratumMembers {
  label: string;
  axis: StrataAxis;
  value: string;
  members: EligibleExecution[];
  rare: boolean;
  highConsequence: boolean;
}

function buildStrata(
  eligible: EligibleExecution[],
  axes: StrataAxis[],
  rareThreshold: number,
  highConsequenceTags: string[],
): StratumMembers[] {
  const byLabel = new Map<string, EligibleExecution[]>();
  for (const execution of eligible) {
    for (const label of deriveStrata(execution, axes)) {
      byLabel.set(label, [...(byLabel.get(label) ?? []), execution]);
    }
  }
  const highConsequence = new Set(highConsequenceTags);
  return [...byLabel.entries()]
    .map(([label, members]) => {
      const [axis, ...rest] = label.split(":");
      const value = rest.join(":");
      return {
        label,
        axis: axis as StrataAxis,
        value,
        members,
        rare: members.length <= rareThreshold,
        highConsequence: axis === "tag" && highConsequence.has(value),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Deterministic stratified selection.
 *
 * Pilot sizes are minimums, never caps: every stratum that is rare (at or
 * below `rareThreshold` available executions) or tagged high-consequence is
 * saturated — all of its members are selected. Remaining strata are filled in
 * axis priority order with a seeded, stable ordering until the per-stratum
 * target is met, counting members already selected for an earlier stratum.
 *
 * When `frozenGroups` is provided (incremental expansion), every surviving
 * frozen execution stays selected and is never displaced; the new batch only
 * adds. Frozen-split boundaries are therefore unchanged by expansion.
 */
export function planStratifiedCohort(options: {
  eligible: EligibleExecution[];
  axes: StrataAxis[];
  seed: string;
  targetPerStratum: number;
  rareThreshold: number;
  highConsequenceTags: string[];
  frozenGroups?: Set<string>;
}): { selected: EligibleExecution[]; reports: StratumReport[] } {
  const { eligible, axes, seed, targetPerStratum, rareThreshold, highConsequenceTags } = options;
  const frozenGroups = options.frozenGroups ?? new Set<string>();
  const strata = buildStrata(eligible, axes, rareThreshold, highConsequenceTags);

  const selected = new Map<string, EligibleExecution>();
  const eligibleByGroup = new Map(eligible.map((execution) => [execution.execution_group, execution]));

  // 1. Frozen members always survive expansion.
  for (const group of [...frozenGroups].sort()) {
    const execution = eligibleByGroup.get(group);
    if (execution) selected.set(group, execution);
  }

  // 2. Saturate rare and high-consequence strata (minimums, never caps).
  for (const stratum of strata) {
    if (!stratum.rare && !stratum.highConsequence) continue;
    for (const member of stratum.members) selected.set(member.execution_group, member);
  }

  // 3. Greedily fill per-stratum targets in axis priority order.
  for (const axis of axes) {
    for (const stratum of strata.filter((candidate) => candidate.axis === axis)) {
      const have = stratum.members.filter((member) => selected.has(member.execution_group)).length;
      if (have >= targetPerStratum) continue;
      const candidates = stratum.members
        .filter((member) => !selected.has(member.execution_group))
        .sort((left, right) => selectionPriority(seed, left.execution_group).localeCompare(selectionPriority(seed, right.execution_group)) || left.execution_group.localeCompare(right.execution_group));
      for (const candidate of candidates.slice(0, targetPerStratum - have)) {
        selected.set(candidate.execution_group, candidate);
      }
    }
  }

  const reports: StratumReport[] = strata.map((stratum) => {
    const selectedCount = stratum.members.filter((member) => selected.has(member.execution_group)).length;
    let rule: StratumReport["rule"];
    if (stratum.members.length === 0) rule = "uncovered";
    else if (stratum.highConsequence) rule = "saturated_high_consequence";
    else if (stratum.rare && selectedCount === stratum.members.length) rule = "saturated_rare";
    else if (selectedCount === stratum.members.length && stratum.members.length < targetPerStratum) rule = "saturated";
    else rule = "sampled";
    return {
      axis: stratum.axis,
      value: stratum.value,
      available: stratum.members.length,
      target: targetPerStratum,
      selected: selectedCount,
      rule,
    };
  });

  const ordered = [...selected.values()].sort((left, right) =>
    selectionPriority(seed, left.execution_group).localeCompare(selectionPriority(seed, right.execution_group)) ||
    left.execution_group.localeCompare(right.execution_group),
  );
  return { selected: ordered, reports };
}

function prevalenceShare(available: number, eligible: number): number {
  if (eligible === 0) return 0;
  return available / eligible;
}

/** SHA-256 identity of a frozen plan, used as `expansion_of` binding. */
export function planIdentity(plan: StrataPlan): string {
  const frozenView = {
    schema_version: plan.schema_version,
    seed: plan.seed,
    inputs: plan.inputs,
    config: plan.config,
    selection: plan.selection.map((entry) => entry.execution_group).sort(),
  };
  return sha256(JSON.stringify(frozenView));
}

/**
 * Build the full plan artifact. Pass `priorPlan` to expand a frozen plan
 * incrementally: prior selections survive untouched and stability is reported
 * against the declared tolerance.
 */
export function buildStrataPlan(options: {
  executionIndexPath: string;
  tasksPath?: string | null;
  planOptions?: StrataPlanOptions;
  priorPlan?: StrataPlan | null;
  tolerance?: number;
}): StrataPlan {
  const { executionIndexPath, priorPlan = null } = options;
  const planOptions = options.planOptions ?? {};
  const seed = planOptions.seed ?? DEFAULT_STRATA_SEED;
  const targetPerStratum = planOptions.targetPerStratum ?? 2;
  const rareThreshold = planOptions.rareThreshold ?? 3;
  const axes = planOptions.axes ?? ["outcome", "mode", "turns", "confidence"];
  const tags = planOptions.tags ?? {};
  const highConsequenceTags = planOptions.highConsequenceTags ?? [];
  const tolerance = options.tolerance ?? 0.1;
  const now = planOptions.now ?? new Date();

  if (priorPlan !== null) {
    if (priorPlan.seed !== seed) {
      throw new Error("Cannot expand a cohort plan with a different seed; frozen selections would be re-ordered.");
    }
    const priorAxes = priorPlan.config.axes.join(",");
    if (priorAxes !== axes.join(",")) {
      throw new Error("Cannot expand a cohort plan with different axes; create a new plan instead.");
    }
  }

  const indexText = readFileSync(executionIndexPath, "utf8");
  const tasksPath = options.tasksPath ?? null;
  const pool = buildEligiblePool(executionIndexPath, tasksPath, tags);

  const frozenGroups = new Set<string>();
  if (priorPlan !== null) {
    for (const entry of priorPlan.selection) frozenGroups.add(entry.execution_group);
  }

  const { selected, reports } = planStratifiedCohort({
    eligible: pool.eligible,
    axes,
    seed,
    targetPerStratum: Math.max(targetPerStratum, priorPlan?.config.target_per_stratum ?? 0),
    rareThreshold,
    highConsequenceTags,
    frozenGroups,
  });

  const selection = selected.map((execution) => ({
    execution_group: execution.execution_group,
    task_id: execution.task_id,
    strata: deriveStrata(execution, axes),
    frozen: frozenGroups.has(execution.execution_group),
  }));

  const uncovered = reports.filter((report) => report.available === 0);
  // Underfilled = decision target not met. For saturated strata this means
  // scarcity (every available execution is already included); for others it
  // cannot happen under greedy selection, so it always reads as a real gap.
  const underfilled = reports.filter((report) => report.selected < report.target);
  // Blocking evidence: important underfilled strata. A stratum is important
  // when it is rare (at or below the rare threshold) or tagged
  // high-consequence — exactly the cases the adaptive loop cannot afford to
  // under-sample.
  const isImportant = (report: StratumReport) =>
    report.available <= rareThreshold ||
    (report.axis === "tag" && highConsequenceTags.includes(report.value));
  const blocking: string[] = underfilled
    .filter(isImportant)
    .map((report) => {
      const kind = report.axis === "tag" && highConsequenceTags.includes(report.value)
        ? "High-consequence"
        : "Rare";
      return `${kind} stratum ${report.axis}:${report.value} has ${report.available} available executions, target ${report.target}.`;
    });

  let stability: StrataPlan["stability"] = { status: "not_applicable", tolerance, moved: [] };
  if (priorPlan !== null) {
    // Stability tracks whether the new batch shifted the eligible pool's
    // composition: per-stratum prevalence (available / eligible) before vs
    // after. A stratum that grows, shrinks, or appears past the declared
    // tolerance is machine-readable evidence that the material moved.
    const priorEligible = priorPlan.pool.eligible;
    const currentEligible = pool.eligible.length;
    const priorPrevalence = new Map<string, number>();
    for (const report of priorPlan.strata) {
      priorPrevalence.set(`${report.axis}:${report.value}`, prevalenceShare(report.available, priorEligible));
    }
    const currentByLabel = new Map<string, StratumReport>();
    for (const report of reports) currentByLabel.set(`${report.axis}:${report.value}`, report);
    const labels = new Set<string>([...priorPrevalence.keys(), ...currentByLabel.keys()]);
    const moved: StrataPlan["stability"]["moved"] = [];
    for (const label of [...labels].sort()) {
      const before = priorPrevalence.get(label) ?? 0;
      const afterReport = currentByLabel.get(label);
      const after = afterReport === undefined ? 0 : prevalenceShare(afterReport.available, currentEligible);
      if (Math.abs(after - before) > tolerance) {
        const [axis, ...rest] = label.split(":");
        moved.push({ axis: axis as StrataAxis, value: rest.join(":"), before, after });
      }
    }
    stability = { status: moved.length === 0 ? "stable" : "unstable", tolerance, moved };
  }

  return {
    schema_version: COHORT_STRATA_PLAN_SCHEMA_VERSION,
    created_at: now.toISOString(),
    seed,
    inputs: {
      execution_index: executionIndexPath,
      execution_index_sha256: sha256(indexText),
      tasks: tasksPath,
    },
    config: { axes, target_per_stratum: targetPerStratum, rare_threshold: rareThreshold, high_consequence_tags: highConsequenceTags },
    pool: { index_rows: pool.indexRowCount, eligible: pool.eligible.length, excluded: pool.excluded },
    strata: reports,
    selection,
    coverage: {
      uncovered_strata: uncovered.map((report) => ({ axis: report.axis, value: report.value })),
      underfilled_strata: underfilled.map((report) => ({ axis: report.axis, value: report.value, available: report.available, target: report.target })),
    },
    ready: blocking.length === 0 && uncovered.length === 0,
    blocking,
    expansion_of: priorPlan !== null ? planIdentity(priorPlan) : null,
    stability,
    privacy: { local_only: true, payload_fields_read: false, upload_performed: false },
  };
}
