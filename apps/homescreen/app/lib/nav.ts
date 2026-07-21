import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Beaker,
  FolderKanban,
  Boxes,
  CreditCard,
  Compass,
  FlaskConical,
  HardDrive,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Settings2,
  Wrench,
} from "lucide-react";
import type { PaneId } from "../components/Sidebar";

export type Scope = { projectId: string | null; workloadId: string | null };

export type NavGroupId =
  | "organization"
  | "workload"
  | "training"
  | "sessions"
  | "manage";

export type NavItemDef = {
  id: string;
  group: NavGroupId;
  label: string;
  icon: LucideIcon;
  /** Target pane; null while the surface has not been ported yet. */
  pane: PaneId | null;
  requiresWorkload?: boolean;
  /** Surface exists in the web control plane but is not ported yet. */
  disabled?: boolean;
  disabledReason?: string;
};

const COMING = "Coming in this migration";

// Registry: surface id -> pane id (Aamir's ControlPlaneShell labels verbatim).
export const NAV_ITEMS: NavItemDef[] = [
  // Organization
  { id: "org-summary", group: "organization", label: "Summary", icon: LayoutDashboard, pane: "org-summary" },
  { id: "org-analytics", group: "organization", label: "Analytics", icon: BarChart3, pane: "reporting" },
  // The web's project Summary (`/p/[project_slug]`, ActiveView "summary");
  // the desktop scopes by the sidebar Project selector instead of a slug URL.
  { id: "org-project", group: "organization", label: "Project", icon: FolderKanban, pane: "project-summary" },
  // The web's project-scoped Analytics (`/p/[project_slug]` reporting view).
  { id: "org-project-analytics", group: "organization", label: "Project Analytics", icon: BarChart3, pane: "project-reporting" },
  // Workload (conditional on scope.workloadId)
  {
    id: "workload-config",
    group: "workload",
    label: "Configuration",
    icon: Settings2,
    pane: "workload-config",
    requiresWorkload: true,
  },
  { id: "workload-captures", group: "workload", label: "Captures", icon: Inbox, pane: "captures", requiresWorkload: true },
  // Training
  { id: "training-overview", group: "training", label: "Overview", icon: FlaskConical, pane: "training-jobs" },
  // Chats (Explore is an ordinary row; New chat is rendered separately)
  { id: "chats-explore", group: "sessions", label: "Explore Data", icon: Compass, pane: "explore" },
  // Manage
  // "Models" is Aamir's catalog surface (web /models). The desktop-native
  // local model library keeps its own row so it stays reachable from nav.
  { id: "manage-models", group: "manage", label: "Models", icon: Boxes, pane: "model-catalog" },
  { id: "manage-local-models", group: "manage", label: "Local models", icon: HardDrive, pane: "models" },
  { id: "manage-api-keys", group: "manage", label: "API keys", icon: KeyRound, pane: "api-keys" },
  { id: "manage-traces", group: "manage", label: "Traces", icon: ScrollText, pane: "traces" },
  { id: "manage-lab", group: "manage", label: "Lab", icon: Beaker, pane: "rlm" },
  // Not yet ported from the web control plane (admin/v1 plumbing pending).
  { id: "manage-billing", group: "manage", label: "Billing", icon: CreditCard, pane: null, disabled: true, disabledReason: COMING },
  { id: "manage-setup", group: "manage", label: "Setup", icon: Wrench, pane: null, disabled: true, disabledReason: COMING },
];

/**
 * Maps the current pane to the nav item that should show as active.
 * Chat sessions and training threads keep their own compound active checks
 * inside ChatSessionList / TrainingThreadList (deliberately not generalized).
 */
export function paneToNavId(
  pane: PaneId,
  activeSessionId: string | null,
  activeThreadId: string | null,
): string | null {
  if (pane === "chat") {
    // Session/thread rows own the active state when one is selected.
    void activeSessionId;
    void activeThreadId;
    return null;
  }
  const item = NAV_ITEMS.find((entry) => entry.pane === pane);
  return item ? item.id : null;
}
