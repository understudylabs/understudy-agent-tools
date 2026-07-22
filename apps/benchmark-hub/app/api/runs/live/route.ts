import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the runs/flags routes.
import { getEntry, loadTaskSidecars } from "../../../../lib/data-core";
import { readRunRequest, runRequestPath } from "../../../../lib/runs-core";
import { accumulateReplay, type ReplayCall } from "../../../../lib/replay-core";
// Journal parsing (torn-tail rule, legacy string-arguments tolerance) is the
// CLI writer's own codec (dist/benchmark-artifacts.js) — never forked.
import { journalCalls, parseJournalText } from "../../../../lib/artifacts-core";

export const dynamic = "force-dynamic";

type Obj = Record<string, unknown>;
const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Cap the journal read; live journals are per-arm and small, but never trust a file size. */
const MAX_JOURNAL_LINES = 5_000;

/**
 * GET /api/runs/live?slug&run=<run_id>[&task=<task_id>][&since=N] →
 * live watch feed for a running arm: the journal lines the generated world
 * server appended so far (from line offset `since` for cheap polling) plus a
 * deterministic contract accumulation computed SERVER-SIDE from those events
 * with the same shared scorer as the Replay tab — tool-call-level streaming
 * (token streaming is deferred). Same slug hardening as /api/runs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const runId = url.searchParams.get("run");
  const taskParam = url.searchParams.get("task");
  const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
  if (!slug || !runId) return NextResponse.json({ error: "slug and run query params are required" }, { status: 400 });
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });

  const runFile = runRequestPath(entry.dir, runId);
  const run = fs.existsSync(runFile) ? readRunRequest(runFile) : null;
  if (!run) return NextResponse.json({ error: "unknown run_id" }, { status: 404 });

  // Journal: the request advertises the active arm's journal while running;
  // otherwise fall back to the newest journal for this run (post-run replay).
  let journal: string | null = null;
  const advertised = asObject(run.live as unknown).journal;
  if (typeof advertised === "string" && !advertised.includes("..")) {
    journal = path.join(entry.dir, advertised);
  } else {
    const liveDir = path.join(entry.dir, "runs", "live");
    try {
      const candidates = fs
        .readdirSync(liveDir)
        .filter((name) => name.startsWith(`${runId}-`) && name.endsWith(".jsonl"))
        .map((name) => path.join(liveDir, name))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
      journal = candidates.at(-1) ?? null;
    } catch {
      journal = null;
    }
  }

  // Shared parse: torn tail line mid-append is dropped uncounted — the next
  // poll gets it whole. `since` windows the returned lines for cheap polling.
  let allLines: Obj[] = [];
  let total = 0;
  if (journal && fs.existsSync(journal)) {
    const parsed = parseJournalText(fs.readFileSync(journal, "utf8"), MAX_JOURNAL_LINES);
    allLines = parsed.lines;
    total = parsed.total;
  }
  const lines: Obj[] = allLines.slice(since);

  // Deterministic live accumulation: journal call events against the task's
  // contract, through the SAME shared scorer as the Replay tab.
  const taskId = taskParam ?? (Array.isArray(run.tasks) && run.tasks.length === 1 ? run.tasks[0] : null) ?? asObject(run.live as unknown).task_id ?? null;
  let accumulation: Obj | null = null;
  if (typeof taskId === "string" && taskId) {
    let task: Obj | null = null;
    if (entry.kind === "proposed") task = (entry.tasks.find((t) => t.task_id === taskId) as unknown as Obj) ?? null;
    else task = loadTaskSidecars(entry)[taskId] ?? null;
    if (task) {
      // Full journal (not just the `since` window) so met-flips are stable.
      const calls: ReplayCall[] = journalCalls(allLines);
      accumulation = accumulateReplay(task, calls) as unknown as Obj;
    }
  }

  return NextResponse.json({
    run_id: runId,
    status: run.status,
    progress: run.progress,
    live: run.live ?? null,
    task_id: taskId,
    since,
    next: total,
    lines,
    accumulation,
  });
}
