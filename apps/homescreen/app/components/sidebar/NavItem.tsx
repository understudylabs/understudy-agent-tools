"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/base-ui/tooltip";

export function NavItem({
  label,
  icon: Icon,
  active,
  disabled,
  disabledReason,
  onSelect,
  badge,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  badge?: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={"chat-nav-item nav-item" + (active ? " active" : "")}
      onClick={onSelect}
      disabled={disabled}
      aria-disabled={disabled || undefined}
    >
      <Icon className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.6} />
      <span className="nav-item-label">{label}</span>
      {badge != null && <span className="nav-item-badge">{badge}</span>}
    </button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip fires on a disabled button */}
          <span className="nav-item-disabled-wrap">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="right">{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }

  return button;
}
