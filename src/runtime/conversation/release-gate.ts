import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  CONFORMANCE_SCHEMA,
  EVENT_SCHEMA,
  RUNTIME_VERSION,
} from "./contract.js";
import { loadConversationConformanceInputs } from "./conformance.js";

export const DEFAULT_DESKTOP_CONFORMANCE_EVIDENCE =
  ".understudy/capture-evidence/desktop-runtime-conformance.json";
export const DEFAULT_DESKTOP_READINESS_EVIDENCE =
  ".understudy/capture-evidence/desktop-runtime-readiness.json";

type EvidenceCheck = {
  path: string;
  ready: boolean;
  generated_at?: string;
  reasons: string[];
};

export type DesktopRuntimeReleaseEvidence = {
  schema_version: "understudy.desktop_runtime_release_evidence.v1";
  ready: boolean;
  conformance: EvidenceCheck;
  readiness: EvidenceCheck;
  reasons: string[];
};

type ReleaseEvidenceOptions = {
  app_version: string;
  runtime_version: string;
  conformance_path?: string;
  readiness_path?: string;
};

const READINESS_THRESHOLDS = {
  app_ready_ms: 2_500,
  runtime_ready_ms: 3_000,
  max_model_load_ms: 45_000,
  app_plus_runtime_rss_mb: 750,
  total_model_rss_gb: 32,
} as const;
const READINESS_CHECKS = [
  "app_ready",
  "runtime_ready",
  "models_ready",
  "app_plus_runtime_memory",
  "model_memory",
] as const;

