import Link from "next/link";
import { notFound } from "next/navigation";
import type { FoundryContractItem, ProposedHubEntry } from "@/lib/types";
import { Badge, ConfidenceChip, DecisionBadge, SplitChip, StageBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { CaptureViewer } from "@/components/proposed/capture-viewer";
import { LineageRail } from "@/components/proposed/lineage";
import { ReviewBar } from "@/components/proposed/review-bar";

function ContractList({ title, items, emptyLabel }: { title: string; items: FoundryContractItem[]; emptyLabel: string }) {
  return (
    <div className="u-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="mono mt-2 text-xs text-faint">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 flex list-none flex-col gap-2.5 p-0">
          {items.map((item, i) => (
            <li key={i} className="u-msg">
              <div className="flex flex-wrap items-center gap-2">
                {item.tool && <Badge className="text-ink-bright">{item.tool}</Badge>}
                {item.type && <Badge>{item.type}</Badge>}
                {item.matching && <Badge>{item.matching.replaceAll("_", " ")}</Badge>}
                <ConfidenceChip level={item.confidence} />
              </div>
              {item.observed_arguments != null && (
                <pre className="u-pre mt-2" style={{ maxHeight: 180 }}>
                  {JSON.stringify(item.observed_arguments, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProposedTaskPage({ entry, taskId }: { entry: ProposedHubEntry; taskId: string }) {
  const task = entry.tasks.find((t) => t.task_id === taskId);
  if (!task) notFound();
  const review = entry.latestReviewByTask[task.task_id] ?? null;
  const nodeIds = task.source?.node_ids ?? [];
  const nodesById = new Map((entry.dag?.nodes ?? []).map((n) => [n.id, n]));
  const rounds = nodeIds
    .map((id) => ({ id, at: nodesById.get(id)?.captured_at ?? "" }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((n) => ({ capture_id: n.id, label: n.id }));

  return (
    <div className="u-page">
      <section className="u-head">
        <p className="u-eyebrow" style={{ marginBottom: 10 }}>
          <Link href={`/b/${entry.slug}`}>← {entry.dir.split("/").pop()}</Link>
        </p>
        {/* Long mono task ids wrap; chips live on their own line below. */}
        <h1 className="mono" style={{ fontSize: "clamp(18px,2.6vw,28px)", overflowWrap: "anywhere" }}>
          {task.task_id}
        </h1>
        {task.title && <p className="u-desc">{task.title}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StageBadge stage="proposed" />
          <SplitChip split={task.split} />
          <ConfidenceChip level={task.machine_confidence} />
          {task.close_call && <Badge className="border-warn/40 text-warn">close call</Badge>}
          <Badge>{task.status}</Badge>
          <DecisionBadge decision={review?.decision ?? null} />
        </div>
        {task.tool_surface.length > 0 && (
          <p className="mono mt-2 text-xs text-ink-muted">tool surface: {task.tool_surface.join(" · ")}</p>
        )}
        <div className="mt-4">
          <ReviewBar
            slug={entry.slug}
            taskId={task.task_id}
            current={review?.decision ?? null}
            readOnly={entry.readOnly}
          />
          {review?.note && (
            <p className="mono mt-2 text-xs text-ink-muted">
              latest note ({review.created_at.slice(0, 10)}): {review.note}
            </p>
          )}
        </div>
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">01</span>
          <h2>Outcome contract</h2>
        </div>
        <p className="u-sec-sub">
          Grading is <span className="mono">{task.outcome_contract.grading.replaceAll("_", " ")}</span>: the
          resulting state is judged, never an exact historical trajectory.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ContractList title="Required" items={task.outcome_contract.required ?? []} emptyLabel="no required effects proposed" />
          <ContractList title="Preserved" items={task.outcome_contract.preserved ?? []} emptyLabel="nothing must be preserved" />
          <ContractList title="Forbidden" items={task.outcome_contract.forbidden ?? []} emptyLabel="nothing is forbidden" />
        </div>
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">02</span>
          <h2>World model</h2>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="u-card">
            <h3>Initial state</h3>
            <pre className="u-pre mt-2" style={{ maxHeight: 220 }}>
              {JSON.stringify(task.world_model?.initial_state ?? {}, null, 2)}
            </pre>
          </div>
          <ContractList title="Transitions" items={task.world_model?.transitions ?? []} emptyLabel="no state transitions proposed" />
        </div>
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">03</span>
          <h2>Machine claims</h2>
        </div>
        {task.claims.length === 0 ? (
          <EmptyState what="The foundry recorded no claims for this task." />
        ) : (
          <ul className="mt-4 flex list-none flex-col gap-2 p-0">
            {task.claims.map((c, i) => (
              <li key={i} className="u-msg flex flex-wrap items-center gap-2">
                <Badge className={c.kind === "observed" ? "text-ok border-ok/50" : "text-warn border-warn/40"}>
                  {c.kind}
                </Badge>
                <span className="text-sm">{c.claim}</span>
                <ConfidenceChip level={c.confidence} />
                {c.source_call_id && <span className="mono text-[10px] text-faint">call {c.source_call_id}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">04</span>
          <h2>Source lineage</h2>
        </div>
        <p className="u-sec-sub">The captured rounds this task was assembled from, in capture order.</p>
        {entry.dag ? (
          <div className="mt-3">
            <LineageRail dag={entry.dag} nodeIds={nodeIds} />
          </div>
        ) : (
          <EmptyState what="No source DAG accompanies this output — the lineage strip cannot render." />
        )}
      </section>

      <section className="u-section" style={{ borderBottom: "none" }}>
        <div className="u-sec-head">
          <span className="u-sec-no">05</span>
          <h2>Captures</h2>
        </div>
        <p className="u-sec-sub">
          The underlying evidence — parsed request/response per round, with the preserved raw payloads one toggle
          away. Bodies load lazily from the local store.
        </p>
        <div className="mt-4">
          {rounds.length === 0 ? (
            <EmptyState what="This task references no captures." />
          ) : (
            <CaptureViewer slug={entry.slug} rounds={rounds} />
          )}
        </div>
      </section>
    </div>
  );
}
