/* 20 · orchard — synthetic run generator + world layout.
 *
 * One seeded AIDE-style outer loop: aide_0 plus 99 rewrite proposals,
 * seven of which move the record. Every proposal is an evaluation — a
 * grove of dozens of solution searches, each search a tree of nodes.
 * Everything is laid out once in a single continuous world so the
 * renderer can morph between scales instead of switching views:
 *
 *   meta      records walk a meandering spine; failed proposals
 *             orbit the record they tried to beat
 *   grove     searches sit on a phyllotaxis disc around the proposal
 *   tree      tidy top-down layout inside each search's slot
 *
 * The generator is deterministic (mulberry32) so replay, layout and
 * picking agree across mounts. A real-run adapter only needs to emit
 * the same World shape.
 */

export const RECORD_STEPS = [2, 6, 28, 39, 47, 63, 85];
export const MAX_STEP = 99;
export const BASE_PERF = 0.7032;
export const FINAL_PERF = 0.7784;

/* world-space constants shared with the engine's LOD bands */
export const EVAL_R = 9; // grove disc radius
export const SPINE_GAP = 150; // distance between consecutive records

export type NodeState = 0 | 1 | 2 | 3 | 4; // root · done · best · dead · running

export type EvalMeta = {
  id: number;
  step: number;
  x: number;
  y: number;
  perf: number;
  record: boolean;
  parent: number; // eval id of the record this proposal built on (-1 for aide_0)
  rule: string;
  frontier: number; // record value as of this step
  s0: number;
  s1: number; // search range [s0, s1)
  n0: number;
  n1: number; // node range [n0, n1)
};

export type SearchMeta = {
  id: number;
  eval: number;
  x: number;
  y: number;
  best: number; // best node score in this search
  bestNode: number;
  n0: number;
  n1: number;
  depth: number;
};

export type World = {
  evals: EvalMeta[];
  searches: SearchMeta[];
  records: number[]; // eval ids, chronological (starts with aide_0)
  /* node SoA for picking + inspection */
  nx: Float32Array;
  ny: Float32Array;
  nscore: Float32Array;
  nstate: Uint8Array;
  nsearch: Int32Array;
  nodeCount: number;
  /* interleaved vertex data, STRIDE floats per vertex */
  points: Float32Array;
  lines: Float32Array;
  pointCount: number;
  lineVertCount: number;
  frontierByStep: Float32Array; // record value after each outer step
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /* real-data adapters may name evals (index = eval id); synthetic
   * worlds leave this unset and the page falls back to aide_N */
  names?: string[];
  /* real-data adapters may caption nodes (index = global node id) —
   * e.g. "case 2296 · label 31 → 104 · wrong" */
  nlabel?: string[];
  /* raw trace per node — the actual input the case graded (shown at
   * case zoom on hover/select) */
  ntrace?: string[];
};

/* vertex layout — keep in sync with engine.ts attribute table */
export const STRIDE = 21;
// aPos(2) aAnchor(2) aBirth(2) aStep aSize aMin aMax aColor(3) aAlpha aBand(4) aSpread(2) aEval

export const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/* palette in linear-ish rgb (matches flows/lib hexes) */
export const MINT: RGB = [0.62, 0.86, 0.83]; // #9edbd3 — a finished node
export const VIOLET: RGB = [0.655, 0.545, 0.98]; // #a78bfa — best of its search
export const INK: RGB = [0.949, 0.949, 0.941]; // #f2f2f0
export const RED: RGB = [0.898, 0.325, 0.294]; // #e5534b — dead end
export const AMBER: RGB = [0.949, 0.702, 0.298]; // #f2b34c — record proposal
export const GREEN: RGB = [0.431, 0.906, 0.627]; // #6ee7a0 — the frontier
export type RGB = [number, number, number];

