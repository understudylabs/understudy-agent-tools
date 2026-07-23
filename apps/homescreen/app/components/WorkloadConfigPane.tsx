"use client";

// Workload Configuration pane — kept for deep links ("workload-config" pane
// id), but its nav row is gone: the controls folded into the Workloads pane
// cards (WorkloadsPane + WorkloadConfigInline). This shell just scopes the
// shared form to the sidebar-selected workload.

import type { Scope } from "../lib/nav";
import "./cedar-summary.css";
import { WorkloadConfigInline } from "./WorkloadConfigInline";

export function WorkloadConfigPane({ scope }: { scope: Scope }) {
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Configuration</h1>
        <p className="pane-sub">
          Route and capture for a workload. This view also lives inline on the
          Workloads pane — expand a card there.
        </p>
      </div>
      <div className="pane-body" style={{ maxWidth: 720 }}>
        {scope.projectId && scope.workloadId ? (
          <WorkloadConfigInline
            key={`${scope.projectId}:${scope.workloadId}`}
            projectId={scope.projectId}
            workloadId={scope.workloadId}
          />
        ) : (
          <div className="sm-empty">
            select a workload in the sidebar to configure its route and capture
          </div>
        )}
      </div>
    </>
  );
}