function readPrivateJson(path: string, label: string): {
  path: string;
  value?: Record<string, unknown>;
  reasons: string[];
} {
  const absolute = resolve(path);
  const reasons: string[] = [];
  if (!existsSync(absolute)) {
    return { path: absolute, reasons: [`${label} evidence is missing`] };
  }
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) reasons.push(`${label} evidence is not a regular file`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      reasons.push(`${label} evidence must be owner-only (0600)`);
    }
    const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reasons.push(`${label} evidence must be a JSON object`);
      return { path: absolute, reasons };
    }
    return { path: absolute, value: value as Record<string, unknown>, reasons };
  } catch (error) {
    reasons.push(
      `${label} evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { path: absolute, reasons };
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function conformanceEvidence(
  path: string,
  runtimeVersion: string,
): EvidenceCheck {
  const loaded = readPrivateJson(path, "conformance");
  const reasons = [...loaded.reasons];
  const report = loaded.value;
  if (!report) return { path: loaded.path, ready: false, reasons };

  if (report.schema_version !== CONFORMANCE_SCHEMA) {
    reasons.push(`conformance schema must be ${CONFORMANCE_SCHEMA}`);
  }
  const suite = loadConversationConformanceInputs();
  if (report.suite_id !== suite.suite_id) {
    reasons.push(`conformance suite must be ${suite.suite_id}`);
  }
  if (report.adapter_id !== "pi") reasons.push("conformance adapter must be pi");
  if (report.passed !== true || report.complete !== true || report.eligible_for_promotion !== true) {
    reasons.push("conformance report must be passed, complete, and eligible for promotion");
  }
  if (!validTimestamp(report.generated_at)) reasons.push("conformance generated_at is invalid");

  const metadata = report.metadata && typeof report.metadata === "object"
    ? report.metadata as Record<string, unknown>
    : {};
  if (metadata.runtime_version !== runtimeVersion) {
    reasons.push(`conformance runtime version must match ${runtimeVersion}`);
  }
  if (metadata.runtime_version !== RUNTIME_VERSION) {
    reasons.push(`conformance runtime version must match installed CLI ${RUNTIME_VERSION}`);
  }
  if (metadata.event_schema !== EVENT_SCHEMA) {
    reasons.push(`conformance event schema must be ${EVENT_SCHEMA}`);
  }
  if (metadata.network_mode !== "offline") {
    reasons.push("conformance network mode must be offline");
  }
  const provider = metadata.provider && typeof metadata.provider === "object"
    ? metadata.provider as Record<string, unknown>
    : {};
  try {
    const providerUrl = new URL(String(provider.base_url ?? ""));
    if (!["127.0.0.1", "localhost", "::1"].includes(providerUrl.hostname)) {
      reasons.push("conformance provider must be loopback-only");
    }
  } catch {
    reasons.push("conformance provider URL is invalid");
  }
  const offline = metadata.offline_environment && typeof metadata.offline_environment === "object"
    ? metadata.offline_environment as Record<string, unknown>
    : {};
  for (const name of ["hf_hub_offline", "transformers_offline", "hf_datasets_offline"]) {
    if (offline[name] !== true) reasons.push(`conformance ${name} must be enabled`);
  }

  const scenarios = Array.isArray(report.scenarios)
    ? report.scenarios.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  if (scenarios.length !== suite.inputs.length) {
    reasons.push(`conformance report must contain exactly ${suite.inputs.length} scenarios`);
  }
  for (const expected of suite.inputs) {
    const matches = scenarios.filter((scenario) => scenario.id === expected.id);
    if (matches.length !== 1) {
      reasons.push(`conformance scenario ${expected.id} must appear exactly once`);
      continue;
    }
    const scenario = matches[0];
    if (scenario.status !== "passed") reasons.push(`conformance scenario ${expected.id} did not pass`);
    if (scenario.fixture !== expected.fixture) {
      reasons.push(`conformance scenario ${expected.id} fixture path is stale`);
    }
    if (scenario.fixture_sha256 !== expected.sha256) {
      reasons.push(`conformance scenario ${expected.id} fixture hash is stale`);
    }
  }

  return {
    path: loaded.path,
    ready: reasons.length === 0,
    ...(validTimestamp(report.generated_at) ? { generated_at: report.generated_at } : {}),
    reasons,
  };
}

function readinessEvidence(
  path: string,
  appVersion: string,
  runtimeVersion: string,
): EvidenceCheck {
  const loaded = readPrivateJson(path, "readiness");
  const reasons = [...loaded.reasons];
  const report = loaded.value;
  if (!report) return { path: loaded.path, ready: false, reasons };

  if (report.schema_version !== "understudy-desktop-runtime-readiness-v1") {
    reasons.push("readiness schema must be understudy-desktop-runtime-readiness-v1");
  }
  if (report.passed !== true) reasons.push("readiness report did not pass");
  if (!validTimestamp(report.generated_at)) reasons.push("readiness generated_at is invalid");
  if (report.measurement_class !== "process-cold-filesystem-warm") {
    reasons.push("readiness measurement class must be process-cold-filesystem-warm");
  }

  const app = report.app && typeof report.app === "object"
    ? report.app as Record<string, unknown>
    : {};
  if (app.version !== appVersion) reasons.push(`readiness app version must match ${appVersion}`);
  const runtime = report.runtime && typeof report.runtime === "object"
    ? report.runtime as Record<string, unknown>
    : {};
  if (runtime.runtime_version !== runtimeVersion) {
    reasons.push(`readiness runtime version must match ${runtimeVersion}`);
  }
  if (runtime.runtime_version !== RUNTIME_VERSION) {
    reasons.push(`readiness runtime version must match installed CLI ${RUNTIME_VERSION}`);
  }
  if (runtime.event_schema !== EVENT_SCHEMA) {
    reasons.push(`readiness event schema must be ${EVENT_SCHEMA}`);
  }
  const checks = report.checks && typeof report.checks === "object"
    ? report.checks as Record<string, unknown>
    : {};
  for (const name of READINESS_CHECKS) {
    if (checks[name] !== true) reasons.push(`readiness check ${name} must pass`);
  }
  const thresholds = report.thresholds && typeof report.thresholds === "object"
    ? report.thresholds as Record<string, unknown>
    : {};
  for (const [name, ceiling] of Object.entries(READINESS_THRESHOLDS)) {
    if (thresholds[name] !== ceiling) reasons.push(`readiness threshold ${name} must be ${ceiling}`);
  }

  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!finite(app.ready_ms) || app.ready_ms > READINESS_THRESHOLDS.app_ready_ms) {
    reasons.push("desktop startup measurement exceeds the release ceiling");
  }
  if (!finite(app.rss_mb)) reasons.push("desktop RSS measurement is missing");
  if (!finite(runtime.ready_ms) || runtime.ready_ms > READINESS_THRESHOLDS.runtime_ready_ms) {
    reasons.push("runtime startup measurement exceeds the release ceiling");
  }
  if (!finite(runtime.rss_mb)) reasons.push("runtime RSS measurement is missing");
  if (
    !finite(report.app_plus_runtime_rss_mb) ||
    report.app_plus_runtime_rss_mb > READINESS_THRESHOLDS.app_plus_runtime_rss_mb
  ) {
    reasons.push("combined desktop/runtime RSS exceeds the release ceiling");
  }
  if (
    !finite(report.total_model_rss_gb) ||
    report.total_model_rss_gb > READINESS_THRESHOLDS.total_model_rss_gb
  ) {
    reasons.push("model RSS exceeds the release ceiling");
  }
  const models = Array.isArray(report.models)
    ? report.models.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  if (models.length === 0) reasons.push("readiness report contains no restored model measurements");
  for (const model of models) {
    if (!finite(model.load_ms) || model.load_ms > READINESS_THRESHOLDS.max_model_load_ms) {
      reasons.push("a restored model load measurement exceeds the release ceiling");
    }
    if (!finite(model.rss_gb)) reasons.push("a restored model RSS measurement is missing");
  }

  return {
    path: loaded.path,
    ready: reasons.length === 0,
    ...(validTimestamp(report.generated_at) ? { generated_at: report.generated_at } : {}),
    reasons,
  };
}

export function evaluateDesktopRuntimeReleaseEvidence(
  options: ReleaseEvidenceOptions,
): DesktopRuntimeReleaseEvidence {
  const conformance = conformanceEvidence(
    options.conformance_path ?? DEFAULT_DESKTOP_CONFORMANCE_EVIDENCE,
    options.runtime_version,
  );
  const readiness = readinessEvidence(
    options.readiness_path ?? DEFAULT_DESKTOP_READINESS_EVIDENCE,
    options.app_version,
    options.runtime_version,
  );
  const reasons = [...conformance.reasons, ...readiness.reasons];
  return {
    schema_version: "understudy.desktop_runtime_release_evidence.v1",
    ready: conformance.ready && readiness.ready,
    conformance,
    readiness,
    reasons,
  };
}
