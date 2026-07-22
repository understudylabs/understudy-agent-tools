import type { Histogram } from "@/lib/trajectory-core";

/**
 * Tiny inline SVG distribution histogram for sortable column headers
 * (Prime-Environments-Hub style). Pure presentational; series color comes
 * from the theme contract's --viz-series-* slots via the `color` prop.
 */
export function InlineHistogram({
  histogram,
  width = 72,
  height = 18,
  color = "var(--viz-series-1)",
  title,
}: {
  histogram: Histogram;
  width?: number;
  height?: number;
  color?: string;
  title?: string;
}) {
  const { bins, count } = histogram;
  if (count === 0) {
    return (
      <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth={1} />
      </svg>
    );
  }
  const max = Math.max(...bins, 1);
  const gap = 1;
  const barW = Math.max(1, (width - gap * (bins.length - 1)) / bins.length);
  return (
    <svg width={width} height={height} role="img" aria-label={title ?? "distribution"} style={{ display: "block" }}>
      {title && <title>{title}</title>}
      {bins.map((n, i) => {
        const h = n === 0 ? 1 : Math.max(2, (n / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            fill={n === 0 ? "var(--border)" : color}
            opacity={n === 0 ? 0.6 : 0.85}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}
