import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFORMANCE_SCHEMA,
  parseRuntimeInputFixture,
  validateRuntimeTrace,
  type EmitRuntimeEvent,
  type RuntimeInputFixture,
} from "./contract.js";

type FixtureGate = {
  id: string;
  fixture?: string;
  fixture_sha256?: string;
  input_fixture_id?: string;
  required_events: string[];
};

type ConformanceManifest = {
  schema_version: string;
  suite_id: string;
  input_fixtures?: Array<{
    id: string;
    fixture: string;
    fixture_sha256: string;
    required_capabilities?: string[];
  }>;
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
  required_capabilities: string[];
  input: RuntimeInputFixture;
};

export type RuntimeConformanceAdapter = {
  id: string;
  capabilities?: readonly string[];
  metadata?: Record<string, unknown>;
  run(input: RuntimeInputFixture): Promise<readonly unknown[]>;
};

export type RuntimeConformanceRunner = (
  request: unknown,
  emit: EmitRuntimeEvent,
  abortSignal?: AbortSignal,
) => Promise<void>;

export type RuntimeConformanceProviderTarget = {
  base_url: string;
  model: string;
};

export type ExecutableConformanceOptions = {
  backend: "pi" | "vercel";
  base_url: string;
  model: string;
  invocation_id: string;
  scenario_timeout_ms: number;
  tool_executor_url?: string;
  allow_remote?: boolean;
  student?: RuntimeConformanceProviderTarget;
  supervisor?: RuntimeConformanceProviderTarget;
  teacher?: RuntimeConformanceProviderTarget;
  malformed_tool?: RuntimeConformanceProviderTarget;
  deterministic_compaction?: boolean;
};

export type RuntimeConformanceScenarioResult = {
  id: string;
  fixture: string;
  fixture_sha256: string;
  status: "passed" | "failed" | "not_applicable";
  event_count: number;
  run_id?: string;
  session_id?: string;
  runtime_id?: string;
  output_chars: number;
  observed_events?: string[];
  observed_event_counts?: Record<string, number>;
  evidence_events?: Array<{
    sequence: number;
    event: string;
    data: Record<string, unknown>;
  }>;
  terminal_event?: string;
  runtime_error?: string;
  error?: string;
};

export type RuntimeConformanceAdapterReport = {
  schema_version: typeof CONFORMANCE_SCHEMA;
  suite_id: string;
  adapter_id: string;
  generated_at: string;
  metadata?: Record<string, unknown>;
  passed: boolean;
  complete: boolean;
  eligible_for_promotion: boolean;
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
      required_capabilities: fixture.required_capabilities ?? [],
      input: parsed,
    };
  });
  if (inputs.length === 0) throw new Error("conformance suite has no frozen inputs");
  return { suite_id: manifest.suite_id, fixture_root: fixtureRoot, inputs };
}

