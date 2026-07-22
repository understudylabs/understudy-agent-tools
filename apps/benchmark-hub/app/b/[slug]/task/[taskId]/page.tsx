import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, loadTaskSidecars, loadTraceRecords } from "@/lib/data";
import { extractBranches, normalizeTraceRecord, type TraceNode } from "@/lib/benchmark-core";
import { formatScore } from "@/lib/scores";
import { FlagBadge, SplitChip, StatusBadge, Badge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { FlagForm } from "@/components/flag-form";
import { ProposedTaskPage } from "@/components/proposed/task-page";

export const dynamic = "force-dynamic";

type RawRecord = Record<string, unknown>;

/** Render cap: only the first N trace branches render (plus a count). */
const BRANCH_RENDER_CAP = 20;

function SectionHead({ n, title }: { n: string; title: string }) {
  return (
    <div className="u-sec-head">
      <span className="u-sec-no">{n}</span>
      <h2>{title}</h2>
    </div>
  );
}

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

  const rows = entry.rows.filter((r) => r.task_id === taskId);
  const openFlags = entry.flags.filter((f) => f.status === "open" && f.task_id === taskId);
  const sidecar = loadTaskSidecars(entry)[taskId] ?? null;
  const sidecarExtras = sidecar
    ? Object.entries(sidecar).filter(([k]) => !["task_id", "question", "gold"].includes(k))
    : [];

  // Trace drill-down: branches for this task from every traces*.jsonl file.
  const traceFiles = loadTraceRecords(entry);
  const branchesByFile: {
    file: string;
    branches: { path: string[]; reward: number | null; metrics: Record<string, number> }[];
    recordsById: Map<string, RawRecord>;
  }[] = [];
  for (const [file, records] of Object.entries(traceFiles)) {
    const nodes = records.map(normalizeTraceRecord).filter((n): n is TraceNode => n !== null);
    const recordsById = new Map<string, RawRecord>();
    for (const record of records) {
      const node = normalizeTraceRecord(record);
      if (node) recordsById.set(node.id, record as RawRecord);
    }
    const branches = extractBranches(nodes).filter((b) => b.taskId === taskId);
    if (branches.length > 0) branchesByFile.push({ file, branches, recordsById });
  }

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
          {task.gold ? <Badge>gold: {task.gold.kind}</Badge> : <Badge className="border-warn/40 text-warn">no gold (unscored)</Badge>}
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

      <section className="u-section">
        <SectionHead n="01" title="Task content" />
        {!sidecar ? (
          <>
            <p className="u-sec-sub">
              No tasks*.jsonl sidecar carries content for this task — only the manifest entry below is available.
            </p>
            <pre className="u-pre mt-4" style={{ maxHeight: 300 }}>{JSON.stringify(task, null, 2)}</pre>
          </>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {sidecar.question != null && (
              <div className="u-card">
                <h3>Question</h3>
                <SidecarValue value={sidecar.question} />
              </div>
            )}
            {sidecar.gold != null && (
              <div className="u-card">
                <h3>Gold contract</h3>
                <SidecarValue value={sidecar.gold} />
              </div>
            )}
            {sidecarExtras.map(([key, value]) => (
              <div key={key} className="u-card">
                <h3>{key}</h3>
                <SidecarValue value={value} />
              </div>
            ))}
            <div className="u-card md:col-span-2">
              <h3>Manifest entry</h3>
              <pre className="u-pre mt-2" style={{ maxHeight: 240 }}>{JSON.stringify(task, null, 2)}</pre>
            </div>
          </div>
        )}
      </section>

      <section className="u-section">
        <SectionHead n="02" title={`Eval rows (${rows.length})`} />
        {rows.length === 0 ? (
          <EmptyState
            what="No eval rows yet for this task — nothing has run against it."
            next="drop understudy.eval_result.v1 lines into rows-*.jsonl (or rows/*.jsonl) next to benchmark.json"
          />
        ) : (
          <div className="u-tbl-scroll mt-4">
            <table className="u-tbl w-full">
              <thead>
                <tr>
                  {["run_id", "model", "route", "status", "score", "subscores", "trace leaf"].map((h) => (
                    <th key={h} className="l" style={{ cursor: "default" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="l mono text-xs">{r.run_id}</td>
                    <td className="l mono text-xs">{r.model ?? "—"}</td>
                    <td className="l mono text-xs">{r.route ?? "—"}</td>
                    <td className="l">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="l mono text-xs font-bold">{formatScore(r.score)}</td>
                    <td className="l" style={{ whiteSpace: "normal" }}>
                      {r.subscores ? (
                        <span className="flex flex-wrap gap-1">
                          {Object.entries(r.subscores).map(([k, v]) => (
                            <Badge key={k}>
                              {k} {v == null ? "—" : formatScore(v)}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="l mono text-xs text-ink-muted">{r.trace_ref?.branch_leaf ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="u-section" style={{ borderBottom: "none" }}>
        <SectionHead n="03" title="Trace branches" />
        {branchesByFile.length === 0 ? (
          <EmptyState
            what="No trace DAG evidence for this task — no run retained its message tree."
            next="keep traces.jsonl beside benchmark.json; each root-to-leaf branch renders here"
          />
        ) : (
          branchesByFile.map(({ file, branches, recordsById }) => (
            <div key={file} className="mt-4 mb-4">
              <p className="u-foot-note !mt-0 mb-2">
                {"// " +
                  file +
                  (branches.length > BRANCH_RENDER_CAP
                    ? ` — showing first ${BRANCH_RENDER_CAP} of ${branches.length} branches`
                    : "")}
              </p>
              <div className="flex flex-col gap-3">
                {branches.slice(0, BRANCH_RENDER_CAP).map((b, i) => (
                  <div key={i} className="u-card">
                    <div className="mono mb-2 flex items-center gap-3 text-xs text-ink-muted">
                      <span>branch {i + 1}</span>
                      <span>depth {b.path.length}</span>
                      <span className="font-semibold text-ink">reward {b.reward ?? "—"}</span>
                      {Object.entries(b.metrics).map(([k, v]) => (
                        <span key={k}>
                          {k}={v}
                        </span>
                      ))}
                    </div>
                    <ol className="flex flex-col gap-1.5">
                      {b.path.map((nodeId, depth) => {
                        const record = recordsById.get(nodeId);
                        const role = typeof record?.role === "string" ? record.role : null;
                        const content = typeof record?.content === "string" ? record.content : null;
                        return (
                          <li key={nodeId} className="flex gap-2 text-xs" style={{ marginLeft: depth * 12 }}>
                            <span className="mono shrink-0 text-ink-muted">{nodeId}</span>
                            {role && <Badge className="shrink-0">{role}</Badge>}
                            <span className="text-ink">{content ?? ""}</span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
