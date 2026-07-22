import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, loadTaskSidecars } from "@/lib/data";
import { trivialPassesForTask } from "@/lib/scores";
import { FlagBadge, SplitChip, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";
import { ProposedTaskPage } from "@/components/proposed/task-page";
import { TaskViews } from "@/components/trajectory/task-views";

export const dynamic = "force-dynamic";

/** Sidecar values render as prose when short strings, JSON blocks otherwise. */
function SidecarValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(value);
    } catch {
      /* plain prose */
    }
    if (parsed && typeof parsed === "object") {
      return <pre className="u-pre mt-2" style={{ maxHeight: 240 }}>{JSON.stringify(parsed, null, 2)}</pre>;
    }
    return <p className="mt-2 text-sm">{value}</p>;
  }
  return <pre className="u-pre mt-2" style={{ maxHeight: 240 }}>{JSON.stringify(value, null, 2)}</pre>;
}

/**
 * Task inspector. Proposed tasks render the foundry trajectory explorer;
 * promoted tasks render the same three-pane explorer over eval rows joined to
 * their trace branches (via /api/rollouts), with verifier + gold on the rail.
 */
export default async function TaskInspector({
  params,
}: {
  params: Promise<{ slug: string; taskId: string }>;
}) {
  const { slug, taskId: rawTaskId } = await params;
  const taskId = decodeURIComponent(rawTaskId);
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") notFound();
  if (entry.kind === "proposed") return <ProposedTaskPage entry={entry} taskId={taskId} />;
  const task = entry.manifest.tasks.find((t) => t.task_id === taskId);
  if (!task) notFound();

  const openFlags = entry.flags.filter((f) => f.status === "open" && f.task_id === taskId);
  const sidecar = loadTaskSidecars(entry)[taskId] ?? null;
  const sidecarExtras = sidecar
    ? Object.entries(sidecar).filter(([k]) => !["task_id", "question", "gold"].includes(k))
    : [];
  const verifier = entry.manifest.verifier;

  const rail = (
    <>
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Verifier</h3>
        <div className="mono mt-2 flex flex-col gap-0.5 text-[11px] text-ink-muted">
          <span>kind: {verifier.kind}</span>
          <span>strict metric: {verifier.strict_metric}</span>
          {verifier.dense_metric && <span>dense metric: {verifier.dense_metric}</span>}
          {verifier.replayable != null && <span>replayable: {String(verifier.replayable)}</span>}
        </div>
        <div className="mt-2">
          {task.gold ? (
            <Badge>gold: {task.gold.kind}</Badge>
          ) : (
            <Badge className="border-warn/40 text-warn">no gold (unscored)</Badge>
          )}
        </div>
      </div>
      {sidecar?.question != null && (
        <div className="u-card" style={{ padding: "12px 14px" }}>
          <h3>Question</h3>
          <SidecarValue value={sidecar.question} />
        </div>
      )}
      {sidecar?.gold != null && (
        <div className="u-card" style={{ padding: "12px 14px" }}>
          <h3>Gold contract / assertions</h3>
          <SidecarValue value={sidecar.gold} />
        </div>
      )}
      {sidecarExtras.map(([key, value]) => (
        <div key={key} className="u-card" style={{ padding: "12px 14px" }}>
          <h3>{key}</h3>
          <details>
            <summary className="mono cursor-pointer text-[10px] text-faint">show</summary>
            <SidecarValue value={value} />
          </details>
        </div>
      ))}
      <div className="u-card" style={{ padding: "12px 14px" }}>
        <h3>Manifest entry</h3>
        <details>
          <summary className="mono cursor-pointer text-[10px] text-faint">show</summary>
          <pre className="u-pre mt-2" style={{ maxHeight: 240 }}>{JSON.stringify(task, null, 2)}</pre>
        </details>
      </div>
    </>
  );

  return (
    <div>
      <section className="u-hero" style={{ paddingTop: 34 }}>
        <p className="u-eyebrow">
          <Link href={`/b/${entry.slug}`}>← {entry.manifest.name ?? entry.manifest.benchmark_id}</Link>
        </p>
        {/* Long mono task ids wrap; chips live on their own line below. */}
        <h1 className="mono" style={{ fontSize: "clamp(18px,2.6vw,28px)", overflowWrap: "anywhere" }}>
          {task.task_id}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{task.category_id}</Badge>
          <Badge>{task.genesis}</Badge>
          <SplitChip split={task.split} />
          {task.incumbent?.model && <Badge className="border-warn/40 text-warn">incumbent: {task.incumbent.model}</Badge>}
          {entry.calibration?.failed_task_ids.includes(task.task_id) && (
            <Badge className="border-bad/40 text-bad">incumbent failed on rerun · suspect</Badge>
          )}
          {/* A trivial calibration arm passing this task means its contract
              is satisfiable with no real work — same suspect idiom. */}
          {trivialPassesForTask(entry.calibration, task.task_id).map((f) => (
            <Badge key={f.armKind} className="border-bad/40 text-bad">
              {f.label} passes this task · suspect
            </Badge>
          ))}
          <FlagBadge count={openFlags.length} />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {openFlags.map((f, i) => (
            <div key={i} className="u-warn text-xs" style={{ borderColor: "var(--bad-border)", background: "var(--bad-bg)", color: "var(--bad)" }}>
              <span className="mono">{f.reason}</span> — {f.note}{" "}
              <span className="mono text-faint">{f.created_at}</span>
            </div>
          ))}
          <FlagForm slug={entry.slug} taskId={task.task_id} readOnly={entry.readOnly} />
        </div>
      </section>

      <section className="u-section" style={{ borderBottom: "none" }}>
        <div className="u-sec-head">
          <span className="u-sec-no">01</span>
          <h2>Trajectories</h2>
        </div>
        <div className="mt-4">
          <TaskViews slug={entry.slug} taskId={task.task_id} mode="promoted" rail={rail} />
        </div>
      </section>
    </div>
  );
}
