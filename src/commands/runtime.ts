import { Command } from "commander";
import kleur from "kleur";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";

import { isJsonMode, runAction } from "../internal/output.js";
import {
  conversationRuntimeHome,
  conversationRuntimeStatus,
  doctorConversationRuntime,
  installConversationRuntime,
  repairConversationRuntime,
  startConversationRuntime,
  stopConversationRuntime,
} from "../runtime/conversation/lifecycle.js";
import { cacheHealthFromSessionRoot } from "../runtime/conversation/cache-health.js";
import {
  CONFORMANCE_SCHEMA,
  EVENT_SCHEMA,
  RUNTIME_ID,
  RUNTIME_VERSION,
} from "../runtime/conversation/contract.js";
import {
  executeFrozenNativeDesktopReferenceScenario,
  executeFrozenConformanceScenario,
  runConversationAdapterConformance,
  runConversationConformance,
} from "../runtime/conversation/conformance.js";
import { runPiConversation } from "../runtime/conversation/pi-runtime.js";
import { runVercelConversation } from "../runtime/conversation/vercel-runtime.js";
import {
  desktopApiFetch,
  requireDesktopApi,
  resolveDesktopSlotProviderTarget,
  responseError,
  type DesktopApiCapability,
} from "../internal/desktop-api.js";

function emit(command: Command, payload: Record<string, unknown>, human: string): void {
  if (isJsonMode(command)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}
function statusLine(status: Awaited<ReturnType<typeof conversationRuntimeStatus>>): string {
  const mark = status.healthy ? kleur.green("●") : kleur.dim("○");
  const endpoint = status.base_url ? ` at ${status.base_url}` : "";
  return `${mark} conversation runtime: ${status.detail}${endpoint} (${status.runtime_version})`;
}

function persistImmutableReport(path: string, report: unknown): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = openSync(target, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  return target;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("value must be a positive integer");
  }
  return parsed;
}

function requiredNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const candidate = value[key];
  if (!Number.isInteger(candidate) || (candidate as number) < 0) {
    throw new Error(`native Rust reference returned invalid ${key}`);
  }
  return candidate as number;
}

async function requireNativeReferenceSlot(
  capability: DesktopApiCapability,
  slotId: number,
  model: string,
  timeoutMs: number,
): Promise<void> {
  const response = await desktopApiFetch(capability, "/v1/residency", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await responseError(response);
  const value = await response.json() as { slots?: unknown };
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const slot = slots.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === slotId,
  );
  if (!slot) throw new Error(`desktop residency slot ${slotId} does not exist`);
  if (slot.state !== "running") {
    throw new Error(`desktop residency slot ${slotId} is ${String(slot.state ?? "not running")}`);
  }
  if (slot.model_id !== model) {
    throw new Error(
      `desktop residency slot ${slotId} serves ${String(slot.model_id)}, not requested ${model}`,
    );
  }
}

