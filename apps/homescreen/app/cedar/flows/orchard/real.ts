/* 20 · orchard — real data. Derek's UND-289 campaign (replace the
 * Instacart shopper pipeline) rendered as the field: every scored Modal
 * run is a dot in true launch order, records walk the spine when a run
 * raises the best score on the frozen 559-row dev set, and failed
 * proposals orbit the run they actually built on (parent_run_id — real
 * lineage, not decoration). Runs on other benchmarks (1103 full
 * pipeline, smoke sets) appear with their honest scores but never set
 * records — different denominators don't compare.
 *
 * One search dot per run carries its architecture. Where a run's own
 * artifact carries per-case grades (input_id/expected/predicted/correct
 * — the fireworks holdout format), the cases become the node level:
 * zoom into that run and see exactly which of Derek's rows it got
 * right (mint) and wrong (red), same disc position for the same case
 * across runs. No grades in the artifact → no nodes; nothing is
 * inferred.
 *
 * Snapshot: app/cedar/flows/orchard/und289.json — refresh with
 * scripts/export-und289.py (reads the orchestrator sqlite read-only).
 */

import raw from "./und289.json";
import {
  AMBER,
  BAND_EVAL,
  BAND_NODE,
  BAND_SEARCH,
  BAND_SPINE,
  BAND_SPOKE,
  EVAL_R,
  GOLDEN,
  GREEN,
  INK,
  MINT,
  mulberry32,
  RED,
  SPINE_GAP,
  SPREAD_NODE,
  SPREAD_NONE,
  SPREAD_SEARCH,
  STRIDE,
  type Band,
  type EvalMeta,
  type RGB,
  type SearchMeta,
  type World,
} from "./run";

export type OrchardRun = {
  id: string;
  parent: string | null;
  family: string;
  arch: string;
  status: string;
  at: string | null;
  acc: number | null;
  balanced: number | null;
  bench: number | null;
  cost: number | null;
  elapsed: number | null;
  /* per-case grades where the run's artifact carries them, enriched
   * with canonical label names and the raw post text */
  cases?: {
    id: string;
    ok: boolean;
    state?: "not_started" | "running" | "succeeded" | "failed" | "timed_out";
    exp: string | number | null;
    got: string | number | null;
    expL?: string;
    gotL?: string;
    text?: string;
  }[];
};

export type OrchardRunSet = {
  campaign: string;
  as_of: string;
  primary_bench: number;
  spend_usd: number | null;
  runs: OrchardRun[];
};

export const UND289 = raw as OrchardRunSet;

export type RealTotals = {
  campaign: string;
  asOf: string;
  scored: number;
  failed: number;
  stopped: number;
  running: number;
  spend: number;
  primaryBench: number;
};

export function realTotals(): RealTotals {
  const by = (s: string) => UND289.runs.filter((r) => r.status === s).length;
  return {
    campaign: UND289.campaign,
    asOf: UND289.as_of,
    scored: UND289.runs.filter((r) => r.acc !== null).length,
    failed: by("failed"),
    stopped: by("stopped"),
    running: by("running"),
    spend: UND289.spend_usd ?? 0,
    primaryBench: UND289.primary_bench,
  };
}

