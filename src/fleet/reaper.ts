// Deployment reaper: decide, without side effects, which deployments should be
// scaled to zero and which should be deleted.
//
// Safety model:
// - The planner is pure. Execution lives in the script and defaults to dry-run.
// - A deployment missing the owner/TTL signal is never killed. It is reported
//   as `review` so an arm that has not adopted the tagging convention yet — or
//   an active arm whose tags were dropped — cannot be taken down by automation.
// - An arm can hold a deployment past its TTL by refreshing the expiry tag; the
//   planner only ever reads what the tags say now.

import type { DeploymentRow } from "./deployments.js";

export type ReapAction = "keep" | "scale-to-zero" | "delete" | "review";

export interface ReapDecision {
  name: string;
  action: ReapAction;
  reason: string;
  owner: string | null;
  arm: string | null;
  usdPerHr: number;
  live: boolean;
  ageHours: number | null;
  expiresAt: string | null;
  overdueHours: number | null;
}

export interface ReapPolicy {
  /** Grace period after expiry before a live deployment is scaled to zero. */
  graceHours?: number;
  /** Hours a scaled-to-zero deployment may linger past expiry before deletion. */
  deleteAfterHours?: number | null;
  /** Arms whose deployments are never touched, matched on owner or arm tag. */
  protect?: string[];
}

export interface ReapPlan {
  generatedAt: string;
  policy: Required<Omit<ReapPolicy, "protect">> & { protect: string[] };
  decisions: ReapDecision[];
  savingsUsdPerHr: number;
  counts: Record<ReapAction, number>;
}

export const DEFAULT_GRACE_HOURS = 0.5;
export const DEFAULT_DELETE_AFTER_HOURS = 24;

function decide(row: DeploymentRow, now: number, policy: Required<Omit<ReapPolicy, "protect">> & { protect: string[] }): ReapDecision {
  const base = {
    name: row.name,
    owner: row.tags.owner,
    arm: row.tags.arm,
    usdPerHr: row.usdPerHr,
    live: row.live,
    ageHours: row.ageHours,
    expiresAt: row.expiresAt,
  };
  const protectedBy = policy.protect.find((entry) => entry === row.tags.owner || entry === row.tags.arm || entry === row.name);
  if (protectedBy) {
    return { ...base, action: "keep", reason: `protected (${protectedBy})`, overdueHours: null };
  }
  if (!row.tagged || !row.expiresAt) {
    const missing = [row.tags.owner ? null : "owner", row.expiresAt ? null : "ttl"].filter(Boolean).join("+");
    return {
      ...base,
      action: "review",
      reason: `missing ${missing} tag — not reaped automatically`,
      overdueHours: null,
    };
  }
  const overdueHours = (now - Date.parse(row.expiresAt)) / 3_600_000;
  if (overdueHours < policy.graceHours) {
    return { ...base, action: "keep", reason: "within TTL", overdueHours };
  }
  if (row.live) {
    return { ...base, action: "scale-to-zero", reason: `${overdueHours.toFixed(1)}h past TTL`, overdueHours };
  }
  if (policy.deleteAfterHours !== null && overdueHours >= policy.deleteAfterHours) {
    return {
      ...base,
      action: "delete",
      reason: `scaled to zero and ${overdueHours.toFixed(1)}h past TTL`,
      overdueHours,
    };
  }
  return { ...base, action: "keep", reason: "already scaled to zero", overdueHours };
}

export function planReap(input: { deployments: DeploymentRow[]; now?: number; policy?: ReapPolicy }): ReapPlan {
  const now = input.now ?? Date.now();
  const policy = {
    graceHours: input.policy?.graceHours ?? DEFAULT_GRACE_HOURS,
    deleteAfterHours: input.policy?.deleteAfterHours === undefined ? DEFAULT_DELETE_AFTER_HOURS : input.policy.deleteAfterHours,
    protect: input.policy?.protect ?? [],
  };
  if (policy.graceHours < 0) throw new Error("graceHours must be >= 0");
  const decisions = input.deployments
    .map((row) => decide(row, now, policy))
    .sort((a, b) => b.usdPerHr - a.usdPerHr || a.name.localeCompare(b.name));
  const counts: Record<ReapAction, number> = { keep: 0, "scale-to-zero": 0, delete: 0, review: 0 };
  for (const decision of decisions) counts[decision.action] += 1;
  return {
    generatedAt: new Date(now).toISOString(),
    policy,
    decisions,
    savingsUsdPerHr: decisions
      .filter((decision) => decision.action === "scale-to-zero")
      .reduce((total, decision) => total + decision.usdPerHr, 0),
    counts,
  };
}

export function formatReapPlan(plan: ReapPlan, { apply }: { apply: boolean }): string {
  const lines: string[] = [];
  lines.push(`${apply ? "APPLY" : "DRY-RUN"}  grace=${plan.policy.graceHours}h delete-after=${plan.policy.deleteAfterHours ?? "never"}`);
  lines.push("ACTION         $/HR   OVERDUE_H  OWNER            NAME  — reason");
  for (const decision of plan.decisions) {
    lines.push(
      [
        decision.action.padEnd(13),
        decision.usdPerHr.toFixed(1).padStart(6),
        (decision.overdueHours === null ? "-" : decision.overdueHours.toFixed(1)).padStart(10),
        (decision.owner ?? "-").padEnd(16),
        decision.name,
        `— ${decision.reason}`,
      ].join(" "),
    );
  }
  lines.push("");
  lines.push(
    `keep: ${plan.counts.keep} | scale-to-zero: ${plan.counts["scale-to-zero"]} | delete: ${plan.counts.delete} | review: ${plan.counts.review} | reclaimable ~$${plan.savingsUsdPerHr.toFixed(0)}/hr`,
  );
  return lines.join("\n");
}
