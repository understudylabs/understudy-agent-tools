import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { projectConfigPath } from "./paths.js";

/**
 * Per-repo `.understudy/config.json` shape. Contains no secrets — it is
 * safe to check into source control, though the CLI gitignores it by
 * default to keep `org_id` out of public repos.
 */
export const ProjectConfigSchema = z.object({
  org_id: z.string().min(1),
  project_slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, {
      message:
        "project_slug must match /^[a-z0-9][a-z0-9-]{1,62}$/ (lowercase, digits, hyphens; 2–63 chars; cannot start with '-')",
    }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Read the nearest `.understudy/config.json`. Returns `null` if no
 * config exists in the current dir or any ancestor.
 */
export function readProjectConfig(startDir?: string): ProjectConfig | null {
  const path = projectConfigPath(startDir);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${path} as JSON: ${(cause as Error).message}`, {
      cause,
    });
  }
  return ProjectConfigSchema.parse(parsed);
}

/**
 * Write `.understudy/config.json` at the given project root. Creates
 * the `.understudy/` directory if it doesn't yet exist.
 */
export function writeProjectConfig(path: string, config: ProjectConfig): void {
  ProjectConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
}
