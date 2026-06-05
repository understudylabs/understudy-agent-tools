import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { readProjectConfig, writeProjectConfig } from "../config/index.js";
import { projectConfigPath } from "../config/paths.js";
import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

const ProjectSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  name: z.string(),
  created_at: z.string(),
  settings: z.string(),
  deleted_at: z.string().nullable(),
});

const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  cursor: z.string().nullable(),
});

const DeleteProjectResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  deleted: z.literal(true),
});

interface OrgOpt {
  org?: string;
}

/**
 * `understudy projects [list|create|switch|delete]` — project CRUD against the
 * admin API at `/admin/v1/orgs/:org_id/projects`.
 *
 * Org is resolved from `~/.understudy/credentials.json`. If multiple
 * orgs are signed in, `--org <id>` is required to disambiguate.
 */
export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .description("Manage Understudy projects within the current org.");

  projects
    .command("list")
    .description("List projects in the current org.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, opts: OrgOpt) {
      await runAction(this, () => runList(this, opts));
    });

  projects
    .command("create <slug>")
    .description("Create a new project with the given slug.")
    .option("--name <label>", "Human-readable project name. Defaults to <slug>.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (
      this: Command,
      slug: string,
      opts: OrgOpt & { name?: string },
    ) {
      await runAction(this, () => runCreate(this, slug, opts));
    });

  projects
    .command("switch <slug>")
    .description("Switch the local repo to the given project.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, slug: string, opts: OrgOpt) {
      await runAction(this, () => runSwitch(this, slug, opts));
    });

  projects
    .command("delete <slug>")
    .description("Soft-delete a project (R2 traces preserved).")
    .option("--yes", "Skip the confirmation prompt.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (
      this: Command,
      slug: string,
      opts: OrgOpt & { yes?: boolean },
    ) {
      await runAction(this, () => runDelete(this, slug, opts));
    });
}

async function runList(cmd: Command, opts: OrgOpt): Promise<void> {
  const auth = resolveAuth(opts.org);
  const res = await request(
    { url: `/admin/v1/orgs/${auth.orgId}/projects`, orgId: auth.orgId },
    ListProjectsResponseSchema,
  );
  trackControlPlaneAction({
    resource: "projects",
    action: "listed",
    orgId: auth.orgId,
    resultCount: res.data.projects.length,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }

  if (res.data.projects.length === 0) {
    process.stdout.write(
      `${kleur.gray("No projects in this org.")} Run ${kleur.cyan("understudy projects create <slug>")} to create one.\n`,
    );
    return;
  }

  const rows = res.data.projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    created_at: p.created_at,
    deleted_at: p.deleted_at ?? "",
  }));
  const headers = ["slug", "name", "created_at", "deleted_at"];
  const widths = headers.map((h) =>
    Math.max(
      h.length,
      ...rows.map((r) => r[h as keyof typeof r].length),
    ),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const headerLine = headers
    .map((h, i) => kleur.bold(pad(h, widths[i]!)))
    .join("  ");
  process.stdout.write(`${headerLine}\n`);
  for (const r of rows) {
    process.stdout.write(
      `${headers.map((h, i) => pad(r[h as keyof typeof r], widths[i]!)).join("  ")}\n`,
    );
  }
}

async function runCreate(
  cmd: Command,
  slug: string,
  opts: OrgOpt & { name?: string },
): Promise<void> {
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{1,62}$/.`,
    );
  }
  const auth = resolveAuth(opts.org);
  const name = opts.name ?? slug;
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/projects`,
      orgId: auth.orgId,
      method: "POST",
      body: { slug, name },
    },
    ProjectSchema,
  );
  trackControlPlaneAction({
    resource: "projects",
    action: "created",
    orgId: auth.orgId,
    projectSlug: slug,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Created project ${kleur.bold(slug)} (${res.data.id})\n`,
  );
}

async function runSwitch(
  cmd: Command,
  slug: string,
  opts: OrgOpt,
): Promise<void> {
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{1,62}$/.`,
    );
  }
  const auth = resolveAuth(opts.org);

  // Verify the slug exists. List call is cheaper than a per-slug GET
  // (which the admin API doesn't expose anyway). If the slug isn't in
  // the first page, walk the cursor — but typical orgs have <20
  // projects so this almost always finishes in one round trip.
  let cursor: string | null = null;
  let found = false;
  while (true) {
    const url: string = cursor
      ? `/admin/v1/orgs/${auth.orgId}/projects?cursor=${encodeURIComponent(cursor)}`
      : `/admin/v1/orgs/${auth.orgId}/projects`;
    const res = await request(
      { url, orgId: auth.orgId },
      ListProjectsResponseSchema,
    );
    if (res.data.projects.some((p) => p.slug === slug)) {
      found = true;
      break;
    }
    cursor = res.data.cursor;
    if (!cursor) break;
  }

  if (!found) {
    throw new Error(
      `No project with slug "${slug}" in org ${auth.orgId}. Run \`understudy projects list\` to see what's available.`,
    );
  }

  // Update .understudy/config.json in place, preserving any existing
  // org_id (which must match anyway, but read-modify-write keeps the
  // file shape stable if we add fields later).
  const existing = readProjectConfig();
  writeProjectConfig(projectConfigPath(), {
    org_id: existing?.org_id ?? auth.orgId,
    project_slug: slug,
  });
  trackControlPlaneAction({
    resource: "projects",
    action: "switched",
    orgId: auth.orgId,
    projectSlug: slug,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, org_id: auth.orgId, project_slug: slug })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Switched local repo to project ${kleur.bold(slug)}\n`,
  );
}

async function runDelete(
  cmd: Command,
  slug: string,
  opts: OrgOpt & { yes?: boolean },
): Promise<void> {
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{1,62}$/.`,
    );
  }
  const auth = resolveAuth(opts.org);

  if (!opts.yes && !isJsonMode(cmd)) {
    const ok = await confirm({
      message: `Soft-delete project "${slug}" in org ${auth.orgId}?`,
      default: false,
    });
    if (!ok) {
      process.stdout.write(`${kleur.gray("Cancelled.")}\n`);
      return;
    }
  }

  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/projects/${encodeURIComponent(slug)}`,
      orgId: auth.orgId,
      method: "DELETE",
    },
    DeleteProjectResponseSchema,
  );
  trackControlPlaneAction({
    resource: "projects",
    action: "deleted",
    orgId: auth.orgId,
    projectSlug: slug,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Deleted project ${kleur.bold(slug)}\n`,
  );
}
