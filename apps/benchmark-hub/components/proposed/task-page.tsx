import Link from "next/link";
import { notFound } from "next/navigation";
import { taskDisplayName, type FoundryContractItem, type ProposedHubEntry } from "@/lib/types";
import { taskProvenance } from "@/lib/data";
import { Badge, ConfidenceChip, DecisionBadge, SplitChip, StageBadge } from "@/components/badges";
import { TrajectoryExplorer } from "@/components/trajectory/explorer";
import { AuthoredPanel } from "@/components/trajectory/authored-panel";

function RequiredEffects({ items }: { items: FoundryContractItem[] }) {
  if (items.length === 0) return <p className="mono mt-2 text-xs text-faint">no required effects proposed</p>;
  return (
    <ul className="mt-2 flex list-none flex-col gap-2 p-0">
      {items.map((item, i) => (
        <li key={i}>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.tool && <Badge className="text-ink-bright">{item.tool}</Badge>}
            <ConfidenceChip level={item.confidence} />
          </div>
          {item.observed_arguments != null && (
            <details className="mt-1">
              <summary className="mono cursor-pointer text-[10px] text-faint">observed arguments</summary>
              <pre className="u-pre mt-1" style={{ maxHeight: 160 }}>{JSON.stringify(item.observed_arguments, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Trajectory-first inspector for a PROPOSED (trace-foundry) task.
 * Level 1: one flattened Conversation History with a trimmed rail — the
 * authored success rubric leads, then Required effects + the outcome
 * contract; one compact provenance disclosure closes the rail. Source
 * lineage lives at the benchmark level only.
 * Level 2: "how this became a task" — authored confirm-card + review actions.
 */
export function ProposedTaskPage({ entry, taskId }: { entry: ProposedHubEntry; taskId: string }) {
  const task = entry.tasks.find((t) => t.task_id === taskId);
  if (!task) notFound();
  const review = entry.latestReviewByTask[task.task_id] ?? null;
  const displayName = taskDisplayName(task);
  const provenance = taskProvenance(entry, task);
  const criteria = task.authored?.success_criteria ?? [];

  const rail = (
    <>
      {/* PRIMARY: what success looks like — authored rubric when present,
          the deterministic contract when unauthored. */}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>What success looks like</h3>
        {criteria.length > 0 ? (
          <ul className="mt-2 flex list-none flex-col gap-2 p-0">
            {criteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mono shrink-0" style={{ color: "var(--ok)" }}>✓</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-muted">
            No authored rubric yet — the deterministic contract below is what success means:{" "}
            {(task.outcome_contract.required ?? []).map((r) => r.tool).filter(Boolean).join(", ") || "no required effects"}.
          </p>
        )}
      </div>

      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Outcome contract — required effects</h3>
        <p className="mono mt-1 text-[11px] text-ink-muted">
          grading: {task.outcome_contract.grading.replaceAll("_", " ")} — resulting state is judged, never an exact
          trajectory.
        </p>
        <RequiredEffects items={task.outcome_contract.required ?? []} />
      </div>

      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>World model — initial state</h3>
        <pre className="u-pre mt-2" style={{ maxHeight: 180 }}>{JSON.stringify(task.world_model?.initial_state ?? {}, null, 2)}</pre>
        {(task.world_model?.transitions ?? []).length > 0 && (
          <details className="mt-2">
            <summary className="mono cursor-pointer text-[10px] text-faint">
              {(task.world_model?.transitions ?? []).length} state transitions
            </summary>
            <pre className="u-pre mt-1" style={{ maxHeight: 180 }}>{JSON.stringify(task.world_model?.transitions, null, 2)}</pre>
          </details>
        )}
      </div>
      {task.claims.length > 0 && (
        <div className="u-card" style={{ padding: "12px 14px" }}>
          <h3>Machine claims ({task.claims.length})</h3>
          <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
            {task.claims.map((c, i) => (
              <li key={i} className="text-xs">
                <Badge className={c.kind === "observed" ? "text-ok border-ok/50" : "text-warn border-warn/40"}>{c.kind}</Badge>{" "}
                {c.claim}
              </li>
            ))}
          </ul>
        </div>
      )}
      {task.tool_surface.length > 0 && (
        <div className="u-card" style={{ padding: "12px 14px" }}>
          <h3>Tool surface</h3>
          <p className="mono mt-1 text-[11px] text-ink-muted">{task.tool_surface.join(" · ")}</p>
        </div>
      )}

      {/* ONE compact provenance line for the task, collapsed behind a disclosure. */}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <details>
          <summary className="mono cursor-pointer text-[11px] text-ink-muted">
            provenance — {provenance.captureCount} capture{provenance.captureCount === 1 ? "" : "s"}
            {provenance.workloads.length > 0 ? ` · ${provenance.workloads.join(", ")}` : ""}
          </summary>
          <div className="mono mt-2 flex flex-col gap-0.5 text-[11px] text-ink-muted" style={{ overflowWrap: "anywhere" }}>
            {provenance.workloads.length > 0 && <span>workload: {provenance.workloads.join(", ")}</span>}
            {provenance.traceIds.map((id) => (
              <span key={id}>trace: {id}</span>
            ))}
            <span>execution group: {task.execution_group}</span>
          </div>
        </details>
      </div>
    </>
  );

  return (
    <div className="u-page">
      <section className="u-head">
        <p className="u-eyebrow" style={{ marginBottom: 10 }}>
          <Link href={`/b/${entry.slug}`}>← {entry.dir.split("/").pop()}</Link>
        </p>
        {/* Authored intent_summary wins as the display name; the raw machine
            title is demoted behind the disclosure in the authored panel. */}
        <h1 style={{ fontSize: "clamp(18px,2.6vw,28px)", overflowWrap: "anywhere" }}>{displayName}</h1>
        <p className="mono u-desc text-xs" style={{ overflowWrap: "anywhere" }}>{task.task_id}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StageBadge stage="proposed" />
          <SplitChip split={task.split} />
          <ConfidenceChip level={task.machine_confidence} />
          {task.close_call && <Badge className="border-warn/40 text-warn">close call</Badge>}
          <Badge>{task.status}</Badge>
          <DecisionBadge decision={review?.decision ?? null} />
        </div>
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">01</span>
          <h2>Trajectory</h2>
        </div>
        <p className="u-sec-sub">
          The captured conversation this task was assembled from, flattened to one history — success criteria and the
          outcome contract on the rail.
        </p>
        <div className="mt-4">
          <TrajectoryExplorer slug={entry.slug} taskId={task.task_id} mode="proposed" rail={rail} />
        </div>
      </section>

      <AuthoredPanel slug={entry.slug} task={task} review={review} readOnly={entry.readOnly} />
    </div>
  );
}