export function buildRealWorld(
  data: OrchardRunSet = UND289,
  options: { includeUnscored?: boolean } = {},
): World {
  const rand = mulberry32(289);
  const runs = data.runs.filter((r) => options.includeUnscored || r.acc !== null);
  const primary = data.primary_bench;

  /* frontier + records over the primary (frozen dev) benchmark only */
  const records: number[] = [];
  const frontierByStep = new Float32Array(runs.length);
  let best = -Infinity;
  runs.forEach((r, i) => {
    const score = r.acc ?? (Number.isFinite(best) ? best : 0);
    if (r.acc !== null && r.bench === primary && score > best) {
      best = score;
      records.push(i);
    }
    frontierByStep[i] = best;
  });
  // steps before the first primary-bench run inherit its baseline
  const firstRec = records.length ? frontierByStep[records[0]] : 0;
  for (let i = 0; i < runs.length && frontierByStep[i] === -Infinity; i++)
    frontierByStep[i] = firstRec;

  /* spine walk for records, same meander as the synthetic field */
  const recPos: { x: number; y: number }[] = [];
  {
    let hx = 0.35,
      hy = 0.55,
      px = 0,
      py = 0;
    recPos.push({ x: 0, y: 0 });
    for (let i = 1; i < records.length; i++) {
      const turn = (rand() - 0.5) * 1.1;
      const c = Math.cos(turn),
        s = Math.sin(turn);
      [hx, hy] = [hx * c - hy * s, hx * s + hy * c];
      const m = Math.hypot(hx, hy);
      hx /= m;
      hy /= m;
      px += hx * SPINE_GAP;
      py += hy * SPINE_GAP;
      recPos.push({ x: px, y: py });
    }
  }

  /* place evals: records on the spine; everything else orbits its REAL
   * parent when we have one, else the latest record */
  const evals: EvalMeta[] = [];
  const searches: SearchMeta[] = [];
  const names: string[] = [];
  const idToStep = new Map(runs.map((r, i) => [r.id, i]));
  const recordSet = new Set(records);
  const orbitCount = new Map<number, number>();
  let latestRec = 0;

  /* node SoA — real graded cases, for the runs that have them. A case
   * keeps the same disc position in every run so failure maps compare
   * spatially across runs. */
  const totalCases = runs.reduce((a, r) => a + (r.cases?.length ?? 0), 0);
  const nx = new Float32Array(totalCases);
  const ny = new Float32Array(totalCases);
  const nscore = new Float32Array(totalCases);
  const nstate = new Uint8Array(totalCases);
  const nsearch = new Int32Array(totalCases);
  const nlabel: string[] = new Array(totalCases);
  const ntrace: string[] = new Array(totalCases);
  const caseSlot = new Map<string, number>(); // case id → shared disc slot
  let nodePtr = 0;

  runs.forEach((r, i) => {
    const isRec = recordSet.has(i);
    let cx: number, cy: number;
    let anchor = -1;
    if (isRec) {
      const p = recPos[records.indexOf(i)];
      cx = p.x;
      cy = p.y;
      anchor = latestRec === i ? -1 : records[Math.max(0, records.indexOf(i) - 1)];
    } else {
      const parentStep = r.parent != null ? idToStep.get(r.parent) : undefined;
      anchor = parentStep !== undefined && parentStep < i ? parentStep : records.length ? latestRec : 0;
      const a = evals[anchor] ?? { x: 0, y: 0 };
      const k = orbitCount.get(anchor) ?? 0;
      orbitCount.set(anchor, k + 1);
      const ang = k * GOLDEN + anchor * 1.7 + rand() * 0.35;
      const rad = 30 + 13 * Math.sqrt(k + 1) + rand() * 6;
      cx = a.x + Math.cos(ang) * rad;
      cy = a.y + Math.sin(ang) * rad;
    }

    const benchNote =
      r.bench === primary ? `${r.bench}-row dev set` : `${r.bench}-row benchmark — off the record board`;
    const rule = [r.arch || r.family, benchNote, r.cost != null ? `$${r.cost.toFixed(2)}` : null]
      .filter(Boolean)
      .join(" · ");

    /* graded cases → nodes on a disc around the run */
    const n0 = nodePtr;
    if (r.cases) {
      const nCases = r.cases.length;
      for (const c of r.cases) {
        let slot = caseSlot.get(c.id);
        if (slot === undefined) {
          slot = caseSlot.size;
          caseSlot.set(c.id, slot);
        }
        const ang = slot * GOLDEN;
        const rad = EVAL_R * 0.78 * Math.sqrt(((slot % nCases) + 0.5) / nCases);
        const gi = nodePtr++;
        nx[gi] = cx + Math.cos(ang) * rad;
        ny[gi] = cy + Math.sin(ang) * rad;
        nscore[gi] = typeof c.got === "number" ? c.got : -1;
        nstate[gi] = c.state === "running" ? 4 : c.ok ? 1 : 3;
        nsearch[gi] = i;
        const expName = c.expL ?? `label ${c.exp ?? "?"}`;
        const gotName = c.gotL ?? `label ${c.got ?? "?"}`;
        nlabel[gi] = c.state === "running"
          ? `running · ${c.id}`
          : c.ok
            ? `right · “${expName}”`
            : `wrong · expected “${expName}” → said “${gotName}”`;
        ntrace[gi] = c.text ?? "";
      }
    }

    evals.push({
      id: i,
      step: i,
      x: cx,
      y: cy,
      perf: r.acc ?? (Number.isFinite(frontierByStep[i]) ? frontierByStep[i] : 0),
      record: isRec,
      parent: anchor,
      rule,
      frontier: frontierByStep[i],
      s0: i,
      s1: i + 1,
      n0,
      n1: nodePtr,
    });
    names.push(r.family.toLowerCase());
    searches.push({
      id: i,
      eval: i,
      x: cx,
      y: cy - EVAL_R * 0.35,
      best: r.acc ?? (Number.isFinite(frontierByStep[i]) ? frontierByStep[i] : 0),
      bestNode: -1, // cases have no "best" — the page's ride uses the disc itself
      n0,
      n1: nodePtr,
      depth: 0,
    });
    if (isRec) latestRec = i;
  });

  /* ---- pack vertex buffers (same layout as run.ts) ---- */
  const pointCount = evals.length + searches.length + totalCases;
  const points = new Float32Array(pointCount * STRIDE);
  const spokeEdges = evals.length - records.length;
  const spineEdges = Math.max(0, records.length - 1);
  const lineVertCount = (spokeEdges + spineEdges) * 2;
  const lines = new Float32Array(lineVertCount * STRIDE);

  let p = 0;
  const put = (
    buf: Float32Array,
    at: number,
    x: number,
    y: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    step: number,
    size: number,
    min: number,
    max: number,
    rgb: RGB,
    alpha: number,
    band: Band,
    spread: [number, number],
    evalId: number
  ) => {
    const o = at * STRIDE;
    buf[o] = x;
    buf[o + 1] = y;
    buf[o + 2] = ax;
    buf[o + 3] = ay;
    buf[o + 4] = bx;
    buf[o + 5] = by;
    buf[o + 6] = step;
    buf[o + 7] = size;
    buf[o + 8] = min;
    buf[o + 9] = max;
    buf[o + 10] = rgb[0];
    buf[o + 11] = rgb[1];
    buf[o + 12] = rgb[2];
    buf[o + 13] = alpha;
    buf[o + 14] = band[0];
    buf[o + 15] = band[1];
    buf[o + 16] = band[2];
    buf[o + 17] = band[3];
    buf[o + 18] = spread[0];
    buf[o + 19] = spread[1];
    buf[o + 20] = evalId;
  };

  /* case nodes — a run's real failure map, sprouting from its dot */
  for (let gi = 0; gi < totalCases; gi++) {
    const ev = evals[nsearch[gi]];
    const ok = nstate[gi] === 1;
    const running = nstate[gi] === 4;
    put(
      points,
      p++,
      nx[gi],
      ny[gi],
      ev.x,
      ev.y,
      ev.x,
      ev.y,
      ev.step + 0.1 + ((gi - ev.n0) / Math.max(1, ev.n1 - ev.n0)) * 0.8,
      0.07,
      1.7,
      22,
      running ? INK : ok ? MINT : RED,
      running ? 0.95 : ok ? 0.8 : 0.85,
      BAND_NODE,
      SPREAD_NODE,
      ev.id
    );
  }
  /* search dots — one per run, its architecture made visible */
  for (const se of searches) {
    const ev = evals[se.eval];
    put(points, p++, se.x, se.y, ev.x, ev.y, ev.x, ev.y, ev.step + 0.05, 0.9, 2, 26, INK, 0.55, BAND_SEARCH, SPREAD_SEARCH, ev.id);
  }
  /* eval dots — sprout from their real parent */
  for (const ev of evals) {
    const par = ev.parent >= 0 ? evals[ev.parent] : ev;
    put(
      points,
      p++,
      ev.x,
      ev.y,
      ev.x,
      ev.y,
      par.x,
      par.y,
      ev.step,
      ev.record ? 4 : 2.2,
      ev.record ? 9 : 5.5,
      ev.record ? 15 : 9,
      ev.record ? AMBER : INK,
      ev.record ? 0.95 : 0.5,
      BAND_EVAL,
      SPREAD_NONE,
      ev.id
    );
  }

  let l = 0;
  /* spokes: real lineage — a run points at what it built on */
  for (const ev of evals) {
    if (ev.record || ev.parent < 0) continue;
    const par = evals[ev.parent];
    put(lines, l++, par.x, par.y, par.x, par.y, par.x, par.y, ev.step, 0, 0, 0, INK, 0.1, BAND_SPOKE, SPREAD_NONE, ev.id);
    put(lines, l++, ev.x, ev.y, ev.x, ev.y, par.x, par.y, ev.step, 0, 0, 0, INK, 0.1, BAND_SPOKE, SPREAD_NONE, ev.id);
  }
  /* spine: record → record */
  for (let i = 1; i < records.length; i++) {
    const a = evals[records[i - 1]];
    const b = evals[records[i]];
    put(lines, l++, a.x, a.y, a.x, a.y, a.x, a.y, b.step, 0, 0, 0, GREEN, 0.55, BAND_SPINE, SPREAD_NONE, b.id);
    put(lines, l++, b.x, b.y, b.x, b.y, a.x, a.y, b.step, 0, 0, 0, GREEN, 0.55, BAND_SPINE, SPREAD_NONE, b.id);
  }

  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ev of evals) {
    x0 = Math.min(x0, ev.x - EVAL_R - 8);
    y0 = Math.min(y0, ev.y - EVAL_R - 8);
    x1 = Math.max(x1, ev.x + EVAL_R + 8);
    y1 = Math.max(y1, ev.y + EVAL_R + 8);
  }

  return {
    evals,
    searches,
    records,
    nx,
    ny,
    nscore,
    nstate,
    nsearch,
    nodeCount: totalCases,
    points,
    lines,
    pointCount,
    lineVertCount: l,
    frontierByStep,
    bounds: { x0, y0, x1, y1 },
    names,
    nlabel,
    ntrace,
  };
}
