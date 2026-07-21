"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/base-ui/collapsible";
import type { NavGroupId } from "../../lib/nav";

function storageKey(group: NavGroupId) {
  return `sidebar.group.${group}`;
}

export function NavGroup({
  group,
  label,
  children,
}: {
  group: NavGroupId;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey(group));
      if (stored === "closed") setOpen(false);
    } catch {
      // localStorage unavailable; stay open.
    }
  }, [group]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(storageKey(group), next ? "open" : "closed");
    } catch {
      // Non-fatal.
    }
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="nav-group">
      <CollapsibleTrigger asChild>
        <button type="button" className="nav-group-label" aria-label={`Toggle ${label} group`}>
          <span>{label}</span>
          <ChevronDownIcon
            aria-hidden="true"
            size={13}
            strokeWidth={1.8}
            className={"nav-group-chevron" + (open ? " open" : "")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="nav-group-content">{children}</CollapsibleContent>
    </Collapsible>
  );
}
