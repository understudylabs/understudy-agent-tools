import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUnderstandCheck, runUnderstandWorkloadCard } from "./understand.js";
import { buildWorkloadCard, previewCaptureImport, scanCaptureImport } from "./capture-import.js";
import { planRouteDecision } from "./route-decision.js";
import { buildValueReport } from "./value-report.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerCompanionCommand } from "./commands/companion.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerProjectsCommand } from "./commands/projects.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCodeCommand } from "./commands/setup-code.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerOptimizeWorkloadCommand } from "./commands/optimize-workload.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type SkillSummary = {
  name: string;
  path: string;
  description: string;
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
  console.log("");
  console.log("Appendix skills are preserved drafts outside the MVP discovered surface.");
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

function printSpine(): void {
  console.log("understudy-agent-tools");
  console.log("");
  console.log("MVP spine:");
  console.log("1. skills/understudy/SKILL.md routes the local-first workflow.");
  console.log("2. skills/capture-evidence/SKILL.md pins harness, metric, splits, and baseline.");
  console.log("3. skills/optimize-workload/SKILL.md validates freshness before optimization claims.");
  console.log("4. skills/use-understudy-gateway/SKILL.md runs authenticated gateway workflows when approved.");
  console.log("");
  console.log("Appendix skills remain available by path, but are not part of the discovered MVP surface.");
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

function registerDeferredRuntimeCommand(program: Command, name: string, description: string): void {
  program
    .command(name)
    .description(description)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      console.log(`${name}: deferred to the full Understudy runtime`);
      console.log("This repo now carries the public tools CLI and skill library.");
      console.log("Gateway, browser, channel, schedule, and daemon commands should come from US intentionally.");
    });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("understudy-tools")
    .description("Public Understudy agent tools and skill-library CLI")
    .version(readPackageVersion())
    .option("--json", "Emit machine-readable JSON when supported");

  program.command("spine").description("Print the public MVP workflow spine").action(printSpine);

  const skills = program.command("skills").description("List and inspect public skills");
  skills.option("--list", "List public MVP skills");
  skills.option("--inspect <name>", "Inspect one public skill");
  skills.action((options: { inspect?: string }) => {
    if (options.inspect) {
      inspectSkill(options.inspect);
      return;
    }
    printSkillList();
  });

  program.command("doctor").description("Run local repository diagnostics").option("--json", "Output JSON").action(printDoctorJson);

  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerStatusCommand(program);
  registerKeysCommand(program);
  registerProjectsCommand(program);
  registerSetupCommand(program);
  registerSetupCodeCommand(program);
  registerRunCommand(program);
  registerCompanionCommand(program);

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

  for (const [name, description] of [
    ["chat", "Start a gateway-backed terminal chat session"],
    ["daemon", "Manage the background daemon"],
    ["gateway", "Start the gateway server"],
    ["browser", "Inspect and control the gateway browser runtime"],
    ["channels", "Manage gateway channels"],
    ["schedule", "Manage gateway schedule jobs"],
    ["agent", "Run a single-shot gateway agent turn"],
    ["agents", "List and manage configured agents"],
    ["dashboard", "Open the control UI"],
    ["webchat", "Open the WebChat UI"],
  ] as const) {
    registerDeferredRuntimeCommand(program, name, description);
  }

  program.action(printSpine);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
