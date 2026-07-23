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
    .command("upgrade <dir>")
    .description(
      "Diff the benchmark's current manifest against a previous one into the minimal rerun/regrade/reuse work " +
        "plan (env change => MAJOR => rerun, verifier => MINOR => regrade, meta => PATCH => reuse), append one " +
        "understudy.benchmark_version.v1 line to <dir>/versions.jsonl (append-only), and with --queue write " +
        "run_request files for the rerun set. Queue-only, never executes: `understudy runs execute --watch` " +
        "picks requests up, same trust posture as the hub Run panel",
    )
    .requiredOption(
      "--against <file>",
      "The PREVIOUS benchmark manifest (old benchmark.json) to diff against. A bare versions.jsonl entry is not " +
        "enough to recompute content hashes — pass the archived manifest",
    )
    .option("--note <text>", "Note recorded on the appended versions.jsonl line")
    .option("--dry-run", "Print the plan without appending to versions.jsonl (and never queue)", false)
    .option("--queue", "Also queue understudy.run_request.v1 files for the rerun set (requires --model)", false)
    .option(
      "--model <id>",
      "Model for the queued rerun (repeatable; required with --queue)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--rollouts <n>", "Rollouts per task for the queued rerun", "1")
    .action(async (dir: string, options: { against: string; note?: string; dryRun: boolean; queue: boolean; model: string[]; rollouts: string }) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { planBenchmarkUpgrade, serializeVersionEntryLine } = await import("../benchmark-upgrade.js");
      const entry = await loadDirEntry(dir);
      if (entry.kind !== "ok") throw new Error(`upgrade needs a promoted benchmark dir (understudy.benchmark.v1); this dir is stage "${entry.kind}"`);

      const againstRaw = JSON.parse(readFileSync(options.against, "utf8"));
      if (againstRaw === null || typeof againstRaw !== "object" || !Array.isArray((againstRaw as { tasks?: unknown }).tasks)) {
        throw new Error(
          "--against must be a previous benchmark manifest (an object with a tasks[] array); a versions.jsonl " +
            "entry alone cannot reproduce the old content hashes",
        );
      }

      // Benchmark-level baseline version: newest versions.jsonl line wins,
      // else the old manifest's own version field, else 1.0.0.
      const lastVersionLine = entry.versions.length > 0 ? entry.versions[entry.versions.length - 1] : null;
      const previousBenchmarkVersion =
        (typeof lastVersionLine?.version === "string" ? lastVersionLine.version : null) ??
        (typeof (againstRaw as { version?: unknown }).version === "string" ? ((againstRaw as { version: string }).version) : null);

      const plan = planBenchmarkUpgrade(againstRaw as Record<string, unknown>, entry.manifest as unknown as Record<string, unknown>, {
        previousBenchmarkVersion,
        note: options.note ?? null,
      });
      console.error(`upgrade plan: ${plan.cost_note}`);
      console.error(`benchmark version: ${plan.benchmark_version.from} -> ${plan.benchmark_version.to} (${plan.benchmark_version.bump})`);

      let queued: unknown = null;
      if (options.dryRun) {
        console.error("dry run: versions.jsonl untouched, nothing queued");
      } else {
        const versionsPath = path.join(entry.dir, "versions.jsonl");
        fs.appendFileSync(versionsPath, serializeVersionEntryLine(plan.entry), "utf8");
        console.error(`appended ${versionsPath}`);
        if (options.queue) {
          if (options.model.length === 0) throw new Error("--queue requires at least one --model");
          if (plan.diff.plan.rerun.length === 0) {
            console.error("queue: rerun set is empty — nothing to queue");
          } else {
            const { queueOrCancelRun } = await import("../benchmark-hub-core.js");
            const result = queueOrCancelRun(entry, {
              models: options.model,
              split: "all",
              tasks: plan.diff.plan.rerun,
              rollouts_per_task: Number(options.rollouts),
            });
            if (!result.ok) throw new Error(`queue failed: ${result.error}`);
            queued = result.run;
            console.error(`queued run ${(result.run as { run_id?: string }).run_id ?? ""} for ${plan.diff.plan.rerun.length} rerun task(s)`);
            if (result.execute_hint) console.error(`execute with: ${result.execute_hint}`);
          }
        }
      }
      console.log(JSON.stringify({ ...plan, queued_run: queued }, null, 2));
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
    .command("report <dir>")
    .description(
      "Generate partner-report.md + partner-report.json — the honest client-facing benchmark-and-savings " +
        "report — from EXISTING artifacts only (rows, calibration, rigor, experiments; no new runs, no " +
        "network). Floors and 95% CIs always shown; no winner claim on overlapping CIs; savings only when " +
        "incumbent + candidate cost-per-correct + a monthly volume exist, always labeled EXTRAPOLATED; " +
        "customer names/emails/domains scrubbed by construction",
    )
    .option("--monthly-volume <n>", "Monthly task volume for the EXTRAPOLATED savings projection (overrides manifest.monthly_volume)")
    .option(
      "--scrub-name <name>",
      "Extra customer-name token to scrub (repeatable; dir-slug tokens are scrubbed automatically)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--out <dir>", "Directory to write partner-report.{md,json} into (default: the benchmark dir; use for read-only benchmark dirs)")
    .action(async (dir: string, options: { monthlyVolume?: string; scrubName: string[]; out?: string }) => {
      const { writePartnerReport } = await import("../partner-report.js");
      const { report, markdownPath, jsonPath } = writePartnerReport(dir, {
        monthlyVolume: options.monthlyVolume === undefined ? undefined : Number(options.monthlyVolume),
        scrubNames: options.scrubName,
        outDir: options.out,
      });
      console.error(`wrote ${markdownPath}`);
      console.error(`wrote ${jsonPath}`);
      console.log(JSON.stringify(report, null, 2));
    });

  benchmarks
    .command("rigor <dir...>")
    .description(
      "Generate rigor-report.md in the benchmark dir: ABC checklist (oracle solvability, null/spam trivial-agent " +
        "floors, incumbent calibration, per-task contract complexity, anomaly counts, split provenance) derived " +
        "purely from existing artifacts — no network, no model calls. --ci switches to the machine-readable " +
        "pass/fail gate (schema, oracle=1.0, floors <= limit, reward-hack sentinels ~0, zero verbatim leakage, " +
        "contamination != contaminated); missing evidence prints honest UNKNOWN lines (fatal only with --strict)",
    )
    .option("--ci", "CI gate mode: JSON reports on stdout, exit 1 on any hard FAIL (no report file written)", false)
    .option("--strict", "With --ci: UNKNOWN (missing evidence) is fatal too", false)
    .option("--changed-only", "With --ci: only check dirs touched since the merge-base with origin/main (or --base)", false)
    .option("--base <ref>", "With --changed-only: explicit git base ref to diff against")
    .action(async (dirs: string[], options: { ci: boolean; strict: boolean; changedOnly: boolean; base?: string }) => {
      if (!options.ci) {
        const { writeRigorReport } = await import("../rigor-report.js");
        const reports = dirs.map((dir) => {
          const { path, report } = writeRigorReport(dir);
          console.error(`wrote ${path}`);
          return report;
        });
        console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
        return;
      }
      const { filterChangedBenchmarkDirs, renderRigorCiLines, rigorCiExitCode, runRigorCiChecks } = await import("../rigor-report.js");
      let targets = dirs;
      if (options.changedOnly) {
        const { dirs: changed, base } = filterChangedBenchmarkDirs(dirs, options.base);
        targets = changed;
        console.error(base === null ? "rigor --ci: git base unavailable — checking every dir" : `rigor --ci: ${changed.length}/${dirs.length} dir(s) changed since ${base}`);
        if (targets.length === 0) {
          console.log(JSON.stringify([], null, 2));
          return;
        }
      }
      const reports = targets.map((dir) => runRigorCiChecks(dir));
      for (const report of reports) for (const line of renderRigorCiLines(report)) console.error(line);
      console.log(JSON.stringify(reports, null, 2));
      const code = rigorCiExitCode(reports, { strict: options.strict });
      if (code !== 0) {
        console.error(`rigor --ci: FAIL${options.strict ? " (strict: UNKNOWN is fatal)" : ""}`);
        process.exitCode = code;
      }
    });
}
