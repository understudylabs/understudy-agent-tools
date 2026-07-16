"use client";

import type { CSSProperties } from "react";

type CsvProfileColumn = {
  name: string;
  unique_count: number;
  profile_kind: "number" | "date" | "category" | "text";
  profile_bars: number[];
};

type Props = {
  sourceName: string;
  rowCount: number;
  columns: CsvProfileColumn[];
  highlightedColumn?: string | null;
  onSelectColumn?: (name: string) => void;
};

const PROFILE_COLORS: Record<CsvProfileColumn["profile_kind"], string> = {
  number: "var(--mb-mint)",
  date: "var(--mb-cyan)",
  category: "#a78bfa",
  text: "color-mix(in srgb, var(--text) 50%, transparent)",
};

export function CsvProfile({
  sourceName,
  rowCount,
  columns,
  highlightedColumn,
  onSelectColumn,
}: Props) {
  return (
    <div className="csv-profile" data-testid="csv-profile">
      <div className="csv-profile-summary" title={sourceName}>
        <span>{sourceName}</span>
        <i aria-hidden="true">·</i>
        <b>{rowCount.toLocaleString()} rows</b>
        <i aria-hidden="true">·</i>
        <span>{columns.length} columns</span>
      </div>
      <div
        className={`csv-profile-columns${columns.length <= 4 ? " is-sparse" : ""}`}
        role="group"
        aria-label="Local CSV column profile"
        style={{ "--sparse-column-count": Math.max(1, columns.length) } as CSSProperties}
      >
        {columns.map((column, columnIndex) => (
          <button
            type="button"
            key={column.name}
            className={`csv-profile-column${highlightedColumn === column.name ? " highlighted" : ""}`}
            style={{ "--profile-delay": `${Math.min(columnIndex * 55, 440)}ms` } as CSSProperties}
            aria-pressed={highlightedColumn === column.name}
            aria-label={`Use ${column.name} as the prediction target; ${
              column.profile_kind === "category"
                ? `${column.unique_count.toLocaleString()} kinds`
                : column.profile_kind
            }`}
            onClick={() => onSelectColumn?.(column.name)}
          >
            <div className="csv-profile-glyph" aria-hidden="true">
              {column.profile_bars.map((bar, barIndex) => (
                <i
                  key={`${column.name}-${barIndex}`}
                  style={{
                    height: `${Math.max(5, Math.min(100, bar * 100))}%`,
                    background: PROFILE_COLORS[column.profile_kind],
                    opacity: 0.34 + Math.min(1, bar) * 0.62,
                  }}
                />
              ))}
            </div>
            <strong title={column.name}>{column.name}</strong>
            <small>
              {column.profile_kind === "category"
                ? `${column.unique_count.toLocaleString()} kinds`
                : column.profile_kind}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}
