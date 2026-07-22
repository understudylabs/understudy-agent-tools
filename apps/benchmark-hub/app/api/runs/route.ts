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
  if (entry.kind !== "ok") return NextResponse.json({ runs: [] });
  return NextResponse.json({ runs: listRunRequests(entry.dir) });
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
  if (entry.kind === "proposed") {
    return NextResponse.json(
      { error: "runs apply to PROMOTED benchmarks; promote this proposal first (understudy traces promote)" },
      { status: 400 },
    );
  }
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

  const knownTaskIds = entry.manifest.tasks.map((t) => t.task_id);
  const input = {
    benchmark_id: entry.manifest.benchmark_id,
    models: body.models,
    split: body.split,
    tasks: body.tasks ?? "all",
    rollouts_per_task: body.rollouts_per_task ?? 1,
  };
  const errors = validateRunRequestInput(input, knownTaskIds);
  if (errors.length > 0) return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  // Reject selections that resolve to zero tasks up front (clear 400, not a
  // queued request the executor immediately fails).
  const selected = selectTasks(entry.manifest as unknown as Record<string, unknown>, {
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
