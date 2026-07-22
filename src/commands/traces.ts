import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry } from "../trace-foundry.js";

export function registerTracesCommand(program: Command): void {
  const traces = program.command("traces").description("Compile local trace captures into benchmark environments");
  traces.command("build-benchmark")
    .description("Build a source DAG, machine-proposed benchmark, and local review viewer")
    .option("--source <path>", "Local capture directory", ".understudy/captures")
    .option("--output <path>", "Private output directory", ".understudy/benchmarks/latest")
    .option("--max-age-days <days>", "Fail closed on stale captures", "3")
    .action((options: { source: string; output: string; maxAgeDays: string }) => {
      const result = compileTraceFoundry(resolve(options.source), resolve(options.output), Number(options.maxAgeDays));
      console.log(JSON.stringify(result, null, 2));
      console.error(`viewer: ${join(result.output_dir, "viewer", "index.html")}`);
    });
}
