"use client";

import type { Scope } from "../lib/nav";

// Stub: the real workload Configuration surface arrives with the admin/v1
// plumbing (separate workstream). The nav item is disabled until then; this
// pane only renders if a workload gets scoped via a deep link.
export function WorkloadConfigPane({ scope }: { scope: Scope }) {
  return (
    <section className="pane workload-config-pane">
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 14 }}>Configuration</h1>
      <p style={{ color: "var(--c-ink-muted)", fontSize: 12.5 }}>
        {scope.workloadId
          ? `Workload ${scope.workloadId} — configuration is coming in this migration.`
          : "Select a workload to configure. Coming in this migration."}
      </p>
    </section>
  );
}
