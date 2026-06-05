import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { globalCompanionDir, globalCompanionStatePath } from "../config/paths.js";
import { isJsonMode, runAction } from "../internal/output.js";

interface CompanionOpenOpts {
  offline?: boolean;
  foreground?: boolean;
}

interface CompanionLaunch {
  path: string;
  pid: number;
  close: () => void;
}

const CompanionStateSchema = z.object({
  pid: z.number().int().positive(),
  path: z.string().min(1),
  started_at_ms: z.number().int().positive(),
});

const FEED = [
  {
    label: "Reflective prompt optimization",
    message: "Reflective prompt optimization scores prompt candidates against examples, studies failures, and writes better variants. GEPA is one approach.",
    read_more_url: "https://university.understudylabs.com/articles/reflective-prompt-optimization",
  },
  {
    label: "Open weights",
    message: "An open weights model publishes its learned parameters so teams can run, inspect, or fine-tune it themselves.",
    read_more_url: "https://university.understudylabs.com/articles/open-weights",
  },
  {
    label: "Inference",
    message: "Inference is the act of running a trained model to produce an answer, tool call, embedding, or prediction.",
    read_more_url: "https://university.understudylabs.com/articles/inference",
  },
  {
    label: "Eval",
    message: "An eval is a repeatable test that turns model behavior into evidence instead of vibes.",
    read_more_url: "https://university.understudylabs.com/articles/evals",
  },
  {
    label: "Routing",
    message: "Model routing chooses which model handles a request based on cost, latency, quality, or policy.",
    read_more_url: "https://university.understudylabs.com/articles/model-routing",
  },
  {
    label: "Context window",
    message: "A context window is the amount of prompt, history, and retrieved material a model can consider at once.",
    read_more_url: "https://university.understudylabs.com/articles/context-windows",
  },
  {
    label: "Recursive Language Model",
    message: "A Recursive Language Model improves a task by looping: propose, critique, revise, and stop when the output clears a rubric.",
    read_more_url: "https://university.understudylabs.com/articles/recursive-language-model",
  },
  {
    label: "Context rot",
    message: "Context rot happens when a prompt accumulates stale, irrelevant, or conflicting material until the model has a harder job.",
    read_more_url: "https://university.understudylabs.com/articles/context-rot",
  },
  {
    label: "Hallucination",
    message: "A hallucination is confident model output that is not grounded in the task, sources, tools, or real world.",
    read_more_url: "https://university.understudylabs.com/articles/hallucination",
  },
  {
    label: "Time to first token",
    message: "Time to first token is how long the user waits before streaming begins; retrieval, queueing, and model startup all affect it.",
    read_more_url: "https://university.understudylabs.com/articles/time-to-first-token",
  },
  {
    label: "Tokens per second",
    message: "Tokens per second measures generation speed after output starts; it depends on model size, hardware, batching, and output length.",
    read_more_url: "https://university.understudylabs.com/articles/tokens-per-second",
  },
  {
    label: "Prompt caching",
    message: "Prompt caching reuses computation for repeated prefix tokens, lowering latency and cost when many calls share the same context.",
    read_more_url: "https://university.understudylabs.com/articles/prompt-caching",
  },
  {
    label: "Distillation",
    message: "Distillation trains a smaller or cheaper model to imitate useful behavior from a stronger model.",
    read_more_url: "https://university.understudylabs.com/articles/distillation",
  },
  {
    label: "Tool call",
    message: "A tool call is structured model output that asks software to run an action, query, or workflow.",
    read_more_url: "https://university.understudylabs.com/articles/tool-calling",
  },
  {
    label: "Latency",
    message: "Latency is the time from request to useful output; good AI systems optimize both quality and wait time.",
    read_more_url: "https://university.understudylabs.com/articles/latency",
  },
  {
    label: "NVIDIA A100",
    message: "A100s are older 40GB/80GB workhorse GPUs, often around $1-3 per GPU-hour, good for many 7B-70B inference jobs.",
    read_more_url: "https://university.understudylabs.com/articles/a100",
  },
  {
    label: "NVIDIA H100",
    message: "H100s are 80GB Hopper GPUs, often around $2-8 per GPU-hour, built for high-throughput training and large-model inference.",
    read_more_url: "https://university.understudylabs.com/articles/h100",
  },
  {
    label: "NVIDIA H200",
    message: "H200s add much more memory bandwidth and 141GB VRAM, often premium priced, useful for larger models and longer contexts.",
    read_more_url: "https://university.understudylabs.com/articles/h200",
  },
  {
    label: "NVIDIA B200 and GB200",
    message: "B200 and GB200 systems are next-gen Blackwell hardware for frontier-scale training and serving; availability and pricing vary widely.",
    read_more_url: "https://university.understudylabs.com/articles/b200-gb200",
  },
];

