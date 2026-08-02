import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixtureSha256, splitSha256, validateEvalRows } from "../../dist/automationbench-offline.js";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export class GpuCostLedger {
  constructor({ usdPerGpuHour = 7, gpuCount = 1, budgetUsd = Infinity } = {}) {
    this.usdPerGpuHour = usdPerGpuHour;
    this.gpuCount = gpuCount;
    this.budgetUsd = budgetUsd;
    this.elapsedMs = 0;
    this.usd = 0;
    this.phases = [];
  }

  async phase(name, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      const elapsedMs = performance.now() - started;
      const usd = elapsedMs / 3_600_000 * this.usdPerGpuHour * this.gpuCount;
      this.elapsedMs += elapsedMs;
      this.usd += usd;
      this.phases.push({ phase: name, elapsed_ms: elapsedMs, gpu_hours: elapsedMs / 3_600_000 * this.gpuCount, usd });
      if (this.usd > this.budgetUsd) throw new Error(`GPU budget cap exceeded: $${this.usd.toFixed(6)} > $${this.budgetUsd.toFixed(6)}`);
    }
  }

  snapshot() {
    return { elapsed_ms: this.elapsedMs, gpu_hours: this.elapsedMs / 3_600_000 * this.gpuCount, usd: this.usd, usd_per_gpu_hour: this.usdPerGpuHour, gpu_count: this.gpuCount, phases: this.phases };
  }
}

export class ArtifactStore {
  constructor(outputDir) {
    mkdirSync(outputDir, { recursive: true });
    this.outputDir = outputDir;
    this.receiptsPath = join(outputDir, "rollouts.jsonl");
  }

  appendReceipt(receipt) {
    appendFileSync(this.receiptsPath, `${JSON.stringify(receipt)}\n`);
  }

  writeJson(name, value) {
    const path = join(this.outputDir, name);
    if (existsSync(path)) throw new Error(`refusing to overwrite artifact: ${path}`);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  readJson(name) {
    return JSON.parse(readFileSync(join(this.outputDir, name), "utf8"));
  }

  evalRows({ runId, model, split, results }) {
    const rows = results.map((result) => ({
      schema_version: "understudy.eval_result.v1",
      run_id: runId,
      task_id: result.taskId,
      split,
      score: result.reward,
      status: "ok",
      model: model ?? null,
      route: "local-offline-sim",
      cost: { usd: result.usd ?? 0, basis: result.usd ? "gpu-wall-clock" : "local-zero-marginal-cost" },
      tokens: result.tokens ?? null,
      benchmark_id: "automationbench-simple-api-offline",
      subscores: { forbidden_effects: result.forbiddenEffects.length, steps: result.steps },
      provenance: { harness_sha256: fixtureSha256(), split_sha256: splitSha256(split), artifact_refs: ["fixture://automationbench-simple-api-offline-v1"] },
    }));
    const errors = validateEvalRows(rows);
    if (errors.length) throw new Error(`invalid eval rows: ${errors.join("; ")}`);
    return rows;
  }
}
