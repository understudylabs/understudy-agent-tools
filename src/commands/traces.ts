import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews, runTraceReplays } from "../trace-foundry.js";
import { serveTraceFoundry } from "../trace-foundry-server.js";
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
  traces.command("import-reviews")
    .description("Apply exported human judgments to a compiled benchmark")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .requiredOption("--reviews <path>", "Exported review JSONL")
    .action((options: { benchmark: string; reviews: string }) => console.log(JSON.stringify(importTraceReviews(resolve(options.benchmark), resolve(options.reviews)), null, 2)));
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
    .action((options: { benchmark: string; model: string[]; variant: string[]; maxExamples: string; yes: boolean }) => console.log(JSON.stringify(runTraceReplays(resolve(options.benchmark), options.model, options.variant, Number(options.maxExamples), options.yes), null, 2)));
  traces.command("serve")
    .description("Serve the local DAG, task, contract, and trace viewer")
    .requiredOption("--benchmark <path>", "Benchmark output directory")
    .option("--port <number>", "Local port", "3003")
    .action((options: { benchmark: string; port: string }) => {
      const port = Number(options.port); serveTraceFoundry(resolve(options.benchmark), port); console.error(`viewer: http://127.0.0.1:${port}`);
    });
}
