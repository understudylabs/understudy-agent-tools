"use client";

// Analytics parent row + indented metric children (Usage / Caching / Cost),
// matching Anthropic's console left nav: the parent keeps its chart icon
// and a disclosure chevron; children are smaller, indented, icon-free rows
// that navigate to the Cedar analytics destinations. Clicking the parent
// navigates to Usage and expands the subtree. The expanded state persists
// like the NavGroup / training-History disclosures.

import { useEffect, useState } from "react";
import { BarChart3, ChevronDownIcon } from "lucide-react";
import type { PaneId } from "../Sidebar";

const OPEN_KEY = "sidebar.analytics";

export const ANALYTICS_CHILDREN: { label: string; pane: PaneId }[] = [
  { label: "Usage", pane: "analytics-usage" },
  { label: "Caching", pane: "analytics-caching" },
  { label: "Cost", pane: "analytics-cost" },
];

export function AnalyticsNavTree({
  active,
  onSelect,
}: {
  active: PaneId;
  onSelect: (pane: PaneId) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      // localStorage unavailable; stay closed.
    }
  }, []);

  const persist = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Non-fatal.
    }
  };

  const childActive = ANALYTICS_CHILDREN.some((child) => child.pane === active);

  return (
    <div className="nav-subtree">
      <button
        type="button"
        className={"chat-nav-item nav-item" + (childActive && !open ? " active" : "")}
        aria-expanded={open}
        onClick={() => {
          onSelect("analytics-usage");
          persist(true);
        }}
      >
        <BarChart3 className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.6} />
        <span className="nav-item-label">Analytics</span>
        <span
          role="button"
          tabIndex={0}
          aria-label={open ? "Collapse analytics" : "Expand analytics"}
          className={"nav-subtree-chevron" + (open ? " open" : "")}
          onClick={(event) => {
            event.stopPropagation();
            persist(!open);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              persist(!open);
            }
          }}
        >
          <ChevronDownIcon aria-hidden="true" size={13} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div className="nav-subtree-children" role="group" aria-label="Analytics views">
          {ANALYTICS_CHILDREN.map((child) => (
            <button
              key={child.pane}
              type="button"
              className={
                "chat-nav-item nav-item nav-subitem" + (active === child.pane ? " active" : "")
              }
              onClick={() => onSelect(child.pane)}
            >
              <span className="nav-item-label">{child.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
