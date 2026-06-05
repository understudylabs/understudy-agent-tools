import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";

const KeyMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  obfuscated_value: z.string(),
  last_used_at: z.string().nullable(),
  permissions: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string().optional(),
});

const ListKeysResponseSchema = z.object({
  keys: z.array(KeyMetadataSchema),
});

const CreateKeyResponseSchema = z.object({
  value: z.string(),
  metadata: KeyMetadataSchema,
});

const RevokeKeyResponseSchema = z.object({
  id: z.string(),
  revoked: z.literal(true),
});

interface OrgOpt {
  org?: string;
}

/**
 * `understudy keys [list|create|revoke <id>]` — org-level API key management
 * against the admin API at `/admin/v1/orgs/:org_id/api_keys`.
 *
 * `keys create` prints the new sk_* value exactly once on success.
 * The admin API never returns it again — it's a write-only secret
 * past the creation moment. Both human and JSON output reflect that.
 */
export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage org-level Understudy API keys.");

  keys
    .command("list")
    .description("List API keys in the current org.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, opts: OrgOpt) {
      await runAction(this, () => runList(this, opts));
    });

  keys
    .command("create")
    .description("Mint a new sk_* API key.")
    .option("--name <label>", "Human-readable key name.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (
      this: Command,
      opts: OrgOpt & { name?: string },
    ) {
      await runAction(this, () => runCreate(this, opts));
    });

  keys
    .command("revoke <id>")
    .description("Revoke an existing API key by id.")
    .option("--yes", "Skip the confirmation prompt.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (
      this: Command,
      id: string,
      opts: OrgOpt & { yes?: boolean },
    ) {
      await runAction(this, () => runRevoke(this, id, opts));
    });
}

async function runList(cmd: Command, opts: OrgOpt): Promise<void> {
  const auth = resolveAuth(opts.org);
  const res = await request(
    { url: `/admin/v1/orgs/${auth.orgId}/api_keys`, orgId: auth.orgId },
    ListKeysResponseSchema,
  );
  trackControlPlaneAction({
    resource: "api_keys",
    action: "listed",
    orgId: auth.orgId,
    resultCount: res.data.keys.length,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }

  if (res.data.keys.length === 0) {
    process.stdout.write(
      `${kleur.gray("No API keys in this org.")} Run ${kleur.cyan("understudy keys create")} to mint one.\n`,
    );
    return;
  }

  const rows = res.data.keys.map((k) => ({
    suffix: k.obfuscated_value,
    name: k.name,
    created_at: k.created_at,
    last_used_at: k.last_used_at ?? "",
    permissions: k.permissions.join(","),
  }));
  const headers = ["suffix", "name", "created_at", "last_used_at", "permissions"];
  const widths = headers.map((h) =>
    Math.max(
      h.length,
      ...rows.map((r) => r[h as keyof typeof r].length),
    ),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(
    `${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${headers.map((h, i) => pad(r[h as keyof typeof r], widths[i]!)).join("  ")}\n`,
    );
  }
}

async function runCreate(
  cmd: Command,
  opts: OrgOpt & { name?: string },
): Promise<void> {
  const auth = resolveAuth(opts.org);
  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/api_keys`,
      orgId: auth.orgId,
      method: "POST",
      body,
    },
    CreateKeyResponseSchema,
  );
  trackControlPlaneAction({
    resource: "api_keys",
    action: "created",
    orgId: auth.orgId,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }

  // One-time copy moment. Explicit framing.
  process.stdout.write(
    `${kleur.yellow("!")} Save this key now — you will not see it again.\n\n`,
  );
  process.stdout.write(`${kleur.bold(res.data.value)}\n\n`);
  process.stdout.write(
    `${kleur.gray(`id: ${res.data.metadata.id}`)}\n` +
      `${kleur.gray(`name: ${res.data.metadata.name}`)}\n`,
  );
}

async function runRevoke(
  cmd: Command,
  id: string,
  opts: OrgOpt & { yes?: boolean },
): Promise<void> {
  const auth = resolveAuth(opts.org);

  if (!opts.yes && !isJsonMode(cmd)) {
    const ok = await confirm({
      message: `Revoke key ${id}? This is immediate and cannot be undone.`,
      default: false,
    });
    if (!ok) {
      process.stdout.write(`${kleur.gray("Cancelled.")}\n`);
      return;
    }
  }

  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/api_keys/${encodeURIComponent(id)}`,
      orgId: auth.orgId,
      method: "DELETE",
    },
    RevokeKeyResponseSchema,
  );
  trackControlPlaneAction({
    resource: "api_keys",
    action: "revoked",
    orgId: auth.orgId,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Revoked key ${kleur.bold(id)}\n`,
  );
}
