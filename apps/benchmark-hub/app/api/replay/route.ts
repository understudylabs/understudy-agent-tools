import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the captures/flags routes.
import { captureFilePath, getEntry } from "../../../lib/data-core";
// Same event extraction the authoring pass grounds against (compiled foundry,
// re-exported through replay-core).
import { accumulateReplay, finalResponseText, observedCalls } from "../../../lib/replay-core";

export const dynamic = "force-dynamic";

type Obj = Record<string, unknown>;

/**
 * GET /api/replay?slug=<hub slug>&task=<task_id> →
 * the deterministic score-accumulation replay of the ORACLE trajectory (the
 * captured conversation) for a proposed task, plus the generated
 * environment's readiness for "try with a new model". Everything here is
 * computed offline from the contract + tool events — no LLM anywhere.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const taskId = url.searchParams.get("task");
  if (!slug || !taskId) {
    return NextResponse.json({ error: "slug and task query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind !== "proposed") {
    return NextResponse.json({ error: "unknown proposed benchmark" }, { status: 404 });
  }
  const task = entry.tasks.find((t) => t.task_id === taskId);
  if (!task) return NextResponse.json({ error: "unknown task id" }, { status: 404 });

  // Spine = the LAST capture round with a body (fullest history), the same
  // rule the flattened conversation uses.
  const bodies: { capturedAt: string; body: Obj }[] = [];
  for (const ref of task.source?.captures ?? []) {
    const file = captureFilePath(entry, ref.capture_id);
    if (!file) continue;
    try {
      const body = JSON.parse(fs.readFileSync(file, "utf8")) as Obj;
      bodies.push({ capturedAt: typeof body.captured_at === "string" ? body.captured_at : "", body });
    } catch {
      // pointer-only round
    }
  }
  bodies.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const spine = bodies.at(-1)?.body ?? null;
  const calls = spine
    ? (observedCalls([spine]) as { id?: string | null; name: string; arguments: unknown }[])
    : [];
  // The captured final assistant response closes the event stream: value
  // propagations and response obligations flip met/unmet on it.
  const finalResponse = spine ? (finalResponseText((spine.response ?? {}) as Obj) as string) : "";
  const replay = accumulateReplay(task as unknown as Obj, calls, finalResponse);

  // "Try with a new model" bridge: the generated environment's readiness.
  const envDir = path.join(entry.dir, "environment");
  const envExists = fs.existsSync(envDir);
  let oraclePass: boolean | null = null;
  let sentinelPass: boolean | null = null;
  try {
    const validation = JSON.parse(fs.readFileSync(path.join(envDir, "offline-validation.json"), "utf8"));
    const row = (Array.isArray(validation?.tasks) ? validation.tasks : []).find((t: Obj) => t.task_id === taskId);
    if (row) {
      oraclePass = row.oracle?.strict === 1;
      // Sentinels prove the scorer discriminates: doing nothing and writing
      // the wrong value must both fail strict.
      sentinelPass = row.sentinels?.noop?.strict === 0 && row.sentinels?.wrong_value?.strict === 0;
    }
  } catch {
    // no offline validation — readiness stays null
  }

  return NextResponse.json({
    task_id: taskId,
    label: "Oracle (captured trajectory) — expected result",
    spine_missing: spine === null,
    ...replay,
    environment: {
      exists: envExists,
      oracle_pass: oraclePass,
      sentinel_pass: sentinelPass,
      cli: `understudy traces run-replays --benchmark ${entry.dir} --model <model-id> --yes`,
    },
    // Model attempts land as eval rows after promotion; proposed outputs have none yet.
    arms: [],
  });
}
