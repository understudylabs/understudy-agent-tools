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
export const MODEL_COLORS: Record<CandidateModel, string> = {
  "gemma-4-e2b-understudy": "#9edbd3", // mint
  "gemma-4-27b": "#d97757", // clay
  "nemotron-3-nano": "#f2b34c", // amber
  "glm-5.2": "#a78bfa", // violet
  "qwen3-coder": "#67e8f9", // cyan
};

export const PROMOTED_GREEN = "#6ee7a0";

// Quality floor: winner must score at least this fraction of the frontier baseline.
export const QUALITY_FLOOR = 0.82;

export interface BenchmarkRow {
  model: CandidateModel;
  /** quality vs frontier baseline, frontier = 1.0 */
  quality: number;
  /** cost multiplier vs frontier, e.g. 0.05 = 20x cheaper */
  costMult: number;
  latencyMs: number;
  qualified: boolean;
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
  winner: CandidateModel;
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
