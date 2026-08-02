// Idempotent reap step, shaped for a durable workflow rather than a controller.
//
// The step holds no state of its own: it reads the control plane, derives the
// plan from the tags that exist right now, and returns artifacts plus small
// redacted events. Retrying it with the same (experimentId, candidateId,
// attempt) yields the same idempotency key, and every action it takes is
// convergent — scaling an already-zero deployment and deleting an already-gone
// deployment are both no-ops rather than a second effect.

import {
  type FleetEvent,
  type ReapPlanArtifact,
  type ScoreboardArtifact,
  canonicalJson,
  fleetEvent,
  sha256Hex,
  toReapPlanArtifact,
  toScoreboardArtifact,
} from "./artifacts.js";
import { type DeploymentRow, type RawDeployment, normalizeDeployments } from "./deployments.js";
import { type ReapPolicy, planReap } from "./reaper.js";
import { type ArmScore, buildScoreboard } from "./scoreboard.js";

export interface FleetControlPlane {
  listDeployments(): Promise<RawDeployment[]>;
  scaleToZero(name: string): Promise<void>;
  deleteDeployment(name: string): Promise<void>;
}

export interface FleetReapStepInput {
  controlPlane: FleetControlPlane;
  experimentId: string;
  attempt: number;
  candidateId?: string | null;
  account?: string | null;
  apply?: boolean;
  policy?: ReapPolicy;
  scores?: ArmScore[];
  now?: number;
  emit?: (event: FleetEvent) => void;
}

export interface FleetReapStepResult {
  idempotencyKey: string;
  mode: "dry-run" | "apply";
  scoreboard: ScoreboardArtifact;
  scoreboardSha256: string;
  plan: ReapPlanArtifact;
  planSha256: string;
  events: FleetEvent[];
}

/** Deterministic on (experimentId, candidateId, attempt) — a retry reuses it. */
export function fleetReapIdempotencyKey(input: {
  experimentId: string;
  candidateId?: string | null;
  attempt: number;
}): string {
  if (!input.experimentId.trim()) throw new Error("experimentId is required");
  if (!Number.isInteger(input.attempt) || input.attempt < 0) throw new Error("attempt must be a non-negative integer");
  return `fleet-reap:${input.experimentId}:${input.candidateId ?? "all"}:${input.attempt}`;
}

function isAlreadyAbsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

function scopeToCandidate(rows: DeploymentRow[], candidateId: string | null | undefined): DeploymentRow[] {
  if (!candidateId) return rows;
  return rows.filter((row) => row.tags.arm === candidateId || row.name === candidateId);
}

export async function runFleetReapStep(input: FleetReapStepInput): Promise<FleetReapStepResult> {
  const now = input.now ?? Date.now();
  const attempt = input.attempt;
  const candidateId = input.candidateId ?? null;
  const idempotencyKey = fleetReapIdempotencyKey({ experimentId: input.experimentId, candidateId, attempt });
  const mode = input.apply ? "apply" : "dry-run";
  const events: FleetEvent[] = [];
  const emit = (event: FleetEvent) => {
    events.push(event);
    input.emit?.(event);
  };
  const event = (kind: FleetEvent["kind"], fields: FleetEvent["fields"]) =>
    fleetEvent({ kind, experimentId: input.experimentId, candidateId, attempt, at: new Date(now).toISOString(), fields });

  const rows = scopeToCandidate(normalizeDeployments(await input.controlPlane.listDeployments(), now), candidateId);
  const scoreboard = toScoreboardArtifact({
    scoreboard: buildScoreboard({ deployments: rows, scores: input.scores, now }),
    experimentId: input.experimentId,
    account: input.account ?? null,
  });
  emit(
    event("usage", {
      est_burn_usd_per_hr: scoreboard.totals.estBurnUsdPerHr,
      untagged_burn_usd_per_hr: scoreboard.totals.untaggedBurnUsdPerHr,
      unscored_burn_usd_per_hr: scoreboard.totals.unscoredBurnUsdPerHr,
      live: scoreboard.totals.live,
    }),
  );
  emit(event("scoreboard", { rows: scoreboard.rows.length, sha256: sha256Hex(canonicalJson(scoreboard)) }));

  const reapPlan = planReap({ deployments: rows, now, policy: input.policy });
  emit(
    event("reap_plan", {
      mode,
      scale_to_zero: reapPlan.counts["scale-to-zero"],
      delete: reapPlan.counts.delete,
      review: reapPlan.counts.review,
      savings_usd_per_hr: reapPlan.savingsUsdPerHr,
    }),
  );

  const applied: ReapPlanArtifact["applied"] = [];
  if (input.apply) {
    for (const decision of reapPlan.decisions) {
      if (decision.action !== "scale-to-zero" && decision.action !== "delete") continue;
      let outcome: "applied" | "already-absent" = "applied";
      try {
        if (decision.action === "scale-to-zero") await input.controlPlane.scaleToZero(decision.name);
        else await input.controlPlane.deleteDeployment(decision.name);
      } catch (error) {
        if (!isAlreadyAbsent(error)) {
          emit(event("error", { deployment: decision.name, action: decision.action, message: "control plane call failed" }));
          throw error;
        }
        outcome = "already-absent";
      }
      applied.push({ name: decision.name, action: decision.action, outcome });
      emit(event("reap_action", { deployment: decision.name, action: decision.action, outcome, usd_per_hr: decision.usdPerHr }));
    }
  }

  const plan = toReapPlanArtifact({
    plan: reapPlan,
    experimentId: input.experimentId,
    candidateId,
    attempt,
    idempotencyKey,
    account: input.account ?? null,
    mode,
    applied,
  });

  return {
    idempotencyKey,
    mode,
    scoreboard,
    scoreboardSha256: sha256Hex(canonicalJson(scoreboard)),
    plan,
    planSha256: sha256Hex(canonicalJson(plan)),
    events,
  };
}
