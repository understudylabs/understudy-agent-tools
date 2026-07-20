// Shared server-side helpers for locating personal benchmark drafts written
// by scripts/benchmark.ts. Not a route file — route.ts exports stay handler-only.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type BenchmarkInstance = {
  instance_id: string;
  session_id: string;
  split: "train" | "dev" | "holdout";
  prompt: string;
  context: {
    project: string;
    harness: string;
    tools_used: string[];
    label: string | null;
    summary: string | null;
  };
  reference: {
    final_assistant: string;
    commits: string[];
    events: number;
  };
  quality: number;
};

export type BenchmarkDraft = {
  benchmark: string;
  version: string;
  created: string;
  cluster: { id: number; name: string };
  counts: { instances: number; train: number; dev: number; holdout: number; dropped: number };
  mean_quality: number;
  split_hash_seed: string;
  instances: BenchmarkInstance[];
};

export type EvalFile = {
  benchmark: string;
  candidate: string;
  kind: string;
  judge: string;
  createdAt: string;
  results: Array<{ instance_id: string; score: number; reason: string; candidate_chars: number }>;
  mean: number;
  n: number;
};

export function clusterSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function benchmarkPath(clusterName: string): string {
  return path.join(process.cwd(), "data", "benchmarks", `${clusterSlug(clusterName)}.json`);
}

export function readBenchmarkDraft(clusterName: string): BenchmarkDraft | null {
  const file = benchmarkPath(clusterName);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BenchmarkDraft;
  } catch {
    return null;
  }
}

// Real measured eval (written by scripts/evalrun.ts) for a cluster, if any.
export function readEvalFile(clusterName: string): EvalFile | null {
  const file = path.join(process.cwd(), "data", "evals", `${clusterSlug(clusterName)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EvalFile;
  } catch {
    return null;
  }
}