/* LOD bands (css-px per world unit): [fadeIn0, fadeIn1, fadeOut0, fadeOut1] */
const ALWAYS_IN = -1;
const NEVER_OUT = 9e8;
export const BAND_EVAL: Band = [ALWAYS_IN, 0, 2.6, 4.8];
export const BAND_SPOKE: Band = [ALWAYS_IN, 0, 2.8, 4.6];
export const BAND_SPINE: Band = [ALWAYS_IN, 0, 4.5, 7.5];
export const BAND_SEARCH: Band = [1.4, 2.8, 7, 13];
export const BAND_NODE: Band = [3.5, 8, NEVER_OUT, NEVER_OUT + 1];
const BAND_EDGE: Band = [7, 16, NEVER_OUT, NEVER_OUT + 1];
export type Band = [number, number, number, number];

/* collapse thresholds: below spread0 the vertex sits on its anchor */
export const SPREAD_NONE: [number, number] = [0, 0.0001];
export const SPREAD_SEARCH: [number, number] = [1.1, 2.5];
export const SPREAD_NODE: [number, number] = [2.2, 6.5];

const WIN_RULES = [
  "demands a root-cause diagnosis before any fix",
  "caps retries at two — banks the failing diff instead",
  "adds a plan critic that vetoes single-file rewrites",
  "seeds each search from the last surviving patch",
  "runs the evaluator twice and trusts only agreement",
  "shrinks the edit window to the failing hunk",
  "prefers reverts over repairs past depth four",
];

const FAIL_RULES = [
  "swaps the planner for freeform chain-of-thought",
  "doubles the search width — drowns in duplicates",
  "lets the agent edit its own harness mid-run",
  "drops the diff summary from the context",
  "raises temperature on retries",
  "prunes any branch that regresses once",
  "batches evaluations to save tokens",
  "asks for three candidate fixes per node",
  "trims the transcript to the last two turns",
  "rewrites the whole file on every proposal",
  "adds a self-score the search learns to game",
  "caches evaluator verdicts across branches",
];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* one tree: parents biased to chain (long droops) with occasional fans */
function growTree(rand: () => number, n: number) {
  const parent = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    if (rand() < 0.55) parent[i] = i - 1;
    else {
      const a = Math.floor(rand() * i);
      const b = Math.floor(rand() * i);
      parent[i] = Math.min(a, b); // bias to earlier (shallower) nodes
    }
  }
  return parent;
}

/* tidy top-down layout into a unit box: x by leaf slots, y by depth */
function layoutTree(parent: Int32Array) {
  const n = parent.length;
  const kids: number[][] = Array.from({ length: n }, () => []);
  for (let i = 1; i < n; i++) kids[parent[i]].push(i);
  const depth = new Float32Array(n);
  for (let i = 1; i < n; i++) depth[i] = depth[parent[i]] + 1;
  const x = new Float32Array(n);
  let slot = 0;
  const walk = (v: number) => {
    if (kids[v].length === 0) {
      x[v] = slot++;
      return;
    }
    for (const k of kids[v]) walk(k);
    x[v] = (x[kids[v][0]] + x[kids[v][kids[v].length - 1]]) / 2;
  };
  walk(0);
  const leaves = slot; // number of leaf slots
  let maxD = 1;
  for (let i = 0; i < n; i++) maxD = Math.max(maxD, depth[i]);
  return { x, depth, leaves, maxD, kids };
}

