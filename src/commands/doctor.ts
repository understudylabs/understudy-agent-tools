import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { readCredentials } from "../config/credentials.js";
import { readProjectConfig } from "../config/index.js";
import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { listProjects, resolveProject } from "../internal/projects.js";
import { listWorkloads } from "../internal/workloads.js";

const ListKeysResponseSchema = z.object({ keys: z.array(z.unknown()) }).passthrough();
const ListModelsResponseSchema = z.object({ models: z.array(z.unknown()) }).passthrough();

interface DoctorOpts {
  hosted?: boolean;
  probe?: boolean;
  org?: string;
  projectId?: string;
  project?: string;
}

type Check = { name: string; ok: boolean; detail?: string };

export function registerDoctorCommand(program: Command, runLocalDoctor: () => void): void {
  program
    .command("doctor")
    .description("Run local repository diagnostics or hosted readiness checks.")
    .option("--json", "Output JSON")
    .option("--hosted", "Check hosted Understudy readiness without provider calls.")
    .option("--probe", "After hosted checks pass, run one explicit tiny gateway probe.")
    .option("--project-id <id>", "Project id for hosted checks.")
    .option("--project <slug>", "Project slug for hosted checks.")
    .option("--org <id>", "Org id to use.")
    .action(async function (this: Command, opts: DoctorOpts) {
      if (!opts.hosted) {
        runLocalDoctor();
        return;
      }
      await runAction(this, () => runHostedDoctor(this, opts));
    });
}

async function runHostedDoctor(cmd: Command, opts: DoctorOpts): Promise<void> {
  const checks: Check[] = [];
  let nextCommand = "understudy login --email you@company.com";
  let auth: ReturnType<typeof resolveAuth> | null = null;

  try {
    readCredentials();
    auth = resolveAuth(opts.org ?? readProjectConfig()?.org_id);
    checks.push({ name: "credentials", ok: true });
  } catch (error) {
    checks.push({ name: "credentials", ok: false, detail: message(error) });
    return finish(cmd, checks, nextCommand);
  }

  await check("gateway health", checks, async () => {
    const res = await fetch(`${auth!.gatewayUrl.replace(/\/+$/, "")}/healthz`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
  });

  await check("projects", checks, async () => {
    const projects = await listProjects(auth!);
    if (projects.length === 0) {
      throw new Error("no projects");
    }
  });

  let projectResolved: Awaited<ReturnType<typeof resolveProject>> | null = null;
  await check("project selection", checks, async () => {
    projectResolved = await resolveProject({ org: opts.org, projectId: opts.projectId, project: opts.project });
  });

  await check("keys", checks, async () => {
    await request({ url: `/admin/v1/orgs/${auth!.orgId}/api_keys`, orgId: auth!.orgId }, ListKeysResponseSchema);
  });

  await check("models", checks, async () => {
    await request({ url: `/admin/v1/orgs/${auth!.orgId}/models`, orgId: auth!.orgId }, ListModelsResponseSchema);
  });

  await check("workloads", checks, async () => {
    if (!projectResolved) throw new Error("project not resolved");
    await listWorkloads(projectResolved);
  });

  const resolvedForNext = projectResolved as Awaited<ReturnType<typeof resolveProject>> | null;
  const projectLabel = resolvedForNext?.projectSlug ?? resolvedForNext?.projectId ?? "rehearsal";
  nextCommand = `understudy gateway probe --provider anthropic --project ${projectLabel}`;

  if (opts.probe && checks.every((entry) => entry.ok)) {
    await check("gateway probe", checks, async () => {
      const res = await fetch(`${auth!.gatewayUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": auth!.token,
          "anthropic-version": "2023-06-01",
          ...(resolvedForNext?.projectSlug ? { "x-understudy-project": resolvedForNext.projectSlug } : {}),
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: 8,
          // Always stream gateway inference: the edge cuts responses with no
          // first byte within ~125s, so a non-streaming probe can 524 on a
          // slow upstream. Streaming returns headers within seconds.
          stream: true,
          messages: [{ role: "user", content: "Reply with the single word ok." }],
        }),
      });
      // Drain the SSE body so the upstream generation completes instead of
      // being cancelled by an early disconnect.
      await res.text().catch(() => {});
      if (!res.ok) throw new Error(`status ${res.status}`);
    });
  }

  finish(cmd, checks, nextCommand);
}

async function check(name: string, checks: Check[], fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, detail: message(error) });
  }
}

function finish(cmd: Command, checks: Check[], nextCommand: string): void {
  const ok = checks.every((entry) => entry.ok);
  const payload = { ok, hosted: true, checks, next_command: nextCommand };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`${kleur.bold("hosted doctor")}\n`);
    for (const entry of checks) {
      const mark = entry.ok ? kleur.green("✓") : kleur.red("✗");
      process.stdout.write(`${mark} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}\n`);
    }
    process.stdout.write(`next: ${nextCommand}\n`);
  }
  if (!ok) {
    process.exitCode = 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
