import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, loadTraceRecords } from "@/lib/data";
import { extractBranches, normalizeTraceRecord, type TraceNode } from "@/lib/benchmark-core";
import { formatScore } from "@/lib/scores";
import { FlagBadge, StatusBadge, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";

export const dynamic = "force-dynamic";

type RawRecord = Record<string, unknown>;

function SectionHead({ n, title }: { n: string; title: string }) {
  return (
    <div className="lb-sec-head">
      <span className="lb-sec-no">{n}</span>
      <h2>{title}</h2>
    </div>
  );
}

export default async function TaskInspector({
  params,
}: {
  params: Promise<{ slug: string; taskId: string }>;
}) {
  const { slug, taskId: rawTaskId } = await params;
  const taskId = decodeURIComponent(rawTaskId);
  const entry = getEntry(slug);
  if (!entry) notFound();
  const task = entry.manifest.tasks.find((t) => t.task_id === taskId);
  if (!task) notFound();

  const rows = entry.rows.filter((r) => r.task_id === taskId);
  const openFlags = entry.flags.filter((f) => f.status === "open" && f.task_id === taskId);

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
      <section className="lb-hero" style={{ paddingTop: 34 }}>
        <p className="lb-eyebrow">
          <Link href={`/b/${entry.slug}`}>← {entry.manifest.name ?? entry.manifest.benchmark_id}</Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mono" style={{ fontSize: "clamp(22px,3vw,32px)" }}>
            {task.task_id}
          </h1>
          <Badge>{task.category_id}</Badge>
          <Badge>{task.genesis}</Badge>
          <Badge>split: {task.split}</Badge>
          <FlagBadge count={openFlags.length} />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {openFlags.map((f, i) => (
            <div key={i} className="lb-warn text-xs" style={{ borderColor: "var(--bad-border)", background: "var(--bad-bg)", color: "var(--bad)" }}>
              <span className="mono">{f.reason}</span> — {f.note}{" "}
              <span className="mono text-faint">{f.created_at}</span>
            </div>
          ))}
          <FlagForm slug={entry.slug} taskId={task.task_id} readOnly={entry.readOnly} />
        </div>
      </section>

      <section className="lb-section">
        <SectionHead n="01" title="Manifest entry" />
        <pre className="lb-card mono mt-4 overflow-x-auto text-xs text-ink-muted">{JSON.stringify(task, null, 2)}</pre>
      </section>

      <section className="lb-section">
        <SectionHead n="02" title={`Eval rows (${rows.length})`} />
        {rows.length === 0 ? (
          <div className="lb-state">
            No eval rows yet for this task. Run the benchmark and drop rows-*.jsonl next to benchmark.json.
          </div>
        ) : (
          <div className="lb-tbl-scroll mt-4">
            <table className="lb-tbl w-full">
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
                    <td className="l mono text-xs text-ink-muted">{r.subscores ? JSON.stringify(r.subscores) : "—"}</td>
                    <td className="l mono text-xs text-ink-muted">{r.trace_ref?.branch_leaf ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="lb-section" style={{ borderBottom: "none" }}>
        <SectionHead n="03" title="Trace branches" />
        {branchesByFile.length === 0 ? (
          <div className="lb-state">
            No trace DAG evidence for this task. When a run retains <code className="mono">traces.jsonl</code> beside
            the manifest, each root-to-leaf branch renders here.
          </div>
        ) : (
          branchesByFile.map(({ file, branches, recordsById }) => (
            <div key={file} className="mt-4 mb-4">
              <p className="lb-foot-note !mt-0 mb-2">{"// " + file}</p>
              <div className="flex flex-col gap-3">
                {branches.map((b, i) => (
                  <div key={i} className="lb-card">
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
