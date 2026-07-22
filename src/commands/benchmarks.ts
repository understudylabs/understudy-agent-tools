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

  const plainDirHelp =
    "Write lineage into a plain directory (no benchmark.json required) — the desktop app keeps experiment records next to a prepared dataset before a benchmark exists";

  experiment
    .command("create <dir>")
    .description("Append one NEW understudy.experiment.v1 line to <dir>/experiments.jsonl (validated; JSON out)")
    .requiredOption("--input <json>", "Experiment record as inline JSON or @file (hypothesis, data_selection, training, ...)")
    .option("--plain-dir", plainDirHelp, false)
    .action(async (dir: string, options: { input: string; plainDir: boolean }) => {
      const path = await import("node:path");
      const { createExperiment, createExperimentInDir } = await import("../benchmark-hub-core.js");
      const input = parseJsonOption(options.input) as never;
      const result = options.plainDir
        ? createExperimentInDir(path.resolve(dir), input)
        : createExperiment(await loadDirEntry(dir), input);
      if (!result.ok) throw new Error(result.error);
      console.error(`appended ${result.file}`);
      console.log(JSON.stringify(result.experiment, null, 2));
    });

  experiment
    .command("update <dir> <experiment_id>")
    .description("Supersede one experiment: merge --input over its newest record and append the full merged record (approvals + eval_run_ids append; JSON out)")
    .requiredOption("--input <json>", "Partial understudy.experiment.v1 fields as inline JSON or @file")
    .option("--plain-dir", plainDirHelp, false)
    .action(async (dir: string, experimentId: string, options: { input: string; plainDir: boolean }) => {
      const path = await import("node:path");
      const { updateExperiment, updateExperimentInDir } = await import("../benchmark-hub-core.js");
      const patch = parseJsonOption(options.input);
      const result = options.plainDir
        ? updateExperimentInDir(path.resolve(dir), experimentId, patch)
        : updateExperiment(await loadDirEntry(dir), experimentId, patch);
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
    .command("from-dataset <file-or-dir>")
    .description(
      "Compile a labeled dataset (JSONL/CSV/TSV/XLSX) into a full benchmark dir on the same spine as trace " +
        "benchmarks: one classification task per row (gold label as a fenced-JSON-tolerant response obligation), " +
        "GROUPED train/dev/holdout splits with zero group overlap, automatic dedupe + label-conflict quarantine " +
        "recorded in curation-report.md, a generated verifiers environment whose oracle scores 1.0 by " +
        "construction, and a recommended run that includes the majority_class floor arm",
    )
    .requiredOption("--output <dir>", "Benchmark output directory (created if absent)")
    .option("--name <name>", "Benchmark display name (default: the dataset file basename)")
    .option("--label-column <name>", "Gold-label column/key (default: inferred — same heuristics as capture-import inspect-csv)")
    .option(
      "--input-column <name>",
      "Input text column/key (repeatable; default: inferred non-label columns)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--group-column <name>", "Leakage-group column: rows sharing its normalized value never straddle splits (default: the normalized input text)")
    .option("--taxonomy <file>", "Label taxonomy file (JSON array or one label per line); observed labels must be a subset, missing classes are reported")
    .option("--system-prompt <text-or-@file>", "System prompt for every task (default: derived prompt listing the taxonomy)")
    .option("--docs <dir>", "Optional context-docs dir recorded as provenance (never parsed, never model input)")
    .option("--train <ratio>", "Train split ratio", "0.8")
    .option("--dev <ratio>", "Dev split ratio", "0.1")
    .option("--holdout <ratio>", "Holdout split ratio (sealed)", "0.1")
    .action(async (source: string, options: { output: string; name?: string; labelColumn?: string; inputColumn: string[]; groupColumn?: string; taxonomy?: string; systemPrompt?: string; docs?: string; train: string; dev: string; holdout: string }) => {
      const { compileDatasetFoundry } = await import("../dataset-foundry.js");
      const fs = await import("node:fs");
      const systemPrompt = options.systemPrompt?.startsWith("@") ? fs.readFileSync(options.systemPrompt.slice(1), "utf8") : options.systemPrompt;
      const result = compileDatasetFoundry(source, options.output, {
        name: options.name,
        labelColumn: options.labelColumn,
        inputColumns: options.inputColumn,
        groupColumn: options.groupColumn,
        taxonomyFile: options.taxonomy,
        systemPrompt,
        docsDir: options.docs,
        ratios: { train: Number(options.train), dev: Number(options.dev), holdout: Number(options.holdout) },
      });
      console.error(`from-dataset: ${result.counts.tasks} task(s) from ${result.counts.source_rows} row(s) → ${result.output_dir}`);
      console.error(`curation: ${result.curation.duplicates_removed} duplicate(s) removed, ${result.curation.conflict_rows_quarantined} conflict row(s) quarantined — see curation-report.md`);
      console.log(JSON.stringify(result, null, 2));
    });

  benchmarks
    .command("review <dir>")
    .description(
      "Bulk task review over <dir>/reviews.jsonl (append-only, newest per task wins). --accept-all-pending " +
        "appends an accept for every task with no review yet — for pending-mode dirs where each task was " +
        "already inspected another way",
    )
    .option("--accept-all-pending", "Append an accept review for every task that has no review yet", false)
    .option("--note <text>", "Review note recorded on each appended line", "bulk accept via `understudy benchmarks review --accept-all-pending`")
    .action(async (dir: string, options: { acceptAllPending: boolean; note: string }) => {
      if (!options.acceptAllPending) throw new Error("nothing to do: pass --accept-all-pending (per-task reviews live in the hub UI / benchmarks mcp)");
      const path = await import("node:path");
      const fs = await import("node:fs");
      const { latestReviewByTask, makeBenchmarkReview, readReviews, serializeReviewLine } = await import("../benchmark-artifacts.js");
      const resolved = path.resolve(dir);
      const tasksPath = path.join(resolved, "tasks.jsonl");
      if (!fs.existsSync(tasksPath)) throw new Error(`not a benchmark dir (no tasks.jsonl): ${resolved}`);
      const taskIds = fs.readFileSync(tasksPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { const id = (JSON.parse(line) as { task_id?: unknown }).task_id; return typeof id === "string" ? [id] : []; } catch { return []; }
      });
      const reviewsPath = path.join(resolved, "reviews.jsonl");
      const reviewed = latestReviewByTask(fs.existsSync(reviewsPath) ? readReviews(reviewsPath).reviews : []);
      const pending = taskIds.filter((id) => reviewed[id] === undefined);
      // Same codec the hub's submitReview uses: benchmark_id is the dir slug.
      const lines = pending.map((taskId) => serializeReviewLine(makeBenchmarkReview({ benchmark_id: path.basename(resolved), task_id: taskId, decision: "accept", note: options.note, source: "auto" })));
      if (lines.length > 0) fs.appendFileSync(reviewsPath, lines.join(""), "utf8");
      console.error(`accepted ${pending.length} pending task(s); ${taskIds.length - pending.length} already reviewed`);
      console.log(JSON.stringify({ dir: resolved, tasks: taskIds.length, accepted: pending.length, already_reviewed: taskIds.length - pending.length }, null, 2));
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
