"use client";

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronsUpDownIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/base-ui/select";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/app/components/base-ui/command";
import type { Scope } from "../../lib/nav";

export type ProjectSummary = { project_id: string; name: string };
export type WorkloadSummary = {
  workload_id: string;
  project_id: string;
  name: string;
  health: "healthy" | "degraded" | "failing" | "unknown";
};

const SCOPE_STORAGE_KEY = "understudy.scope";

export function loadStoredScope(): Scope {
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Scope>;
      return {
        projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
        workloadId: typeof parsed.workloadId === "string" ? parsed.workloadId : null,
      };
    }
  } catch {
    // Corrupt or unavailable storage; fall through.
  }
  return { projectId: null, workloadId: null };
}

export function storeScope(scope: Scope) {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope));
  } catch {
    // Non-fatal.
  }
}

function healthDotClass(health: WorkloadSummary["health"]) {
  return "workload-health-dot " + health;
}

/**
 * Port of the web WorkloadScopeSwitcher semantics:
 * - Project select RESCOPES only (sets projectId, clears workloadId).
 * - Workload picker NAVIGATES (sets workloadId AND pane -> workload-config).
 * Data comes from the `projects_list` / `workloads_list` Tauri stubs; until
 * those return real rows the controls render disabled with a sole-org label.
 */
export function ScopeSwitcher({
  scope,
  onScopeChange,
  onWorkloadSelected,
}: {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onWorkloadSelected: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workloads, setWorkloads] = useState<WorkloadSummary[]>([]);
  const [workloadPickerOpen, setWorkloadPickerOpen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const [projectRows, workloadRows] = await Promise.all([
          invoke<ProjectSummary[]>("projects_list").catch(() => []),
          invoke<WorkloadSummary[]>("workloads_list").catch(() => []),
        ]);
        if (cancelled) return;
        setProjects(projectRows);
        setWorkloads(workloadRows);
      } catch {
        // Stubs unavailable; keep placeholder state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const projectWorkloads = scope.projectId
    ? workloads.filter((w) => w.project_id === scope.projectId)
    : workloads;
  const selectedWorkload =
    workloads.find((w) => w.workload_id === scope.workloadId) ?? null;

  const noData = projects.length === 0;

  return (
    <div className="scope-switcher">
      <Select
        value={scope.projectId ?? undefined}
        disabled={noData}
        onValueChange={(projectId) => {
          // Rescope only: no pane change, workload cleared.
          onScopeChange({ projectId, workloadId: null });
        }}
      >
        <SelectTrigger className="scope-switcher-trigger" aria-label="Project">
          <SelectValue
            placeholder={noData ? "Personal org" : "Select project"}
          />
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.project_id} value={project.project_id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <button
        type="button"
        className="scope-switcher-workload"
        disabled={noData || projectWorkloads.length === 0}
        onClick={() => setWorkloadPickerOpen(true)}
        aria-label="Workload"
      >
        {selectedWorkload ? (
          <>
            <span
              className={healthDotClass(selectedWorkload.health)}
              aria-label={`Workload health: ${selectedWorkload.health}`}
              role="img"
            />
            <span className="scope-switcher-workload-name">{selectedWorkload.name}</span>
          </>
        ) : (
          <span className="scope-switcher-workload-name muted">
            {noData ? "No workloads yet" : "Select workload"}
          </span>
        )}
        <ChevronsUpDownIcon aria-hidden="true" size={13} strokeWidth={1.8} />
      </button>

      <CommandDialog
        open={workloadPickerOpen}
        onOpenChange={setWorkloadPickerOpen}
        title="Select workload"
        description="Choose a workload to configure"
      >
        <CommandInput placeholder="Search workloads…" />
        <CommandList>
          <CommandEmpty>No workloads found.</CommandEmpty>
          {projectWorkloads.map((workload) => (
            <CommandItem
              key={workload.workload_id}
              value={`${workload.name} ${workload.workload_id}`}
              onSelect={() => {
                // Selecting a workload navigates to its configuration pane.
                onScopeChange({
                  projectId: scope.projectId ?? workload.project_id,
                  workloadId: workload.workload_id,
                });
                setWorkloadPickerOpen(false);
                onWorkloadSelected();
              }}
            >
              <span className={healthDotClass(workload.health)} aria-hidden="true" />
              {workload.name}
            </CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
    </div>
  );
}
