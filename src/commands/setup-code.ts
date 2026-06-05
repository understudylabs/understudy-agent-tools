import { Command } from "commander";

import { isJsonMode, runAction } from "../internal/output.js";

interface SetupCodeOpts {
  client?: string;
  file?: string;
}

const recipeByClient: Record<string, string> = {
  setup: "skills/onboard/setup-code.md",
  anthropic: "skills/onboard/anthropic-typescript.md",
  openai: "skills/onboard/openai-typescript.md",
  mastra: "skills/onboard/mastra-typescript.md",
  universal: "skills/onboard/universal-typescript.md",
  gepa: "skills/onboard/gepa-typescript.md",
};

export function registerSetupCodeCommand(program: Command): void {
  program
    .command("setup-code")
    .description("Route coding agents to the Understudy setup skill instead of patching code directly.")
    .option("--client <name>", "Recipe hint: anthropic, openai, mastra, universal, or gepa.", "universal")
    .option("--file <path>", "Optional source file hint for the coding agent.")
    .action(async function (this: Command, opts: SetupCodeOpts) {
      await runAction(this, async () => routeSetupCode(opts, isJsonMode(this)));
    });
}

function routeSetupCode(opts: SetupCodeOpts, json: boolean): void {
  const client = normalizeClient(opts.client);
  const recipe = recipeByClient[client] ?? recipeByClient.setup;
  const payload = {
    ok: true,
    mode: "skill-routed",
    skill: "skills/onboard/setup-code.md",
    recipe,
    file_hint: opts.file ?? null,
    next_command: "understudy setup",
    message:
      "Use the onboarding skill and referenced recipe to patch the application. The CLI no longer rewrites source code directly.",
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(
    [
      "setup-code is skill-routed.",
      "",
      `Skill: ${payload.skill}`,
      `Recipe: ${payload.recipe}`,
      opts.file ? `File hint: ${opts.file}` : null,
      "",
      "Run `understudy setup` to install the onboarding skill, then ask your coding agent to convert this repo to Understudy.",
      "The CLI does not rewrite source code directly.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n") + "\n",
  );
}

function normalizeClient(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "universal";
  return normalized in recipeByClient ? normalized : "universal";
}
