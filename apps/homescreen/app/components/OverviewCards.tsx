"use client";

// Overview summary components — the app-side port of the design system's
// design overview door door (understudy-design@design/consolidated-home).
// Same anatomy, live data: metric tiles, the spend trend on shadcn charts,
// workload cards with dot health. Styles in overview-cards.css (sm-).

import { useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, XAxis, YAxis } from "recharts";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/app/components/base-ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/base-ui/popover";
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

export type OverviewHealth = "healthy" | "idle" | "degraded" | "unavailable";

export function OverviewHealthDot({ status }: { status: OverviewHealth }) {
  return (
    <span className={`sm-health ${status}`} title={status}>
      <i className="sm-dot" />
      {status === "unavailable" ? "n/a" : status}
    </span>
  );
}

export function OverviewMetricTile({
  label,
  value,
  of,
  detail,
  onOpen,
}: {
  label: string;
  value: string;
  of?: string;
  detail: string;
  /** When set the tile is a hot-link: pointer cursor, mint hairline on hover, ↗. */
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="sm-cap">
        {label}
        {onOpen ? (
          <span className="sm-tile-go" aria-hidden="true">
            ↗
          </span>
        ) : null}
      </span>
      <span className="sm-tile-value">
        {value}
        {of ? <small> / {of}</small> : null}
      </span>
      <span className="sm-tile-detail">{detail}</span>
    </>
  );
  if (!onOpen) return <div className="sm-tile">{body}</div>;
  return (
    <button type="button" className="sm-tile sm-tile-link" onClick={onOpen} aria-label={`open ${label}`}>
      {body}
    </button>
  );
}

// Model palette (design system v2.0), cycled deterministically over the
// alphabetical rank of a series name within its key set.
export const SERIES_PALETTE = ["#9edbd3", "#d97757", "#a78bfa", "#f2b34c", "#67e8f9"] as const;

export function overviewSeriesColors(keys: string[]): Map<string, string> {
  const ranked = [...keys].sort((a, b) => a.localeCompare(b));
  return new Map(ranked.map((key, index) => [key, SERIES_PALETTE[index % SERIES_PALETTE.length]]));
}

/** Chip-row legend: colored sm-dot + series name, under the chart. */
export function OverviewLegendChips({
  items,
  note,
}: {
  items: { name: string; color: string }[];
  note?: string;
}) {
  return (
    <div className="sm-legend">
      {items.map((item) => (
        <span key={item.name} className="sm-chip sm-legend-chip">
          <i className="sm-dot" style={{ background: item.color }} />
          {item.name}
        </span>
      ))}
      {note ? <span className="sm-note">{note}</span> : null}
    </div>
  );
}

/** House tooltip for stacked bars: each segment + total, mono tabular. */
function StackTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | string; color?: string }[];
  label?: string;
  format: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((entry) => Number(entry.value) > 0);
  const total = rows.reduce((sum, entry) => sum + Number(entry.value ?? 0), 0);
  return (
    <div className="sm-tip">
      <div className="sm-cap">{label}</div>
      {[...rows].reverse().map((entry) => (
        <div key={String(entry.dataKey)} className="sm-tip-row">
          <i className="sm-dot" style={{ background: entry.color }} />
          <span className="sm-tip-name">{String(entry.dataKey)}</span>
          <span className="sm-tip-value">{format(Number(entry.value))}</span>
        </div>
      ))}
      {rows.length > 1 ? (
        <div className="sm-tip-row sm-tip-total">
          <span className="sm-tip-name">total</span>
          <span className="sm-tip-value">{format(total)}</span>
        </div>
      ) : null}
    </div>
  );
}

const AXIS_TICK = { fill: "rgba(242,242,240,0.45)" };
const CHART_CLASS =
  "mt-4 h-[280px] w-full [&_.recharts-cartesian-axis-tick_text]:font-mono [&_.recharts-cartesian-axis-tick_text]:text-[9.5px] [&_.recharts-cartesian-axis-tick_text]:uppercase [&_.recharts-cartesian-axis-tick_text]:tracking-[0.08em]";

