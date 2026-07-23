"use client";

// Cedar summary components — the app-side port of the design system's
// cedar/flows/summary door (understudy-design@design/consolidated-home).
// Same anatomy, live data: metric tiles, the spend trend on shadcn charts,
// workload cards with dot health. Styles in cedar-summary.css (sm-).

import { useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/app/components/base-ui/chart";

/** recharts animation gated on the OS motion preference. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export type CedarHealth = "healthy" | "idle" | "degraded" | "unavailable";

export function CedarHealthDot({ status }: { status: CedarHealth }) {
  return (
    <span className={`sm-health ${status}`} title={status}>
      <i className="sm-dot" />
      {status === "unavailable" ? "n/a" : status}
    </span>
  );
}

export function CedarMetricTile({
  label,
  value,
  of,
  detail,
}: {
  label: string;
  value: string;
  of?: string;
  detail: string;
}) {
  return (
    <div className="sm-tile">
      <span className="sm-cap">{label}</span>
      <span className="sm-tile-value">
        {value}
        {of ? <small> / {of}</small> : null}
      </span>
      <span className="sm-tile-detail">{detail}</span>
    </div>
  );
}

const MINT = "#9edbd3";

export function CedarSpendTrend({
  rows,
}: {
  rows: { day: string; cost: number }[];
}) {
  const reducedMotion = useReducedMotion();
  if (rows.length === 0) {
    return <div className="sm-empty">no metered traffic in this range</div>;
  }
  const peak = rows.reduce((a, b) => (b.cost > a.cost ? b : a), rows[0]);
  const chartConfig = {
    cost: { label: "spend", color: MINT },
  } satisfies ChartConfig;
  return (
    <ChartContainer
      config={chartConfig}
      className="mt-4 h-[280px] w-full [&_.recharts-cartesian-axis-tick_text]:font-mono [&_.recharts-cartesian-axis-tick_text]:text-[9.5px] [&_.recharts-cartesian-axis-tick_text]:uppercase [&_.recharts-cartesian-axis-tick_text]:tracking-[0.08em]"
      role="img"
      aria-label="estimated daily cost over the selected range"
    >
      <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 4 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="day"
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
          tickMargin={8}
          tick={{ fill: "rgba(242,242,240,0.45)" }}
        />
        <ChartTooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              className="rounded-lg border-white/10 bg-black font-mono text-[11px] text-[#f2f2f0]"
              formatter={(value) => (
                <span className="font-mono tabular-nums">
                  ${Number(value).toFixed(2)}
                </span>
              )}
            />
          }
        />
        <Bar
          dataKey="cost"
          radius={[3, 3, 0, 0]}
          maxBarSize={72}
          isAnimationActive={!reducedMotion}
          animationDuration={500}
          stroke="rgba(158,219,211,0.9)"
          strokeWidth={1}
        >
          {rows.map((r) => (
            <Cell key={r.day} fill={r === peak ? MINT : "rgba(158,219,211,0.5)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function CedarWorkloadCard({
  project,
  name,
  isDefault,
  health,
  route,
  cost,
  requests,
  capture,
  onOpen,
}: {
  project: string;
  name: string;
  isDefault?: boolean;
  health: CedarHealth;
  route: string;
  cost: string;
  requests: string;
  capture: "on" | "off";
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="sm-card"
      onClick={onOpen}
      aria-label={`configure ${name} in ${project}`}
    >
      <div className="sm-card-top">
        <span className="sm-cap">{project}</span>
        <span className="sm-spacer" />
        <CedarHealthDot status={health} />
      </div>
      <div className="sm-card-top">
        <span className="sm-card-name">{name}</span>
        {isDefault ? <span className="sm-chip">default</span> : null}
        <span className="sm-spacer" />
        <span className="sm-chip">{route}</span>
      </div>
      <div className="sm-card-minis">
        <span className="sm-mini">
          <span className="sm-cap">7-day cost</span>
          <b>{cost}</b>
        </span>
        <span className="sm-mini">
          <span className="sm-cap">requests</span>
          <b>{requests}</b>
        </span>
        <span className="sm-mini">
          <span className="sm-cap">capture</span>
          <b style={{ color: capture === "on" ? MINT : "var(--text-2)" }}>{capture}</b>
        </span>
      </div>
    </button>
  );
}

/** Panel shell shared by the spend + workloads sections. */
export function CedarPanel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="sm-panel">
      <div className="sm-panel-head">
        <span className="sm-panel-title">{title}</span>
        <span className="sm-spacer" />
        {action}
      </div>
      {children}
    </div>
  );
}
