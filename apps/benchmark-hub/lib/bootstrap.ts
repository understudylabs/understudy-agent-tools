/**
 * Percentile-bootstrap confidence intervals over per-task mean scores.
 *
 * Pure and DETERMINISTIC: the PRNG is seeded (fnv1a over a caller-provided
 * seed string + mulberry32) so the same rows always produce the same CI —
 * no Math.random anywhere, so tests and reruns are exactly reproducible.
 *
 * The resampling unit is the TASK, not the row: rollout repeats of one task
 * are correlated, so we first collapse rows to per-task means and then
 * resample tasks with replacement. With one task the interval collapses to a
 * degenerate [mean, mean] — honest (no between-task variance is observable),
 * and the UI should treat everything as a tie at N=1.
 */

export type BootstrapCI = {
  lo: number;
  hi: number;
  /** The statistic the interval brackets: the macro-average (mean of per-task means). */
  mean: number;
  iterations: number;
  /** Number of distinct tasks resampled (the effective N). */
  taskN: number;
};

/** fnv1a 32-bit string hash — a stable seed derivation for string keys. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile over a SORTED ascending array (p in [0,1]). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export type BootstrapOptions = {
  /** Resample count; the fixed project default is 2000. */
  iterations?: number;
  /** Seed string (e.g. `${benchmarkId}::${model}`); same seed => same CI. */
  seed?: string;
  /** Two-sided coverage, default 0.95 (percentile bounds at 2.5 / 97.5). */
  coverage?: number;
};

/**
 * Percentile-bootstrap CI over per-task mean scores. Returns null when there
 * are no tasks to resample.
 */
export function bootstrapCI(perTaskMeans: number[], options: BootstrapOptions = {}): BootstrapCI | null {
  const n = perTaskMeans.length;
  if (n === 0) return null;
  const iterations = options.iterations ?? 2000;
  const coverage = options.coverage ?? 0.95;
  const mean = perTaskMeans.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { lo: mean, hi: mean, mean, iterations, taskN: 1 };
  const rand = mulberry32(fnv1a(options.seed ?? "understudy-bootstrap"));
  const stats: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += perTaskMeans[Math.floor(rand() * n)];
    stats[i] = sum / n;
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - coverage) / 2;
  return { lo: percentile(stats, alpha), hi: percentile(stats, 1 - alpha), mean, iterations, taskN: n };
}

/** Group rows' scores by task and return per-task means (input: [taskId, score] pairs). */
export function perTaskMeans(pairs: Array<[string, number]>): number[] {
  const byTask = new Map<string, { sum: number; n: number }>();
  for (const [taskId, score] of pairs) {
    const cur = byTask.get(taskId) ?? { sum: 0, n: 0 };
    cur.sum += score;
    cur.n += 1;
    byTask.set(taskId, cur);
  }
  return [...byTask.values()].map((v) => v.sum / v.n);
}
