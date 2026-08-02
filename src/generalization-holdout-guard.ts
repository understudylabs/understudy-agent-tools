import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<HoldoutAccessRecord>;
  if (value.schema_version !== "understudy.generalization_holdout_access.v2" || !value.accesses) {
    throw new Error(`invalid holdout access marker: ${path}`);
  }
  return value as HoldoutAccessRecord;
}

export function claimHoldoutAccess(path: string, arm: string, group: string, now = new Date()): HoldoutAccessRecord {
  const record = readHoldoutAccess(path);
  const key = holdoutAccessKey(arm, group);
  if (record.accesses[key]) {
    throw new Error(`holdout access already claimed for ${key}`);
  }
  record.accesses[key] = { accessed_at: now.toISOString(), arm, group, split: "holdout" };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "w" });
  return record;
}
