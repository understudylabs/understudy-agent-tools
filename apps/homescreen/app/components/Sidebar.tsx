import type { ReactNode } from "react";

export type PaneId =
  | "status"
  | "chat"
  | "models"
  | "capture"
  | "account"
  | "usage"
  | "traces"
  | "training-evals"
  | "training-optimization"
  | "training-datasets"
  | "training-finetuning"
  | "training-rl"
  | "training-jobs";

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
  capture: (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2.5 4.5h4l1.2-1.5h5.8v9.5h-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5 8h6M8 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".72" />
    </svg>
  ),
  "training-evals": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2 11.5 5.5 8l2 2 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 14h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  "training-optimization": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M3 12.5c2.7 0 2.7-9 5-9s2.3 9 5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2 8h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".65" />
    </svg>
  ),
  "training-datasets": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <ellipse cx="8" cy="3.5" rx="5" ry="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 3.5v4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-4M3 7.5v4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  "training-finetuning": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M3 13h10M5 13V5.5L8 3l3 2.5V13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 8h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  "training-rl": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M2.5 12.5 8 3l5.5 9.5H2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 7v2.2M8 11.5h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  "training-jobs": (
    <svg viewBox="0 0 16 16" fill="none" className="nav-icon">
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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

const SERVING_NAV: { id: PaneId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "status", label: "Status" },
  { id: "capture", label: "Capture" },
  { id: "models", label: "Models" },
  { id: "traces", label: "Traces" },
  { id: "usage", label: "Usage" },
];

const TRAINING_NAV: { id: PaneId; label: string }[] = [
  { id: "training-evals", label: "Evals" },
  { id: "training-optimization", label: "Optimization" },
  { id: "training-datasets", label: "Datasets" },
  { id: "training-finetuning", label: "Fine-tuning" },
  { id: "training-rl", label: "RL" },
  { id: "training-jobs", label: "Jobs" },
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
      <div className="nav-section">Serving</div>
      {SERVING_NAV.map((n) => (
        <div
          key={n.id}
          className={"nav-item" + (active === n.id ? " active" : "")}
          onClick={() => onSelect(n.id)}
        >
          {ICONS[n.id]}
          {n.label}
        </div>
      ))}

      <div className="nav-section">Training</div>
      {TRAINING_NAV.map((n) => (
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
      <button
        className={"nav-account" + (active === "account" ? " active" : "")}
        onClick={() => onSelect("account")}
      >
        {ICONS.account}
        <span className="nav-account-copy">
          <span>Account</span>
          <span className="nav-account-status">
            <span className={"dot" + (connected ? " running" : "")} />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </span>
      </button>
    </aside>
  );
}
