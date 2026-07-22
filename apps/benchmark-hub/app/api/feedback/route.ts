import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { getEntry, submitTaskFeedback } from "../../../lib/data-core";

export const dynamic = "force-dynamic";

/**
 * POST { slug, task_id, feedback } →
 * (a) appends one understudy.task_feedback.v1 line to feedback.jsonl next to
 *     the foundry manifest (append-only sidecar; shared writer in
 *     dist/benchmark-hub-core.js), and
 * (b) returns a copyable, pre-filled agent handoff prompt referencing
 *     `understudy traces regenerate-env`.
 *
 * The hub NEVER executes the edit itself — no model calls, no subprocesses
 * (architectural boundary). The user's coding agent, the benchmarks MCP
 * surface, or a future daemon verb consumes the recorded feedback unchanged.
 */
export async function POST(request: Request) {
  let body: { slug?: string; task_id?: string; feedback?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = body.slug ? getEntry(body.slug) : null;
  const result = submitTaskFeedback(entry, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, feedback: result.feedback, handoff: result.handoff });
}
