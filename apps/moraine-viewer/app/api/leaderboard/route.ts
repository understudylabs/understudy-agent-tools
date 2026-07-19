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

    const clusters: ClusterDatum[] = clusterRows.map((row) => {
      const id = `${row.leaf}::${row.harness}`;
      const benchmarks = syntheticBenchmarks(id);
      const winner = pickWinner(benchmarks);
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
