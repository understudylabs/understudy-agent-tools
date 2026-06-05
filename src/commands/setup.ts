import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import kleur from "kleur";

import { isJsonMode, runAction } from "../internal/output.js";
import { trackSetupCompleted } from "../internal/telemetry.js";

const SKILL_NAME = "understudy-onboard";

/**
 * The frontmatter Claude Code uses to decide when to invoke this skill.
 * The `description` is the routing hint — sharper trigger phrases here
 * = better skill match rate. Test against actual phrasings users use
 * before tweaking.
 */
const SKILL_FRONTMATTER = `---
name: ${SKILL_NAME}
description: Convert an existing application to route LLM calls through the Understudy gateway at UNDERSTUDY_GATEWAY_URL, or add thin Understudy cookbooks such as a DSPy-style GEPA prompt optimizer. Use when the user asks to "convert to Understudy", "set up Understudy in this repo", "route through Understudy", "siphon traffic to Understudy", "add GEPA", "optimize this prompt", "improve this eval", or any similar phrasing about wiring up Understudy or using an Understudy API key from an agent. Detects the SDK or framework in use (raw Anthropic SDK, raw OpenAI SDK, Mastra, Vercel AI SDK, LangChain, LlamaIndex, DSPy/GEPA, or anything else that speaks Anthropic/OpenAI wire shape) and applies the matching recipe.
---

`;

interface SetupOpts {
  global?: boolean;
  force?: boolean;
}

/**
 * `understudy setup` — install the agent-onboarding skill into the user's
 * coding-agent skill directory.
 *
 * Today this targets Claude Code only (`.claude/skills/<name>/SKILL.md`
 * locally, `~/.claude/skills/<name>/SKILL.md` with `--global`).
 * Per-agent format adapters (Cursor `.cursor/rules/*.mdc`, Codex
 * `.codex/...`, etc.) are followup work — pattern lift from `bt setup`
 * which fans out across seven agents.
 *
 * The skill content (master task + per-target recipes) is shipped
 * inside the CLI at `dist/skills/` (copied from repo-root `skills/`
 * by the build script). This means a user who just installed `understudy` via
 * curl or npm has the latest skill content embedded — no separate
 * download, no network dependency at install time.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Install the Understudy onboarding skill into your coding agent's skill directory.",
    )
    .option(
      "--global",
      "Install to ~/.claude/skills/ instead of ./.claude/skills/.",
    )
    .option(
      "--force",
      "Overwrite existing skill files without prompting (default: overwrite anyway, but reserve this for any future confirm gate).",
    )
    .action(async function (this: Command, opts: SetupOpts) {
      await runAction(this, () => runSetup(this, opts));
    });
}

async function runSetup(cmd: Command, opts: SetupOpts): Promise<void> {
  const json = isJsonMode(cmd);
  const skillsSource = locateSkillsSource();
  const destRoot = opts.global
    ? join(homedir(), ".claude", "skills", SKILL_NAME)
    : join(process.cwd(), ".claude", "skills", SKILL_NAME);

  mkdirSync(destRoot, { recursive: true });
  mkdirSync(join(destRoot, "references"), { recursive: true });

  // Write the master SKILL.md = frontmatter + focused setup-code recipe.
  const taskBody = readFileSync(
    join(skillsSource, "onboard", "setup-code.md"),
    "utf8",
  );
  const skillPath = join(destRoot, "SKILL.md");
  writeFileSync(skillPath, SKILL_FRONTMATTER + taskBody, "utf8");

  // Copy every per-target recipe into references/. We don't pick by
  // language here — the agent reads the dispatch table in SKILL.md and
  // picks the right recipe at run time. Shipping all of them lets the
  // agent handle whichever stack the user actually has.
  const recipesDir = join(skillsSource, "onboard");
  const recipeFiles = readdirSync(recipesDir).filter((f) => f.endsWith(".md"));
  const referencePaths: string[] = [];
  for (const filename of recipeFiles) {
    const dest = join(destRoot, "references", filename);
    copyFileSync(join(recipesDir, filename), dest);
    referencePaths.push(dest);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        skill_dir: destRoot,
        skill_path: skillPath,
        references: referencePaths,
      })}\n`,
    );
    await trackSetupCompleted({
      skill: SKILL_NAME,
      global: Boolean(opts.global),
      referenceCount: referencePaths.length,
    });
    return;
  }

  const scopeLabel = opts.global ? "globally" : "in this repo";
  process.stdout.write(
    `\n${kleur.green("✓")} Installed the Understudy onboarding skill ${scopeLabel}.\n\n`,
  );
  process.stdout.write(`  ${kleur.bold(skillPath)}\n`);
  for (const ref of referencePaths) {
    process.stdout.write(`  ${kleur.gray(ref)}\n`);
  }
  process.stdout.write(
    `\n${kleur.bold("Next step")}\n` +
      `  Open this repo in Claude Code (or any agent that reads .claude/skills/)\n` +
      `  and say: ${kleur.cyan('"convert this to Understudy"')}\n\n` +
      `  The agent will read the skill, detect your SDK, and apply the matching\n` +
      `  recipe end-to-end.\n`,
  );
  await trackSetupCompleted({
    skill: SKILL_NAME,
    global: Boolean(opts.global),
    referenceCount: referencePaths.length,
  });
}

/**
 * Find the bundled skills directory.
 *
 * Two layout cases:
 *   - **Installed CLI** (npm or curl): `dist/skills/` lives next to
 *     `dist/cli.js` and `dist/commands/setup.js`. Resolve via
 *     `import.meta.url` → go up one from `dist/commands/` → join
 *     `skills/`.
 *   - **Linked dev checkout** (`pnpm link --global` on this repo):
 *     same `dist/skills/` exists once the build step ran. If it
 *     doesn't (developer ran `setup` straight against `src/` via tsx
 *     without rebuilding), fall back to the repo-root `skills/`.
 *
 * The fallback is what makes `understudy setup` work for *contributors* before
 * they remember to run `pnpm run build`. End users only ever hit the
 * first path.
 */
function locateSkillsSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Try `dist/skills/` (the shipping layout).
  const distSkills = join(here, "..", "skills");
  if (existsSync(join(distSkills, "onboard", "setup-code.md"))) {
    return distSkills;
  }
  // Fall back to repo-root `skills/` — useful only when running this
  // command straight from `src/` via tsx in the contributor's
  // checkout. Goes up: src/commands/ → src/ → repo root.
  const repoSkills = join(here, "..", "..", "skills");
  if (existsSync(join(repoSkills, "onboard", "setup-code.md"))) {
    return repoSkills;
  }
  throw new Error(
    "Could not locate the bundled skill content. If you're developing this CLI, run `pnpm run build` first. If you saw this from an installed CLI, please file an issue.",
  );
}
