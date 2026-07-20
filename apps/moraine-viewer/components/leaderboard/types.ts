// Shared types for the /leaderboard benchmark overlay.

export const CANDIDATE_MODELS = [
  "gemma-4-e2b-understudy",
  "gemma-4-27b",
  "nemotron-3-nano",
  "glm-5.2",
  "qwen3-coder",
] as const;

export type CandidateModel = (typeof CANDIDATE_MODELS)[number];

// CSS-token hexes (mirrors app/globals.css --model-* values; three.js needs raw hex).
// Includes measured sweep model ids beyond the synthetic candidate list.
export const MODEL_COLORS: Record<string, string> = {
  "gemma-4-e2b-understudy": "#9edbd3", // mint
  "gemma-4-27b": "#d97757", // clay
  "nemotron-3-nano": "#f2b34c", // amber
  "glm-5.2": "#a78bfa", // violet
  "qwen3-coder": "#67e8f9", // cyan
  // measured sweep additions
  "gemma-4-31b-it": "#d97757", // clay
  "nemotron-3-super": "#f2b34c", // amber
  "claude-opus-4-8": "#fb7185", // rose (frontier)
};

export function modelColor(model: string): string {
  return MODEL_COLORS[model] ?? "#8b8d93";
}

export const PROMOTED_GREEN = "#6ee7a0";

// Quality floor: winner must score at least this fraction of the frontier baseline.
export const QUALITY_FLOOR = 0.82;

export interface BenchmarkRow {
  /** synthetic candidate id or measured sweep model id */
  model: string;
  /** quality vs frontier baseline, frontier = 1.0 (measured rows: judge mean) */
  quality: number;
  /** cost multiplier vs frontier, e.g. 0.05 = 20x cheaper */
  costMult: number;
  latencyMs: number;
  qualified: boolean;
  /** true when quality is a REAL measured eval (scripts/evalrun.ts), not synthetic */
  measured?: boolean;
  measuredKind?: string;
  measuredN?: number;
  measuredJudge?: string;
}

export interface ClusterDatum {
  id: string;
  label: string;
  harness: string;
  dominantTool: string;
  sessions: number;
  events: number;
  tokens: number;
  benchmarks: BenchmarkRow[];
  winner: string;
  winnerQuality: number;
  winnerCostMult: number;
  /** winner beats quality floor at >10x cheaper */
  promoted: boolean;
}

export interface LeaderboardPayload {
  totals: {
    sessions: number;
    events: number;
    tokens: number;
    estSpendUsd: number;
  };
  clusters: ClusterDatum[];
  generatedAt: string;
  synthetic: true;
}
