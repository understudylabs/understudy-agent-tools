import { cn } from "@/lib/utils";
import type { EvidenceWarning, HubEntry } from "@/lib/types";
import { AlertTriangle, Flag } from "lucide-react";

export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-rule-strong bg-card px-2 py-0.5 font-mono text-[11px] leading-4 text-ink-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

const ORIGIN_STYLES: Record<string, string> = {
  "derived-from-traces": "text-ok border-ok/50",
  imported: "text-warn border-warn/40",
  authored: "text-ink-muted border-rule-strong",
};

export function OriginBadge({ origin }: { origin: string }) {
  const label = origin === "derived-from-traces" ? "derived" : origin;
  return <Badge className={ORIGIN_STYLES[origin] ?? "text-ink-muted"}>{label}</Badge>;
}

export function SourceBadge({ entry }: { entry: Pick<HubEntry, "source"> }) {
  if (entry.source === "fixture") return <Badge>fixture · read-only</Badge>;
  if (entry.source === "demo") return <Badge>demo</Badge>;
  return null;
}

/**
 * Split chip that understands BOTH split enums: promoted benchmark.v1 uses
 * train/dev/holdout, the foundry's benchmark_task.v1 uses
 * construction/fit/heldout. Labels render as-is; visual treatment maps the
 * corresponding pairs to parity (construction≈train, fit≈dev,
 * heldout≈holdout). Upstream enum reconciliation is tracked for the foundry —
 * once names converge this collapses to one enum.
 */
const SPLIT_STYLES: Record<string, string> = {
  train: "text-ink-muted",
  construction: "text-ink-muted",
  dev: "text-stamp border-stamp/40",
  fit: "text-stamp border-stamp/40",
  holdout: "text-ok border-ok/50",
  heldout: "text-ok border-ok/50",
  none: "text-faint",
};

export function SplitChip({ split }: { split: string }) {
  return <Badge className={SPLIT_STYLES[split] ?? "text-ink-muted"}>{split}</Badge>;
}

export function ConfidenceChip({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  const style =
    level === "high" ? "text-ok border-ok/50" : level === "low" ? "text-bad border-bad/40" : "text-warn border-warn/40";
  return <Badge className={style}>{level} confidence</Badge>;
}

export const DECISION_STYLES: Record<string, string> = {
  accept: "text-ok border-ok/50",
  restrict: "text-warn border-warn/40",
  needs_more: "text-warn border-warn/40",
  reject: "text-bad border-bad/40",
};

export function DecisionBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision) return <Badge>pending review</Badge>;
  return <Badge className={DECISION_STYLES[decision] ?? ""}>{decision.replace("_", " ")}</Badge>;
}

/** Lifecycle stage: proposed (foundry output, review pending) vs promoted (benchmark.v1). */
export function StageBadge({ stage }: { stage: "proposed" | "promoted" }) {
  return (
    <Badge className={stage === "proposed" ? "border-warn/40 text-warn" : "text-ink-muted"}>{stage}</Badge>
  );
}

export function FlagBadge({ count, resolved }: { count: number; resolved?: boolean }) {
  if (count === 0) return null;
  return (
    <Badge className={resolved ? "text-ink-muted" : "border-bad/40 text-bad"}>
      <Flag className="h-3 w-3" />
      {count} flag{count === 1 ? "" : "s"}
    </Badge>
  );
}

/**
 * LiveBench-"open"-style route badge on arm names (local | gateway | byo).
 * Local = green outline (their "open weights" treatment), gateway = blue.
 */
export function RouteBadge({ route }: { route: string | null }) {
  if (!route) return null;
  if (route === "local") return <span className="opn">local</span>;
  return (
    <span className="opn" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
      {route}
    </span>
  );
}

export function WarningList({ warnings, compact }: { warnings: EvidenceWarning[]; compact?: boolean }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {warnings.map((w) => (
        <li key={w.kind} className="u-warn flex items-start gap-2.5 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="lab">{w.label}</span>
            {!compact && <span className="block sm:inline sm:before:content-['_—_']">{w.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const style =
    status === "ok" ? "text-ok border-ok/50" : status === "error" ? "text-bad border-bad/40" : "text-ink-muted";
  return <Badge className={style}>{status}</Badge>;
}
