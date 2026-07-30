import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateBenchmarkManifest } from "./benchmark.js";

type ReviewDecision = "approve" | "request_changes";
type ReviewScope = "benchmark" | "task" | "rollout";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(dir: string): Record<string, any> {
  const path = join(resolve(dir), "benchmark.json");
  if (!existsSync(path)) throw new Error(`missing benchmark.json: ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateBenchmarkManifest(manifest);
  if (errors.length) throw new Error(`invalid benchmark manifest: ${errors.join("; ")}`);
  return manifest;
}

export function appendPrimeBenchmarkReview(
  dir: string,
  input: { decision: ReviewDecision; scope?: ReviewScope; ref?: string | null; note: string; reviewer: string },
): Record<string, unknown> {
  if (!["approve", "request_changes"].includes(input.decision)) throw new Error("decision must be approve or request_changes");
  if (!input.note.trim()) throw new Error("review note is required");
  if (!input.reviewer.trim()) throw new Error("reviewer is required");
  const manifest = readManifest(dir);
  const review = {
    schema_version: "understudy.prime_benchmark_review.v1",
    benchmark_id: manifest.benchmark_id,
    decision: input.decision,
    scope: input.scope ?? "benchmark",
    ref: input.ref ?? null,
    note: input.note.trim(),
    reviewer: input.reviewer.trim(),
    created_at: new Date().toISOString(),
  };
  const path = join(resolve(dir), "reviews.jsonl");
  appendFileSync(path, `${JSON.stringify(review)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return review;
}

export function freezePrimeBenchmark(dir: string, note: string): Record<string, unknown> {
  const resolved = resolve(dir);
  const manifest = readManifest(resolved);
  if (manifest.calibration?.status !== "incumbent_passed") {
    throw new Error("benchmark cannot freeze until calibration.status is incumbent_passed");
  }
  const rowsPath = join(resolved, "rows-prime.jsonl");
  if (!existsSync(rowsPath) || !readFileSync(rowsPath, "utf8").trim()) throw new Error("benchmark cannot freeze without rows-prime.jsonl");
  const reviewsPath = join(resolved, "reviews.jsonl");
  const reviews = existsSync(reviewsPath)
    ? readFileSync(reviewsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const latestBenchmarkReview = [...reviews].reverse().find((review) => review.scope === "benchmark");
  if (latestBenchmarkReview?.decision !== "approve") {
    throw new Error("benchmark cannot freeze until its latest benchmark-scope review approves it");
  }
  const version = {
    schema_version: "understudy.prime_benchmark_version.v1",
    benchmark_id: manifest.benchmark_id,
    status: "frozen",
    manifest_sha256: sha256File(join(resolved, "benchmark.json")),
    rows_sha256: sha256File(rowsPath),
    verifier_version: manifest.environment?.verifiers_version_pin ?? null,
    incumbent_model: manifest.calibration.incumbent_model,
    task_count: manifest.tasks.length,
    note: note.trim() || "Frozen after incumbent calibration and human approval.",
    created_at: new Date().toISOString(),
  };
  const versionsPath = join(resolved, "versions.jsonl");
  appendFileSync(versionsPath, `${JSON.stringify(version)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(versionsPath, 0o600);
  writeFileSync(
    join(resolved, "state.json"),
    `${JSON.stringify({ schema_version: "understudy.prime_benchmark_state.v1", benchmark_id: manifest.benchmark_id, status: "frozen", current_version: version }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return version;
}
