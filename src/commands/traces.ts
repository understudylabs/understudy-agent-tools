import { Command } from "commander";
import { join, resolve } from "node:path";
import { compileTraceFoundry } from "../trace-foundry.js";
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
    .action((options: { source: string; output: string; maxAgeDays: string }) => {
      const result = compileTraceFoundry(resolve(options.source), resolve(options.output), Number(options.maxAgeDays));
      console.log(JSON.stringify(result, null, 2));
      console.error(`viewer: ${join(result.output_dir, "viewer", "index.html")}`);
    });
}
