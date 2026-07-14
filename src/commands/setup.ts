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
import { packagePath } from "../internal/package-root.js";
import { trackSetupCompleted } from "../internal/telemetry.js";

const SKILL_NAME = "understudy-onboard";

/**
 * Frontmatter description for the installed copy. The plugin ships
 * onboarding (`SKILL.md`) and code conversion (`setup-code.md` + per-stack
 * recipes) as separate surfaces, but this loose copy is a single skill — and
 * Claude-style skill discovery selects on the description. So it must carry
 * both trigger sets: the first-run onboarding phrases from
 * `skills/onboard/SKILL.md` and the conversion phrases from the historical
 * pre-plugin frontmatter ("convert to Understudy", "add GEPA", ...).
 */
const INSTALLED_DESCRIPTION =
  'Use as the engaging first-run experience right after installing Understudy — whenever a developer says "get started", "set me up", "I\'m new to this", "onboard me", or asks what Understudy is and where to begin — and to convert an existing application to route LLM calls through the Understudy gateway or add thin Understudy cookbooks such as a DSPy-style GEPA prompt optimizer. Use when the user asks to "convert to Understudy", "set up Understudy in this repo", "route through Understudy", "siphon traffic to Understudy", "add GEPA", "optimize this prompt", "improve this eval", or any similar phrasing about wiring up Understudy or using an Understudy API key from an agent. Onboarding profiles the machine and the developer, writes a durable ~/.understudy/profile.json, and hands off to the understudy orchestrator; conversion detects the SDK or framework in use (raw Anthropic SDK, raw OpenAI SDK, Mastra, Vercel AI SDK, LangChain, LlamaIndex, DSPy/GEPA, or anything else that speaks Anthropic/OpenAI wire shape) and applies the matching recipe.';

/**
 * Routing section appended to the installed SKILL.md body. The plugin build
 * of the onboard skill never mentions the conversion recipes, so the flat
 * legacy copy needs an explicit pointer from the skill body to the sibling
 * files it ships with.
 */
const CONVERSION_ROUTING = `
## Converting a repo to Understudy

For "convert this to Understudy", "route through Understudy", "add GEPA", or
any other request about wiring an application to the Understudy gateway,
follow [setup-code.md](setup-code.md) in this directory. Its dispatch table
picks the matching per-stack recipe shipped alongside this file:
[anthropic-typescript.md](anthropic-typescript.md),
[openai-typescript.md](openai-typescript.md),
[mastra-typescript.md](mastra-typescript.md),
[gepa-typescript.md](gepa-typescript.md),
[universal-typescript.md](universal-typescript.md).
`;

interface SetupOpts {
  global?: boolean;
  force?: boolean;
}

/**
 * `understudy setup` — install the agent-onboarding skill into the user's
 * coding-agent skill directory.
 *
 * This command is the legacy direct skill-copy path for agents that read
 * Claude-compatible `.claude/skills/<name>/SKILL.md` directories. The primary
 * multi-agent install path is now `install.sh --agents ...` plus the
 * `install-agent-adapter` skill, which handles Claude Code, Cursor, Codex, and
 * OpenCode without copying skill content per platform.
 *
 * The skill content (`SKILL.md` + per-target recipes) ships inside the
 * package at `skills/` (with a `dist/skills/` fallback for older layouts).
 * This means a user who just installed `understudy` via curl or npm has the
 * latest skill content embedded — no separate download, no network dependency
 * at install time.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Install the legacy Claude-compatible Understudy onboarding skill copy.",
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

  // Write the master SKILL.md from the bundled onboarding skill, with three
  // legacy-copy adjustments: the frontmatter name matches the installed
  // directory, the description covers both onboarding and conversion
  // triggers, and the body ends with a routing section for the conversion
  // recipes shipped alongside.
  const skillSource = readFileSync(
    join(skillsSource, "onboard", "SKILL.md"),
    "utf8",
  );
  const skillPath = join(destRoot, "SKILL.md");
  const installedSkill = `${skillSource
    .replace(/^name:.*$/m, `name: ${SKILL_NAME}`)
    .replace(/^description:.*$/m, `description: ${INSTALLED_DESCRIPTION}`)
    .trimEnd()}\n${CONVERSION_ROUTING}`;
  writeFileSync(skillPath, installedSkill, "utf8");

  // Copy the supporting docs (per-target recipes, setup-code task,
  // reference.md) next to SKILL.md, mirroring `skills/onboard/` so relative
  // links keep working. We don't pick by language here — the agent reads the
  // dispatch table and picks the right recipe at run time. Shipping all of
  // them lets the agent handle whichever stack the user actually has.
  const recipesDir = join(skillsSource, "onboard");
  const recipeFiles = readdirSync(recipesDir).filter(
    (f) => f.endsWith(".md") && f !== "SKILL.md",
  );
  const referencePaths: string[] = [];
  for (const filename of recipeFiles) {
    const dest = join(destRoot, filename);
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
      `  Open this repo in Claude Code or another agent that reads .claude/skills/\n` +
      `  and say: ${kleur.cyan('"convert this to Understudy"')}\n\n` +
      `  For Claude Code, Cursor, Codex, or OpenCode adapter setup, prefer\n` +
      `  ${kleur.cyan("install.sh --agents ...")} or the ${kleur.cyan("install-agent-adapter")} skill.\n\n` +
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
  const packagedSkills = packagePath("skills");
  if (existsSync(join(packagedSkills, "onboard", "setup-code.md"))) {
    return packagedSkills;
  }
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
