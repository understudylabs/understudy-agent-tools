"use client";

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronDownIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/app/components/base-ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/base-ui/dropdown-menu";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/app/components/base-ui/command";
import type { Scope } from "../lib/nav";
import type { ProjectSummary, WorkloadSummary } from "./sidebar/ScopeSwitcher";

/**
 * Title-bar scope breadcrumb — replaces the sidebar project/workload
 * switcher. Same semantics as the web WorkloadScopeSwitcher port it
 * supersedes:
 * - the project crumb RESCOPES only (sets projectId, clears workloadId);
 * - the workload crumb NAVIGATES (sets workloadId AND pane → workload-config)
 *   through the same searchable command dialog.
 * Data still comes from the `projects_list` / `workloads_list` Tauri
 * commands; with no rows the crumbs render as a sole-org label.
 */
export function ScopeBreadcrumb({
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
  const selectedProject =
    projects.find((p) => p.project_id === scope.projectId) ?? null;
  const selectedWorkload =
    workloads.find((w) => w.workload_id === scope.workloadId) ?? null;
  const noData = projects.length === 0;

  return (
    <Breadcrumb className="titlebar-scope" aria-label="Scope">
      <BreadcrumbList>
        <BreadcrumbItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="titlebar-scope-crumb"
              disabled={noData}
              aria-label="Project"
            >
              {selectedProject?.name ?? (noData ? "Personal org" : "Select project")}
              <ChevronDownIcon aria-hidden="true" size={12} strokeWidth={1.8} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.project_id}
                  onSelect={() => {
                    // Rescope only: no pane change, workload cleared.
                    onScopeChange({ projectId: project.project_id, workloadId: null });
                  }}
                >
                  {project.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <button
            type="button"
            className="titlebar-scope-crumb"
            disabled={noData || projectWorkloads.length === 0}
            onClick={() => setWorkloadPickerOpen(true)}
            aria-label="Workload"
          >
            {selectedWorkload ? (
              <>
                <span
                  className={"workload-health-dot " + selectedWorkload.health}
                  aria-label={`Workload health: ${selectedWorkload.health}`}
                  role="img"
                />
                {selectedWorkload.name}
              </>
            ) : (
              <span className="muted">{noData ? "No workloads yet" : "Select workload"}</span>
            )}
            <ChevronDownIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          </button>
        </BreadcrumbItem>
      </BreadcrumbList>
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
              <span className={"workload-health-dot " + workload.health} aria-hidden="true" />
              {workload.name}
            </CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
    </Breadcrumb>
  );
}
