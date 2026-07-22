import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews } from "../trace-foundry.js";

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
}
