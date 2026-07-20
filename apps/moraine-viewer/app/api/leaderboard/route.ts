import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chQuery } from "@/lib/clickhouse";
import {
  BenchmarkRow,
  CANDIDATE_MODELS,
  CandidateModel,
  ClusterDatum,
  LeaderboardPayload,
  QUALITY_FLOOR,
} from "@/components/leaderboard/types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Deterministic pseudo-random from a string (FNV-1a → [0,1)). No Math.random.
// ---------------------------------------------------------------------------
function hash01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

// Per-model priors: quality center/spread vs frontier=1.0, cost multiplier, latency.
const MODEL_PRIORS: Record<
  CandidateModel,
  { q: number; spread: number; cost: number; latency: number }
> = {
  "gemma-4-e2b-understudy": { q: 0.84, spread: 0.14, cost: 0.02, latency: 380 },
  "gemma-4-27b": { q: 0.91, spread: 0.09, cost: 0.08, latency: 900 },
  "nemotron-3-nano": { q: 0.8, spread: 0.15, cost: 0.03, latency: 420 },
  "glm-5.2": { q: 0.95, spread: 0.06, cost: 0.25, latency: 1400 },
  "qwen3-coder": { q: 0.9, spread: 0.1, cost: 0.12, latency: 1100 },
};

function syntheticBenchmarks(clusterId: string): BenchmarkRow[] {
  return CANDIDATE_MODELS.map((model) => {
    const p = MODEL_PRIORS[model];
    const rQ = hash01(`${clusterId}::${model}::q`);
    const rC = hash01(`${clusterId}::${model}::c`);
    const rL = hash01(`${clusterId}::${model}::l`);
    const quality = Math.min(1.04, Math.max(0.55, p.q + (rQ - 0.5) * 2 * p.spread));
    const costMult = p.cost * (0.75 + rC * 0.5);
    const latencyMs = Math.round(p.latency * (0.8 + rL * 0.5));
    return {
      model,
      quality: Math.round(quality * 1000) / 1000,
      costMult: Math.round(costMult * 10000) / 10000,
      latencyMs,
      qualified: quality >= QUALITY_FLOOR,
    };
  });
}

function pickWinner(rows: BenchmarkRow[]): BenchmarkRow {
  const qualified = rows.filter((r) => r.qualified);
  if (qualified.length === 0) {
    return rows.reduce((a, b) => (b.quality > a.quality ? b : a));
  }
  // best quality-per-cost above the floor
  return qualified.reduce((a, b) => (b.quality / b.costMult > a.quality / a.costMult ? b : a));
}

// ---------------------------------------------------------------------------
// Real measured evals (scripts/evalrun.ts). Each eval file scores dev
// instances of one task-cluster benchmark; those instances carry the real
// project/harness they came from, so an eval maps onto the treemap cluster
// (project-leaf::harness) that dominates its evaluated instances.
// ---------------------------------------------------------------------------
type MeasuredEval = {
  candidate: string;
  kind: string;
  judge: string;
  mean: number;
  n: number;
  benchmark: string;
};

// candidate id used by evalrun.ts → leaderboard model row id
function candidateToModel(candidate: string): string {
  if (candidate.startsWith("local:gemma-4-e2b") || candidate.startsWith("gemma-4-e2b")) {
    return "gemma-4-e2b-understudy";
  }
  return candidate;
}

// cost/latency priors for measured model rows (quality comes from the eval).
const MEASURED_PRIORS: Record<string, { cost: number; latency: number }> = {
  "gemma-4-e2b-understudy": { cost: 0.02, latency: 380 },
  "gemma-4-31b-it": { cost: 0.08, latency: 900 },
  "glm-5.2": { cost: 0.25, latency: 1400 },
  "nemotron-3-super": { cost: 0.06, latency: 800 },
  "claude-opus-4-8": { cost: 1, latency: 2500 },
};

