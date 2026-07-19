import { cn } from "@/lib/utils";
import type { EvidenceWarning, HubEntry } from "@/lib/types";
import { AlertTriangle, Flag } from "lucide-react";

export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-rule-strong px-2 py-0.5 text-[11px] font-mono leading-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

const ORIGIN_STYLES: Record<string, string> = {
  "derived-from-traces": "text-ok border-ok/40 bg-ok/10",
  imported: "text-warn border-warn/40 bg-warn/10",
  authored: "text-ink border-rule-strong bg-hover",
};

export function OriginBadge({ origin }: { origin: string }) {
  const label = origin === "derived-from-traces" ? "derived" : origin;
  return <Badge className={ORIGIN_STYLES[origin] ?? "text-ink"}>{label}</Badge>;
}

export function SourceBadge({ entry }: { entry: HubEntry }) {
  if (entry.source === "fixture") return <Badge className="text-ink-muted">fixture · read-only</Badge>;
  if (entry.source === "demo") return <Badge className="text-ink-muted">demo</Badge>;
  return null;
}

export function FlagBadge({ count, resolved }: { count: number; resolved?: boolean }) {
  if (count === 0) return null;
  return (
    <Badge className={resolved ? "text-ink-muted" : "text-bad border-bad/40 bg-bad/10"}>
      <Flag className="h-3 w-3" />
      {count} flag{count === 1 ? "" : "s"}
    </Badge>
  );
}

const ROUTE_STYLES: Record<string, string> = {
  local: "text-ok border-ok/40 bg-ok/10",
  gateway: "text-stamp border-stamp/40 bg-stamp/10",
  byo: "text-ink-muted border-rule-strong",
};

/** LiveBench-"open"-style route badge on arm names (local | gateway | byo). */
export function RouteBadge({ route }: { route: string | null }) {
  if (!route) return null;
  return <Badge className={cn("px-1.5 py-0 text-[10px]", ROUTE_STYLES[route] ?? "text-ink-muted")}>{route}</Badge>;
}

export function WarningList({ warnings, compact }: { warnings: EvidenceWarning[]; compact?: boolean }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {warnings.map((w) => (
        <li
          key={w.kind}
          className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{w.label}</span>
            {!compact && <span className="text-warn/80"> — {w.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const style =
    status === "ok"
      ? "text-ok border-ok/40"
      : status === "error"
        ? "text-bad border-bad/40"
        : "text-ink-muted";
  return <Badge className={style}>{status}</Badge>;
}