const TIPS = FEED.map((item) => item.message);

export function registerCompanionCommand(program: Command): void {
  const companion = program
    .command("companion")
    .description("Manage the optional local Understudy companion status app.");

  companion
    .command("open")
    .description("Open the optional local companion status app.")
    .option("--offline", "Fail if the companion is not already installed.")
    .option("--foreground", "Run in the foreground instead of detaching.")
    .action(async function (this: Command, opts: CompanionOpenOpts) {
      await runAction(this, () => openCompanion(opts, isJsonMode(this)));
    });

  companion
    .command("status")
    .description("Print local companion install and process state.")
    .action(function (this: Command) {
      statusCompanion(isJsonMode(this));
    });

  companion
    .command("close")
    .description("Close the running local companion status app.")
    .action(function (this: Command) {
      closeCompanion(isJsonMode(this));
    });

  companion
    .command("tips")
    .description("Print waiting-room tips for long-running agent tasks.")
    .action(function (this: Command) {
      printTips(isJsonMode(this));
    });

  companion
    .command("feed")
    .description("Print the safe display feed used by the companion.")
    .action(function (this: Command) {
      printFeed(isJsonMode(this));
    });

  companion
    .command("preview")
    .description("Open the companion UI preview in the local browser.")
    .action(function (this: Command) {
      previewCompanion(isJsonMode(this));
    });
}

async function openCompanion(
  opts: CompanionOpenOpts,
  json: boolean,
): Promise<void> {
  const companion = await launchCompanion({
    offline: Boolean(opts.offline),
    foreground: Boolean(opts.foreground),
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, path: companion.path, pid: companion.pid, detached: !opts.foreground })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Opened Understudy companion\n` +
      `${kleur.gray("path")}  ${companion.path}\n` +
      `${kleur.gray("pid")}   ${companion.pid}\n`,
  );
}

export async function launchCompanion(opts: {
  offline?: boolean;
  foreground?: boolean;
} = {}): Promise<CompanionLaunch> {
  const path = await resolveCompanionPath(Boolean(opts.offline));
  const env = {
    ...process.env,
    UNDERSTUDY_COMPANION_TIPS: JSON.stringify(TIPS),
  };
  const child = spawn(path, [], {
    env,
    stdio: opts.foreground ? "inherit" : "ignore",
    detached: !opts.foreground,
  });
  if (!child.pid) {
    throw new Error("Companion process did not start.");
  }
  const pid = child.pid;
  if (!opts.foreground) {
    child.unref();
  }
  writeCompanionState({ pid, path, started_at_ms: Date.now() });
  return {
    path,
    pid,
    close: () => closeCompanionPid(pid),
  };
}

function statusCompanion(json: boolean): void {
  const installed = installedCompanionPath();
  const state = readCompanionState();
  const running = state ? isPidRunning(state.pid) : false;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        installed: Boolean(installed),
        installed_path: installed,
        running,
        pid: running ? state?.pid : null,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${kleur.bold("installed")}  ${installed ? "yes" : "no"}\n` +
      `${kleur.bold("path")}       ${installed ?? kleur.dim("(none)")}\n` +
      `${kleur.bold("running")}    ${running ? "yes" : "no"}\n` +
      `${kleur.bold("pid")}        ${running ? state?.pid : kleur.dim("(none)")}\n`,
  );
}

