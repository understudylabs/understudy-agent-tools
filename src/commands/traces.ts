import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews, promoteTraceBenchmark, runTraceReplays } from "../trace-foundry.js";
import { serveTraceFoundry } from "../trace-foundry-server.js";
import { authorTasks, compareAuthoringModels, gatewayClient, resolveDefaultModel, resolveGatewayAuth } from "../trace-author.js";
import { renderTraceViewer } from "../trace-viewer.js";

export function registerTracesCommand(program: Command): void {
  const traces = program.command("traces").description("Inspect local trace captures and compile benchmark environments");
  traces.command("build-viewer")
    .description("Build a private local viewer for one trace's model calls, prompts, and tools")
    .option("--source <path>", "Local capture file or directory", ".understudy/captures")
    .option("--output <path>", "Private viewer output directory", ".understudy/trace-viewer")
    .option("--trace-id <id>", "Trace ID to select when the source contains multiple traces")
    .option("--label <text>", "Local label shown above the trace ID", "Local Understudy captures")
    .action((options: { source: string; output: string; traceId?: string; label: string }) => {
      const result = renderTraceViewer(
        resolve(options.source),
        resolve(options.output),
        options.traceId,
        options.label,
      );
      console.log(JSON.stringify(result, null, 2));
      console.error(`viewer: ${join(result.output_dir, "index.html")}`);
    });

  traces.command("build-benchmark")
    .description("Build a source DAG, machine-proposed benchmark, and local review viewer")
    .option("--source <path>", "Local capture directory", ".understudy/captures")
    .option("--output <path>", "Private output directory", ".understudy/benchmarks/latest")
    .option("--max-age-days <days>", "Fail closed on stale captures", "3")
    .option("--workload <name>", "Compile only captures matching workload id or name")
    .option("--batch-size <count>", "Resumable processing batch size", "10")
    .action((options: { source: string; output: string; maxAgeDays: string; workload?: string; batchSize: string }) => {
      const result = compileTraceFoundry(resolve(options.source), resolve(options.output), Number(options.maxAgeDays), new Date(), { workload: options.workload, batchSize: Number(options.batchSize) });
      console.log(JSON.stringify(result, null, 2));
      console.error(`viewer: ${join(result.output_dir, "viewer", "index.html")}`);
    });
  traces.command("author-tasks")
    .description("LLM-author legible task definitions over a compiled benchmark, grounding-verified against the deterministic evidence (Understudy gateway only)")
    .requiredOption("--benchmark <dir>", "Benchmark output directory (tasks.jsonl + normalized-captures.jsonl)")
    .option("--model <id>", "Gateway model id; defaults to a cheap capable model from /v1/models")
    .option("--limit <count>", "Author at most N tasks")
    .option("--only-unauthored", "Skip tasks that already carry an authored block", true)
    .option("--no-only-unauthored", "Re-author tasks even if already authored")
    .option("--compare-models <ids>", "Comma-separated model ids: author the same tasks with each and report agreement (no tasks.jsonl writeback; resumable via authoring-results.jsonl)")
    .option("--experiment-out <path>", "Write the comparison report JSON here instead of stdout only")
    .option("--concurrency <count>", "Concurrent in-flight authoring calls", "8")
    .action(async (options: { benchmark: string; model?: string; limit?: string; onlyUnauthored: boolean; compareModels?: string; experimentOut?: string; concurrency: string }) => {
      const auth = resolveGatewayAuth();
      const model = options.model ?? await resolveDefaultModel(auth.baseUrl, auth.apiKey);
      const limit = options.limit === undefined ? undefined : Number(options.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
      const concurrency = Number(options.concurrency);
      if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("--concurrency must be a positive integer");
      const client = gatewayClient(auth.baseUrl, auth.apiKey);
      if (options.compareModels) {
        const models = options.compareModels.split(",").map((id) => id.trim()).filter(Boolean);
        const report = await compareAuthoringModels(resolve(options.benchmark), models, { limit, client, onlyUnauthored: false, concurrency, progressStream: process.stderr, partialResultsPath: options.experimentOut ? `${resolve(options.experimentOut)}.partial.jsonl` : undefined });
        if (options.experimentOut) { const { writeFileSync, mkdirSync } = await import("node:fs"); mkdirSync(resolve(options.experimentOut, ".."), { recursive: true }); writeFileSync(resolve(options.experimentOut), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); console.error(`comparison: ${resolve(options.experimentOut)}`); console.log(JSON.stringify({ runs: report.runs, agreement: { ...report.agreement, per_task: undefined } }, null, 2)); }
        else console.log(JSON.stringify(report, null, 2));
        return;
      }
      const result = await authorTasks(resolve(options.benchmark), { model, client, limit, onlyUnauthored: options.onlyUnauthored, concurrency, progressStream: process.stderr });
      console.log(JSON.stringify({ ...result, results: undefined }, null, 2));
    });
  traces.command("import-reviews")
    .description("Apply exported human judgments to a compiled benchmark")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .requiredOption("--reviews <path>", "Exported review JSONL")
    .action((options: { benchmark: string; reviews: string }) => console.log(JSON.stringify(importTraceReviews(resolve(options.benchmark), resolve(options.reviews)), null, 2)));
  traces.command("promote")
    .description("Promote a reviewed proposal to an executable understudy.benchmark.v1 (accepted tasks only)")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .option("--waive-dag <reason>", "Waive remaining source-DAG issues with this recorded rationale")
    .action((options: { benchmark: string; waiveDag?: string }) => console.log(JSON.stringify(promoteTraceBenchmark(resolve(options.benchmark), { waiveDagReason: options.waiveDag }), null, 2)));
  traces.command("plan-replays")
    .description("Create a no-spend multi-model and context-rot replay plan")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .requiredOption("--model <id...>", "Candidate model IDs; repeat or provide a list")
    .action((options: { benchmark: string; model: string[] }) => console.log(JSON.stringify(createTraceReplayPlan(resolve(options.benchmark), options.model), null, 2)));
  traces.command("run-replays")
    .description("Run approved models through the generated Verifiers v1 environment")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .requiredOption("--model <id...>", "Approved model IDs")
    .option("--variant <name...>", "Context variants", ["authentic_history"])
    .option("--max-examples <count>", "Maximum examples per model and variant", "5")
    .option("--yes", "Approve provider calls for this bounded run", false)
    .option("--push", "Opt in to uploading traces to the Prime Intellect platform (off by default; requires PRIME_API_KEY)", false)
    .action((options: { benchmark: string; model: string[]; variant: string[]; maxExamples: string; yes: boolean; push: boolean }) => console.log(JSON.stringify(runTraceReplays(resolve(options.benchmark), options.model, options.variant, Number(options.maxExamples), options.yes, options.push), null, 2)));
  traces.command("serve")
    .description("Serve the local DAG, task, contract, and trace viewer")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .option("--port <number>", "Local port", "3003")
    .action((options: { benchmark: string; port: string }) => {
      const port = Number(options.port); serveTraceFoundry(resolve(options.benchmark), port); console.error(`viewer: http://127.0.0.1:${port}`);
    });
}
