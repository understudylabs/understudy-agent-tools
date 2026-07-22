import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the flags/reviews routes.
import { getEntry } from "../../../lib/data-core";
import {
  cancelRunRequest,
  createRunRequest,
  listRunRequests,
  selectTasks,
  validateRunRequestInput,
  type RunSplit,
} from "../../../lib/runs-core";

export const dynamic = "force-dynamic";

/**
 * The run queue API. The hub NEVER executes models: POST only writes an
 * understudy.run_request.v1 file into <benchmark-dir>/runs/queue/ (or flips
 * one to cancelled); `understudy runs execute --benchmark <dir> [--watch]`
 * is what picks requests up. GET re-reads the queue files for live status.
 *
 * Hardening mirrors /api/flags: slug resolves through getEntry (prefix →
 * one scan root, no rescans), read-only sources are rejected, only PROMOTED
 * benchmarks are runnable, and every field is validated before any write.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug query param is required" }, { status: 400 });
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  // Proposed entries list too: accepted tasks run pre-promotion.
  return NextResponse.json({ runs: listRunRequests(entry.dir) });
}

/**
 * Environment readiness for one task: the generated environment must exist
 * and the task's offline oracle validation must pass (the same signals the
 * Replay tab's readiness chips show).
 */
function environmentReadiness(dir: string, taskId: string): { ready: boolean; reason: string } {
  const envDir = path.join(dir, "environment");
  if (!fs.existsSync(envDir)) return { ready: false, reason: "no generated environment/ dir — rebuild the benchmark" };
  try {
    const validation = JSON.parse(fs.readFileSync(path.join(envDir, "offline-validation.json"), "utf8"));
    const row = (Array.isArray(validation?.tasks) ? validation.tasks : []).find(
      (t: { task_id?: string }) => t?.task_id === taskId,
    );
    if (!row) return { ready: false, reason: "task has no offline validation entry" };
    if (row.oracle?.strict !== 1) return { ready: false, reason: "oracle validation does not pass for this task" };
    return { ready: true, reason: "" };
  } catch {
    return { ready: false, reason: "offline-validation.json missing or unreadable" };
  }
}

/** The proposal-stamped benchmark.json's benchmark_id (rows must carry it). */
function readProposalBenchmarkId(dir: string): string | null {
  try {
    const proposal = JSON.parse(fs.readFileSync(path.join(dir, "benchmark.json"), "utf8"));
    return typeof proposal?.benchmark_id === "string" ? proposal.benchmark_id : null;
  } catch {
    return null;
  }
}

type PostBody = {
  slug?: string;
  action?: string;
  run_id?: string;
  models?: unknown;
  split?: unknown;
  tasks?: unknown;
  rollouts_per_task?: unknown;
};

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = body.slug ? getEntry(body.slug) : null;
  if (!entry || entry.kind === "invalid") return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  if (entry.readOnly) {
    return NextResponse.json(
      { error: "This entry is read-only (demo/fixture source); runs cannot be queued here." },
      { status: 403 },
    );
  }

  // Cancel = status flip on the request file; the executor honors it between rollouts.
  if (body.action === "cancel") {
    if (typeof body.run_id !== "string" || body.run_id.length === 0) {
      return NextResponse.json({ error: "run_id is required to cancel" }, { status: 400 });
    }
    const result = cancelRunRequest(entry.dir, body.run_id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, run: result.request });
  }
  if (body.action !== undefined && body.action !== "queue") {
    return NextResponse.json({ error: 'action must be "queue" (default) or "cancel"' }, { status: 400 });
  }

  // PROPOSED gating: benchmark-level runs stay promoted-only, but a SINGLE
  // accepted task with a validated environment is runnable pre-promotion
  // ("if a task is accepted, why can't I try it with a new model?").
  let benchmarkId: string;
  let knownTaskIds: string[];
  let manifestForSelection: Record<string, unknown>;
  if (entry.kind === "proposed") {
    const requested = body.tasks;
    if (!Array.isArray(requested) || requested.length !== 1 || typeof requested[0] !== "string") {
      return NextResponse.json(
        { error: "proposed benchmarks accept single-task runs only (tasks: [task_id]); promote the benchmark for full runs (understudy traces promote)" },
        { status: 400 },
      );
    }
    const taskId = requested[0];
    const task = entry.tasks.find((t) => t.task_id === taskId);
    if (!task) return NextResponse.json({ error: "unknown task_id" }, { status: 404 });
    const decision = entry.latestReviewByTask[taskId]?.decision ?? null;
    if (decision !== "accept") {
      return NextResponse.json(
        { error: decision === null ? "task not accepted yet (unreviewed)" : `task not accepted yet (latest review: ${decision})` },
        { status: 403 },
      );
    }
    const readiness = environmentReadiness(entry.dir, taskId);
    if (!readiness.ready) {
      return NextResponse.json({ error: `environment not ready: ${readiness.reason}` }, { status: 503 });
    }
    benchmarkId = readProposalBenchmarkId(entry.dir) ?? entry.slug;
    knownTaskIds = entry.tasks.map((t) => t.task_id);
    // Foundry splits (construction/fit/heldout) never match run splits, so a
    // proposed single-task selection always runs under split "all".
    if (body.split !== undefined && body.split !== "all") {
      return NextResponse.json({ error: 'proposed single-task runs must use split "all"' }, { status: 400 });
    }
    body.split = "all";
    manifestForSelection = { tasks: [{ task_id: taskId, split: "all" }] };
  } else {
    benchmarkId = entry.manifest.benchmark_id;
    knownTaskIds = entry.manifest.tasks.map((t) => t.task_id);
    manifestForSelection = entry.manifest as unknown as Record<string, unknown>;
  }

  const input = {
    benchmark_id: benchmarkId,
    models: body.models,
    split: body.split,
    tasks: body.tasks ?? "all",
    rollouts_per_task: body.rollouts_per_task ?? 1,
  };
  const errors = validateRunRequestInput(input, knownTaskIds);
  if (errors.length > 0) return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  // Reject selections that resolve to zero tasks up front (clear 400, not a
  // queued request the executor immediately fails).
  const selected = selectTasks(manifestForSelection, {
    split: input.split as RunSplit,
    tasks: input.tasks as "all" | string[],
  });
  if (selected.length === 0) {
    return NextResponse.json({ error: `no tasks match split=${String(input.split)}` }, { status: 400 });
  }

  const run = createRunRequest(entry.dir, {
    benchmark_id: input.benchmark_id,
    models: input.models as string[],
    split: input.split as RunSplit,
    tasks: input.tasks as "all" | string[],
    rollouts_per_task: input.rollouts_per_task as number,
  });
  return NextResponse.json({
    ok: true,
    run,
    execute_hint: `understudy runs execute --benchmark ${entry.dir} --watch`,
  });
}
