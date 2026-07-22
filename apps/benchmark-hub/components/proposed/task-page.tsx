import Link from "next/link";
import { notFound } from "next/navigation";
import { taskDisplayName, type FoundryContractItem, type ProposedHubEntry } from "@/lib/types";
import { Badge, ConfidenceChip, DecisionBadge, SplitChip, StageBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { TrajectoryExplorer } from "@/components/trajectory/explorer";
import { AuthoredPanel } from "@/components/trajectory/authored-panel";
import { LineageRail } from "@/components/proposed/lineage";

function RailContract({ title, items, emptyLabel }: { title: string; items: FoundryContractItem[]; emptyLabel: string }) {
  return (
    <div className="u-card" style={{ padding: "12px 14px" }}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="mono mt-2 text-xs text-faint">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 flex list-none flex-col gap-2 p-0">
          {items.map((item, i) => (
            <li key={i}>
              <div className="flex flex-wrap items-center gap-1.5">
                {item.tool && <Badge className="text-ink-bright">{item.tool}</Badge>}
                {item.matching && <Badge>{item.matching.replaceAll("_", " ")}</Badge>}
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
      )}
    </div>
  );
}

/**
 * Trajectory-first inspector for a PROPOSED (trace-foundry) task.
 * Level 1: three-pane explorer over the task's capture rounds.
 * Level 2: "how this became a task" — authored confirm-card + review actions.
 * Level 3 lives on the benchmark page.
 */
export function ProposedTaskPage({ entry, taskId }: { entry: ProposedHubEntry; taskId: string }) {
  const task = entry.tasks.find((t) => t.task_id === taskId);
  if (!task) notFound();
  const review = entry.latestReviewByTask[task.task_id] ?? null;
  const displayName = taskDisplayName(task);

  const rail = (
    <>
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Outcome contract</h3>
        <p className="mono mt-1 text-[11px] text-ink-muted">
          grading: {task.outcome_contract.grading.replaceAll("_", " ")} — resulting state is judged, never an exact
          trajectory.
        </p>
      </div>
      <RailContract title="Required" items={task.outcome_contract.required ?? []} emptyLabel="no required effects proposed" />
      <RailContract title="Preserved" items={task.outcome_contract.preserved ?? []} emptyLabel="nothing must be preserved" />
      <RailContract title="Forbidden" items={task.outcome_contract.forbidden ?? []} emptyLabel="nothing is forbidden" />
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
          The captured rounds this task was assembled from — conversation history center, deterministic evidence on the
          rail. Bodies load lazily from the local store.
        </p>
        <div className="mt-4">
          <TrajectoryExplorer slug={entry.slug} taskId={task.task_id} mode="proposed" rail={rail} />
        </div>
      </section>

      <AuthoredPanel slug={entry.slug} task={task} review={review} readOnly={entry.readOnly} />

      <section className="u-section" style={{ borderBottom: "none" }}>
        <div className="u-sec-head">
          <span className="u-sec-no">03</span>
          <h2>Source lineage</h2>
        </div>
        <p className="u-sec-sub">The captured rounds this task was assembled from, in capture order.</p>
        {entry.dag ? (
          <div className="mt-3">
            <LineageRail dag={entry.dag} nodeIds={task.source?.node_ids ?? []} />
          </div>
        ) : (
          <EmptyState what="No source DAG accompanies this output — the lineage strip cannot render." />
        )}
      </section>
    </div>
  );
}
