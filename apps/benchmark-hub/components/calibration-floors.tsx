import Link from "next/link";
import { calibrationFloors, formatFloor } from "@/lib/scores";
import type { CalibrationSummary } from "@/lib/types";
import { Badge } from "@/components/badges";

/**
 * Trivial-arm floors from the calibration sidecar (null_floor / spam_floor):
 * one mono line per arm that ran. A floor above the executor's 5% limit is a
 * red structural flag — the benchmark's contracts are satisfiable by doing
 * nothing (null agent) or by ritual tool calling (spam agent) — and the
 * offending passed tasks link straight to their task pages. Same footnote
 * idiom as the incumbent-calibration line it sits next to.
 */
export function CalibrationFloors({ calibration, slug }: { calibration: CalibrationSummary; slug: string }) {
  const floors = calibrationFloors(calibration);
  if (floors.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {floors.map((f) => (
        <p key={f.armKind} className="mono text-xs" style={{ color: f.exceeded ? "var(--bad)" : "var(--muted-foreground)" }}>
          {f.exceeded && <Badge className="border-bad/40 text-bad mr-2">floor exceeded</Badge>}
          {f.label} floor: {formatFloor(f.floor)}
          {f.exceeded
            ? ` — above the 5% trivial-floor limit; ${f.passedTaskIds.length} task${f.passedTaskIds.length === 1 ? "" : "s"} pass${f.passedTaskIds.length === 1 ? "es" : ""} with no real work: `
            : f.floor != null && f.passedTaskIds.length > 0
              ? ` — passes ${f.passedTaskIds.length} task${f.passedTaskIds.length === 1 ? "" : "s"}: `
              : f.floor == null
                ? " — the arm produced no rows"
                : " — passes no tasks"}
          {f.passedTaskIds.map((taskId, i) => (
            <span key={taskId}>
              {i > 0 && ", "}
              <Link href={`/b/${slug}/task/${encodeURIComponent(taskId)}`} style={{ textDecoration: "underline" }}>
                {taskId}
              </Link>
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
