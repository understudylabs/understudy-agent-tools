import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUnderstandCheck, runUnderstandWorkloadCard } from "./understand.js";
import { buildWorkloadCard, previewCaptureImport, scanCaptureImport } from "./capture-import.js";
import { planRouteDecision } from "./route-decision.js";
import { buildValueReport } from "./value-report.js";
import { registerCapturesCommand } from "./commands/captures.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerGatewayCommand } from "./commands/gateway.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerProjectsCommand } from "./commands/projects.js";
import { registerRoutesCommand } from "./commands/routes.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCodeCommand } from "./commands/setup-code.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerOptimizeWorkloadCommand } from "./commands/optimize-workload.js";
import { registerWorkloadsCommand } from "./commands/workloads.js";
import { registerExperimentsCommands, registerNextCommand } from "./commands/experiments.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type SkillSummary = {
  name: string;
  path: string;
  description: string;
};

type SearchResult = {
  name: string;
  path: string;
  kind: "skill" | "reference" | "cookbook";
  score: number;
  matches: string[];
};

type SearchCandidate = Omit<SearchResult, "score" | "matches"> & {
  text: string;
};

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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
    console.log(`No skill or cookbook matches for: ${query}`);
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
  const candidates = [
    ...readSearchFiles(join(repoRoot, "skills"), "skill"),
    ...readSearchFiles(join(repoRoot, "cookbook"), "cookbook"),
  ];
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

function readSearchFiles(root: string, defaultKind: "skill" | "cookbook"): SearchCandidate[] {
  if (!existsSync(root)) {
    return [];
  }
  const files = walkTextFiles(root)
    .filter((path) => {
      const relativePath = relative(repoRoot, path).replaceAll("\\", "/");
      return (
        relativePath.endsWith("/SKILL.md") ||
        relativePath.endsWith("/reference.md") ||
        relativePath.startsWith("skills/onboard/") && relativePath.endsWith(".md") ||
        relativePath.startsWith("cookbook/") && relativePath.endsWith("README.md")
      );
    });
  return files.map((path) => {
    const relativePath = relative(repoRoot, path).replaceAll("\\", "/");
    const text = readFileSync(path, "utf8");
    const skillName = relativePath.startsWith("skills/")
      ? relativePath.split("/")[1] ?? relativePath
      : relativePath.split("/").slice(0, 2).join("/");
    return {
      name: skillName,
      path: relativePath,
      kind: relativePath.endsWith("SKILL.md") ? "skill" : defaultKind === "cookbook" ? "cookbook" : "reference",
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
  console.log("1. skills/understudy/SKILL.md routes the local-first workflow.");
  console.log("2. skills/capture-evidence/SKILL.md pins harness, metric, splits, and baseline.");
  console.log("3. skills/optimize-workload/SKILL.md validates freshness before optimization claims.");
  console.log("4. skills/use-understudy-gateway/SKILL.md runs authenticated gateway workflows when approved.");
}

function printDoctorJson(): void {
  const required = [
    "README.md",
    "LICENSE",
    "package.json",
    "src/index.ts",
    "skills/understudy/SKILL.md",
    "vendor/MANIFEST.md",
  ];
  const missing = required.filter((path) => !existsSync(join(repoRoot, path)));
  console.log(
    JSON.stringify(
      {
        repo: "understudy-agent-tools",
        runtime: "node",
        node: process.version,
        missing,
        ok: missing.length === 0,
      },
      null,
      2,
    ),
  );
  if (missing.length > 0) {
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

function registerCaptureImportCommands(program: Command): void {
  const captureImport = program
    .command("capture-import")
    .description("Scan and preview local import candidates using metadata only");

  captureImport
    .command("scan")
    .description("Scan a local repo for capture/import source metadata")
    .option("--repo <path>", "Repository to scan", ".")
    .option("--json", "Output JSON")
    .action((options: { repo: string; json?: boolean }) => {
      const manifest = scanCaptureImport(options.repo);
      if (commandJsonEnabled(program, options)) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      console.log(`capture-import scan: ${manifest.source_count} metadata-only sources`);
      console.log(`manifest: ${relative(process.cwd(), join(resolve(options.repo), ".understudy/capture-import/capture-sources.json"))}`);
      console.log(`redaction: ${manifest.redaction_manifest_path}`);
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
    .version(readPackageVersion())
    .option("--json", "Emit machine-readable JSON when supported");

  program.command("spine").description("Print the public MVP workflow spine").action(printSpine);

  const skills = program.command("skills").description("List and inspect public skills");
  skills.option("--list", "List public MVP skills");
  skills.option("--inspect <name>", "Inspect one public skill");
  skills.option("--search <query>", "Search skills, references, and cookbook README files");
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

  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerStatusCommand(program);
  registerKeysCommand(program);
  registerModelsCommand(program);
  registerProjectsCommand(program);
  registerWorkloadsCommand(program);
  registerCapturesCommand(program);
  registerGatewayCommand(program);
  registerRoutesCommand(program);
  registerSetupCommand(program);
  registerSetupCodeCommand(program);
  registerRunCommand(program);

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

  program.action(printSpine);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
