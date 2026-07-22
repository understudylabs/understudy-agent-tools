import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runUnderstandCheck, runUnderstandWorkloadCard } from "./understand.js";
import {
  buildWorkloadCard,
  compileCaptureImport,
  inspectCaptureCsv,
  prepareCaptureClassificationDataset,
  previewCaptureImport,
  scanCaptureImport,
} from "./capture-import.js";
import {
  DEFAULT_CLASSIFIER_MODEL,
  predictLocalClassifier,
  startLocalClassifierTraining,
} from "./local-classifier/index.js";
import {
  getLocalClassifierRun,
  listLocalClassifierRuns,
  updateLocalClassifierRun,
} from "./local-classifier/registry.js";
import {
  exportLocalClassifierPredictions,
  repeatLocalClassifierEvaluation,
} from "./local-classifier/lifecycle.js";
import {
  compareClassifierWithFrontier,
  DEFAULT_FRONTIER_CLASSIFIER_BUDGET_USD,
  DEFAULT_FRONTIER_CLASSIFIER_MODEL,
} from "./local-classifier/frontier.js";
import { planRouteDecision } from "./route-decision.js";
import { buildValueReport } from "./value-report.js";
import { type AgentPlatformAdapter, agentPlatformAdapters, findAgentPlatformAdapter } from "./agent-platforms.js";
import { registerCapturesCommand } from "./commands/captures.js";
import { registerTracesCommand } from "./commands/traces.js";
import { registerEvalsCommand } from "./commands/evals.js";
import { registerExploreCommand } from "./commands/explore.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerDesktopCommand } from "./commands/desktop.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerGatewayCommand } from "./commands/gateway.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerProjectsCommand } from "./commands/projects.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerRunCommand } from "./commands/run.js";
import { registerRunsCommand } from "./commands/runs.js";
import { registerRuntimeCommand } from "./commands/runtime.js";
import { registerTrainingCommand } from "./commands/training.js";
import { registerSetupCodeCommand } from "./commands/setup-code.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerOptimizeWorkloadCommand } from "./commands/optimize-workload.js";
import { registerWorkloadsCommand } from "./commands/workloads.js";
import { registerExperimentsCommands, registerNextCommand } from "./commands/experiments.js";
import { daemonStatus } from "./internal/daemon.js";
import { readCliVersion, readManifestVersions } from "./internal/version.js";
import { installedPackageRoot } from "./internal/package-root.js";

export { compileTraceFoundry, createTraceReplayPlan, importTraceReviews, runTraceReplays } from "./trace-foundry.js";
export { serveTraceFoundry } from "./trace-foundry-server.js";

export const repoRoot = installedPackageRoot();

type SkillSummary = {
  name: string;
  path: string;
  description: string;
};

type SearchResult = {
  name: string;
  path: string;
  kind: "skill" | "reference";
  score: number;
  matches: string[];
};

type SearchCandidate = Omit<SearchResult, "score" | "matches"> & {
  text: string;
};

function readSkillSummaries(): SkillSummary[] {
  const skillsRoot = join(repoRoot, "skills");
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillPath = join(skillsRoot, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) {
        return null;
      }
      const text = readFileSync(skillPath, "utf8");
      const description =
        text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "Understudy public skill.";
      return {
        name: entry.name,
        path: relative(repoRoot, skillPath),
        description,
      };
    })
    .filter((skill): skill is SkillSummary => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function printSkillList(): void {
  const skills = readSkillSummaries();
  if (skills.length === 0) {
    console.log("No public skills found.");
    return;
  }
  console.log("Public Understudy skills:");
  for (const skill of skills) {
    console.log(`- ${skill.name} (${skill.path})`);
    console.log(`  ${skill.description}`);
  }
}

function inspectSkill(name: string): void {
  const skill = readSkillSummaries().find((candidate) => candidate.name === name);
  if (!skill) {
    throw new Error(`Unknown public skill: ${name}`);
  }
  console.log(`${skill.name}`);
  console.log(`path: ${skill.path}`);
  console.log(`description: ${skill.description}`);
}

function searchSkills(query: string, json: boolean): void {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    throw new Error("Usage: understudy skills --search <query>");
  }
  const results = searchSkillDocs(terms).slice(0, 8);
  if (json) {
    printJson({ query, results });
    return;
  }
  if (results.length === 0) {
    console.log(`No skill matches for: ${query}`);
    console.log("Try: understudy skills --list");
    return;
  }
  console.log(`Skill search: ${query}`);
  for (const result of results) {
    console.log(`- ${result.name} (${result.kind})`);
    console.log(`  path: ${result.path}`);
    console.log(`  matched: ${result.matches.join(", ")}`);
    if (result.kind === "skill") {
      console.log(`  next: understudy skills --inspect ${result.name}`);
    }
  }
}

