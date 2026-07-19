import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, loadTraceRecords } from "@/lib/data";
import { extractBranches, normalizeTraceRecord, type TraceNode } from "@/lib/benchmark-core";
import { formatScore } from "@/lib/scores";
import { FlagBadge, StatusBadge, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";

export const dynamic = "force-dynamic";

type RawRecord = Record<string, unknown>;

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
    <div className="flex flex-col gap-8">
      <div>
        <Link href={`/b/${entry.slug}`} className="text-xs text-ink-muted hover:text-ink">
          ← {entry.manifest.name ?? entry.manifest.benchmark_id}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold">{task.task_id}</h1>
          <Badge className="text-ink-muted">{task.category_id}</Badge>
          <Badge className="text-ink-muted">{task.genesis}</Badge>
          <Badge className="text-ink-muted">split: {task.split}</Badge>
          <FlagBadge count={openFlags.length} />
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {openFlags.map((f, i) => (
            <div key={i} className="rounded-md border border-bad/30 bg-bad/10 px-3 py-1.5 text-xs">
              <span className="font-mono text-bad">{f.reason}</span> — {f.note}{" "}
              <span className="text-ink-muted">{f.created_at}</span>
            </div>
          ))}
          <FlagForm slug={entry.slug} taskId={task.task_id} readOnly={entry.readOnly} />
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Manifest entry</h2>
        <pre className="overflow-x-auto rounded-lg border border-rule bg-card p-4 font-mono text-xs text-ink-muted">
          {JSON.stringify(task, null, 2)}
        </pre>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Eval rows ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded-md border border-rule bg-card p-4 text-sm text-ink-muted">
            No eval rows yet for this task. Run the benchmark and drop rows-*.jsonl next to benchmark.json.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-rule">
            <table className="w-full border-collapse bg-card text-sm">
              <thead className="border-b border-rule font-mono text-[11px] text-ink-muted">
                <tr>
                  {["run_id", "model", "route", "status", "score", "subscores", "trace leaf"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-rule last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.run_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.model ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.route ?? "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{formatScore(r.score)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                      {r.subscores ? JSON.stringify(r.subscores) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                      {r.trace_ref?.branch_leaf ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Trace branches</h2>
        {branchesByFile.length === 0 ? (
          <div className="rounded-md border border-rule bg-card p-4 text-sm text-ink-muted">
            No trace DAG evidence for this task. When a run retains{" "}
            <code className="font-mono">traces.jsonl</code> beside the manifest, each root-to-leaf branch renders
            here.
          </div>
        ) : (
          branchesByFile.map(({ file, branches, recordsById }) => (
            <div key={file} className="mb-4">
              <p className="mb-2 font-mono text-xs text-ink-muted">{file}</p>
              <div className="flex flex-col gap-3">
                {branches.map((b, i) => (
                  <div key={i} className="rounded-lg border border-rule bg-card p-3">
                    <div className="mb-2 flex items-center gap-3 font-mono text-xs text-ink-muted">
                      <span>branch {i + 1}</span>
                      <span>depth {b.path.length}</span>
                      <span className="font-semibold text-ink">reward {b.reward ?? "—"}</span>
                      {Object.entries(b.metrics).map(([k, v]) => (
                        <span key={k}>{k}={v}</span>
                      ))}
                    </div>
                    <ol className="flex flex-col gap-1.5">
                      {b.path.map((nodeId, depth) => {
                        const record = recordsById.get(nodeId);
                        const role = typeof record?.role === "string" ? record.role : null;
                        const content = typeof record?.content === "string" ? record.content : null;
                        return (
                          <li key={nodeId} className="flex gap-2 text-xs" style={{ marginLeft: depth * 12 }}>
                            <span className="shrink-0 font-mono text-ink-muted">{nodeId}</span>
                            {role && <Badge className="shrink-0 text-ink-muted">{role}</Badge>}
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
