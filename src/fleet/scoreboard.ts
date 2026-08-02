// Arm scoreboard keyed on both axes that matter during a parallel sweep:
// the verifier score (is this arm working?) and the live burn in $/hr (what is
// it costing right now?). A score with no burn attached is cheap; burn with no
// score attached is the orphaned-deployment failure mode this module exists for.

import type { DeploymentRow } from "./deployments.js";

export interface ArmScore {
  /** Arm identifier; matched against the deployment's arm tag or its name. */
  arm: string;
  /** Verifier reward for the arm, higher is better. */
  score: number;
  split?: string;
  deployment?: string;
}

export interface ScoreboardRow {
  arm: string;
  score: number | null;
  split: string | null;
  deployment: string | null;
  baseModel: string | null;
  owner: string | null;
  usdPerHr: number;
  live: boolean;
  ageHours: number | null;
  expiresAt: string | null;
  tagged: boolean;
  /** Verifier score per dollar-hour; null when the arm is not burning. */
  scorePerUsdHr: number | null;
  flags: string[];
}

export interface Scoreboard {
  generatedAt: string;
  rows: ScoreboardRow[];
  totals: {
    arms: number;
    deployments: number;
    live: number;
    scaledToZero: number;
    estBurnUsdPerHr: number;
    untaggedBurnUsdPerHr: number;
    unscoredBurnUsdPerHr: number;
  };
}

function armKey(row: DeploymentRow): string {
  return row.tags.arm ?? row.name;
}

function rowFlags(deployment: DeploymentRow | null, score: number | null, now: number): string[] {
  const flags: string[] = [];
  if (!deployment) {
    flags.push("no-deployment");
    return flags;
  }
  if (deployment.live && score === null) flags.push("burn-without-score");
  if (deployment.live && !deployment.tagged) flags.push("untagged");
  if (deployment.expiresAt && Date.parse(deployment.expiresAt) <= now) flags.push("expired");
  if (!deployment.live) flags.push("scaled-to-zero");
  return flags;
}

/**
 * Join verifier scores onto costed deployments. Arms with no deployment and
 * deployments with no score both appear — the gaps are the point.
 */
export function buildScoreboard(input: {
  deployments: DeploymentRow[];
  scores?: ArmScore[];
  now?: number;
}): Scoreboard {
  const now = input.now ?? Date.now();
  const scores = input.scores ?? [];
  const byName = new Map(input.deployments.map((row) => [row.name, row]));
  const byArm = new Map(input.deployments.map((row) => [armKey(row), row]));
  const claimed = new Set<string>();
  const rows: ScoreboardRow[] = [];

  for (const entry of scores) {
    const deployment =
      (entry.deployment ? byName.get(entry.deployment) : undefined) ?? byArm.get(entry.arm) ?? byName.get(entry.arm) ?? null;
    if (deployment) claimed.add(deployment.name);
    rows.push(makeRow(entry.arm, entry.score, entry.split ?? null, deployment, now));
  }

  for (const deployment of input.deployments) {
    if (claimed.has(deployment.name)) continue;
    rows.push(makeRow(armKey(deployment), null, null, deployment, now));
  }

  rows.sort((a, b) => {
    if (a.score === null && b.score !== null) return 1;
    if (b.score === null && a.score !== null) return -1;
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
    return b.usdPerHr - a.usdPerHr;
  });

  const live = input.deployments.filter((row) => row.live);
  const scoredNames = new Set(rows.filter((row) => row.score !== null && row.deployment).map((row) => row.deployment));
  return {
    generatedAt: new Date(now).toISOString(),
    rows,
    totals: {
      arms: rows.length,
      deployments: input.deployments.length,
      live: live.length,
      scaledToZero: input.deployments.length - live.length,
      estBurnUsdPerHr: sum(live.map((row) => row.usdPerHr)),
      untaggedBurnUsdPerHr: sum(live.filter((row) => !row.tagged).map((row) => row.usdPerHr)),
      unscoredBurnUsdPerHr: sum(live.filter((row) => !scoredNames.has(row.name)).map((row) => row.usdPerHr)),
    },
  };
}

function makeRow(
  arm: string,
  score: number | null,
  split: string | null,
  deployment: DeploymentRow | null,
  now: number,
): ScoreboardRow {
  const usdPerHr = deployment?.usdPerHr ?? 0;
  return {
    arm,
    score,
    split,
    deployment: deployment?.name ?? null,
    baseModel: deployment?.baseModel ?? null,
    owner: deployment?.tags.owner ?? null,
    usdPerHr,
    live: deployment?.live ?? false,
    ageHours: deployment?.ageHours ?? null,
    expiresAt: deployment?.expiresAt ?? null,
    tagged: deployment?.tagged ?? false,
    scorePerUsdHr: score !== null && usdPerHr > 0 ? score / usdPerHr : null,
    flags: rowFlags(deployment, score, now),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function formatScoreboard(scoreboard: Scoreboard): string {
  const lines: string[] = [];
  lines.push("SCORE  $/HR   SCORE/$  STATE  AGE_H  OWNER            ARM  <- baseModel");
  for (const row of scoreboard.rows) {
    const state = row.deployment ? (row.live ? "LIVE " : "ZERO ") : "NONE ";
    lines.push(
      [
        (row.score === null ? "-" : row.score.toFixed(3)).padStart(5),
        row.usdPerHr.toFixed(1).padStart(6),
        (row.scorePerUsdHr === null ? "-" : row.scorePerUsdHr.toFixed(3)).padStart(8),
        state.padStart(6),
        (row.ageHours === null ? "-" : row.ageHours.toFixed(1)).padStart(6),
        (row.owner ?? "-").padEnd(16),
        row.arm,
        row.baseModel ? `<- ${row.baseModel}` : "",
        row.flags.length > 0 ? `[${row.flags.join(",")}]` : "",
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  const totals = scoreboard.totals;
  lines.push("");
  lines.push(
    `arms: ${totals.arms} | deployments: ${totals.deployments} | live: ${totals.live} | scaled-to-zero: ${totals.scaledToZero}`,
  );
  lines.push(
    `est burn ~$${totals.estBurnUsdPerHr.toFixed(0)}/hr | untagged ~$${totals.untaggedBurnUsdPerHr.toFixed(0)}/hr | unscored ~$${totals.unscoredBurnUsdPerHr.toFixed(0)}/hr`,
  );
  return lines.join("\n");
}
