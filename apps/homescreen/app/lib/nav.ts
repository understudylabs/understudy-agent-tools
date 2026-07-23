import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Beaker,
  Boxes,
  CreditCard,
  Compass,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  Wrench,
} from "lucide-react";
import type { PaneId } from "../components/Sidebar";

export type Scope = { projectId: string | null; workloadId: string | null };

export type NavGroupId =
  | "organization"
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

// Registry: surface id -> pane id (Aamir's ControlPlaneShell labels verbatim).
export const NAV_ITEMS: NavItemDef[] = [
  // Organization
  { id: "org-summary", group: "organization", label: "Summary", icon: LayoutDashboard, pane: "org-summary" },
  // The flat "Analytics" row (ReportingPane, pane id "reporting") is
  // superseded by the Analytics subtree the Sidebar renders here — a
  // collapsible parent with Usage / Caching / Cost children (see
  // components/sidebar/AnalyticsNavTree.tsx). The old pane id remains
  // reachable for deep links, like Captures below.
  // The web's project Summary is folded into org Summary on desktop — the
  // panes were near-duplicates (same metrics/trend/workload cards). The
  // project-summary pane itself remains reachable by pane id.
  // The web's project-scoped Analytics (`/p/[project_slug]` reporting view),
  // presented as the per-workload breakdown.
  { id: "org-project-analytics", group: "organization", label: "Workloads", icon: BarChart3, pane: "project-reporting" },
  // The Configuration row is folded into the Workloads pane — each workload
  // card expands into its route/capture controls (WorkloadConfigInline). The
  // "workload-config" pane id + WorkloadConfigPane remain reachable for deep
  // links, like Captures below.
  // Captures view removed from the nav for now — the pane is being rebuilt
  // for a future release (CapturesPane and the "captures" pane id remain so
  // deep links and the rebuild have a home).
  // Training
  { id: "training-overview", group: "training", label: "Overview", icon: FlaskConical, pane: "training-jobs" },
  // Chats (Explore is an ordinary row; New chat is the sidebar's primary
  // action, rendered at the top of the rail rather than inside this group)
  { id: "chats-explore", group: "sessions", label: "Explore data", icon: Compass, pane: "explore" },
  // Manage
  // "Models" is Aamir's catalog surface (web /models). The desktop-native
  // local model library pane still exists but is reachable only via deep-link.
  { id: "manage-models", group: "manage", label: "Models", icon: Boxes, pane: "model-catalog" },
  { id: "manage-api-keys", group: "manage", label: "API keys", icon: KeyRound, pane: "api-keys" },
  { id: "manage-lab", group: "manage", label: "Lab", icon: Beaker, pane: "rlm" },
  // Settings folded into the Account view; project settings return with a
  // future release.
  { id: "manage-billing", group: "manage", label: "Billing", icon: CreditCard, pane: "billing" },
  { id: "manage-setup", group: "manage", label: "Setup", icon: Wrench, pane: "setup" },
];

/**
 * Maps the current pane to the nav item that should show as active.
 * Chat sessions and training threads keep their own compound active checks
 * inside ChatSessionList / TrainingThreadList (deliberately not generalized).
 */
export function paneToNavId(pane: PaneId): string | null {
  if (pane === "chat") {
    // Session/thread rows own the active state when one is selected.
    return null;
  }
  const item = NAV_ITEMS.find((entry) => entry.pane === pane);
  return item ? item.id : null;
}
