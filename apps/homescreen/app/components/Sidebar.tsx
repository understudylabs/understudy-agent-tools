import type { ReactNode } from "react";

export type PaneId = "status" | "chat" | "models" | "account" | "usage" | "traces";

const ICONS: Record<PaneId, ReactNode> = {
  status: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M1 8h3l2-5 3 10 2-5h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2 3h12v8H6l-3 3v-3H2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
  models: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  account: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 14c.7-2.5 2.7-4 5-4s4.3 1.5 5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  usage: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2 13V3M2 13h12M5 13V9M8 13V6M11 13V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  traces: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2 3h12M2 8h12M2 13h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
};

const NAV: { id: PaneId; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "chat", label: "Chat" },
  { id: "models", label: "Models" },
  { id: "traces", label: "Traces" },
  { id: "usage", label: "Usage" },
  { id: "account", label: "Account" },
];

export function Sidebar({
  active,
  onSelect,
  connected,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
  connected: boolean;
}) {
  return (
    <aside className="sidebar">
      <div className="nav-section">Local</div>
      {NAV.map((n) => (
        <div
          key={n.id}
          className={"nav-item" + (active === n.id ? " active" : "")}
          onClick={() => onSelect(n.id)}
        >
          {ICONS[n.id]}
          {n.label}
        </div>
      ))}

      <div className="nav-spacer" />
      <div className="nav-status">
        <span className={"dot" + (connected ? " running" : "")} />
        {connected ? "Connected" : "Disconnected"}
      </div>
    </aside>
  );
}
