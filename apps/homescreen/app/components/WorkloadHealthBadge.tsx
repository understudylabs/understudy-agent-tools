"use client";

import type { ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/base-ui/tooltip";

export type WorkloadHealthStatus = "healthy" | "degraded" | "idle" | "unavailable";

// Faithful port of apps/web/components/WorkloadHealthBadge.tsx, recolored
// with the desktop token system (mint=healthy, amber-adjacent warn is the
// web's emerald/destructive pair; here we use the sanctioned status tokens).
const HEALTH_CONTENT: Record<
  WorkloadHealthStatus,
  { label: string; description: string; className: string; Icon: typeof CircleCheckIcon }
> = {
  healthy: {
    label: "Healthy",
    description:
      "Traffic was observed in the last 24 hours and the 5xx error rate is below the degraded threshold.",
    className:
      "border-[color-mix(in_srgb,var(--color-ok)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-ok)_14%,transparent)] text-[var(--color-ok)]",
    Icon: CircleCheckIcon,
  },
  degraded: {
    label: "Degraded",
    description:
      "The observed 5xx error rate reached the degraded threshold in the last 24 hours.",
    className:
      "border-[color-mix(in_srgb,var(--color-bad)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] text-[var(--color-bad)]",
    Icon: CircleAlertIcon,
  },
  idle: {
    label: "Idle",
    description: "No traffic was observed for this workload in the last 24 hours.",
    className: "border-[var(--color-rule)] bg-[var(--color-card)] text-[var(--color-ink-muted)]",
    Icon: CircleMinusIcon,
  },
  unavailable: {
    label: "Status unavailable",
    description: "Analytics could not load this workload's current health status.",
    className: "border-[var(--color-rule)] bg-[var(--color-card)] text-[var(--color-ink-muted)]",
    Icon: CircleMinusIcon,
  },
};

/** Focusable status control so the health meaning is available on hover and keyboard focus. */
export function WorkloadHealthBadge({
  status,
}: {
  status?: WorkloadHealthStatus;
}): ReactNode {
  if (!status) {
    return (
      <span className="inline-flex h-7 items-center rounded-md border border-[var(--color-rule)] bg-[var(--color-card)] px-2 text-xs text-[var(--color-ink-muted)]">
        Not observed
      </span>
    );
  }

  const { label, description, className, Icon } =
    HEALTH_CONTENT[status] ?? HEALTH_CONTENT.unavailable;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${className}`}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
