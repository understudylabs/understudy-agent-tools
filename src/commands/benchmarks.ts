import { readFileSync } from "node:fs";
import { Command } from "commander";

/**
 * `understudy benchmarks …` — the agent-operator surface over the file-based
 * benchmark artifacts. `benchmarks mcp` serves the read/diff/review/queue
 * tools over stdio so a coding agent can drive the improvement loop; it
 * never executes models (that stays with `understudy runs execute`).
 */
export function registerBenchmarksCommand(program: Command): void {
  const benchmarks = program
    .command("benchmarks")
    .description("Agent-operator surface over local benchmark dirs (proposed foundry outputs + promoted benchmarks)");

  benchmarks
    .command("mcp")
    .description(
      "Stdio MCP server: list/read benchmarks and tasks, read + diff rollout trajectories with contract " +
        "scoring, append reviews, queue run requests, and poll run status — same shared cores as the hub, " +
        "no model execution",
    )
    .option(
      "--root <dir>",
      "Additional benchmark root scanned after ~/.understudy/benchmarks (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (options: { root: string[] }) => {
      const { runBenchmarksMcpServer } = await import("../benchmarks-mcp.js");
      await runBenchmarksMcpServer(options.root);
    });

  // Experiment lineage (experiments.jsonl — understudy.experiment.v1,
  // append-only, newest line per experiment_id wins). JSON in / JSON out so
  // agents can round-trip records; shared read/write cores with the MCP tools.
  const experiment = benchmarks
    .command("experiment")
    .description("Machine-readable experiment lineage: data selection → training (+approval gates) → artifact → eval runs → verdict");

  /** Parse --input (inline JSON or @file) into an object. */
  const parseJsonOption = (raw: string): Record<string, unknown> => {
    const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object");
    return parsed as Record<string, unknown>;
  };

  const loadDirEntry = async (dir: string) => {
    const path = await import("node:path");
    const { loadEntryFromDir } = await import("../benchmark-hub-core.js");
    const resolved = path.resolve(dir);
    const entry = loadEntryFromDir(resolved, "data-dir", path.basename(resolved), false);
    if (!entry) throw new Error(`not a benchmark dir (no benchmark.json or manifest.json): ${resolved}`);
    return entry;
  };

  experiment
    .command("create <dir>")
    .description("Append one NEW understudy.experiment.v1 line to <dir>/experiments.jsonl (validated; JSON out)")
    .requiredOption("--input <json>", "Experiment record as inline JSON or @file (hypothesis, data_selection, training, ...)")
    .action(async (dir: string, options: { input: string }) => {
      const { createExperiment } = await import("../benchmark-hub-core.js");
      const result = createExperiment(await loadDirEntry(dir), parseJsonOption(options.input) as never);
      if (!result.ok) throw new Error(result.error);
      console.error(`appended ${result.file}`);
      console.log(JSON.stringify(result.experiment, null, 2));
    });

  experiment
    .command("update <dir> <experiment_id>")
    .description("Supersede one experiment: merge --input over its newest record and append the full merged record (approvals + eval_run_ids append; JSON out)")
    .requiredOption("--input <json>", "Partial understudy.experiment.v1 fields as inline JSON or @file")
    .action(async (dir: string, experimentId: string, options: { input: string }) => {
      const { updateExperiment } = await import("../benchmark-hub-core.js");
      const result = updateExperiment(await loadDirEntry(dir), experimentId, parseJsonOption(options.input));
      if (!result.ok) throw new Error(result.error);
      console.error(`appended ${result.file}`);
      console.log(JSON.stringify(result.experiment, null, 2));
    });

  experiment
    .command("list <dir>")
    .description("Latest record per experiment_id from <dir>/experiments.jsonl (JSON out)")
    .action(async (dir: string) => {
      const path = await import("node:path");
      const { listExperiments } = await import("../benchmark-hub-core.js");
      console.log(JSON.stringify(listExperiments(path.resolve(dir)), null, 2));
    });

  experiment
    .command("show <dir> <experiment_id>")
    .description("Newest record for one experiment_id (JSON out; exits non-zero when unknown)")
    .action(async (dir: string, experimentId: string) => {
      const path = await import("node:path");
      const { listExperiments } = await import("../benchmark-hub-core.js");
      const found = listExperiments(path.resolve(dir)).experiments.find((e) => e.experiment_id === experimentId);
      if (!found) throw new Error(`unknown experiment_id: ${experimentId}`);
      console.log(JSON.stringify(found, null, 2));
    });

  benchmarks
    .command("rigor <dir>")
    .description(
      "Generate rigor-report.md in the benchmark dir: ABC checklist (oracle solvability, null/spam trivial-agent " +
        "floors, incumbent calibration, per-task contract complexity, anomaly counts, split provenance) derived " +
        "purely from existing artifacts — no network, no model calls",
    )
    .action(async (dir: string) => {
      const { writeRigorReport } = await import("../rigor-report.js");
      const { path, report } = writeRigorReport(dir);
      console.error(`wrote ${path}`);
      console.log(JSON.stringify(report, null, 2));
    });
}
