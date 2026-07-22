import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews, runTraceReplays } from "../trace-foundry.js";
import { serveTraceFoundry } from "../trace-foundry-server.js";

export function registerTracesCommand(program: Command): void {
  const traces = program.command("traces").description("Compile local trace captures into benchmark environments");
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