function closeCompanion(json: boolean): void {
  const state = readCompanionState();
  const running = state ? isPidRunning(state.pid) : false;
  if (state && running) {
    closeCompanionPid(state.pid);
  }
  clearCompanionState();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, closed: running, pid: running ? state?.pid : null })}\n`,
    );
    return;
  }

  if (running) {
    process.stdout.write(`${kleur.green("✓")} Closed Understudy companion\n`);
    return;
  }
  process.stdout.write(`${kleur.dim("No running Understudy companion found.")}\n`);
}

function printTips(json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, tips: TIPS })}\n`);
    return;
  }
  process.stdout.write(`${TIPS.map((tip) => `- ${tip}`).join("\n")}\n`);
}

function printFeed(json: boolean): void {
  const feed = {
    ok: true,
    status: "working",
    headline: "Agent run in progress",
    org_id: null,
    project_slug: null,
    items: FEED,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(feed)}\n`);
    return;
  }
  for (const item of feed.items) {
    process.stdout.write(`${kleur.bold(item.label)}  ${item.message}\n`);
  }
}

function previewCompanion(json: boolean): void {
  const url = companionPreviewUrl();
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, url })}\n`);
    return;
  }
  openUrl(url);
  process.stdout.write(`${kleur.green("✓")} Opened companion preview\n${kleur.gray("url")}  ${url}\n`);
}

async function resolveCompanionPath(noDownload: boolean): Promise<string> {
  const override = process.env.UNDERSTUDY_COMPANION_PATH;
  if (override) return override;

  const installed = installedCompanionPath();
  if (installed) return installed;

  if (noDownload) {
    throw new Error("Companion app is not installed. Run `understudy companion open` without --offline.");
  }

  return downloadCompanion();
}

function installedCompanionPath(): string | null {
  const path = companionInstallPath();
  return existsSync(path) ? path : null;
}

async function downloadCompanion(): Promise<string> {
  const url = companionDownloadUrl();
  const path = companionInstallPath();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not download companion app (${res.status}) from ${url}.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes);
  chmodSync(path, 0o700);
  return path;
}

function companionDownloadUrl(): string {
  const override = process.env.UNDERSTUDY_COMPANION_URL;
  if (override) return override;
  return `https://github.com/understudylabs/understudy-tools/releases/latest/download/${companionArtifactName()}`;
}

function companionPreviewUrl(): string {
  const uiPath = join(companionUiDir(), "index.html");
  const params = new URLSearchParams({
    status: "working",
    headline: "Agent run in progress",
    items: JSON.stringify(FEED),
  });
  return `file://${uiPath}?${params.toString()}`;
}

function companionUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "companion", "ui"),
    resolve(here, "..", "companion", "ui"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (!found) {
    throw new Error("Could not locate companion UI assets. Run `npm run build` first.");
  }
  return found;
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function companionInstallPath(): string {
  return join(globalCompanionDir(), companionArtifactName());
}

function companionArtifactName(): string {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  return `understudy-tools-companion-${os}-${arch}${ext}`;
}

function writeCompanionState(state: z.infer<typeof CompanionStateSchema>): void {
  const path = globalCompanionStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
}

function readCompanionState(): z.infer<typeof CompanionStateSchema> | null {
  const path = globalCompanionStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = CompanionStateSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function clearCompanionState(): void {
  try {
    unlinkSync(globalCompanionStatePath());
  } catch {
    // The state file is best-effort bookkeeping.
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function closeCompanionPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The companion may already have exited.
  }
}
