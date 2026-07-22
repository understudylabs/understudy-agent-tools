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

  benchmarks
    .command("evolve <dir>")
    .description(
      "GEPA-style prompt evolution over run arms: propose suffixes with an authoring model (fed per-class " +
        "rejection counts + failed obligations from the run journals), queue prompt_overrides runs on train, " +
        "select the champion on dev, then verify champion-vs-bare ONCE on the sealed holdout. Queue-only: " +
        "`understudy runs execute --watch` must be running in another terminal",
    )
    .requiredOption("--model <id>", "The base model whose system prompt is being evolved (every arm runs this model)")
    .option("--author-model <id>", "Gateway model that authors suffix proposals (default: resolveDefaultModel)")
    .option("--generations <n>", "Evolution generations on the train split (1-6)", "2")
    .option("--variants <n>", "Suffix variants per generation (2-4)", "3")
    .option("--rollouts <n>", "Rollouts per task per arm", "1")
    .option("--budget-runs <n>", "Hard cap on runs queued by this invocation (baseline + generations + dev + holdout)")
    .option("--no-final", "Skip the holdout run; the result is explicitly UNVERIFIED and never a win")
    .action(async (dir: string, options: { model: string; authorModel?: string; generations: string; variants: string; rollouts: string; budgetRuns?: string; final: boolean }) => {
      const { evolvePrompts } = await import("../prompt-evolution.js");
      const result = await evolvePrompts(dir, {
        model: options.model,
        authorModel: options.authorModel,
        generations: Number(options.generations),
        variants: Number(options.variants),
        rolloutsPerTask: Number(options.rollouts),
        budgetRuns: options.budgetRuns === undefined ? undefined : Number(options.budgetRuns),
        final: options.final,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.verdict.verdict !== "win") {
        console.error(`evolve: verdict is "${result.verdict.verdict}" — do not report a win without a CI-positive holdout run`);
      }
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