export function validateScenarioEvidence(input: RuntimeInputFixture, values: readonly unknown[]) {
  const events = validateRuntimeTrace(values);
  const emitted = new Set(events.map((event) => event.event));
  for (const required of input.expected_events) {
    if (!emitted.has(required)) {
      throw new Error(`${input.fixture_id} did not emit required event ${required}`);
    }
  }
  const latestUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (latestUser?.role === "user") {
    const messages = events.filter(
      (event) => event.event === "message" && event.data.role === "user",
    );
    if (
      messages.length !== 1 ||
      messages[0].data.text !== latestUser.content
    ) {
      throw new Error(`${input.fixture_id} changed canonical input message identity`);
    }
  }
  if (input.expected_events.includes("cancellation") && events.at(-1)?.event !== "cancellation") {
    throw new Error(`${input.fixture_id} cancellation was not terminal`);
  }
  if (
    input.expected_cancellation_reason &&
    events.at(-1)?.data.reason !== input.expected_cancellation_reason
  ) {
    throw new Error(
      `${input.fixture_id} cancellation reason changed: expected ${input.expected_cancellation_reason}, got ${String(events.at(-1)?.data.reason)}`,
    );
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
  if (input.fixture_id === "malformed-tool-call") {
    const malformedCalls = events.filter(
      (event) =>
        event.event === "tool_call" &&
        typeof event.data.parse_error === "string" &&
        event.data.parse_error.length > 0,
    );
    if (malformedCalls.length === 0) {
      throw new Error("malformed-tool-call did not preserve a tool argument parse error");
    }
    for (const call of malformedCalls) {
      const rejected = events.some(
        (event) =>
          event.event === "tool_result" &&
          event.data.call_id === call.data.call_id &&
          event.data.ok === false,
      );
      if (!rejected) {
        throw new Error(`malformed tool call ${String(call.data.call_id)} was not rejected`);
      }
    }
  }
  if (input.fixture_id === "supervisor-takeover") {
    const usageByRole = new Map<string, Array<(typeof events)[number]>>();
    for (const event of events.filter((event) => event.event === "usage")) {
      const role = String(event.data.role);
      usageByRole.set(role, [...(usageByRole.get(role) ?? []), event]);
    }
    for (const role of ["student", "supervisor", "teacher"]) {
      if (!usageByRole.has(role)) {
        throw new Error(`supervisor-takeover did not attribute ${role} usage`);
      }
    }
    const verdict = events.find((event) => event.event === "supervisor_verdict");
    const continuation = events.find((event) => event.event === "teacher_continuation");
    const supervisorModels = new Set(
      (usageByRole.get("supervisor") ?? []).map((event) => String(event.data.model)),
    );
    const teacherModels = new Set(
      (usageByRole.get("teacher") ?? []).map((event) => String(event.data.model)),
    );
    if (!supervisorModels.has(String(verdict?.data.supervisor_model))) {
      throw new Error("supervisor-takeover verdict and usage disagree on supervisor model");
    }
    if (!teacherModels.has(String(continuation?.data.teacher_model))) {
      throw new Error("supervisor-takeover continuation and usage disagree on teacher model");
    }
    const deltaModels = new Map<string, Set<string>>();
    for (const event of events.filter((event) => event.event === "delta")) {
      const role = String(event.data.role);
      deltaModels.set(role, new Set([...(deltaModels.get(role) ?? []), String(event.data.model)]));
    }
    for (const role of ["student", "teacher"]) {
      const observed = deltaModels.get(role);
      const attributed = new Set(
        (usageByRole.get(role) ?? []).map((event) => String(event.data.model)),
      );
      if (!observed || [...observed].some((model) => !attributed.has(model))) {
        throw new Error(`supervisor-takeover ${role} deltas and usage disagree on model`);
      }
    }
  }
  if (input.fixture_id === "long-chat-compaction") {
    const reduced = events.some(
      (event) =>
        event.event === "compaction_boundary" &&
        Number(event.data.estimated_tokens_after) < Number(event.data.estimated_tokens_before),
    );
    if (!reduced) {
      throw new Error("long-chat-compaction did not reduce the estimated token count");
    }
  }
  return events;
}

function observedScenario(events: ReturnType<typeof validateRuntimeTrace>) {
  const terminal = events.at(-1);
  const observedEvents = [...new Set(events.map((event) => event.event))];
  const evidenceEventNames = new Set([
    "tool_call",
    "tool_result",
    "usage",
    "supervisor_verdict",
    "student_interruption",
    "teacher_continuation",
    "cancellation",
    "error",
    "image_attachment",
    "compaction_boundary",
  ]);
  const observedEventCounts = Object.fromEntries(
    observedEvents.map((name) => [
      name,
      events.filter((event) => event.event === name).length,
    ]),
  );
  return {
    event_count: events.length,
    run_id: events[0]?.run_id,
    session_id: events[0]?.session_id,
    runtime_id: events[0]?.runtime_id,
    output_chars: events
      .filter((event) => event.event === "delta")
      .reduce((total, event) => total + String(event.data.text).length, 0),
    observed_events: observedEvents,
    observed_event_counts: observedEventCounts,
    evidence_events: events
      .filter((event) => evidenceEventNames.has(event.event))
      .map((event) => ({
        sequence: event.sequence,
        event: event.event,
        data: event.data,
      })),
    terminal_event: terminal?.event,
    runtime_error:
      terminal?.event === "error"
        ? String(terminal.data.message)
        : terminal?.event === "cancellation"
          ? String(terminal.data.reason)
          : undefined,
  };
}

/**
 * Execute one frozen input with the production-shaped setup required by that
 * scenario. Tests and the public CLI call this same helper so restart,
 * compaction, supervision, timeout, and cancellation cannot drift into
 * test-only behavior.
 */
export async function executeFrozenConformanceScenario(
  input: RuntimeInputFixture,
  runner: RuntimeConformanceRunner,
  options: ExecutableConformanceOptions,
): Promise<readonly unknown[]> {
  const events: unknown[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`conformance_timeout_${options.scenario_timeout_ms}ms`),
    options.scenario_timeout_ms,
  );
  const runId = `conformance-${options.backend}-${input.fixture_id}-${options.invocation_id}`;
  const sessionId = `conformance-${options.backend}-${input.fixture_id}-${options.invocation_id}`;
  const primary =
    input.fixture_id === "malformed-tool-call" && options.malformed_tool
      ? options.malformed_tool
      : { base_url: options.base_url, model: options.model };
  const request = {
    run_id: runId,
    session_id: sessionId,
    base_url: primary.base_url,
    model: primary.model,
    role: input.role,
    messages: input.messages,
    tools: input.tools,
    max_output_tokens: input.fixture_id === "long-chat-compaction" ? 128 : 256,
    context_window_tokens: input.fixture_id === "long-chat-compaction" ? 1_024 : 32_768,
    ...(input.fixture_id === "long-chat-compaction"
      ? { provider_context_window_tokens: 32_768 }
      : {}),
    max_tool_rounds: 2,
    ...(input.tools.length > 0 && options.tool_executor_url
      ? { tool_executor_url: options.tool_executor_url }
      : {}),
    allow_remote: options.allow_remote ?? false,
    runtime_backend: options.backend,
    ...(input.fixture_id === "long-chat-compaction" &&
    options.backend === "pi" &&
    options.deterministic_compaction
      ? { conformance_deterministic_compaction: true }
      : {}),
    ...(input.fixture_id === "supervisor-takeover" && options.backend === "pi"
      ? {
          supervision: {
            student: options.student ?? primary,
            supervisor: {
              ...(options.supervisor ?? primary),
              system_prompt:
                "Interrupt immediately when the student's partial contains a factual error, even when the user requested it or the student may correct it later.",
              max_output_tokens: 24,
            },
            teacher: options.teacher ?? primary,
            boundary_chars: 10,
            max_nudges: 0,
          },
        }
      : {}),
  };

  try {
    if (input.fixture_id === "restart-resume" && options.backend === "pi") {
      const primeEvents: unknown[] = [];
      await runner(
        {
          ...request,
          run_id: `${runId}-prime`,
          messages: [input.messages[0]],
          emit_input: false,
        },
        (event) => {
          primeEvents.push(event);
        },
        controller.signal,
      );
      const primeTrace = validateRuntimeTrace(primeEvents);
      const terminal = primeTrace.at(-1);
      if (terminal?.event === "error" || terminal?.event === "cancellation") {
        throw new Error(
          `restart-resume prime failed: ${String(terminal.data.message ?? terminal.data.reason)}`,
        );
      }
    }

    await runner(
      request,
      (event) => {
        events.push(event);
        if (
          input.fixture_id === "cancellation" &&
          event.event === "delta" &&
          !controller.signal.aborted
        ) {
          controller.abort(input.expected_cancellation_reason ?? "frozen_conformance_cancel");
        }
      },
      controller.signal,
    );
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

/** Execute every frozen input through one real adapter and retain failures. */
export async function runConversationAdapterConformance(
  adapter: RuntimeConformanceAdapter,
  root = bundledConformanceRoot(),
): Promise<RuntimeConformanceAdapterReport> {
  const suite = loadConversationConformanceInputs(root);
  const scenarios: RuntimeConformanceScenarioResult[] = [];
  const capabilities = new Set(adapter.capabilities ?? []);
  for (const fixture of suite.inputs) {
    const missing = fixture.required_capabilities.filter(
      (capability) => !capabilities.has(capability),
    );
    if (missing.length > 0) {
      scenarios.push({
        id: fixture.id,
        fixture: fixture.fixture,
        fixture_sha256: fixture.sha256,
        status: "not_applicable",
        event_count: 0,
        output_chars: 0,
        error: `adapter does not declare required capabilities: ${missing.join(", ")}`,
      });
      continue;
    }
    let values: readonly unknown[] = [];
    try {
      values = await adapter.run(fixture.input);
      const events = validateScenarioEvidence(fixture.input, values);
      scenarios.push({
        id: fixture.id,
        fixture: fixture.fixture,
        fixture_sha256: fixture.sha256,
        status: "passed",
        ...observedScenario(events),
      });
    } catch (error) {
      let observed = { event_count: 0, output_chars: 0 };
      if (values.length > 0) {
        try {
          observed = observedScenario(validateRuntimeTrace(values));
        } catch {
          // Never summarize unvalidated envelopes; the validation error below
          // remains the authoritative failure evidence.
        }
      }
      scenarios.push({
        id: fixture.id,
        fixture: fixture.fixture,
        fixture_sha256: fixture.sha256,
        status: "failed",
        ...observed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passed = scenarios.every((scenario) => scenario.status !== "failed");
  const complete = scenarios.every((scenario) => scenario.status === "passed");
  return {
    schema_version: CONFORMANCE_SCHEMA,
    suite_id: suite.suite_id,
    adapter_id: adapter.id,
    generated_at: new Date().toISOString(),
    ...(adapter.metadata ? { metadata: adapter.metadata } : {}),
    passed,
    complete,
    eligible_for_promotion: passed && complete,
    scenarios,
  };
}

/** Replay the immutable suite through the same validator used for live output. */
export function runConversationConformance(root = bundledConformanceRoot()): ConformanceReport {
  const { fixtureRoot, manifestPath, manifest } = loadManifest(root);
  const loadedInputs = loadConversationConformanceInputs(root).inputs;
  const inputById = new Map(loadedInputs.map((fixture) => [fixture.id, fixture]));
  const inputs = loadedInputs.map((fixture) => ({
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
    if (gate.input_fixture_id) {
      const input = inputById.get(gate.input_fixture_id);
      if (!input) {
        throw new Error(
          `${gate.id} references missing input fixture ${gate.input_fixture_id}`,
        );
      }
      validateScenarioEvidence(input.input, events);
    }
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
