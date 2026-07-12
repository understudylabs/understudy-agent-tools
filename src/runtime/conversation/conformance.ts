import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFORMANCE_SCHEMA,
  parseRuntimeInputFixture,
  validateRuntimeTrace,
} from "./contract.js";

type FixtureGate = {
  id: string;
  fixture?: string;
  fixture_sha256?: string;
  required_events: string[];
};

type ConformanceManifest = {
  schema_version: string;
  suite_id: string;
  input_fixtures?: Array<{ id: string; fixture: string; fixture_sha256: string }>;
  scenario_gates: FixtureGate[];
};

export type ConformanceGateResult = {
  id: string;
  fixture: string;
  event_count: number;
  sha256: string;
  passed: true;
};

export type ConformanceReport = {
  schema_version: typeof CONFORMANCE_SCHEMA;
  suite_id: string;
  fixture_root: string;
  passed: true;
  inputs: Array<{ id: string; fixture: string; sha256: string; passed: true }>;
  gates: ConformanceGateResult[];
};

export function bundledConformanceRoot(): string {
  return fileURLToPath(
    new URL("../../../schemas/conversation-runtime-conformance/", import.meta.url),
  );
}

/** Replay the immutable suite through the same validator used for live output. */
export function runConversationConformance(root = bundledConformanceRoot()): ConformanceReport {
  const fixtureRoot = resolve(root);
  const manifestPath = join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConformanceManifest;
  if (manifest.schema_version !== CONFORMANCE_SCHEMA) {
    throw new Error(
      `unsupported conformance schema ${manifest.schema_version}; expected ${CONFORMANCE_SCHEMA}`,
    );
  }
  if (!manifest.suite_id || !Array.isArray(manifest.scenario_gates)) {
    throw new Error("invalid conversation-runtime conformance manifest");
  }

  const inputs = (manifest.input_fixtures ?? []).map((fixture) => {
    const fixturePath = join(dirname(manifestPath), fixture.fixture);
    const raw = readFileSync(fixturePath, "utf8");
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== fixture.fixture_sha256) {
      throw new Error(`${fixture.id} input fixture hash mismatch: ${digest}`);
    }
    const parsed = parseRuntimeInputFixture(JSON.parse(raw) as unknown);
    if (parsed.fixture_id !== fixture.id) {
      throw new Error(`${fixture.id} input fixture changed identity to ${parsed.fixture_id}`);
    }
    return {
      id: fixture.id,
      fixture: fixture.fixture,
      sha256: digest,
      passed: true as const,
    };
  });

  const gates: ConformanceGateResult[] = [];
  for (const gate of manifest.scenario_gates) {
    if (!gate.fixture) continue;
    if (!gate.fixture_sha256) {
      throw new Error(`${gate.id} is missing fixture_sha256`);
    }
    const fixturePath = join(dirname(manifestPath), gate.fixture);
    const raw = readFileSync(fixturePath, "utf8");
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== gate.fixture_sha256) {
      throw new Error(`${gate.id} fixture hash mismatch: ${digest}`);
    }
    const rows = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const events = validateRuntimeTrace(rows);
    const emitted = new Set(events.map((event) => event.event));
    for (const required of gate.required_events) {
      if (!emitted.has(required as never)) {
        throw new Error(`${gate.id} did not emit required event ${required}`);
      }
    }
    gates.push({
      id: gate.id,
      fixture: gate.fixture,
      event_count: events.length,
      sha256: digest,
      passed: true,
    });
  }
  if (gates.length === 0) throw new Error("conformance suite has no immutable fixture gates");
  return {
    schema_version: CONFORMANCE_SCHEMA,
    suite_id: manifest.suite_id,
    fixture_root: fixtureRoot,
    passed: true,
    inputs,
    gates,
  };
}
