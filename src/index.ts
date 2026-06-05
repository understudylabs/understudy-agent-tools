import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  console.log("2. skills/understand-workload/SKILL.md pins harness, metric, splits, and baseline.");
  console.log("3. skills/validate-and-optimize/SKILL.md validates freshness before optimization claims.");
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

function printOptimizeGuide(): void {
  console.log("validate-and-optimize");
  console.log("");
  console.log("This repo keeps workflow in skills and the public CLI. Python is only for small, local optimizer envs.");
  console.log("");
  console.log("Required local artifacts:");
  console.log("- .understudy/understand-workload/harness.json");
  console.log("- .understudy/understand-workload/metric.json");
  console.log("- .understudy/understand-workload/splits.json");
  console.log("- .understudy/understand-workload/baseline.json");
  console.log("");
  console.log("uv setup for GEPA/DSPy experiments:");
  console.log("  uv venv .understudy/venvs/optimize");
  console.log("  uv pip install --python .understudy/venvs/optimize/bin/python 'gepa>=0.0.27,<0.1' 'dspy>=3.0.0'");
  console.log("");
  console.log("Credential boundary:");
  console.log("- Prefer Understudy gateway credentials when the developer explicitly chooses that path.");
  console.log("- BYO provider keys are allowed, but secret values must stay local and must not be printed.");
  console.log("- No provider calls, uploads, downloads, hosted jobs, or package installs without approval.");
  console.log("");
  console.log("Skill entrypoint: skills/validate-and-optimize/SKILL.md");
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
    .version(readPackageVersion());

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

  const validateAndOptimize = program
    .command("validate-and-optimize")
    .alias("optimize")
    .description("Show the skill-led GEPA/DSPy optimization guide");
  validateAndOptimize
    .option("--uv", "Show uv-based optimizer environment guidance")
    .action(printOptimizeGuide);

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