function loadMeasuredEvals(): Map<string, MeasuredEval[]> {
  const byClusterId = new Map<string, MeasuredEval[]>();
  const evalDir = path.join(process.cwd(), "data", "evals");
  if (!existsSync(evalDir)) return byClusterId;
  for (const file of readdirSync(evalDir)) {
    // multi-model sweep files only: <benchmark-slug>__<candidate-slug>.json
    if (!file.endsWith(".json") || !file.includes("__")) continue;
    try {
      const slug = file.replace(/\.json$/, "").split("__")[0];
      const ev = JSON.parse(readFileSync(path.join(evalDir, file), "utf8"));
      const draft = JSON.parse(
        readFileSync(path.join(process.cwd(), "data", "benchmarks", `${slug}.json`), "utf8"),
      ) as {
        instances: Array<{ instance_id: string; context: { project: string; harness: string } }>;
      };
      // modal project-leaf::harness among the instances this eval actually scored
      const scored = new Set(ev.results.map((r: { instance_id: string }) => r.instance_id));
      const counts = new Map<string, number>();
      for (const inst of draft.instances) {
        if (!scored.has(inst.instance_id)) continue;
        const leaf = inst.context.project.split("/").filter(Boolean).pop() ?? "(no-cwd)";
        const id = `${leaf}::${inst.context.harness}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      let best: string | null = null;
      let bestN = 0;
      for (const [id, n] of counts) if (n > bestN) [best, bestN] = [id, n];
      if (!best) continue;
      const entry: MeasuredEval = {
        candidate: ev.candidate,
        kind: ev.kind,
        judge: ev.judge,
        mean: ev.mean,
        n: ev.n,
        benchmark: ev.benchmark,
      };
      const list = byClusterId.get(best) ?? [];
      // same model measured twice for a cluster: keep the larger-n eval
      const model = candidateToModel(entry.candidate);
      const i = list.findIndex((e) => candidateToModel(e.candidate) === model);
      if (i >= 0) {
        if (entry.n > list[i].n) list[i] = entry;
      } else {
        list.push(entry);
      }
      byClusterId.set(best, list);
    } catch {
      // malformed eval/benchmark file — skip
    }
  }
  return byClusterId;
}

interface ClusterRow {
  leaf: string;
  harness: string;
  dominant_tool: string;
  sessions: string;
  events: string;
  toks: string;
}

interface TotalsRow {
  sessions: string;
  events: string;
  toks: string;
}

// Blended $/Mtok used only for the header "est. token spend" figure.
const EST_USD_PER_MTOK = 6;

export async function GET() {
  try {
    // Proxy task clusters: top-of-cwd project leaf × harness, with dominant tool mix.
    // Real clustering is Stage 2 — this is a cheap, honest stand-in from real events.
    const [clusterRows, totalsRows] = await Promise.all([
      chQuery<ClusterRow>(`
        SELECT
          if(cwd = '', '(no-cwd)', arrayElement(splitByChar('/', cwd), length(splitByChar('/', cwd)))) AS leaf,
          harness,
          topK(1)(if(tool_name = '', NULL, tool_name))[1] AS dominant_tool,
          uniqExact(session_id) AS sessions,
          count() AS events,
          sum(input_tokens + output_tokens) AS toks
        FROM events
        WHERE event_ts > '2026-06-01' AND is_substream = 0
        GROUP BY leaf, harness
        HAVING events > 500
        ORDER BY events DESC
        LIMIT 14
      `),
      chQuery<TotalsRow>(`
        SELECT
          uniqExact(session_id) AS sessions,
          count() AS events,
          sum(input_tokens + output_tokens) AS toks
        FROM events
        WHERE event_ts > '2026-06-01' AND is_substream = 0
      `),
    ]);

    const measuredEvals = loadMeasuredEvals();

    const clusters: ClusterDatum[] = clusterRows.map((row) => {
      const id = `${row.leaf}::${row.harness}`;
      // measured sweep rows first (actual measured model set), then synthetic
      // rows for candidate models NOT covered by a measurement — clearly synthetic.
      const measured = measuredEvals.get(id) ?? [];
      const measuredRows: BenchmarkRow[] = measured.map((ev) => {
        const model = candidateToModel(ev.candidate);
        const p = MEASURED_PRIORS[model] ?? { cost: 0.5, latency: 1500 };
        return {
          model,
          quality: ev.mean,
          costMult: p.cost,
          latencyMs: p.latency,
          qualified: ev.mean >= QUALITY_FLOOR,
          measured: true,
          measuredKind: ev.kind,
          measuredN: ev.n,
          measuredJudge: ev.judge,
        };
      });
      const measuredModels = new Set(measuredRows.map((r) => r.model));
      const benchmarks: BenchmarkRow[] = [
        ...measuredRows,
        ...syntheticBenchmarks(id).filter((b) => !measuredModels.has(b.model)),
      ];
      // winner: prefer measured rows whenever any exist for the cluster
      const winner = pickWinner(measuredRows.length > 0 ? measuredRows : benchmarks);
      return {
        id,
        label: row.leaf,
        harness: row.harness,
        dominantTool: row.dominant_tool || "—",
        sessions: Number(row.sessions),
        events: Number(row.events),
        tokens: Number(row.toks),
        benchmarks,
        winner: winner.model,
        winnerQuality: winner.quality,
        winnerCostMult: winner.costMult,
        promoted: winner.quality >= QUALITY_FLOOR && winner.costMult < 0.1,
      };
    });

    const t = totalsRows[0];
    const tokens = t ? Number(t.toks) : 0;
    const payload: LeaderboardPayload = {
      totals: {
        sessions: t ? Number(t.sessions) : 0,
        events: t ? Number(t.events) : 0,
        tokens,
        estSpendUsd: Math.round((tokens / 1_000_000) * EST_USD_PER_MTOK),
      },
      clusters,
      generatedAt: new Date().toISOString(),
      synthetic: true,
    };
    return Response.json(payload);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "query failed" },
      { status: 500 },
    );
  }
}
