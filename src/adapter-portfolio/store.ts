import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AdapterPortfolioRegistrySchema,
  AdapterRecordSchema,
  EvidenceRowSchema,
  type AdapterMethod,
  type AdapterPortfolioRegistry,
  type AdapterRecord,
  type EvidenceRow,
  type Holdout,
  type PromotionPolicy,
} from "./types.js";

export const DEFAULT_ADAPTER_PORTFOLIO_PATH = join(
  homedir(),
  ".understudy",
  "adapter-portfolio.json",
);

export type RegistryPathOptions = { registryPath?: string };

function pathFor(options: RegistryPathOptions = {}): string {
  return resolve(options.registryPath ?? process.env.UNDERSTUDY_ADAPTER_PORTFOLIO ?? DEFAULT_ADAPTER_PORTFOLIO_PATH);
}

function now(): string {
  return new Date().toISOString();
}

function defaultPolicy(overrides: Partial<PromotionPolicy> = {}): PromotionPolicy {
  return {
    metric: overrides.metric ?? "score",
    ...(overrides.min_dev_score === undefined ? {} : { min_dev_score: overrides.min_dev_score }),
    ...(overrides.min_holdout_score === undefined ? {} : { min_holdout_score: overrides.min_holdout_score }),
    min_lift_vs_base: overrides.min_lift_vs_base ?? 0,
    max_regression: overrides.max_regression ?? 0,
  };
}

export function emptyRegistry(policy: Partial<PromotionPolicy> = {}): AdapterPortfolioRegistry {
  return AdapterPortfolioRegistrySchema.parse({
    schema_version: "understudy.adapter_portfolio_registry.v1",
    policy: defaultPolicy(policy),
    adapters: {},
  });
}

export function loadRegistry(options: RegistryPathOptions = {}): AdapterPortfolioRegistry {
  const path = pathFor(options);
  if (!existsSync(path)) return emptyRegistry();
  try {
    return AdapterPortfolioRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Adapter portfolio registry is invalid: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveRegistry(registry: AdapterPortfolioRegistry, options: RegistryPathOptions = {}): AdapterPortfolioRegistry {
  const validated = AdapterPortfolioRegistrySchema.parse(registry);
  const path = pathFor(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return validated;
}

export type RegisterAdapterInput = {
  name: string;
  adapterPath: string;
  baseModel: string;
  suite: string;
  method?: AdapterMethod;
  holdout?: Holdout | null;
};

export function registerAdapter(
  input: RegisterAdapterInput,
  options: RegistryPathOptions = {},
): AdapterRecord {
  const registry = loadRegistry(options);
  if (registry.adapters[input.name]) throw new Error(`Adapter already exists: ${input.name}`);
  const timestamp = now();
  const record = AdapterRecordSchema.parse({
    name: input.name,
    adapter_path: input.adapterPath,
    base_model: input.baseModel,
    method: input.method ?? "other",
    status: "draft",
    suite: input.suite,
    holdout: input.holdout ?? null,
    evidence: [],
    created_at: timestamp,
    updated_at: timestamp,
  });
  registry.adapters[input.name] = record;
  saveRegistry(registry, options);
  return record;
}

export function updateAdapter(
  name: string,
  update: { status?: AdapterRecord["status"] },
  options: RegistryPathOptions = {},
): AdapterRecord {
  const registry = loadRegistry(options);
  const current = registry.adapters[name];
  if (!current) throw new Error(`Unknown adapter: ${name}`);
  const updated = AdapterRecordSchema.parse({ ...current, ...update, updated_at: now() });
  registry.adapters[name] = updated;
  saveRegistry(registry, options);
  return updated;
}

export function addEvidence(
  name: string,
  evidenceInput: Omit<EvidenceRow, "evidence_id" | "recorded_at"> & Partial<Pick<EvidenceRow, "evidence_id" | "recorded_at">>,
  options: RegistryPathOptions = {},
): EvidenceRow {
  const registry = loadRegistry(options);
  const adapter = registry.adapters[name];
  if (!adapter) throw new Error(`Unknown adapter: ${name}`);
  const evidence = EvidenceRowSchema.parse({
    ...evidenceInput,
    evidence_id: evidenceInput.evidence_id ?? randomUUID(),
    recorded_at: evidenceInput.recorded_at ?? now(),
  });
  if (evidence.subject === "adapter" && evidence.adapter_name !== name) {
    throw new Error(`Adapter evidence must name the target adapter (${name}).`);
  }
  if (evidence.subject === "base" && evidence.adapter_name) {
    throw new Error("Base evidence cannot include adapter_name.");
  }
  adapter.evidence = [...adapter.evidence, evidence];
  adapter.updated_at = now();
  saveRegistry(registry, options);
  return evidence;
}

export function listAdapters(options: RegistryPathOptions = {}): AdapterRecord[] {
  return Object.values(loadRegistry(options).adapters).sort((left, right) => left.name.localeCompare(right.name));
}

export function getAdapter(name: string, options: RegistryPathOptions = {}): AdapterRecord {
  const adapter = loadRegistry(options).adapters[name];
  if (!adapter) throw new Error(`Unknown adapter: ${name}`);
  return adapter;
}

export function registryPath(options: RegistryPathOptions = {}): string {
  return pathFor(options);
}
