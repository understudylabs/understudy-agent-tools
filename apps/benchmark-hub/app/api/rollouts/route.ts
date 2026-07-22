import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the captures/flags routes.
import { getEntry, loadTraceRecords } from "../../../lib/data-core";
import { extractBranches, normalizeTraceRecord, type TraceNode } from "../../../lib/benchmark-core";
import { firstLine } from "../../../lib/trajectory-core";

export const dynamic = "force-dynamic";

/** Render caps: rollouts per task and turns per rollout. */
const ROLLOUT_CAP = 100;
const TURN_CAP = 400;

type RawRecord = Record<string, unknown>;

/**
 * GET /api/rollouts?slug=<hub slug>&task=<task_id> →
 * the task's rollouts for a PROMOTED benchmark: one entry per eval row,
 * joined (via trace_ref.branch_leaf) to its trace branch's turns; trace
 * branches without an eval row surface as unscored rollouts. Conversation
 * content is only served through here (lazy), never embedded in an RSC
 * payload. Proposed entries use /api/captures instead.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const task = url.searchParams.get("task");
  if (!slug || !task) {
    return NextResponse.json({ error: "slug and task query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind !== "ok") {
    return NextResponse.json({ error: "unknown promoted benchmark" }, { status: 404 });
  }
  if (!entry.manifest.tasks.some((t) => t.task_id === task)) {
    return NextResponse.json({ error: "unknown task id" }, { status: 404 });
  }

  // Branches for this task across every traces*.jsonl file, keyed by leaf id.
  const turnsByLeaf = new Map<string, { turns: { role: string | null; text: string }[]; depth: number; reward: number | null; metrics: Record<string, number> }>();
  for (const records of Object.values(loadTraceRecords(entry))) {
    const nodes = records.map(normalizeTraceRecord).filter((n): n is TraceNode => n !== null);
    const recordsById = new Map<string, RawRecord>();
    for (const record of records) {
      const node = normalizeTraceRecord(record);
      if (node && !recordsById.has(node.id)) recordsById.set(node.id, record as RawRecord);
    }
    for (const b of extractBranches(nodes).filter((b) => b.taskId === task)) {
      const leaf = b.path[b.path.length - 1];
      if (turnsByLeaf.has(leaf)) continue;
      const turns = b.path.slice(0, TURN_CAP).map((nodeId) => {
        const record = recordsById.get(nodeId);
        return {
          role: typeof record?.role === "string" ? record.role : null,
          text: typeof record?.content === "string" ? record.content : "",
        };
      });
      turnsByLeaf.set(leaf, { turns, depth: b.path.length, reward: b.reward, metrics: b.metrics });
    }
  }

  const rows = entry.rows.filter((r) => r.task_id === task);
  const usedLeaves = new Set<string>();
  const rollouts = rows.slice(0, ROLLOUT_CAP).map((r, i) => {
    const leaf = r.trace_ref?.branch_leaf ?? null;
    const branch = leaf ? turnsByLeaf.get(leaf) ?? null : null;
    if (leaf) usedLeaves.add(leaf);
    // System turns demote into a dedicated block; the rest are the turn stream.
    const systemTurn = branch?.turns.find((t) => t.role === "system") ?? null;
    const turns = (branch?.turns ?? []).filter((t) => t.role !== "system");
    return {
      id: `row-${i}`,
      run_id: r.run_id,
      model: r.model ?? null,
      route: r.route ?? null,
      status: r.status,
      score: typeof r.score === "number" ? r.score : null,
      subscores: r.subscores ?? null,
      latency_ms: r.latency_ms ?? null,
      trace_leaf: leaf,
      snippet: firstLine(turns.find((t) => t.role === "user")?.text ?? turns[0]?.text ?? "", 120),
      system: systemTurn?.text ?? null,
      turns,
      branch_depth: branch?.depth ?? null,
    };
  });

  // Trace branches with no joined eval row still count as rollouts (unscored).
  for (const [leaf, branch] of turnsByLeaf) {
    if (usedLeaves.has(leaf) || rollouts.length >= ROLLOUT_CAP) continue;
    const systemTurn = branch.turns.find((t) => t.role === "system") ?? null;
    const turns = branch.turns.filter((t) => t.role !== "system");
    rollouts.push({
      id: `branch-${leaf}`,
      run_id: "(trace only)",
      model: null,
      route: null,
      status: "unscored",
      score: branch.reward,
      subscores: Object.keys(branch.metrics).length > 0 ? branch.metrics : null,
      latency_ms: null,
      trace_leaf: leaf,
      snippet: firstLine(turns.find((t) => t.role === "user")?.text ?? turns[0]?.text ?? "", 120),
      system: systemTurn?.text ?? null,
      turns,
      branch_depth: branch.depth,
    });
  }

  return NextResponse.json({ task_id: task, rollouts, total_rows: rows.length });
}
