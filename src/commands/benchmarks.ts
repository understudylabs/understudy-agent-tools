import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { AuditReceipt } from "../verifier-audit.js";
import type { TranscriptRow } from "../verifier-audit-envs.js";

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
    .command("init-prime <config>")
    .description("Create a reviewed-config template for a Prime-native benchmark without running models")
    .option("--benchmark-id <id>", "Stable anonymized benchmark id", "workload-000-prime-benchmark-v1")
    .option("--name <name>", "Anonymized display name", "Workload 000 · Prime benchmark")
    .action(async (configPath: string, options: { benchmarkId: string; name: string }) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const resolved = path.resolve(configPath);
      if (fs.existsSync(resolved)) throw new Error(`refusing to overwrite existing config: ${resolved}`);
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const template = {
        schema_version: "understudy.prime_benchmark_import.v1",
        benchmark_id: options.benchmarkId,
        name: options.name,
        description: "Anonymized description of the workload and measured behavior.",
        source_dir: ".understudy/prime-runs/<benchmark>",
        output_dir: ".understudy/benchmark-aggregates/<benchmark>",
        scorecard_output_dir: ".understudy/benchmarks/<benchmark>",
        verifier_version: "0.2.1",
        incumbent_model: "<incumbent-model-id>",
        anonymized: true,
        environment: {
          package_ref: "<installed-prime-environment-id-or-path>",
          package_sha256: null,
          runtime: "subprocess",
          tool_surface: ["<tool-name>"],
        },
        tasks: {
          "<exact-task-id>": {
            label: "Anonymized task label",
            category_id: "capability-category",
            summary: [
              "Describes the production-derived scenario without identity.",
              "States the expected tool or routing behavior.",
              "States what the deterministic verifier measures.",
            ],
            split: "holdout",
          },
        },
        pricing: {
          "<model-id>": {
            input: 0,
            cache_read: 0,
            output: 0,
            source: "Reviewed dated price source; do not leave placeholder rates for authoritative comparisons.",
          },
        },
      };
      fs.writeFileSync(resolved, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ config: resolved, model_execution_started: false }, null, 2));
    });

  benchmarks
    .command("import-prime <config>")
    .description(
      "Compile completed Prime Verifiers traces into an anonymized understudy.benchmark.v1 registry package",
    )
    .action(async (config: string) => {
      const { importPrimeBenchmark } = await import("../prime-benchmark-import.js");
      const result = importPrimeBenchmark(config);
      console.error(`import-prime: ${result.rows} row(s), ${result.models} model(s), ${result.tasks} task(s) → ${result.output_dir}`);
      console.log(JSON.stringify(result, null, 2));
    });

  benchmarks
    .command("status-prime <config>")
    .description("Inspect Prime trace discovery, completion, version, task, model, and import-readiness state")
    .action(async (config: string) => {
      const { inspectPrimeBenchmark } = await import("../prime-benchmark-import.js");
      console.log(JSON.stringify(inspectPrimeBenchmark(config), null, 2));
    });

  benchmarks
    .command("run-prime <eval-config>")
    .description("Run a native Prime evaluation from a reviewed TOML config; requires explicit provider-data authorization")
    .requiredOption(
      "--allow-provider-data-transfer",
      "Confirm private benchmark prompts may be sent to the provider configured by the Prime TOML",
    )
    .option("--prime-bin <path>", "Prime CLI executable", "prime")
    .option("--dry-run", "Validate and print the exact native Prime invocation without executing it")
    .action(async (
      evalConfig: string,
      options: { allowProviderDataTransfer: boolean; primeBin: string; dryRun?: boolean },
    ) => {
      const { runPrimeEvaluation } = await import("../prime-benchmark-runner.js");
      console.log(JSON.stringify(runPrimeEvaluation(evalConfig, options), null, 2));
    });

  benchmarks
    .command("plan-prime-run <execution-config>")
    .description("Plan an idempotent provider-aware Prime run and list only missing/invalid tasks")
    .action(async (config: string) => {
      const { planProviderAwarePrimeRun } = await import("../prime-benchmark-runner.js");
      console.log(JSON.stringify(planProviderAwarePrimeRun(config), null, 2));
    });

  benchmarks
    .command("run-prime-workflow <execution-config>")
    .description("Run missing Prime tasks through a provider policy, quarantine invalid attempts, and publish accepted rows")
    .requiredOption("--allow-provider-data-transfer", "Confirm private benchmark prompts may be sent to the approved provider")
    .option("--prime-bin <path>", "Prime CLI executable", "prime")
    .option("--dry-run", "Plan and validate without provider execution")
    .action(async (
      config: string,
      options: { allowProviderDataTransfer: boolean; primeBin: string; dryRun?: boolean },
    ) => {
      const { runProviderAwarePrimeEvaluation } = await import("../prime-benchmark-runner.js");
      console.log(JSON.stringify(runProviderAwarePrimeEvaluation(config, options), null, 2));
    });

  benchmarks
    .command("validate-prime-run <execution-config>")
    .alias("status-prime-run")
    .description("Validate native rows and report accepted, rejected, and missing task coverage")
    .action(async (config: string) => {
      const { primeExecutionCoverage } = await import("../prime-benchmark-runner.js");
      const coverage = primeExecutionCoverage(config);
      console.log(JSON.stringify(coverage, null, 2));
      if (!coverage.complete) process.exitCode = 1;
    });

  benchmarks
    .command("resume-prime <execution-config>")
    .description("Resume only missing/invalid tasks using the immutable provider-aware execution identity")
    .requiredOption("--allow-provider-data-transfer", "Confirm private benchmark prompts may be sent to the approved provider")
    .option("--prime-bin <path>", "Prime CLI executable", "prime")
    .option("--dry-run", "Plan the resume without provider execution")
    .action(async (
      config: string,
      options: { allowProviderDataTransfer: boolean; primeBin: string; dryRun?: boolean },
    ) => {
      const { runProviderAwarePrimeEvaluation } = await import("../prime-benchmark-runner.js");
      console.log(JSON.stringify(runProviderAwarePrimeEvaluation(config, options), null, 2));
    });

  benchmarks
    .command("watch-prime <config>")
    .description("Watch native Prime trace files until the reviewed import corpus is complete and error-free")
    .option("--interval-ms <n>", "Polling interval in milliseconds", "1000")
    .option("--timeout-ms <n>", "Stop waiting after this many milliseconds; 0 waits indefinitely", "0")
    .action(async (config: string, options: { intervalMs: string; timeoutMs: string }) => {
      const intervalMs = Number(options.intervalMs);
      const timeoutMs = Number(options.timeoutMs);
      const { watchPrimeBenchmark } = await import("../prime-benchmark-runner.js");
      const result = await watchPrimeBenchmark(config, {
        intervalMs,
        timeoutMs,
        onSnapshot: (snapshot) => process.stdout.write(`${JSON.stringify(snapshot)}\n`),
      });
      console.error(`watch-prime: ready to import (${result.traces} completed trace(s))`);
    });

  benchmarks
    .command("compare-prime <dir>")
    .description("Compare one candidate with the incumbent on the exact same imported Prime task ids")
    .requiredOption("--baseline <model>", "Incumbent or baseline model id")
    .requiredOption("--candidate <model>", "Candidate model id")
    .action(async (dir: string, options: { baseline: string; candidate: string }) => {
      const { comparePrimeModels } = await import("../prime-benchmark-compare.js");
      console.log(JSON.stringify(comparePrimeModels(dir, options.baseline, options.candidate), null, 2));
    });

  benchmarks
    .command("build-scorecard <config>")
    .description("Render the Prime-native interactive scorecard from a reviewed benchmark import config")
    .action(async (config: string) => {
      const { spawnSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const renderer = fileURLToPath(new URL("../../runtime-assets/prime-scorecard/build-scorecard.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [renderer, config], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Prime scorecard renderer exited ${result.status}`);
      process.stdout.write(result.stdout);
    });

  benchmarks
    .command("serve-gallery")
    .description("Serve a private local gallery of Prime-native scorecards discovered under a benchmark root")
    .option("--root <dir>", "Benchmark root containing <slug>/viewer/index.html", ".understudy/benchmarks")
    .option("--port <n>", "Local port", "4317")
    .option("--host <host>", "Bind host (loopback by default)", "127.0.0.1")
    .action(async (options: { root: string; port: string; host: string }) => {
      const { startPrimeScorecardServer } = await import("../prime-scorecard-server.js");
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
      const result = await startPrimeScorecardServer(options.root, port, options.host);
      console.error(`Prime benchmark gallery: ${result.url} (${result.entries.length} scorecard(s))`);
    });

  benchmarks
    .command("reopen-prime <config>")
    .description("Reopen the private native scorecard for one benchmark through the local gallery server")
    .option("--port <n>", "Local port", "4317")
    .option("--host <host>", "Bind host (loopback by default)", "127.0.0.1")
    .action(async (configPath: string, options: { port: string; host: string }) => {
      const path = await import("node:path");
      const { readPrimeImportConfig } = await import("../prime-benchmark-runner.js");
      const { startPrimeScorecardServer } = await import("../prime-scorecard-server.js");
      const config = readPrimeImportConfig(configPath);
      if (typeof config.scorecard_output_dir !== "string") throw new Error("config.scorecard_output_dir is required");
      if (typeof config.benchmark_id !== "string") throw new Error("config.benchmark_id is required");
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
      const configFile = path.resolve(configPath);
      const output = path.isAbsolute(config.scorecard_output_dir)
        ? config.scorecard_output_dir
        : path.resolve(path.dirname(configFile), config.scorecard_output_dir);
      const root = path.dirname(output);
      const result = await startPrimeScorecardServer(root, port, options.host);
      const slug = config.benchmark_id.replace(/-v\d+$/, "");
      if (!result.entries.some((entry) => entry.slug === slug)) {
        result.server.close();
        throw new Error(`scorecard not found for ${config.benchmark_id}; run build-scorecard first`);
      }
      console.error(`Prime benchmark scorecard: ${result.url}b/${encodeURIComponent(slug)}/`);
    });

  benchmarks
    .command("review-prime <dir>")
    .description("Append a human review decision to an anonymized Prime benchmark package")
    .requiredOption("--decision <decision>", "approve or request_changes")
    .requiredOption("--reviewer <name>", "Reviewer name or stable internal id")
    .requiredOption("--note <text>", "Review rationale")
    .option("--scope <scope>", "benchmark, task, or rollout", "benchmark")
    .option("--ref <id>", "Task or rollout id when scope is not benchmark")
    .action(async (dir: string, options: { decision: "approve" | "request_changes"; reviewer: string; note: string; scope: "benchmark" | "task" | "rollout"; ref?: string }) => {
      const { appendPrimeBenchmarkReview } = await import("../prime-benchmark-lifecycle.js");
      const review = appendPrimeBenchmarkReview(dir, options);
      console.log(JSON.stringify(review, null, 2));
    });

  benchmarks
    .command("freeze-prime <dir>")
    .description("Freeze a calibrated, human-approved Prime benchmark version with content hashes")
    .option("--note <text>", "Version note", "Frozen after incumbent calibration and human approval.")
    .action(async (dir: string, options: { note: string }) => {
      const { freezePrimeBenchmark } = await import("../prime-benchmark-lifecycle.js");
      const version = freezePrimeBenchmark(dir, options.note);
      console.log(JSON.stringify(version, null, 2));
    });

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
    .option(
      "--against <file>",
      "The PREVIOUS benchmark manifest (old benchmark.json) to diff against. A legacy versions.jsonl entry " +
        "without a tasks[] snapshot is not enough to recompute content hashes — pass the archived manifest",
    )
    .option(
      "--against-version <version|index>",
      "Diff against a versions.jsonl entry's tasks[] snapshot instead of an archived manifest: a benchmark " +
        "version string (e.g. 1.2.0) or a 0-based entry index. Only entries written with per-task snapshots " +
        "(version + content_hashes) qualify; legacy lines still need --against",
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
    .action(async (dir: string, options: { against?: string; againstVersion?: string; note?: string; dryRun: boolean; queue: boolean; model: string[]; rollouts: string }) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { planBenchmarkUpgrade, serializeVersionEntryLine } = await import("../benchmark-upgrade.js");
      const entry = await loadDirEntry(dir);
      if (entry.kind !== "ok") throw new Error(`upgrade needs a promoted benchmark dir (understudy.benchmark.v1); this dir is stage "${entry.kind}"`);
      if ((options.against ? 1 : 0) + (options.againstVersion ? 1 : 0) !== 1) {
        throw new Error("pass exactly one of --against <old-manifest.json> or --against-version <version|index>");
      }

      let againstRaw: unknown;
      if (options.againstVersion) {
        // Ledger-backed baseline: a versions.jsonl entry with a per-task
        // snapshot (tasks[]: version + content_hashes) stands in for the
        // archived manifest — classifyTaskChange compares stamped hashes.
        const wanted = options.againstVersion;
        const versionLines = entry.versions as Record<string, unknown>[];
        const byVersion = versionLines.filter((line) => typeof line.version === "string" && line.version === wanted);
        const line = byVersion.length > 0
          ? byVersion[byVersion.length - 1]
          : /^\d+$/.test(wanted) && Number(wanted) < versionLines.length
            ? versionLines[Number(wanted)]
            : null;
        if (!line) {
          const known = versionLines.map((l, i) => `${i}:${typeof l.version === "string" ? l.version : "(no version)"}`).join(", ");
          throw new Error(`--against-version ${wanted} matches no versions.jsonl entry (have: ${known || "none"})`);
        }
        const snapshots = Array.isArray(line.tasks) ? line.tasks : null;
        if (!snapshots || snapshots.length === 0) {
          throw new Error(
            `versions.jsonl entry ${typeof line.version === "string" ? line.version : wanted} carries no tasks[] snapshot ` +
              "(written before snapshot support) — a bare entry cannot reproduce the old content hashes; pass the " +
              "archived manifest with --against instead",
          );
        }
        const unstamped = snapshots.filter((s) => !(s as { content_hashes?: unknown }).content_hashes);
        if (unstamped.length > 0) {
          throw new Error(
            `versions.jsonl snapshot for entry ${typeof line.version === "string" ? line.version : wanted} has ` +
              `${unstamped.length} task(s) without content_hashes — cannot diff exactly; pass the archived manifest with --against`,
          );
        }
        againstRaw = { version: line.version ?? null, tasks: snapshots };
      } else {
        againstRaw = JSON.parse(readFileSync(options.against!, "utf8"));
      }
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

  benchmarks
    .command("verifier-audit")
    .description("Run the deterministic offline verifier reliability audit over fixture states and optional recorded transcripts")
    .option("--fixture <fixture>", "Fixture: automationbench-v2, synthetic-workflow, or all", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--split <split>", "Split: train, dev, holdout, or all (repeatable)", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--transcripts <path>", "Transcript JSONL file, directory, or simple glob for the natural-trajectory arm", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--out <dir>", "Output directory", "experiments/verifier-reliability-audit")
    .option("--frozen-holdout <fixture=sha256>", "Required frozen holdout hash; repeatable fixture=sha256, or bare sha256 for one fixture", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--ci", "Exit non-zero when any audited band fails the dual-arm gate", false)
    .action(async (options: {
      fixture: string[];
      split: string[];
      transcripts: string[];
      out: string;
      frozenHoldout: string[];
      ci: boolean;
    }) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { auditAdapter, attachNaturalAudit, renderAuditJson, renderNaturalJson, renderAuditMarkdown } = await import("../verifier-audit.js");
      const {
        AUDIT_ADAPTERS,
        parseAutomationTranscripts,
        parseSyntheticTranscripts,
      } = await import("../verifier-audit-envs.js");
      const fixtures = options.fixture.length === 0 || options.fixture.includes("all")
        ? ["automationbench-v2", "synthetic-workflow"]
        : options.fixture;
      const splits = options.split.length === 0 || options.split.includes("all") ? ["train", "dev", "holdout"] : options.split;
      const holdoutHashes = new Map<string, string>();
      for (const value of options.frozenHoldout) {
        const separator = value.indexOf("=");
        if (separator < 0) {
          if (options.frozenHoldout.length !== 1 || fixtures.length !== 1) {
            throw new Error("--frozen-holdout bare form requires exactly one selected fixture; use <fixture>=<sha256> for multiple fixtures");
          }
          holdoutHashes.set(fixtures[0], value);
        } else {
          const fixture = value.slice(0, separator);
          const hash = value.slice(separator + 1);
          if (!["automationbench-v2", "synthetic-workflow"].includes(fixture)) {
            throw new Error(`unknown --frozen-holdout fixture: ${fixture}`);
          }
          holdoutHashes.set(fixture, hash);
        }
      }
      if (splits.includes("holdout")) {
        for (const fixture of fixtures) {
          if (!holdoutHashes.has(fixture)) {
            throw new Error(`--frozen-holdout is required for holdout fixture: ${fixture}`);
          }
        }
      }
      const files: string[] = [];
      const collect = (candidate: string): void => {
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) {
          for (const entry of fs.readdirSync(candidate)) collect(path.join(candidate, entry));
        } else if (candidate.endsWith(".jsonl")) files.push(candidate);
      };
      for (const transcriptPath of options.transcripts) {
        const candidate = path.resolve(transcriptPath);
        if (fs.existsSync(candidate)) collect(candidate);
        else {
          const base = path.dirname(candidate);
          const pattern = new RegExp(`^${path.basename(candidate).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
          if (fs.existsSync(base)) for (const entry of fs.readdirSync(base)) if (pattern.test(entry)) files.push(path.join(base, entry));
        }
      }
      fs.mkdirSync(path.resolve(options.out), { recursive: true, mode: 0o700 });
      const outputs: AuditReceipt[] = [];
      const { createHash } = await import("node:crypto");
      const transcriptRefs = files.map((file) => ({
        path: path.relative(process.cwd(), file).split(path.sep).join("/"),
        sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      })).sort((a, b) => a.path.localeCompare(b.path));
      for (const fixture of fixtures) {
        const naturalRows: TranscriptRow[] = files.flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
          const row: TranscriptRow = JSON.parse(line);
          return row;
        }));
        let adversarialReceipt: AuditReceipt;
        let finalReceipt: AuditReceipt;
        if (fixture === "automationbench-v2") {
          const adapter = AUDIT_ADAPTERS.automationBenchV2;
          adversarialReceipt = auditAdapter(adapter, {
            splits,
            frozenHoldoutSha256: holdoutHashes.get(fixture),
            transcriptRefs,
          });
          finalReceipt = attachNaturalAudit(adversarialReceipt, adapter, parseAutomationTranscripts(naturalRows), {
            splits,
            frozenHoldoutSha256: holdoutHashes.get(fixture),
          });
        } else if (fixture === "synthetic-workflow") {
          const adapter = AUDIT_ADAPTERS.syntheticWorkflow;
          adversarialReceipt = auditAdapter(adapter, {
            splits,
            frozenHoldoutSha256: holdoutHashes.get(fixture),
            transcriptRefs,
          });
          finalReceipt = attachNaturalAudit(adversarialReceipt, adapter, parseSyntheticTranscripts(naturalRows), {
            splits,
            frozenHoldoutSha256: holdoutHashes.get(fixture),
          });
        } else {
          throw new Error(`unknown verifier-audit fixture: ${fixture}`);
        }
        const prefix = path.join(path.resolve(options.out), fixture);
        fs.writeFileSync(`${prefix}-adversarial.json`, `${renderAuditJson(adversarialReceipt)}\n`, { mode: 0o600 });
        fs.writeFileSync(`${prefix}.md`, `${renderAuditMarkdown(finalReceipt)}\n`, { mode: 0o600 });
        if (finalReceipt.natural) fs.writeFileSync(`${prefix}-natural.json`, `${renderNaturalJson(finalReceipt.natural, finalReceipt)}\n`, { mode: 0o600 });
        outputs.push(finalReceipt);
      }
      for (const receipt of outputs) {
        console.log(`fixture: ${receipt.adapter}`);
        for (const [band, verdict] of Object.entries(receipt.verdicts).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(`  ${band}: ${verdict.verdict}${verdict.reasons.length > 0 ? ` (${verdict.reasons.join(", ")})` : ""}`);
        }
        const natural = receipt.natural;
        console.log(`  natural: ${natural ? `probes=${natural.probes}, replay_fidelity_mismatches=${natural.replay_fidelity_mismatches}` : "no evidence"}`);
        const artifactPrefix = receipt.adapter === "automationbench-v2" ? "automationbench-v2" : "synthetic-workflow";
        console.log(`  artifacts: ${path.join(options.out, `${artifactPrefix}-adversarial.json`)}, ${path.join(options.out, `${artifactPrefix}-natural.json`)}, ${path.join(options.out, `${artifactPrefix}.md`)}`);
        console.log(`  idempotency_key: ${receipt.idempotency_key}`);
      }
      if (options.ci && outputs.some((receipt) => Object.values(receipt.verdicts).some((verdict) => verdict.verdict !== "trusted"))) {
        process.exitCode = 1;
      }
    });
}