/**
 * Daily bars with stacked per-group segments (the Anthropic-console shape).
 * `rows` come from org-summary's stack helpers; `keys` order bottom-to-top.
 * Radius is skipped on stacked bars by design (recharts rounds every
 * segment, not just the crown).
 */
export function OverviewStackedBars({
  rows,
  keys,
  format,
  ariaLabel,
}: {
  rows: { day: string; label: string; values: Record<string, number> }[];
  keys: string[];
  format: (value: number) => string;
  ariaLabel: string;
}) {
  const reducedMotion = useReducedMotion();
  if (rows.length === 0 || keys.length === 0) {
    return <div className="sm-empty">no metered traffic in this range</div>;
  }
  const colors = overviewSeriesColors(keys);
  const data = rows.map((row) => ({ label: row.label, ...row.values }));
  const chartConfig = Object.fromEntries(
    keys.map((key) => [key, { label: key, color: colors.get(key)! }]),
  ) satisfies ChartConfig;
  return (
    <ChartContainer config={chartConfig} className={CHART_CLASS} role="img" aria-label={ariaLabel}>
      <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="label"
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
          tickMargin={8}
          tick={AXIS_TICK}
        />
        <ChartTooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          isAnimationActive={false}
          content={<StackTooltip format={format} />}
        />
        {keys.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="day"
            maxBarSize={72}
            fill={colors.get(key)}
            fillOpacity={0.75}
            stroke={colors.get(key)}
            strokeWidth={0.5}
            isAnimationActive={!reducedMotion}
            animationDuration={500}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** Single mint percent series on a fixed 0-100 axis (cache-read rate). */
export function OverviewRateTrend({
  rows,
  ariaLabel,
}: {
  rows: { label: string; pct: number | null }[];
  ariaLabel: string;
}) {
  const reducedMotion = useReducedMotion();
  if (rows.length === 0) {
    return <div className="sm-empty">no metered traffic in this range</div>;
  }
  const chartConfig = { pct: { label: "cache rate", color: MINT } } satisfies ChartConfig;
  return (
    <ChartContainer config={chartConfig} className={CHART_CLASS} role="img" aria-label={ariaLabel}>
      <LineChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="label"
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
          tickMargin={8}
          tick={AXIS_TICK}
        />
        <YAxis
          domain={[0, 100]}
          width={34}
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          tickFormatter={(value) => `${value}%`}
        />
        <ChartTooltip
          cursor={{ stroke: "rgba(255,255,255,0.12)" }}
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              className="rounded-lg border-white/10 bg-black font-mono text-[11px] text-[#f2f2f0]"
              formatter={(value) => (
                <span className="font-mono tabular-nums">{Number(value).toFixed(1)}%</span>
              )}
            />
          }
        />
        <Line
          dataKey="pct"
          type="monotone"
          stroke={MINT}
          strokeWidth={1.5}
          dot={false}
          connectNulls
          isAnimationActive={!reducedMotion}
          animationDuration={500}
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Range chip + calendar popover shared by the summary and analytics panes.
 * The hosted API only serves fixed windows, so callers load the widest (30d)
 * daily series once and slice it client-side against this range.
 */
export function OverviewRangePicker({
  range,
  onChange,
  minDate,
  maxDate,
  label,
}: {
  range: DateRange;
  onChange: (next: DateRange) => void;
  minDate: Date;
  maxDate: Date;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const text =
    range.from && range.to
      ? `${fmt(range.from)} – ${fmt(range.to)}`
      : range.from
        ? fmt(range.from)
        : "Pick a range";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="sm-range" aria-label={label}>
          <CalendarIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          {text}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={range}
          defaultMonth={range.from}
          disabled={{ before: minDate, after: maxDate }}
          onSelect={(next) => {
            if (!next) return;
            onChange(next);
            if (next.from && next.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const MINT = "#9edbd3";

export function OverviewSpendTrend({
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

export function OverviewWorkloadCard({
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
  health: OverviewHealth;
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
        <OverviewHealthDot status={health} />
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
export function OverviewPanel({
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