async function runNativeDesktopReferenceCompletion(
  capability: DesktopApiCapability,
  slotId: number,
  timeoutMs: number,
  request: { run_id: string; session_id: string; prompt: string; max_tokens: number },
) {
  const response = await desktopApiFetch(capability, "/api/chat/completion", {
    method: "POST",
    body: JSON.stringify({
      slot_id: slotId,
      prompt: request.prompt,
      session_id: request.session_id,
      capture_run_id: request.run_id,
      max_tokens: request.max_tokens,
      runtime_backend: "native-rust-reference",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await responseError(response);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native Rust reference returned a malformed completion");
  }
  const row = value as Record<string, unknown>;
  return {
    capture_run_id: String(row.capture_run_id ?? ""),
    content: String(row.content ?? ""),
    status: String(row.status ?? ""),
    runtime_backend: String(row.runtime_backend ?? ""),
    prompt_tokens: requiredNonNegativeInteger(row, "prompt_tokens"),
    completion_tokens: requiredNonNegativeInteger(row, "completion_tokens"),
    reasoning_tokens: requiredNonNegativeInteger(row, "reasoning_tokens"),
  };
}

async function startDeterministicSupervisorFixture(): Promise<{
  target: { base_url: string; model: string };
  close(): Promise<void>;
}> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const evidence = (body.messages ?? [])
        .map((message) => String(message.content ?? ""))
        .join("\n");
      if (!evidence.includes("[smaller model's partial answer so far]")) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "frozen supervisor partial changed" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "INTERRUPT: Frozen conformance forced intervention.",
              },
              logprobs: {
                content: [
                  {
                    token: "INTER",
                    logprob: -0.01,
                    top_logprobs: [
                      { token: "INTER", logprob: -0.01 },
                      { token: "CONTIN", logprob: -10 },
                    ],
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    target: {
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: "understudy-deterministic-supervisor-v1",
    },
    close: () =>
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
  };
}

async function startDeterministicMalformedToolFixture(): Promise<{
  target: { base_url: string; model: string };
  close(): Promise<void>;
}> {
  let callCount = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const evidence = JSON.stringify(body.messages ?? []);
      if (!evidence.includes("malformed arguments must never execute")) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "frozen malformed-tool input changed" }));
        return;
      }
      callCount += 1;
      const model = body.model ?? "understudy-deterministic-malformed-tool-v1";
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (callCount === 1) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-deterministic-malformed",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-deterministic-malformed",
                      type: "function",
                      function: { name: "status", arguments: "{bad" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-deterministic-malformed",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-deterministic-malformed-final",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "The malformed request was rejected without execution.",
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-deterministic-malformed-final",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    target: {
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: "understudy-deterministic-malformed-tool-v1",
    },
    close: () =>
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
  };
}

