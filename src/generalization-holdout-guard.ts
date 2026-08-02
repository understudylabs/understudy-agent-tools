import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HoldoutAccessRecord = {
  schema_version: "understudy.generalization_holdout_access.v2";
  accesses: Record<string, {
    accessed_at: string;
    arm: string;
    group: string;
    split: "holdout";
  }>;
};

export function holdoutAccessKey(arm: string, group: string): string {
  return `${arm}:${group}:holdout`;
}

export function readHoldoutAccess(path: string): HoldoutAccessRecord {
  if (!existsSync(path)) return { schema_version: "understudy.generalization_holdout_access.v2", accesses: {} };
  const accesses: HoldoutAccessRecord["accesses"] = {};
  for (const file of readdirSync(path).filter((name) => name.endsWith(".json"))) {
    const value = JSON.parse(readFileSync(join(path, file), "utf8")) as HoldoutAccessRecord["accesses"][string];
    if (!value || value.split !== "holdout" || !value.arm || !value.group) throw new Error(`invalid holdout access marker: ${join(path, file)}`);
    accesses[holdoutAccessKey(value.arm, value.group)] = value;
  }
  return { schema_version: "understudy.generalization_holdout_access.v2", accesses };
}

export function claimHoldoutAccess(path: string, arm: string, group: string, now = new Date()): HoldoutAccessRecord {
  const record = readHoldoutAccess(path);
  const key = holdoutAccessKey(arm, group);
  if (record.accesses[key]) {
    throw new Error(`holdout access already claimed for ${key}`);
  }
  mkdirSync(path, { recursive: true });
  const markerPath = join(path, `${arm}-${group}.json`);
  if (existsSync(markerPath)) throw new Error(`holdout access already claimed for ${key}`);
  writeFileSync(markerPath, `${JSON.stringify({ accessed_at: now.toISOString(), arm, group, split: "holdout" }, null, 2)}\n`, { flag: "wx" });
  record.accesses[key] = { accessed_at: now.toISOString(), arm, group, split: "holdout" };
  return record;
}
