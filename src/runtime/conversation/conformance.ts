import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFORMANCE_SCHEMA,
  parseRuntimeInputFixture,
  validateRuntimeTrace,
  type RuntimeInputFixture,
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

export type LoadedConformanceInput = {
  id: string;
  fixture: string;
  sha256: string;
  input: RuntimeInputFixture;
};

export type RuntimeConformanceAdapter = {
  id: string;
  run(input: RuntimeInputFixture): Promise<readonly unknown[]>;
};

export type RuntimeConformanceScenarioResult = {
  id: string;
  fixture: string;
  fixture_sha256: string;
  status: "passed" | "failed";
  event_count: number;
  runtime_id?: string;
  output_chars: number;
  error?: string;
};

export type RuntimeConformanceAdapterReport = {
  schema_version: typeof CONFORMANCE_SCHEMA;
  suite_id: string;
  adapter_id: string;
  passed: boolean;
  scenarios: RuntimeConformanceScenarioResult[];
};

export function bundledConformanceRoot(): string {
  return fileURLToPath(
    new URL("../../../schemas/conversation-runtime-conformance/", import.meta.url),
  );
}

function loadManifest(root: string): {
  fixtureRoot: string;
  manifestPath: string;
  manifest: ConformanceManifest;
} {
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
  return { fixtureRoot, manifestPath, manifest };
}

export function loadConversationConformanceInputs(
  root = bundledConformanceRoot(),
): { suite_id: string; fixture_root: string; inputs: LoadedConformanceInput[] } {
  const { fixtureRoot, manifestPath, manifest } = loadManifest(root);
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
      input: parsed,
    };
  });
  if (inputs.length === 0) throw new Error("conformance suite has no frozen inputs");
  return { suite_id: manifest.suite_id, fixture_root: fixtureRoot, inputs };
}

function assertScenarioEvidence(input: RuntimeInputFixture, values: readonly unknown[]) {
  const events = validateRuntimeTrace(values);
  const emitted = new Set(events.map((event) => event.event));
  for (const required of input.expected_events) {
    if (!emitted.has(required)) {
      throw new Error(`${input.fixture_id} did not emit required event ${required}`);
    }
  }
  if (input.expected_events.includes("cancellation") && events.at(-1)?.event !== "cancellation") {
    throw new Error(`${input.fixture_id} cancellation was not terminal`);
  }
  const expectedAttachments = input.messages.flatMap((message) =>
    message.role === "user" ? (message.attachments ?? []).map((attachment) => attachment.id) : [],
  );
  const emittedAttachments = events
    .filter((event) => event.event === "image_attachment")
    .map((event) => String(event.data.attachment_id));
  if (
    expectedAttachments.length > 0 &&
    (expectedAttachments.length !== emittedAttachments.length ||
      expectedAttachments.some((id, index) => emittedAttachments[index] !== id))
  ) {
    throw new Error(`${input.fixture_id} changed image attachment identity or ordering`);
  }
  return events;
}

/** Execute every frozen input through one real adapter and retain failures. */
export async function runConversationAdapterConformance(
  adapter: RuntimeConformanceAdapter,
  root = bundledConformanceRoot(),
): Promise<RuntimeConformanceAdapterReport> {
  const suite = loadConversationConformanceInputs(root);
  const scenarios: RuntimeConformanceScenarioResult[] = [];
  for (const fixture of suite.inputs) {
    try {
      const events = assertScenarioEvidence(fixture.input, await adapter.run(fixture.input));
      scenarios.push({
        id: fixture.id,
        fixture: fixture.fixture,
        fixture_sha256: fixture.sha256,
        status: "passed",
        event_count: events.length,
        runtime_id: events[0]?.runtime_id,
        output_chars: events
          .filter((event) => event.event === "delta")
          .reduce((total, event) => total + String(event.data.text).length, 0),
      });
    } catch (error) {
      scenarios.push({
        id: fixture.id,
        fixture: fixture.fixture,
        fixture_sha256: fixture.sha256,
        status: "failed",
        event_count: 0,
        output_chars: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    schema_version: CONFORMANCE_SCHEMA,
    suite_id: suite.suite_id,
    adapter_id: adapter.id,
    passed: scenarios.every((scenario) => scenario.status === "passed"),
    scenarios,
  };
}

/** Replay the immutable suite through the same validator used for live output. */
export function runConversationConformance(root = bundledConformanceRoot()): ConformanceReport {
  const { fixtureRoot, manifestPath, manifest } = loadManifest(root);
  const inputs = loadConversationConformanceInputs(root).inputs.map((fixture) => ({
    id: fixture.id,
    fixture: fixture.fixture,
    sha256: fixture.sha256,
    passed: true as const,
  }));

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