export function registerRuntimeCommand(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("Manage the local conversation runtime used by Understudy Desktop.");

  runtime
    .command("version")
    .description("Print the bundled runtime and event-contract versions.")
    .option("--json", "Output JSON")
    .action(function (this: Command) {
      emit(
        this,
        {
          runtime_id: RUNTIME_ID,
          runtime_version: RUNTIME_VERSION,
          event_schema: EVENT_SCHEMA,
          conformance_schema: CONFORMANCE_SCHEMA,
        },
        `${RUNTIME_ID} ${RUNTIME_VERSION} · ${EVENT_SCHEMA}`,
      );
    });

  runtime
    .command("install")
    .description("Verify the bundled runtime and create its private local state directory.")
    .option("--json", "Output JSON")
    .action(function (this: Command) {
      const status = installConversationRuntime();
      emit(this, status, statusLine(status));
    });

  runtime
    .command("start")
    .description("Start the managed runtime on an ephemeral loopback port.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await startConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });

  runtime
    .command("status")
    .description("Check the managed process, event schema, and health endpoint.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      const status = await conversationRuntimeStatus();
      emit(this, status, statusLine(status));
      if (!status.healthy) process.exitCode = 1;
    });

  runtime
    .command("cache-health")
    .description("Summarize prompt-cache reuse without printing per-turn notices.")
    .option("--json", "Output JSON")
    .action(function (this: Command) {
      const health = cacheHealthFromSessionRoot(
        join(conversationRuntimeHome(), "pi-sessions"),
      );
      const score = health.score_pct === null ? "unavailable" : `${health.score_pct.toFixed(1)}%`;
      emit(
        this,
        health,
        `cache health: ${score} · ${health.detail}`,
      );
    });

  runtime
    .command("stop")
    .description("Stop the managed runtime and remove ephemeral tokens.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await stopConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });

  runtime
    .command("doctor")
    .description("Diagnose Node, packaged assets, schema compatibility, and health.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      const result = await doctorConversationRuntime();
      if (isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${kleur.bold("conversation runtime doctor")}\n`);
        for (const check of result.checks) {
          const mark = check.ok ? kleur.green("✓") : kleur.red("✗");
          process.stdout.write(`${mark} ${check.name} — ${check.detail}\n`);
        }
        if (!result.ok) process.stdout.write(`repair: ${result.repair_command}\n`);
      }
      if (!result.ok) process.exitCode = 1;
    });

  runtime
    .command("conformance")
    .description("Verify immutable evidence or execute every frozen input through one adapter.")
    .option("--fixtures <path>", "Use a specific conformance fixture directory")
    .option("--backend <backend>", "Execute inputs through pi, vercel, or native")
    .option("--base-url <url>", "OpenAI-compatible provider base URL")
    .option("--model <id>", "Provider model identifier")
    .option(
      "--slot <id>",
      "Warm desktop slot (auto-resolves the exact local Pi/Vercel provider identity)",
      positiveInteger,
    )
    .option("--student-base-url <url>", "Student provider URL for the supervision scenario")
    .option("--student-model <id>", "Student model for the supervision scenario")
    .option("--supervisor-base-url <url>", "Supervisor provider URL for the supervision scenario")
    .option("--supervisor-model <id>", "Supervisor model for the supervision scenario")
    .option(
      "--deterministic-supervisor",
      "Use the built-in offline supervisor fixture to prove interruption mechanics",
    )
    .option(
      "--deterministic-malformed-tool",
      "Use the built-in malformed tool-call fixture to prove parser rejection",
    )
    .option(
      "--deterministic-compaction",
      "Use the built-in bounded summary to prove compaction mechanics",
    )
    .option("--teacher-base-url <url>", "Teacher provider URL for the supervision scenario")
    .option("--teacher-model <id>", "Teacher model for the supervision scenario")
    .option("--tool-executor-url <url>", "Authenticated loopback tool executor")
    .option("--capabilities <list>", "Comma-separated adapter capabilities to execute")
    .option("--require-complete", "Fail when any frozen capability is not applicable")
    .option("--scenario-timeout-ms <ms>", "Abort one frozen scenario after this many ms", "60000")
    .option("--output <path>", "Write one immutable private JSON evidence report")
    .option("--allow-remote", "Allow a remote HTTPS provider (also requires the environment gate)")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      options: {
        fixtures?: string;
        backend?: string;
        baseUrl?: string;
        model?: string;
        slot?: number;
        studentBaseUrl?: string;
        studentModel?: string;
        supervisorBaseUrl?: string;
        supervisorModel?: string;
        deterministicSupervisor?: boolean;
        deterministicMalformedTool?: boolean;
        deterministicCompaction?: boolean;
        teacherBaseUrl?: string;
        teacherModel?: string;
        toolExecutorUrl?: string;
        capabilities?: string;
        requireComplete?: boolean;
        scenarioTimeoutMs?: string;
        output?: string;
        allowRemote?: boolean;
      },
    ) {
      await runAction(this, async () => {
        if (!options.backend) {
          const report = runConversationConformance(options.fixtures);
          if (isJsonMode(this)) {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          } else {
            process.stdout.write(
              `${kleur.green("✓")} ${report.suite_id}: ${report.gates.length} immutable replay gates passed\n`,
            );
          }
          return;
        }
        if (!["pi", "vercel", "native"].includes(options.backend)) {
          throw new Error("--backend must be pi, vercel, or native");
        }
        const backend = options.backend as "pi" | "vercel" | "native";
        if (backend === "native") {
          if (!options.model) throw new Error("--backend native requires --model");
          if (!options.slot) throw new Error("--backend native requires --slot");
          if (options.baseUrl) {
            throw new Error("--backend native uses the authenticated desktop API, not --base-url");
          }
          if (options.allowRemote) throw new Error("--backend native cannot use --allow-remote");
        } else if (options.slot && (options.baseUrl || options.model)) {
          throw new Error(
            "--slot resolves --base-url and --model from Desktop; do not combine them",
          );
        } else if (!options.slot && (!options.baseUrl || !options.model)) {
          throw new Error("--backend pi or vercel requires --base-url and --model");
        }
        if (options.deterministicSupervisor && backend !== "pi") {
          throw new Error("--deterministic-supervisor requires --backend pi");
        }
        if (
          options.deterministicSupervisor &&
          (options.supervisorBaseUrl || options.supervisorModel)
        ) {
          throw new Error(
            "--deterministic-supervisor cannot be combined with supervisor provider flags",
          );
        }
        const run = backend === "pi" ? runPiConversation : runVercelConversation;
        const defaultCapabilities =
          backend === "pi" ? "compaction,restart,supervision" : "";
        const capabilities = (options.capabilities ?? defaultCapabilities)
          .split(",")
          .map((capability) => capability.trim())
          .filter(Boolean);
        const scenarioTimeoutMs = Number(options.scenarioTimeoutMs ?? "60000");
        if (
          !Number.isInteger(scenarioTimeoutMs) ||
          scenarioTimeoutMs < 1_000 ||
          scenarioTimeoutMs > 600_000
        ) {
          throw new Error("--scenario-timeout-ms must be an integer from 1000 to 600000");
        }
        const invocationId = `${Date.now()}-${process.pid}`;
        const nativeCapability = backend === "native" ? await requireDesktopApi() : undefined;
        if (nativeCapability) {
          await requireNativeReferenceSlot(
            nativeCapability,
            options.slot!,
            options.model!,
            scenarioTimeoutMs,
          );
        }
        const desktopSlotCapability = backend !== "native" && options.slot
          ? await requireDesktopApi()
          : undefined;
        const desktopSlotTarget = desktopSlotCapability
          ? await resolveDesktopSlotProviderTarget(
              desktopSlotCapability,
              options.slot!,
              scenarioTimeoutMs,
            )
          : undefined;
        const providerBaseUrl = desktopSlotTarget?.baseUrl ?? options.baseUrl!;
        const providerModel = desktopSlotTarget?.model ?? options.model!;
        const desktopToolExecutor = desktopSlotCapability && !options.toolExecutorUrl
          ? {
              url: `${desktopSlotCapability.baseUrl}/api/conversation-runtime/tool?slot_id=${options.slot}`,
              token: desktopSlotCapability.token,
            }
          : undefined;
        const toolExecutorUrl = options.toolExecutorUrl ?? desktopToolExecutor?.url;
        const supervisorFixture = options.deterministicSupervisor
          ? await startDeterministicSupervisorFixture()
          : undefined;
        const malformedToolFixture = options.deterministicMalformedTool
          ? await startDeterministicMalformedToolFixture()
          : undefined;
        const supervisorTarget = supervisorFixture?.target ?? {
          base_url: options.supervisorBaseUrl ?? providerBaseUrl,
          model: options.supervisorModel ?? providerModel,
        };
        const previousToolToken = process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
        if (desktopToolExecutor) {
          process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = desktopToolExecutor.token;
        }
        let report;
        try {
          report = await runConversationAdapterConformance(
            {
              id: backend,
              capabilities,
              metadata: {
                backend,
                runtime_id: backend === "native" ? "native-rust-reference" : RUNTIME_ID,
                runtime_version: RUNTIME_VERSION,
                event_schema: EVENT_SCHEMA,
                conformance_schema: CONFORMANCE_SCHEMA,
                network_mode: options.allowRemote ? "remote_allowed" : "offline",
                offline_environment: {
                  hf_hub_offline: process.env.HF_HUB_OFFLINE === "1",
                  transformers_offline: process.env.TRANSFORMERS_OFFLINE === "1",
                  hf_datasets_offline: process.env.HF_DATASETS_OFFLINE === "1",
                },
                provider: backend === "native"
                  ? {
                      base_url: nativeCapability!.baseUrl,
                      model: options.model,
                      slot_id: options.slot,
                    }
                  : {
                      base_url: providerBaseUrl,
                      model: providerModel,
                      ...(desktopSlotTarget
                        ? {
                            slot_id: desktopSlotTarget.slotId,
                            artifact_id: desktopSlotTarget.artifactId,
                            identity_source: "desktop_residency_model_path",
                          }
                        : {}),
                    },
                ...(backend === "native"
                  ? { evidence_projection: "legacy_prompt_only_completion_summary" }
                  : {
                      supervision: {
                        student: {
                          base_url: options.studentBaseUrl ?? providerBaseUrl,
                          model: options.studentModel ?? providerModel,
                        },
                        supervisor: {
                          ...supervisorTarget,
                        },
                        teacher: {
                          base_url: options.teacherBaseUrl ?? providerBaseUrl,
                          model: options.teacherModel ?? providerModel,
                        },
                      },
                      supervisor_mode: options.deterministicSupervisor
                        ? "deterministic_fixture"
                        : "model",
                      malformed_tool_mode: options.deterministicMalformedTool
                        ? "deterministic_fixture"
                        : "model",
                      compaction_mode: options.deterministicCompaction
                        ? "deterministic_fixture"
                        : "model",
                    }),
                scenario_timeout_ms: scenarioTimeoutMs,
                tool_executor_configured: Boolean(toolExecutorUrl),
                tool_executor_source: desktopToolExecutor
                  ? "desktop_authenticated_slot"
                  : toolExecutorUrl
                    ? "explicit"
                    : "none",
                allow_remote: options.allowRemote ?? false,
              },
              async run(input) {
                if (backend === "native") {
                  return executeFrozenNativeDesktopReferenceScenario(input, {
                    model: options.model!,
                    invocation_id: invocationId,
                    complete: (request) =>
                      runNativeDesktopReferenceCompletion(
                        nativeCapability!,
                        options.slot!,
                        scenarioTimeoutMs,
                        request,
                      ),
                  });
                }
                return executeFrozenConformanceScenario(input, run, {
                  backend,
                  base_url: providerBaseUrl,
                  model: providerModel,
                  invocation_id: invocationId,
                  scenario_timeout_ms: scenarioTimeoutMs,
                  tool_executor_url: toolExecutorUrl,
                  allow_remote: options.allowRemote,
                  student: {
                    base_url: options.studentBaseUrl ?? providerBaseUrl,
                    model: options.studentModel ?? providerModel,
                  },
                  supervisor: {
                    ...supervisorTarget,
                  },
                  teacher: {
                    base_url: options.teacherBaseUrl ?? providerBaseUrl,
                    model: options.teacherModel ?? providerModel,
                  },
                  malformed_tool: malformedToolFixture?.target,
                  deterministic_compaction: options.deterministicCompaction,
                });
              },
            },
            options.fixtures,
          );
        } finally {
          await supervisorFixture?.close();
          await malformedToolFixture?.close();
          if (desktopToolExecutor) {
            if (previousToolToken === undefined) {
              delete process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
            } else {
              process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = previousToolToken;
            }
          }
        }
        const outputPath = options.output
          ? persistImmutableReport(options.output, report)
          : undefined;
        if (isJsonMode(this)) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const mark = report.eligible_for_promotion
            ? kleur.green("✓")
            : report.passed
              ? kleur.yellow("△")
              : kleur.red("✗");
          const passed = report.scenarios.filter((scenario) => scenario.status === "passed").length;
          process.stdout.write(
            `${mark} ${report.suite_id}: ${passed}/${report.scenarios.length} ${backend} execution gates passed\n`,
          );
          for (const scenario of report.scenarios.filter(({ status }) => status === "failed")) {
            process.stdout.write(`  ${kleur.red("✗")} ${scenario.id}: ${scenario.error}\n`);
          }
          for (const scenario of report.scenarios.filter(
            ({ status }) => status === "not_applicable",
          )) {
            process.stdout.write(`  ${kleur.yellow("-")} ${scenario.id}: ${scenario.error}\n`);
          }
          if (outputPath) process.stdout.write(`evidence: ${outputPath}\n`);
        }
        if (!report.passed || (options.requireComplete && !report.eligible_for_promotion)) {
          process.exitCode = 1;
        }
      });
    });

  runtime
    .command("repair")
    .description("Stop stale state, verify the bundled runtime, and start a clean process.")
    .option("--json", "Output JSON")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        const status = await repairConversationRuntime();
        emit(this, status, statusLine(status));
      });
    });
}