export function generateRun(seed = 20260715): World {
  const rand = mulberry32(seed);
  const gauss = () => (rand() + rand() + rand()) / 1.5 - 1; // ~[-1,1]

  /* ---- outer loop: perf trajectory ---- */
  const recordSet = new Set(RECORD_STEPS);
  const frontierByStep = new Float32Array(MAX_STEP + 1);
  const perfByStep = new Float32Array(MAX_STEP + 1);
  // diminishing record deltas that land exactly on FINAL_PERF
  const weights = RECORD_STEPS.map((_, i) => 1 / (i + 1.35));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const gain = FINAL_PERF - BASE_PERF;
  let frontier = BASE_PERF;
  const recPerf = new Map<number, number>();
  RECORD_STEPS.forEach((s, i) => {
    frontier += (gain * weights[i]) / wSum;
    recPerf.set(s, frontier);
  });
  frontier = BASE_PERF;
  for (let s = 0; s <= MAX_STEP; s++) {
    if (recordSet.has(s)) frontier = recPerf.get(s)!;
    frontierByStep[s] = frontier;
    if (s === 0) perfByStep[s] = BASE_PERF;
    else if (recordSet.has(s)) perfByStep[s] = frontier;
    else {
      // honest scatter under the line, a few catastrophes
      const drop =
        rand() < 0.12 ? 0.02 + rand() * 0.05 : 0.002 + Math.abs(gauss()) * 0.014;
      perfByStep[s] = Math.max(0.688, frontierByStep[s] - drop);
    }
  }

  /* ---- meta layout: records walk a meandering spine ---- */
  const recPos: { x: number; y: number }[] = [];
  let hx = 0.35,
    hy = 0.55; // heading, roughly down-right
  let px = 0,
    py = 0;
  recPos.push({ x: 0, y: 0 }); // aide_0
  for (let i = 0; i < RECORD_STEPS.length; i++) {
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

  /* ---- evaluations ---- */
  const evals: EvalMeta[] = [];
  const searches: SearchMeta[] = [];
  const records: number[] = [];
  const orbitCount = new Map<number, number>(); // per parent record
  let winRule = 0,
    failRule = 0;

  // provisional counts to size arrays
  const searchCountFor: number[] = [];
  const nodeCountFor: number[][] = [];
  let totalNodes = 0;
  for (let s = 0; s <= MAX_STEP; s++) {
    const nS = 18 + Math.floor(rand() * 25); // 18..42 searches
    const perSearch: number[] = [];
    for (let i = 0; i < nS; i++) {
      const nN = 12 + Math.floor(rand() * 59); // 12..70 nodes
      perSearch.push(nN);
      totalNodes += nN;
    }
    searchCountFor.push(nS);
    nodeCountFor.push(perSearch);
  }

  const nx = new Float32Array(totalNodes);
  const ny = new Float32Array(totalNodes);
  const nscore = new Float32Array(totalNodes);
  const nstate = new Uint8Array(totalNodes);
  const nsearch = new Int32Array(totalNodes);
  const nparent = new Int32Array(totalNodes);
  const nstep = new Float32Array(totalNodes);

  let nodePtr = 0;
  let recIdx = 0; // index into recPos of current record
  let parentEval = -1;

  for (let s = 0; s <= MAX_STEP; s++) {
    const isRec = s === 0 || recordSet.has(s);
    let cx: number, cy: number;
    if (isRec) {
      const p = recPos[s === 0 ? 0 : RECORD_STEPS.indexOf(s) + 1];
      cx = p.x;
      cy = p.y;
    } else {
      const anchor = recPos[recIdx];
      const k = orbitCount.get(recIdx) ?? 0;
      orbitCount.set(recIdx, k + 1);
      const ang = k * GOLDEN + recIdx * 1.7 + rand() * 0.35;
      const rad = 30 + 13 * Math.sqrt(k + 1) + rand() * 6;
      cx = anchor.x + Math.cos(ang) * rad;
      cy = anchor.y + Math.sin(ang) * rad;
    }

    const rule =
      s === 0
        ? "the seed agent — hand-written harness"
        : isRec
          ? WIN_RULES[winRule++ % WIN_RULES.length]
          : FAIL_RULES[failRule++ % FAIL_RULES.length];

    const ev: EvalMeta = {
      id: s,
      step: s,
      x: cx,
      y: cy,
      perf: perfByStep[s],
      record: isRec,
      parent: parentEval,
      rule,
      frontier: frontierByStep[s],
      s0: searches.length,
      s1: searches.length + searchCountFor[s],
      n0: nodePtr,
      n1: nodePtr,
    };

    /* grove: searches on a phyllotaxis disc */
    const nS = searchCountFor[s];
    for (let i = 0; i < nS; i++) {
      const ang = i * GOLDEN + s * 0.9;
      const rad = EVAL_R * Math.sqrt((i + 0.5) / nS);
      const sx = cx + Math.cos(ang) * rad;
      const sy = cy + Math.sin(ang) * rad;
      const nN = nodeCountFor[s][i];
      const parent = growTree(rand, nN);
      const lay = layoutTree(parent);
      const boxW = Math.min(2.4, Math.max(0.8, lay.leaves * 0.11));
      const boxH = Math.min(2.6, Math.max(0.9, lay.maxD * 0.16));
      const n0 = nodePtr;

      /* scores: random walk from the era frontier */
      const base = frontierByStep[Math.max(0, s - 1)] - 0.004;
      const xDenom = Math.max(1, lay.leaves - 1);
      for (let j = 0; j < nN; j++) {
        const gi = nodePtr;
        nsearch[gi] = searches.length;
        nparent[gi] = j === 0 ? -1 : n0 + parent[j];
        nscore[gi] =
          j === 0 ? base : nscore[nparent[gi]] + gauss() * 0.006 + 0.0008;
        const xn = lay.leaves > 1 ? lay.x[j] / xDenom : 0.5;
        nx[gi] = sx + (xn - 0.5) * boxW + gauss() * 0.045;
        ny[gi] = sy - boxH / 2 + (lay.depth[j] / lay.maxD) * boxH + gauss() * 0.045;
        nodePtr++;
      }
      /* states: best of search, dead leaves */
      let bestNode = n0,
        best = -Infinity;
      for (let j = 0; j < nN; j++) {
        const gi = n0 + j;
        if (nscore[gi] > best) {
          best = nscore[gi];
          bestNode = gi;
        }
      }
      for (let j = 0; j < nN; j++) {
        const gi = n0 + j;
        const isLeaf = lay.kids[j].length === 0;
        nstate[gi] =
          j === 0
            ? 0
            : gi === bestNode
              ? 2
              : isLeaf && nscore[gi] < nscore[nparent[gi]] - 0.004
                ? 3
                : 1;
      }
      searches.push({
        id: searches.length,
        eval: s,
        x: sx,
        y: sy,
        best,
        bestNode,
        n0,
        n1: nodePtr,
        depth: lay.maxD,
      });
    }
    ev.n1 = nodePtr;

    /* nudge scores so the eval's best equals its reported perf */
    let evBest = -Infinity;
    for (let gi = ev.n0; gi < ev.n1; gi++) evBest = Math.max(evBest, nscore[gi]);
    const off = ev.perf - evBest;
    for (let gi = ev.n0; gi < ev.n1; gi++) nscore[gi] += off;
    for (let si = ev.s0; si < ev.s1; si++) searches[si].best += off;

    /* reveal order: searches grow in parallel (round-robin by depth-in-tree) */
    const spans: [number, number][] = [];
    for (let si = ev.s0; si < ev.s1; si++) spans.push([searches[si].n0, searches[si].n1]);
    const order: number[] = [];
    for (let j = 0; ; j++) {
      let any = false;
      for (const [a, b] of spans)
        if (a + j < b) {
          order.push(a + j);
          any = true;
        }
      if (!any) break;
    }
    order.forEach((gi, k) => {
      nstep[gi] = s + 0.05 + 0.85 * (k / order.length);
    });

    evals.push(ev);
    if (isRec) {
      records.push(s);
      recIdx = records.length - 1;
      parentEval = s;
    }
  }

  /* ---- pack vertex buffers ---- */
  const searchVerts = searches.length;
  const evalVerts = evals.length;
  const pointCount = totalNodes + searchVerts + evalVerts;
  const points = new Float32Array(pointCount * STRIDE);

  let treeEdges = 0;
  for (let gi = 0; gi < totalNodes; gi++) if (nparent[gi] >= 0) treeEdges++;
  const spokeEdges = evals.length - records.length;
  const spineEdges = records.length - 1;
  const lineVertCount = (treeEdges + spokeEdges + spineEdges) * 2;
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

  /* nodes */
  for (let gi = 0; gi < totalNodes; gi++) {
    const se = searches[nsearch[gi]];
    const ev = evals[se.eval];
    const st = nstate[gi];
    const rgb = st === 0 ? INK : st === 2 ? VIOLET : st === 3 ? RED : MINT;
    const alpha = st === 3 ? 0.38 : st === 2 ? 1 : 0.88;
    const size = st === 2 ? 0.11 : st === 0 ? 0.085 : 0.062;
    const bx = nparent[gi] >= 0 ? nx[nparent[gi]] : se.x;
    const by = nparent[gi] >= 0 ? ny[nparent[gi]] : se.y;
    put(
      points,
      p++,
      nx[gi],
      ny[gi],
      se.x,
      se.y,
      bx,
      by,
      nstep[gi],
      size,
      1.7,
      st === 2 ? 30 : 22,
      rgb,
      alpha,
      BAND_NODE,
      SPREAD_NODE,
      ev.id
    );
  }
  /* search dots */
  for (const se of searches) {
    const ev = evals[se.eval];
    const n = se.n1 - se.n0;
    put(
      points,
      p++,
      se.x,
      se.y,
      ev.x,
      ev.y,
      ev.x,
      ev.y,
      ev.step + 0.05,
      0.16 * Math.sqrt(n),
      2,
      30,
      INK,
      0.55,
      BAND_SEARCH,
      SPREAD_SEARCH,
      ev.id
    );
  }
  /* eval dots */
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
  /* tree edges: parent vert then child vert (child sprouts from parent) */
  for (let gi = 0; gi < totalNodes; gi++) {
    const pa = nparent[gi];
    if (pa < 0) continue;
    const se = searches[nsearch[gi]];
    const evId = se.eval;
    const dead = nstate[gi] === 3;
    const rgb = dead ? RED : INK;
    const alpha = dead ? 0.1 : 0.2;
    put(lines, l++, nx[pa], ny[pa], se.x, se.y, nx[pa], ny[pa], nstep[gi], 0, 0, 0, rgb, alpha, BAND_EDGE, SPREAD_NODE, evId);
    put(lines, l++, nx[gi], ny[gi], se.x, se.y, nx[pa], ny[pa], nstep[gi], 0, 0, 0, rgb, alpha, BAND_EDGE, SPREAD_NODE, evId);
  }
  /* spokes: record → failed proposal */
  for (const ev of evals) {
    if (ev.record || ev.parent < 0) continue;
    const par = evals[ev.parent];
    put(lines, l++, par.x, par.y, par.x, par.y, par.x, par.y, ev.step, 0, 0, 0, INK, 0.1, BAND_SPOKE, SPREAD_NONE, ev.id);
    put(lines, l++, ev.x, ev.y, ev.x, ev.y, par.x, par.y, ev.step, 0, 0, 0, INK, 0.1, BAND_SPOKE, SPREAD_NONE, ev.id);
  }
  /* spine: record → record, frontier green */
  for (let i = 1; i < records.length; i++) {
    const a = evals[records[i - 1]];
    const b = evals[records[i]];
    put(lines, l++, a.x, a.y, a.x, a.y, a.x, a.y, b.step, 0, 0, 0, GREEN, 0.55, BAND_SPINE, SPREAD_NONE, b.id);
    put(lines, l++, b.x, b.y, b.x, b.y, a.x, a.y, b.step, 0, 0, 0, GREEN, 0.55, BAND_SPINE, SPREAD_NONE, b.id);
  }

  /* bounds over eval centers + orbit reach */
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
    nodeCount: totalNodes,
    points,
    lines,
    pointCount,
    lineVertCount,
    frontierByStep,
    bounds: { x0, y0, x1, y1 },
  };
}
