import type { SourceDag, SourceDagEdge, SourceDagNode } from "@/lib/types";

/**
 * Vertical source-lineage rail: rounds ordered by captured_at with typed
 * edges (retry | prefix_append | branch | destructive_mutation), edge
 * confidence, and the common-prefix evidence behind the classification.
 * This ports the foundry orchard viewer's information design into the hub's
 * component/token system (see .u-lineage in globals.css).
 */
export function LineageRail({
  dag,
  nodeIds,
}: {
  dag: SourceDag;
  /** When set, only these nodes render (task-scoped lineage strip). */
  nodeIds?: string[];
}) {
  const scope = nodeIds ? new Set(nodeIds) : null;
  const nodes = dag.nodes.filter((n) => !scope || scope.has(n.id));
  const groups = new Map<string, SourceDagNode[]>();
  for (const n of nodes) groups.set(n.execution_group, [...(groups.get(n.execution_group) ?? []), n]);
  const edgeTo = new Map<string, SourceDagEdge>(dag.edges.map((e) => [e.to, e]));

  return (
    <div>
      {[...groups.entries()].map(([groupId, groupNodes]) => {
        const ordered = [...groupNodes].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
        return (
          <div key={groupId}>
            {!scope && (
              <p className="u-lgroup">
                execution group {groupId.slice(0, 12)} · {ordered.length} round{ordered.length === 1 ? "" : "s"}
              </p>
            )}
            <div className="u-lineage">
              {ordered.map((n, i) => {
                const edge = edgeTo.get(n.id);
                return (
                  <div key={n.id} className="u-lnode">
                    <div className="card">
                      <span className="u-ledge">
                        {edge
                          ? `${edge.type} · ${edge.confidence} · common prefix ${edge.evidence?.common_prefix_messages ?? 0} msg`
                          : "root boundary"}
                      </span>
                      <div className="mono flex flex-wrap items-baseline gap-x-3 text-xs">
                        <span className="text-ink-muted">round {String(i + 1).padStart(2, "0")}</span>
                        <span className="font-semibold text-ink-bright">{n.id}</span>
                        <span className="text-ink-muted">{n.message_count} messages</span>
                        <span className="text-faint">{n.captured_at}</span>
                        {n.has_error && <span className="text-bad">error status</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