function searchSkillDocs(terms: string[]): SearchResult[] {
  const candidates = readSearchFiles(join(repoRoot, "skills"));
  const results: SearchResult[] = [];
  for (const candidate of candidates) {
    const haystack = `${candidate.name}\n${candidate.path}\n${candidate.text}`.toLowerCase();
    const matches = terms.filter((term) => haystack.includes(term));
    if (matches.length === 0) {
      continue;
    }
    const frontmatterBoost = candidate.kind === "skill" && candidate.path.endsWith("SKILL.md") ? 3 : 0;
    // A skill whose NAME matches the query is the canonical hit (e.g. "gateway" ->
    // use-understudy-gateway); rank it above docs that merely mention the term, so it
    // survives the result cap no matter how many other skills reference the topic.
    const nameHaystack = candidate.name.toLowerCase();
    const nameBoost = terms.some((term) => nameHaystack.includes(term)) ? 100 : 0;
    const score = matches.length * 10 + frontmatterBoost + nameBoost;
    results.push({ ...candidate, score, matches });
  }
  return results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function readSearchFiles(root: string): SearchCandidate[] {
  if (!existsSync(root)) {
    return [];
  }
  const files = walkTextFiles(root)
    .filter((path) => {
      const relativePath = relative(repoRoot, path).replaceAll("\\", "/");
      return (
        relativePath.endsWith("/SKILL.md") ||
        relativePath.endsWith("/reference.md") ||
        relativePath.includes("/references/") && relativePath.endsWith(".md") ||
        relativePath.startsWith("skills/onboard/") && relativePath.endsWith(".md")
      );
    });
  return files.map((path) => {
    const relativePath = relative(repoRoot, path).replaceAll("\\", "/");
    const text = readFileSync(path, "utf8");
    const skillName = relativePath.split("/")[1] ?? relativePath;
    return {
      name: skillName,
      path: relativePath,
      kind: relativePath.endsWith("SKILL.md") ? "skill" : "reference",
      text,
    };
  });
}

function walkTextFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function printSpine(): void {
  console.log("understudy-agent-tools");
  console.log("");
  console.log("MVP spine:");
  console.log("1. skills/understudy/SKILL.md routes the backend-agnostic workflow.");
  console.log("2. skills/capture-evidence/SKILL.md pins harness, metric, splits, and baseline.");
  console.log("3. skills/optimize-workload/SKILL.md validates freshness before optimization claims.");
  console.log("4. skills/use-understudy-gateway/SKILL.md runs authenticated gateway workflows when approved.");
}

function printPlatforms(json: boolean, inspect?: string): void {
  let adapters: AgentPlatformAdapter[];
  if (inspect) {
    const adapter = findAgentPlatformAdapter(inspect);
    if (!adapter) {
      throw new Error(`Unknown agent platform adapter: ${inspect}`);
    }
    adapters = [adapter];
  } else {
    adapters = agentPlatformAdapters;
  }
  if (json) {
    printJson({ adapters });
    return;
  }
  console.log("Understudy agent platform adapters:");
  for (const adapter of adapters) {
    console.log(`- ${adapter.id} (${adapter.status})`);
    console.log(`  ${adapter.displayName}: ${adapter.discovery}`);
    console.log(`  manifest: ${adapter.manifestPath}`);
    console.log(`  reload: ${adapter.reload}`);
    console.log(`  onboarding: ${adapter.onboarding}`);
  }
}

async function printDoctorJson(): Promise<void> {
  const required = [
    "README.md",
    "LICENSE",
    "package.json",
    "dist/index.js",
    "skills/understudy/SKILL.md",
  ];
  const missing = required.filter((path) => !existsSync(join(repoRoot, path)));
  // package.json and the plugin manifests must move together: installed
  // plugins have no other staleness signal, so a skipped bump ships silently.
  const versions = readManifestVersions();
  const versionsConsistent =
    versions.cli !== null &&
    versions.cli === versions.plugin &&
    versions.cli === versions.marketplace &&
    versions.cli === versions.cursorPlugin &&
    versions.cli === versions.codexPlugin &&
    versions.cli === versions.codexMarketplace &&
    versions.cli === versions.opencodeAdapter &&
    versions.cli === versions.hermesAdapter &&
    versions.cli === versions.devinAdapter;
  // Desktop-app daemon discovery (agent-card + pid check + health probe).
  // Informational: a missing daemon never fails the doctor.
  const daemon = await daemonStatus();
  console.log(
    JSON.stringify(
      {
        repo: "understudy-agent-tools",
        runtime: "node",
        node: process.version,
        versions,
        versions_consistent: versionsConsistent,
        missing,
        desktop_app_daemon: daemon.running ? `running at ${daemon.baseUrl}` : "not detected",
        daemon,
        ok: missing.length === 0 && versionsConsistent,
      },
      null,
      2,
    ),
  );
  if (missing.length > 0 || !versionsConsistent) {
    process.exitCode = 1;
  }
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function commandJsonEnabled(program: Command, options: { json?: boolean }): boolean {
  return options.json === true || program.optsWithGlobals<{ json?: boolean }>().json === true;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got: ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got: ${value}`);
  }
  return parsed;
}

function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function registerCaptureImportCommands(program: Command): void {
  const captureImport = program
    .command("capture-import")
    .description("Compile local import candidates and explicitly inspect approved data");

  captureImport
    .command("scan")
    .description("Scan a local repo for capture/import source metadata")
    .option("--repo <path>", "Repository to scan", ".")
    .option("--source <path>", "Exact file or directory to scan inside the repository")
    .option("--json", "Output JSON")
    .action((options: { repo: string; source?: string; json?: boolean }) => {
      const manifest = scanCaptureImport(options.repo, new Date(), options.source);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      console.log(`capture-import scan: ${manifest.source_count} metadata-only sources`);
      console.log(`manifest: ${relative(process.cwd(), join(resolve(options.repo), ".understudy/capture-import/capture-sources.json"))}`);
      console.log(`redaction: ${manifest.redaction_manifest_path}`);
    });

  captureImport
    .command("compile")
    .description("Compile one dropped local file or directory into a metadata-only Workload Card")
    .requiredOption("--source <path>", "Local file or directory to compile")
    .option("--output-root <path>", "Private local artifact root; defaults under ~/.understudy")
    .option("--json", "Output JSON")
    .action((options: { source: string; outputRoot?: string; json?: boolean }) => {
      const result = compileCaptureImport(options.source, new Date(), options.outputRoot);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`capture-import compile: ${result.source_count} source(s) from ${result.source_name}`);
      console.log(`workload card: ${result.workload_card_path}`);
      console.log("payload_read: false");
    });

  captureImport
    .command("inspect-csv")
    .description("Read one bounded local delimited table and write a statistics-only training inspection")
    .requiredOption("--source <path>", "Local CSV, TSV, tab, text, or extensionless table to inspect")
    .requiredOption("--artifact-root <path>", "Existing private artifact root from capture-import compile")
    .option("--json", "Output JSON")
    .action((options: { source: string; artifactRoot: string; json?: boolean }) => {
      const result = inspectCaptureCsv(options.source, options.artifactRoot);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`capture-import inspect-csv: ${result.row_count} row(s), ${result.column_count} column(s)`);
      console.log(`mapping: ${result.recommended_mapping.label_column ?? "label confirmation required"}`);
      console.log(`artifact: ${result.artifact_path}`);
      console.log("payload_read: true (local only; source rows were not copied)");
    });

  captureImport
    .command("prepare-classification")
    .description("Transform an inspected table into deterministic local train, dev, and holdout JSONL")
    .requiredOption("--source <path>", "Inspected local delimited table")
    .requiredOption("--artifact-root <path>", "Existing private artifact root from capture-import compile")
    .requiredOption("--label-column <name>", "Caller-confirmed label column")
    .requiredOption("--group-column <name>", "Caller-confirmed merchant, payee, or description leakage group")
    .option("--input-column <name>", "Caller-confirmed input column; repeat for multiple columns", collectRepeated, [])
    .option("--json", "Output JSON")
    .action((options: {
      source: string;
      artifactRoot: string;
      labelColumn: string;
      groupColumn: string;
      inputColumn: string[];
      json?: boolean;
    }) => {
      const result = prepareCaptureClassificationDataset(
        options.source,
        options.artifactRoot,
        options.inputColumn,
        options.labelColumn,
        options.groupColumn,
      );
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`capture-import prepare-classification: ${result.row_count} row(s)`);
      console.log(
        `splits: train ${result.splits.train.row_count}, dev ${result.splits.dev.row_count}, holdout ${result.splits.holdout.row_count}`,
      );
      console.log(`manifest: ${result.manifest_path}`);
      console.log("local_only: true (transformed examples were persisted locally)");
    });

  captureImport
    .command("train-classification")
    .description("Fine-tune and evaluate a local text classifier from a prepared dataset")
    .requiredOption("--manifest <path>", "Prepared classification dataset manifest")
    .requiredOption("--run-id <id>", "Immutable local training run identifier")
    .option("--output-root <path>", "Private local training-run root")
    .option("--runtime-root <path>", "Content-addressed local training runtime root")
    .option("--model <id>", "Hugging Face sequence-classification model", DEFAULT_CLASSIFIER_MODEL)
    .option("--model-revision <revision>", "Pinned model revision")
    .option("--epochs <count>", "Training epochs", parsePositiveInteger)
    .option("--batch-size <count>", "Training batch size", parsePositiveInteger)
    .option("--learning-rate <rate>", "Training learning rate", parseNonNegativeNumber)
    .option("--max-length <tokens>", "Maximum input token length", parsePositiveInteger)
    .option("--max-runtime-ms <milliseconds>", "Terminal runtime timeout", parsePositiveInteger)
    .option("--jsonl", "Stream machine-readable phase and terminal result events")
    .option("--json", "Output the terminal run manifest as JSON")
    .action(async (options: {
      manifest: string;
      runId: string;
      outputRoot?: string;
      runtimeRoot?: string;
      model: string;
      modelRevision?: string;
      epochs?: number;
      batchSize?: number;
      learningRate?: number;
      maxLength?: number;
      maxRuntimeMs?: number;
      jsonl?: boolean;
      json?: boolean;
    }) => {
      const job = startLocalClassifierTraining({
        datasetManifestPath: options.manifest,
        runId: options.runId,
        outputRoot: options.outputRoot,
        runtimeRoot: options.runtimeRoot,
        modelId: options.model,
        modelRevision: options.modelRevision,
        epochs: options.epochs,
        batchSize: options.batchSize,
        learningRate: options.learningRate,
        maxLength: options.maxLength,
        maxRuntimeMs: options.maxRuntimeMs,
        onEvent: options.jsonl ? (event) => console.log(JSON.stringify(event)) : undefined,
      });
      const result = await job.completion;
      if (options.jsonl) {
        if (result.status !== "completed") process.exitCode = 1;
        return;
      }
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== "completed") process.exitCode = 1;
      } else if (result.status === "completed") {
        console.log(`capture-import train-classification: ${result.verdict?.status ?? "completed"}`);
        console.log(`heldout macro-F1: ${result.heldout?.macro_f1.toFixed(4) ?? "unavailable"}`);
        console.log(`manifest: ${result.manifest_path}`);
      } else {
        console.error(result.error?.message ?? `Local training ended with status ${result.status}.`);
        process.exitCode = 1;
      }
    });

  captureImport
    .command("predict-classification")
    .description("Run a completed local classifier without retaining the input text")
    .requiredOption("--run-manifest <path>", "Completed local classification run manifest")
    .option("--text <text>", "New local text to classify; visible to local process inspection")
    .option("--text-stdin", "Read new local text from stdin without exposing it in process arguments")
    .option("--runtime-root <path>", "Content-addressed local training runtime root")
    .option("--max-length <tokens>", "Maximum input token length", parsePositiveInteger)
    .option("--json", "Output JSON")
    .action((options: {
      runManifest: string;
      text?: string;
      textStdin?: boolean;
      runtimeRoot?: string;
      maxLength?: number;
      json?: boolean;
    }) => {
      if (Boolean(options.text) === Boolean(options.textStdin)) {
        throw new Error("Choose exactly one of --text or --text-stdin.");
      }
      const text = options.textStdin ? readFileSync(0, "utf8") : options.text!;
      const prediction = predictLocalClassifier({
        runManifestPath: options.runManifest,
        text,
        runtimeRoot: options.runtimeRoot,
        maxLength: options.maxLength,
      });
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(prediction, null, 2));
        return;
      }
      console.log(`prediction: ${prediction.label}`);
      console.log(`confidence: ${(prediction.scores[0]?.score ?? 0).toFixed(4)}`);
      console.log("local_only: true (input text was not retained)");
    });

  captureImport
    .command("repeat-classification-evaluation")
    .description("Re-run a saved classifier on its exact immutable holdout and persist new evidence")
    .requiredOption("--run-manifest <path>", "Completed local classification run manifest")
    .option("--evaluation-id <id>", "Immutable repeat-evaluation identifier")
    .option("--runtime-root <path>", "Content-addressed local lifecycle runtime root")
    .option("--max-length <tokens>", "Maximum input token length", parsePositiveInteger)
    .option("--json", "Output JSON")
    .action((options: {
      runManifest: string;
      evaluationId?: string;
      runtimeRoot?: string;
      maxLength?: number;
      json?: boolean;
    }) => {
      const result = repeatLocalClassifierEvaluation({
        runManifestPath: options.runManifest,
        evaluationId: options.evaluationId,
        runtimeRoot: options.runtimeRoot,
        maxLength: options.maxLength,
      });
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`repeat evaluation: ${result.verdict.status}`);
      console.log(`correct answers: ${(result.repeat.accuracy * 100).toFixed(1)}%`);
      console.log(`artifact: ${result.artifact_path}`);
      console.log("local_only: true (holdout examples were not uploaded)");
    });

  captureImport
    .command("export-classification-predictions")
    .description("Append local classifier labels to a bounded CSV and write an evidence sidecar")
    .requiredOption("--run-manifest <path>", "Completed local classification run manifest")
    .option("--source <path>", "CSV/TSV to label; defaults to the original training source")
    .option("--input-column <columns...>", "Source columns to combine; defaults to the confirmed training mapping")
    .option("--output <path>", "Destination CSV; defaults under the immutable local run")
    .option("--runtime-root <path>", "Content-addressed local lifecycle runtime root")
    .option("--max-length <tokens>", "Maximum input token length", parsePositiveInteger)
    .option("--json", "Output JSON")
    .action((options: {
      runManifest: string;
      source?: string;
      inputColumn?: string[];
      output?: string;
      runtimeRoot?: string;
      maxLength?: number;
      json?: boolean;
    }) => {
      const result = exportLocalClassifierPredictions({
        runManifestPath: options.runManifest,
        sourcePath: options.source,
        inputColumns: options.inputColumn,
        outputPath: options.output,
        runtimeRoot: options.runtimeRoot,
        maxLength: options.maxLength,
      });
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`prediction export: ${result.predicted_row_count.toLocaleString()} labeled row(s)`);
      if (result.skipped_row_count > 0) console.log(`skipped empty rows: ${result.skipped_row_count.toLocaleString()}`);
      console.log(`output: ${result.output_path}`);
      console.log(`evidence: ${result.manifest_path}`);
      console.log("local_only: true (source and predictions were not uploaded)");
    });

  captureImport
    .command("list-classification-runs")
    .description("List durable local classifier runs without reading training examples")
    .option("--capture-root <path>", "Private capture-import root; defaults under ~/.understudy")
    .option("--archived", "List archived runs instead of active runs")
    .option("--limit <count>", "Maximum runs to return", parsePositiveInteger, 100)
    .option("--json", "Output JSON")
    .action((options: { captureRoot?: string; archived?: boolean; limit: number; json?: boolean }) => {
      const runs = listLocalClassifierRuns({
        captureRoot: options.captureRoot,
        archived: Boolean(options.archived),
        limit: options.limit,
      });
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log(options.archived ? "No archived local classifiers." : "No local classifiers yet.");
        return;
      }
      for (const run of runs) {
        const accuracy = run.evaluation ? `${(run.evaluation.accuracy * 100).toFixed(1)}% correct` : run.run_status;
        console.log(`${run.display_name}\t${accuracy}\t${run.manifest_path}`);
      }
    });

  captureImport
    .command("classification-run")
    .description("Read or update rename/archive metadata for one immutable local classifier run")
    .requiredOption("--run-manifest <path>", "Local classification run manifest")
    .option("--name <name>", "Human-readable local display name")
    .option("--archive", "Hide this run from the active model list")
    .option("--restore", "Return this run to the active model list")
    .option("--json", "Output JSON")
    .action((options: {
      runManifest: string;
      name?: string;
      archive?: boolean;
      restore?: boolean;
      json?: boolean;
    }) => {
      if (options.archive && options.restore) {
        throw new Error("Choose either --archive or --restore, not both.");
      }
      const changed = options.name !== undefined || options.archive || options.restore;
      const run = changed
        ? updateLocalClassifierRun({
          runManifestPath: options.runManifest,
          displayName: options.name,
          archived: options.archive ? true : options.restore ? false : undefined,
        })
        : getLocalClassifierRun(options.runManifest);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      console.log(`${run.display_name}: ${run.run_status}${run.archived_at ? " (archived)" : ""}`);
      console.log(`manifest: ${run.manifest_path}`);
    });

  captureImport
    .command("compare-classification-frontier")
    .description("Compare a completed local classifier with a frontier model on the exact same holdout")
    .requiredOption("--run-manifest <path>", "Completed local classification run manifest")
    .option("--model <id>", "Frontier catalog model", DEFAULT_FRONTIER_CLASSIFIER_MODEL)
    .option(
      "--confirm-remote",
      "Confirm held-out examples may be sent to the named managed frontier model; training examples remain local",
    )
    .option(
      "--confirm-spend",
      "Confirm paid frontier inference within the explicit --budget-usd cap",
    )
    .option(
      "--budget-usd <usd>",
      "Hard maximum approved frontier spend in USD",
      parsePositiveNumber,
      DEFAULT_FRONTIER_CLASSIFIER_BUDGET_USD,
    )
    .option("--jsonl", "Stream machine-readable phase and terminal result events")
    .option("--json", "Output the terminal comparison artifact as JSON")
    .action(async (options: {
      runManifest: string;
      model: string;
      confirmRemote?: boolean;
      confirmSpend?: boolean;
      budgetUsd: number;
      jsonl?: boolean;
      json?: boolean;
    }) => {
      const result = await compareClassifierWithFrontier({
        runManifestPath: options.runManifest,
        modelId: options.model,
        confirmRemote: Boolean(options.confirmRemote),
        confirmSpend: Boolean(options.confirmSpend),
        budgetUsd: options.budgetUsd,
        onEvent: options.jsonl ? (event) => console.log(JSON.stringify(event)) : undefined,
      });
      if (options.jsonl) {
        console.log(JSON.stringify({ type: "result", result }));
        return;
      }
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`capture-import compare-classification-frontier: ${result.requested_model}`);
      console.log(`same holdout: ${result.row_count} row(s), ${result.holdout_sha256}`);
      console.log(`correct answers: ${(result.heldout.accuracy * 100).toFixed(1)}%`);
      console.log(`frontier spend: $${result.spend.attributed_cost_usd.toFixed(4)} (approved cap $${result.spend.approved_budget_usd.toFixed(2)})`);
      console.log(`artifact: ${result.artifact_path}`);
    });

  captureImport
    .command("preview")
    .description("Write a bounded metadata-only preview artifact from the last scan")
    .option("--repo <path>", "Repository with scan artifacts", ".")
    .option("--source-id <id>", "Source id from capture-sources.json", "source-001")
    .option("--limit <count>", "Preview row limit to record for later payload approval", parsePositiveInteger, 25)
    .option("--json", "Output JSON")
    .action((options: { repo: string; sourceId: string; limit: number; json?: boolean }) => {
      const preview = previewCaptureImport(options.repo, options.sourceId, options.limit);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(preview, null, 2));
        return;
      }
      console.log(`capture-import preview: ${preview.source.id} ${preview.source.kind} ${preview.source.path}`);
      console.log(`artifact: .understudy/capture-import/preview-${preview.source_id}.json`);
      console.log("payload_read: false");
    });

  captureImport
    .command("workload-card")
    .description("Create a metadata-only workload card from the last scan")
    .option("--repo <path>", "Repository with scan artifacts", ".")
    .option("--json", "Output JSON")
    .action((options: { repo: string; json?: boolean }) => {
      const card = buildWorkloadCard(options.repo);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(card, null, 2));
        return;
      }
      console.log(`capture-import workload-card: ${card.discovery.source_count} source(s) summarized`);
      console.log("artifact: .understudy/capture-import/workload-card.json");
    });
}

function registerRouteDecisionCommands(program: Command): void {
  const routeDecision = program
    .command("route-decision")
    .description("Plan conservative route decision packets from local Workload Cards");

  routeDecision
    .command("plan")
    .description("Write a route decision packet JSON artifact")
    .requiredOption("--workload-card <path>", "Path to a Workload Card JSON artifact")
    .option("--output <path>", "Output path; defaults to .understudy/route-decision/route-decision-packet.json")
    .option("--json", "Output JSON")
    .action((options: { workloadCard: string; output?: string; json?: boolean }) => {
      const { packet, outputPath } = planRouteDecision(options.workloadCard, options.output);
      if (commandJsonEnabled(program, options)) {
        printJson(packet);
        return;
      }
      console.log(`Route Decision Packet written: ${relative(process.cwd(), outputPath)}`);
      console.log(`decision: ${String(packet.decision)}`);
      console.log("No provider calls, live pricing lookups, uploads, or hosted jobs were made.");
    });
}

function registerValueCommands(program: Command): void {
  const value = program.command("value").description("Build local value artifacts without provider calls");

  value
    .command("report")
    .description("Write a conservative Value Report from local artifacts")
    .requiredOption("--workload-card <path>", "Path to a Workload Card JSON artifact")
    .requiredOption("--route-decision <path>", "Path to a Route Decision Packet JSON artifact")
    .option("--requests-per-month <number>", "Monthly request volume for scenario math", parseNonNegativeNumber)
    .option("--baseline-cost-usd <number>", "Planning override for baseline cost per request", parseNonNegativeNumber)
    .option("--baseline-latency-ms <number>", "Planning override for baseline latency", parseNonNegativeNumber)
    .option("--candidate-cost-usd <number>", "Planning override for candidate cost per request", parseNonNegativeNumber)
    .option("--candidate-latency-ms <number>", "Planning override for candidate latency", parseNonNegativeNumber)
    .option("--output <path>", "Output path; defaults to .understudy/value/value-report.json")
    .action(
      (options: {
        workloadCard: string;
        routeDecision: string;
        requestsPerMonth?: number;
        baselineCostUsd?: number;
        baselineLatencyMs?: number;
        candidateCostUsd?: number;
        candidateLatencyMs?: number;
        output?: string;
      }) => {
        try {
          const { report, outputPath } = buildValueReport(options);
          console.log(`Value Report written: ${relative(process.cwd(), outputPath)}`);
          console.log(`claim_status: ${String(report.claim_status)}`);
          console.log("No provider calls, uploads, hosted jobs, or public savings claims were made.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(message);
          process.exitCode = 1;
        }
      },
    );
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("understudy")
    .description("Public Understudy agent tools and skill-library CLI")
    .version(readCliVersion())
    .option("--json", "Emit machine-readable JSON when supported");

  program.command("spine").description("Print the public MVP workflow spine").action(printSpine);

  program
    .command("platforms")
    .description("List agent platform adapters for Claude Code, Cursor, Codex, and OpenCode")
    .option("--inspect <id>", "Inspect one platform adapter")
    .action((options: { inspect?: string }) => {
      printPlatforms(commandJsonEnabled(program, {}), options.inspect);
    });

  const skills = program.command("skills").description("List and inspect public skills");
  skills.option("--list", "List public MVP skills");
  skills.option("--inspect <name>", "Inspect one public skill");
  skills.option("--search <query>", "Search skills and reference docs");
  skills.action((options: { inspect?: string; search?: string }) => {
    if (options.inspect) {
      inspectSkill(options.inspect);
      return;
    }
    if (options.search) {
      searchSkills(options.search, commandJsonEnabled(program, {}));
      return;
    }
    printSkillList();
  });

  registerDoctorCommand(program, printDoctorJson);
  registerDaemonCommand(program);
  registerDesktopCommand(program);

  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerStatusCommand(program);
  registerKeysCommand(program);
  registerModelsCommand(program);
  registerProjectsCommand(program);
  registerWorkloadsCommand(program);
  registerCapturesCommand(program);
  registerTracesCommand(program);
  registerEvalsCommand(program);
  registerExploreCommand(program);
  registerGatewayCommand(program);
  registerRoutesCommand(program);
  registerSetupCommand(program);
  registerSetupCodeCommand(program);
  registerRunCommand(program);
  registerRunsCommand(program);
  registerRuntimeCommand(program);
  registerTrainingCommand(program);

  const understand = program
    .command("capture-evidence")
    .alias("understand")
    .description("Run local-only workload evidence capture commands");
  understand
    .command("check")
    .description("Inspect local repo metadata and write .understudy/capture-evidence/check.json")
    .requiredOption("--repo <path>", "Local repository path")
    .action((options: { repo: string }) => {
      printJson(runUnderstandCheck(options.repo));
    });
  understand
    .command("workload-card")
    .description("Create a metadata-only Workload Card under .understudy/workload-discovery/")
    .requiredOption("--repo <path>", "Local repository path")
    .action((options: { repo: string }) => {
      printJson(runUnderstandWorkloadCard(options.repo));
    });

  registerOptimizeWorkloadCommand(program);

  registerCaptureImportCommands(program);
  registerRouteDecisionCommands(program);
  registerValueCommands(program);
  registerExperimentsCommands(program);
  registerNextCommand(program);

  annotateGlobalJsonHelp(program);

  program.action(printSpine);
  return program;
}

/**
 * The global `--json` flag only appears in the program's own help, but
 * Commander accepts it before or after the subcommand. Surface it in
 * every subcommand's help so it is discoverable without trial and error;
 * skip commands that declare their own `--json`.
 */
function annotateGlobalJsonHelp(command: Command): void {
  for (const sub of command.commands) {
    const hasOwnJson = sub.options.some((option) => option.long === "--json");
    if (!hasOwnJson) {
      sub.addHelpText(
        "after",
        "\nGlobal options:\n  --json    Emit machine-readable JSON when supported",
      );
    }
    annotateGlobalJsonHelp(sub);
  }
}

export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
