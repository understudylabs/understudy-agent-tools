import { Command, Option } from "commander";
import { basename, extname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  desktopApiContractPath,
  desktopApiFetch,
  desktopApiFetchCompat,
  readDesktopApiContract,
  requireDesktopApi,
  responseError,
} from "../internal/desktop-api.js";

interface RuntimeEvent {
  run_id?: string;
  session_id?: string;
  event?: string;
  data?: Record<string, unknown>;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("value must be a positive integer");
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function jsonRequested(command: Command, local?: boolean): boolean {
  return local === true || command.optsWithGlobals<{ json?: boolean }>().json === true;
}

function printStructured(value: unknown, json: boolean, summary?: string): void {
  if (json || !summary) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${summary}\n`);
  }
}

async function desktopControlJson(
  capability: Awaited<ReturnType<typeof requireDesktopApi>>,
  versionedPath: string,
  legacyPath: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await desktopApiFetchCompat(capability, versionedPath, legacyPath, init);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function imageMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: throw new Error(`unsupported image extension: ${path}`);
  }
}

function imageUpload(path: string): { filename: string; mediaType: string; dataUrl: string } {
  const absolute = resolve(path);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
    throw new Error(`${absolute} must be a non-empty image no larger than 8 MB`);
  }
  const mediaType = imageMediaType(absolute);
  return {
    filename: basename(absolute),
    mediaType,
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
  };
}

async function* ndjson(response: Response): AsyncGenerator<RuntimeEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as RuntimeEvent;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as RuntimeEvent;
}

async function printRuntimeEvents(response: Response, json: boolean): Promise<number> {
  let count = 0;
  let wroteText = false;
  for await (const event of ndjson(response)) {
    count += 1;
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }
    if (event.event === "delta" && typeof event.data?.text === "string") {
      process.stdout.write(event.data.text);
      wroteText = true;
    } else if (event.event === "error") {
      process.stderr.write(`\nruntime error: ${String(event.data?.message ?? "unknown error")}\n`);
    } else if (event.event === "cancellation") {
      process.stderr.write(`\nrun cancelled: ${String(event.data?.reason ?? "cancelled")}\n`);
    }
  }
  if (!json && wroteText) process.stdout.write("\n");
  return count;
}

export function registerDesktopCommand(program: Command): void {
  const desktop = program
    .command("desktop")
    .description("Use the authenticated local API of the running Understudy Desktop app.");

  desktop
    .command("contract")
    .description("Print the versioned OpenAPI contract without requiring Desktop to be running.")
    .option("--json", "Output the complete OpenAPI document")
    .action(function (this: Command, opts: { json?: boolean }) {
      const contract = readDesktopApiContract();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
        return;
      }
      const info = contract.info as { title?: string; version?: string };
      const paths = contract.paths as Record<string, unknown>;
      process.stdout.write(
        `${info.title ?? "Understudy Desktop Agent API"} ${info.version ?? "unknown"}\n` +
        `operations: ${Object.keys(paths).length}\n` +
        `contract: ${desktopApiContractPath()}\n`,
      );
    });

  desktop
    .command("capabilities")
    .description("Discover the live desktop runtime, models, and agent API contract.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(capability, "/v1/capabilities");
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        const row = value as {
          schema_version?: string;
          api_version?: string;
          event_schema?: string;
        };
        process.stdout.write(
          `desktop API ${row.api_version ?? row.schema_version ?? "unknown"} at ${capability.baseUrl}\n` +
          `events: ${row.event_schema ?? "unknown"}\n`,
        );
      }
    });

  desktop
    .command("status")
    .description("Inspect the running app, runtime, warm slots, and repair state.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/status", "/api/status");
      printStructured(value, jsonRequested(this, opts.json));
    });

  const models = desktop.command("model").description("Inspect Desktop model inventory.");
  models
    .command("list")
    .description("List model snapshots already available to Desktop.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/models", "/api/models");
      printStructured(value, jsonRequested(this, opts.json));
    });
  models
    .command("catalog")
    .description("List the bundled certified snapshot catalog.")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/models/catalog",
        "/api/snapshots",
      );
      printStructured(value, jsonRequested(this, opts.json));
    });

  const slots = desktop.command("slot").description("Manage Desktop model residency slots.");
  slots
    .command("list")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/residency", "/api/residency");
      printStructured(value, jsonRequested(this, opts.json));
    });
  slots
    .command("add")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/residency/slots",
        "/api/residency/slots",
        { method: "POST" },
      );
      printStructured(value, jsonRequested(this, opts.json), "added residency slot");
    });
  slots
    .command("assign")
    .argument("<slot-id>", "Residency slot id", positiveInteger)
    .argument("<model-id>", "Installed model id")
    .option("--json", "Output JSON")
    .action(async function (
      this: Command,
      slotId: number,
      modelId: string,
      opts: { json?: boolean },
    ) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/residency/assign",
        "/api/residency/assign",
        {
          method: "POST",
          body: JSON.stringify({ slot_id: slotId, model_id: modelId }),
        },
      );
      printStructured(value, jsonRequested(this, opts.json), `assigned slot ${slotId}`);
    });
  for (const [verb, past] of [
    ["warm", "warming"],
    ["cool", "cooled"],
    ["remove", "removed"],
  ] as const) {
    slots
      .command(verb)
      .argument("<slot-id>", "Residency slot id", positiveInteger)
      .option("--json", "Output JSON")
      .action(async function (this: Command, slotId: number, opts: { json?: boolean }) {
        const capability = await requireDesktopApi();
        const value = await desktopControlJson(
          capability,
          `/v1/residency/${verb}`,
          `/api/residency/${verb}`,
          { method: "POST", body: JSON.stringify({ slot_id: slotId }) },
        );
        printStructured(value, jsonRequested(this, opts.json), `${past} slot ${slotId}`);
      });
  }

  const downloads = desktop.command("download").description("Manage Desktop model downloads.");
  downloads
    .command("list")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(capability, "/v1/downloads", "/api/downloads");
      printStructured(value, jsonRequested(this, opts.json));
    });
  downloads
    .command("start")
    .argument("<model-id>", "Certified snapshot id from desktop model catalog")
    .option("--json", "Output JSON")
    .action(async function (this: Command, modelId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const value = await desktopControlJson(
        capability,
        "/v1/downloads",
        "/api/downloads",
        { method: "POST", body: JSON.stringify({ model_id: modelId }) },
      );
      printStructured(value, jsonRequested(this, opts.json), `started download for ${modelId}`);
    });
  for (const [verb, past] of [
    ["status", "download"],
    ["cancel", "cancelled download"],
  ] as const) {
    downloads
      .command(verb)
      .argument("<download-id>")
      .option("--json", "Output JSON")
      .action(async function (this: Command, downloadId: string, opts: { json?: boolean }) {
        const capability = await requireDesktopApi();
        const suffix = verb === "cancel" ? "/cancel" : "";
        const value = await desktopControlJson(
          capability,
          `/v1/downloads/${encodeURIComponent(downloadId)}${suffix}`,
          `/api/downloads/${encodeURIComponent(downloadId)}${suffix}`,
          verb === "cancel" ? { method: "POST" } : {},
        );
        printStructured(value, jsonRequested(this, opts.json), `${past} ${downloadId}`);
      });
  }

  desktop
    .command("chat")
    .description("Run one canonical local conversation turn and stream its runtime events.")
    .argument("[prompt]", "User text; optional when at least one --image is supplied")
    .requiredOption("--slot <id>", "Warm student or primary desktop residency slot", positiveInteger)
    .option(
      "--supervisor-slot <id>",
      "Distinct warm model that judges the student and continues after interruption",
      positiveInteger,
    )
    .option("--session <id>", "Stable conversation session id")
    .option("--run-id <id>", "Caller-supplied exact run id")
    .option("--max-tokens <n>", "Maximum output tokens", positiveInteger)
    .option("--image <path>", "Attach an image; repeat up to four times", collect, [])
    .option("--json", "Emit canonical events as NDJSON")
    .action(async function (
      this: Command,
      prompt: string | undefined,
      opts: {
        slot: number;
        supervisorSlot?: number;
        session?: string;
        runId?: string;
        maxTokens?: number;
        image: string[];
        json?: boolean;
      },
    ) {
      if (!prompt?.trim() && opts.image.length === 0) {
        throw new Error("prompt or at least one --image is required");
      }
      if (opts.image.length > 4) throw new Error("attach at most four images per turn");
      const capability = await requireDesktopApi();
      const sessionId = opts.session ?? `agent-${randomUUID()}`;
      const runId = opts.runId ?? `run-${randomUUID()}`;
      const response = await desktopApiFetch(
        capability,
        `/v1/conversations/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            slotId: opts.slot,
            supervisorSlotId: opts.supervisorSlot,
            text: prompt?.trim() ?? "",
            runId,
            maxTokens: opts.maxTokens,
            attachments: opts.image.map(imageUpload),
          }),
        },
      );
      if (!response.ok) throw await responseError(response);
      const acceptedRunId = response.headers.get("x-understudy-run-id") ?? runId;
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      if (!json) process.stderr.write(`run: ${acceptedRunId}\n`);
      const count = await printRuntimeEvents(response, json);
      if (count === 0) throw new Error(`run ${acceptedRunId} ended without canonical events`);
    });

  const runs = desktop.command("run").description("Inspect or cancel exact desktop runtime runs.");
  runs
    .command("cancel")
    .argument("<run-id>")
    .option("--json", "Output JSON")
    .action(async function (this: Command, runId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(
        capability,
        `/v1/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        process.stdout.write(`cancelling ${runId}\n`);
      }
    });

  runs
    .command("events")
    .argument("<run-id>")
    .option("--json", "Emit canonical events as NDJSON")
    .action(async function (this: Command, runId: string, opts: { json?: boolean }) {
      const capability = await requireDesktopApi();
      const response = await desktopApiFetch(
        capability,
        `/v1/runs/${encodeURIComponent(runId)}/events`,
      );
      if (!response.ok) throw await responseError(response);
      const json = opts.json === true || this.optsWithGlobals<{ json?: boolean }>().json === true;
      await printRuntimeEvents(response, json);
    });

  desktop
    .command("supervisor-feedback")
    .description("Record a human judgment for one supervisor intervention marker.")
    .requiredOption("--session <id>")
    .requiredOption("--run-id <id>")
    .requiredOption("--marker <id>")
    .addOption(new Option("--stage <stage>").choices(["nudge", "take_over"]).makeOptionMandatory())
    .addOption(new Option("--correct-action <action>").choices(["continue", "nudge", "interrupt", "stop"]).makeOptionMandatory())
    .option("--justification <text>")
    .option("--json", "Output JSON")
    .action(async function (this: Command, opts: {
      session: string;
      runId: string;
      marker: string;
      stage: "nudge" | "take_over";
      correctAction: "continue" | "nudge" | "interrupt" | "stop";
      justification?: string;
      json?: boolean;
    }) {
      const capability = await requireDesktopApi();
      const recordedAction = opts.stage === "take_over" ? "interrupt" : "nudge";
      const response = await desktopApiFetch(capability, "/v1/feedback/supervisor", {
        method: "POST",
        body: JSON.stringify({
          sessionId: opts.session,
          runId: opts.runId,
          markerId: opts.marker,
          stage: opts.stage,
          helpful: opts.correctAction === recordedAction,
          correctAction: opts.correctAction,
          justification: opts.justification,
        }),
      });
      if (!response.ok) throw await responseError(response);
      const value = await response.json();
      if (opts.json || this.optsWithGlobals<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        process.stdout.write(`recorded supervisor judgment for ${opts.marker}\n`);
      }
    });
}
