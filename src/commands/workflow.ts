import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import kleur from "kleur";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowsRoot = join(packageRoot, "workflows");

type WorkflowTemplate = {
  id: string;
  path: string;
  description: string;
};

export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("List and run packaged durable workflow templates.");

  workflow
    .command("list")
    .description("List packaged workflow templates.")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) => {
      const templates = readWorkflowTemplates();
      if (options.json || Boolean(program.optsWithGlobals<{ json?: boolean }>().json)) {
        process.stdout.write(`${JSON.stringify({ templates }, null, 2)}\n`);
        return;
      }
      if (templates.length === 0) {
        process.stdout.write(`${kleur.gray("No packaged workflow templates found.")}\n`);
        return;
      }
      process.stdout.write("Packaged workflow templates:\n");
      for (const template of templates) {
        process.stdout.write(`- ${template.id} (${template.path})\n`);
        process.stdout.write(`  ${template.description}\n`);
      }
    });

  workflow
    .command("run <template>")
    .description("Run a packaged workflow template through a Smithers-compatible runner.")
    .option("--run-id <id>", "Durable run id to pass to the workflow runner.")
    .option("--input <json-or-path>", "JSON string or path to a JSON input file.", "{}")
    .option("--format <format>", "Runner output format.", "json")
    .option("--runner-bin <path>", "Smithers-compatible runner binary.", "smithers")
    .option("--dry-run", "Print the runner command without executing it.")
    .action((template: string, options: { runId?: string; input: string; format: string; runnerBin: string; dryRun?: boolean }) => {
      runWorkflowTemplate(template, options);
    });
}

function readWorkflowTemplates(): WorkflowTemplate[] {
  if (!existsSync(workflowsRoot)) {
    return [];
  }
  return readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => {
      const path = join(workflowsRoot, entry.name);
      const text = readFileSync(path, "utf8");
      const id = entry.name.replace(/\.tsx$/, "");
      const description =
        text.match(/^\/\/ understudy-description:\s*(.+)$/m)?.[1]?.trim() ??
        "Packaged Understudy durable workflow template.";
      return {
        id,
        path: relative(packageRoot, path),
        description,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function runWorkflowTemplate(
  templateId: string,
  options: { runId?: string; input: string; format: string; runnerBin: string; dryRun?: boolean },
): void {
  const template = readWorkflowTemplates().find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Unknown workflow template: ${templateId}. Run \`understudy workflow list\`.`);
  }
  const input = readInput(options.input);
  const args = ["up", resolve(packageRoot, template.path)];
  if (options.runId) {
    args.push("--run-id", options.runId);
  }
  args.push("--input", input, "--format", options.format);

  if (options.dryRun) {
    process.stdout.write(`${options.runnerBin} ${args.map(shellQuote).join(" ")}\n`);
    return;
  }

  const result = spawnSync(options.runnerBin, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    const suffix = result.error.message.includes("ENOENT")
      ? " Install a Smithers-compatible runner or pass --runner-bin <path>."
      : "";
    throw new Error(`Unable to run ${options.runnerBin}.${suffix}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function readInput(value: string): string {
  const maybePath = resolve(value);
  if (existsSync(maybePath)) {
    return readFileSync(maybePath, "utf8");
  }
  JSON.parse(value);
  return value;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
