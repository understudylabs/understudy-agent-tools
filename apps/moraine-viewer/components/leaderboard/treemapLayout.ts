// Pure squarified-treemap layout (Bruls, Huizing & van Wijk 2000). No deps.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapEntry<T> {
  item: T;
  rect: Rect;
}

/** Worst aspect ratio in a row of areas laid against a side of given length. */
function worst(areas: number[], side: number): number {
  if (areas.length === 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Squarified treemap: partitions `rect` into cells with area proportional to
 * each item's value. Deterministic; items with value <= 0 are dropped.
 */
export function squarify<T>(
  items: ReadonlyArray<{ item: T; value: number }>,
  rect: Rect,
): TreemapEntry<T>[] {
  const out: TreemapEntry<T>[] = [];
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((acc, i) => acc + i.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

  const scale = (rect.w * rect.h) / total;
  const queue = positive
    .map((i) => ({ item: i.item, area: i.value * scale }))
    .sort((a, b) => b.area - a.area);

  const free: Rect = { ...rect };

  const layoutRow = (row: { item: T; area: number }[]) => {
    const rowArea = row.reduce((acc, r) => acc + r.area, 0);
    if (free.w >= free.h) {
      // vertical strip on the left, spanning the (shorter) height
      const stripW = rowArea / free.h;
      let y = free.y;
      for (const r of row) {
        const h = r.area / stripW;
        out.push({ item: r.item, rect: { x: free.x, y, w: stripW, h } });
        y += h;
      }
      free.x += stripW;
      free.w -= stripW;
    } else {
      // horizontal strip on top, spanning the (shorter) width
      const stripH = rowArea / free.w;
      let x = free.x;
      for (const r of row) {
        const w = r.area / stripH;
        out.push({ item: r.item, rect: { x, y: free.y, w, h: stripH } });
        x += w;
      }
      free.y += stripH;
      free.h -= stripH;
    }
  };

  let row: { item: T; area: number }[] = [];
  for (const it of queue) {
    const side = Math.min(free.w, free.h);
    const current = row.map((r) => r.area);
    if (row.length === 0 || worst([...current, it.area], side) <= worst(current, side)) {
      row.push(it);
    } else {
      layoutRow(row);
      row = [it];
    }
  }
  if (row.length > 0) layoutRow(row);
  return out;
}

/** Shrink a rect inward on all sides. */
export function insetRect(r: Rect, pad: number): Rect {
  const p = Math.min(pad, r.w / 2 - 1e-4, r.h / 2 - 1e-4);
  return { x: r.x + p, y: r.y + p, w: r.w - 2 * p, h: r.h - 2 * p };
}
