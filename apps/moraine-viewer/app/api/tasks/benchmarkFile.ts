// Shared server-side helpers for locating personal benchmark drafts written
// by scripts/benchmark.ts. Not a route file — route.ts exports stay handler-only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// All real measured evals (written by scripts/evalrun.ts) for a cluster:
// every data/evals/<slug>__<candidate>.json for this cluster's slug.
export function readEvalFiles(clusterName: string): EvalFile[] {
  const dir = path.join(process.cwd(), "data", "evals");
  if (!existsSync(dir)) return [];
  const prefix = `${clusterSlug(clusterName)}__`;
  const out: EvalFile[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as EvalFile);
    } catch {
      // malformed eval file — skip
    }
  }
  return out.sort((a, b) => b.mean - a.mean);
}

// Back-compat single eval: the local-gemma entry among the measured evals.
export function readEvalFile(clusterName: string): EvalFile | null {
  const evals = readEvalFiles(clusterName);
  return evals.find((e) => e.candidate.startsWith("local:")) ?? null;
}
