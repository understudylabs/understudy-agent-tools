import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the captures/flags routes.
import { captureBodyPath, getEntry, loadTaskSidecars } from "../../../lib/data-core";
// Same event extraction the authoring pass grounds against (compiled foundry,
// re-exported through replay-core).
import { accumulateReplay, finalResponseText, observedCalls, type ReplayCall } from "../../../lib/replay-core";
import type { CaptureRef, EvalRow } from "../../../lib/types";

export const dynamic = "force-dynamic";

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Oracle spine = the LAST capture round with a body (fullest history). */
function oracleCalls(dir: string, refs: CaptureRef[]): { calls: ReplayCall[]; finalResponse: string; spineMissing: boolean } {
  const bodies: { capturedAt: string; body: Obj }[] = [];
  for (const ref of refs) {
    try {
      const body = JSON.parse(fs.readFileSync(captureBodyPath(dir, ref), "utf8")) as Obj;
      bodies.push({ capturedAt: typeof body.captured_at === "string" ? body.captured_at : "", body });
    } catch {
      // pointer-only round
    }
  }
  bodies.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const spine = bodies.at(-1)?.body ?? null;
  return {
    calls: spine ? (observedCalls([spine]) as ReplayCall[]) : [],
    // The captured final assistant response closes the event stream: value
    // propagations and response obligations flip met/unmet on it.
    finalResponse: spine ? (finalResponseText((spine.response ?? {}) as Obj) as string) : "",
    spineMissing: spine === null,
  };
}

/**
 * Per-arm accumulation replays from eval rows: executor rows carry the arm's
 * mutating calls as a `writes` extension field, so each arm replays through
 * the SAME deterministic contract accumulation as the oracle. One arm per
 * (model, run_id); latest rollout with writes wins for the replay, all
 * rollouts feed the mean.
 */
function armReplays(task: Obj, rows: EvalRow[]): Obj[] {
  const byArm = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const key = `${row.model ?? "(unknown model)"} · ${row.run_id}`;
    byArm.set(key, [...(byArm.get(key) ?? []), row]);
  }
  const arms: Obj[] = [];
  for (const [key, armRows] of byArm) {
    const withWrites = armRows.filter((r) => Array.isArray((r as Obj).writes));
    const latest = (withWrites.length > 0 ? withWrites : armRows).at(-1)!;
    const calls: ReplayCall[] = (Array.isArray((latest as Obj).writes) ? ((latest as Obj).writes as Obj[]) : []).map((w) => ({
      name: String(w.tool ?? ""),
      arguments: w.arguments ?? {},
    }));
    const scored = armRows.filter((r) => r.status === "ok" && typeof r.score === "number");
    arms.push({
      key,
      model: latest.model ?? "(unknown model)",
      run_id: latest.run_id,
      created_at: latest.created_at ?? null,
      rollouts: armRows.length,
      mean_score: scored.length > 0 ? scored.reduce((a, r) => a + (r.score as number), 0) / scored.length : null,
      subscores: latest.subscores ?? null,
      status: latest.status,
      has_writes: withWrites.length > 0,
      ...accumulateReplay(task, calls),
    });
  }
  return arms.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/**
 * GET /api/replay?slug=<hub slug>&task=<task_id> →
 * the deterministic score-accumulation replay of the ORACLE trajectory (the
 * captured conversation), plus — for PROMOTED benchmarks with eval rows —
 * one accumulation replay per model arm, selectable next to the oracle.
 * Everything here is computed offline from the contract + tool events — no
 * LLM anywhere.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const taskId = url.searchParams.get("task");
  if (!slug || !taskId) {
    return NextResponse.json({ error: "slug and task query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") {
    return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  }

  // The contract-bearing task: proposed entries carry it in memory; promoted
  // dirs retain the foundry tasks.jsonl as a sidecar.
  let task: Obj | null = null;
  let rows: EvalRow[] = [];
  let taskReview: string | null = null;
  if (entry.kind === "proposed") {
    task = (entry.tasks.find((t) => t.task_id === taskId) as unknown as Obj) ?? null;
    taskReview = entry.latestReviewByTask[taskId]?.decision ?? null;
    // Accepted proposed tasks are runnable, so their run rows render as arms.
    rows = entry.rows.filter((r) => r.task_id === taskId);
  } else {
    if (!entry.manifest.tasks.some((t) => t.task_id === taskId)) {
      return NextResponse.json({ error: "unknown task id" }, { status: 404 });
    }
    task = loadTaskSidecars(entry)[taskId] ?? null;
    rows = entry.rows.filter((r) => r.task_id === taskId);
  }
if (!task) return NextResponse.json({ error: "unknown task id (no contract sidecar)" }, { status: 404 });

  const refs = (asObject(task.source).captures ?? []) as CaptureRef[];
  const { calls, finalResponse, spineMissing } = oracleCalls(entry.dir, Array.isArray(refs) ? refs : []);
  const replay = accumulateReplay(task, calls, finalResponse);

  // "Try with a new model" bridge: the generated environment's readiness.
  const envDir = path.join(entry.dir, "environment");
  const envExists = fs.existsSync(envDir);
  let oraclePass: boolean | null = null;
  let sentinelPass: boolean | null = null;
  try {
    const validation = JSON.parse(fs.readFileSync(path.join(envDir, "offline-validation.json"), "utf8"));
    const row = (Array.isArray(validation?.tasks) ? validation.tasks : []).find((t: Obj) => t.task_id === taskId);
    if (row) {
      oraclePass = asObject(row.oracle).strict === 1;
      // Sentinels prove the scorer discriminates: doing nothing and writing
      // the wrong value must both fail strict.
      const sentinels = asObject(row.sentinels);
      sentinelPass = asObject(sentinels.noop).strict === 0 && asObject(sentinels.wrong_value).strict === 0;
    }
  } catch {
    // no offline validation — readiness stays null
  }

  // Reward-function weights for the rubric bars: the generated environment's
  // @vf.reward(weight=1.0) strict metric; the dense metric is a weightless
  // @vf.metric. (Rollout-lab convention: raw × weight = contribution.)
  const verifier = entry.kind === "ok" ? entry.manifest.verifier : null;
  const rewardFunctions = [
    { name: verifier?.strict_metric ?? "final_state", weight: 1.0 },
    ...(verifier?.dense_metric ? [{ name: verifier.dense_metric, weight: null }] : [{ name: "final_state_partial_credit", weight: null }]),
  ];

  return NextResponse.json({
    task_id: taskId,
    stage: entry.kind === "proposed" ? "proposed" : "promoted",
    // Per-task run gating inputs (proposed): latest review decision; the
    // readiness chips below carry the environment half of the gate.
    task_review: taskReview,
    label: "Oracle (captured trajectory) — expected result",
    spine_missing: spineMissing,
    ...replay,
    reward_functions: rewardFunctions,
    environment: {
      exists: envExists,
      oracle_pass: oraclePass,
      sentinel_pass: sentinelPass,
      cli: `understudy runs execute --benchmark ${entry.dir} --watch`,
    },
    // Model attempts accumulate as eval rows (promoted, or accepted proposed
    // tasks run pre-promotion); each arm replays here next to the oracle.
    arms: armReplays(task, rows),
  });
}
