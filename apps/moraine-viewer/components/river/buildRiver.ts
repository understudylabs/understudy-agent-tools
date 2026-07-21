import { DailyPoint, DAY } from "./types";

export type Band = {
  harness: string;
  // sampled curve, x in day units, top/bottom in world px (y up)
  xs: number[];
  top: number[];
  bottom: number[];
  totalEvents: number;
};

export type River = {
  day0: number; // unix seconds of first day (UTC midnight)
  numDays: number;
  bands: Band[]; // stacked, symmetric around y = 0
  maxHalf: number; // max half-thickness of the stack, world px
};

const SUBDIV = 4; // samples per day (catmull-rom upsample)

function gaussianSmooth(v: number[]): number[] {
  const k = [1, 4, 6, 4, 1];
  const ks = 16;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    let acc = 0;
    for (let j = -2; j <= 2; j++) {
      const idx = Math.min(v.length - 1, Math.max(0, i + j));
      acc += v[idx] * k[j + 2];
    }
    out[i] = acc / ks;
  }
  return out;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function upsample(v: number[], subdiv: number): number[] {
  if (v.length < 2) return v.slice();
  const out: number[] = [];
  for (let i = 0; i < v.length - 1; i++) {
    const p0 = v[Math.max(0, i - 1)];
    const p1 = v[i];
    const p2 = v[i + 1];
    const p3 = v[Math.min(v.length - 1, i + 2)];
    for (let s = 0; s < subdiv; s++) {
      out.push(Math.max(0, catmullRom(p0, p1, p2, p3, s / subdiv)));
    }
  }
  out.push(v[v.length - 1]);
  return out;
}

/** Build a symmetric ("silhouette") streamgraph from daily counts. */
export function buildRiver(daily: DailyPoint[], thicknessScale = 4.2): River {
  if (daily.length === 0) {
    return { day0: 0, numDays: 1, bands: [], maxHalf: 10 };
  }
  const dates = daily.map((r) => Date.parse(r.d + "T00:00:00Z") / 1000);
  const day0 = Math.min(...dates);
  const dayN = Math.max(...dates);
  const numDays = Math.round((dayN - day0) / DAY) + 1;

  // dense per-harness daily series (sqrt scale tames codex's 1.8M spikes)
  const byHarness = new Map<string, number[]>();
  daily.forEach((r, i) => {
    let series = byHarness.get(r.harness);
    if (!series) {
      series = new Array<number>(numDays).fill(0);
      byHarness.set(r.harness, series);
    }
    const idx = Math.round((dates[i] - day0) / DAY);
    series[idx] += r.c;
  });

  const totals = [...byHarness.entries()]
    .map(([harness, series]) => ({ harness, series, total: series.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);

  // thickness = sqrt(count) * scale, smoothed then upsampled
  const smoothed = totals.map((t) => ({
    ...t,
    thick: upsample(
      gaussianSmooth(t.series.map((c) => Math.sqrt(c) * (thicknessScale / 10))),
      SUBDIV
    ),
  }));

  const n = smoothed.length > 0 ? smoothed[0].thick.length : 0;
  const xs = new Array<number>(n);
  for (let i = 0; i < n; i++) xs[i] = i / SUBDIV;

  // stack symmetric around y = 0 (biggest band innermost)
  const sums = new Array<number>(n).fill(0);
  for (const s of smoothed) for (let i = 0; i < n; i++) sums[i] += s.thick[i];
  let maxHalf = 0;
  for (let i = 0; i < n; i++) maxHalf = Math.max(maxHalf, sums[i] / 2);

  const cursor = sums.map((s) => -s / 2); // bottom of stack per sample
  const bands: Band[] = smoothed.map((s) => {
    const bottom = new Array<number>(n);
    const top = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      bottom[i] = cursor[i];
      top[i] = cursor[i] + s.thick[i];
      cursor[i] = top[i];
    }
    return { harness: s.harness, xs, top, bottom, totalEvents: s.total };
  });

  return { day0, numDays, bands, maxHalf: Math.max(maxHalf, 10) };
}

/** Greedy interval row-packing for session marks inside a harness lane. */
export function packRows<T extends { start: number; end: number }>(
  items: T[],
  maxRows: number
): Map<T, number> {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const rowEnds: number[] = [];
  const out = new Map<T, number>();
  for (const it of sorted) {
    let placed = -1;
    for (let r = 0; r < rowEnds.length; r++) {
      if (rowEnds[r] <= it.start) {
        placed = r;
        break;
      }
    }
    if (placed === -1) {
      if (rowEnds.length < maxRows) {
        placed = rowEnds.length;
        rowEnds.push(0);
      } else {
        // overflow: drop into the row that frees up soonest
        placed = rowEnds.indexOf(Math.min(...rowEnds));
      }
    }
    rowEnds[placed] = it.end + 60; // 1 min gap
    out.set(it, placed);
  }
  return out;
}
