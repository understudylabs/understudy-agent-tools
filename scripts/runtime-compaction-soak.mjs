#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateRuntimeTrace } from "../dist/runtime/conversation/contract.js";
import { runPiConversation } from "../dist/runtime/conversation/pi-runtime.js";
import {
  requireDesktopApi,
  resolveDesktopSlotProviderTarget,
} from "../dist/internal/desktop-api.js";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

let baseUrl = option("base-url");
let model = option("model");
let artifactId = null;
const slotRaw = option("slot");
const output = option("output");
const cycles = Number(option("cycles", "28"));
const logicalContext = Number(option("context-window", "8192"));
const providerContextRaw = option("provider-context-window");

if (process.argv.includes("--help")) {
  process.stdout.write(
    "usage: runtime-compaction-soak --slot <warm-desktop-slot> [--cycles <2-100>] [--output <private-json>]\n" +
      "   or: runtime-compaction-soak --base-url <local-openai-url> --model <exact-served-model> --provider-context-window <tokens>\n",
  );
  process.exit(0);
}

function configuredContextWindow(modelPath) {
  try {
    const config = JSON.parse(readFileSync(join(modelPath, "config.json"), "utf8"));
    const candidates = [
      config?.text_config?.max_position_embeddings,
      config?.max_position_embeddings,
      config?.text_config?.n_positions,
      config?.n_positions,
    ];
    return candidates.find((value) => Number.isInteger(value) && value >= 1_024) ?? null;
  } catch {
    return null;
  }
}

if (slotRaw) {
  if (baseUrl || model) {
    throw new Error("--slot cannot be combined with --base-url or --model");
  }
  const slot = Number(slotRaw);
  if (!Number.isInteger(slot) || slot <= 0) {
    throw new Error("--slot must be a positive integer");
  }
  const target = await resolveDesktopSlotProviderTarget(await requireDesktopApi(), slot);
  baseUrl = target.baseUrl;
  model = target.model;
  artifactId = target.artifactId;
}

if (!baseUrl || !model) {
  throw new Error(
    "provide --slot <warm-desktop-slot> or both --base-url and --model",
  );
}
const configuredProviderContext = configuredContextWindow(model);
const providerContext = Number(
  providerContextRaw ?? configuredProviderContext ?? "262144",
);
if (!Number.isInteger(cycles) || cycles < 2 || cycles > 100) {
  throw new Error("--cycles must be an integer from 2 to 100");
}
if (!Number.isInteger(logicalContext) || logicalContext < 1_024) {
  throw new Error("--context-window must be an integer of at least 1024");
}
if (!Number.isInteger(providerContext) || providerContext < logicalContext) {
  throw new Error("provider context window must be an integer at least as large as the logical context window");
}

const notes = [
  "Architecture note one: the desktop owns presentation and consent, the runtime owns ordered conversation events, and the evidence ledger owns immutable attribution.",
  "Architecture note two: interrupted student text and teacher continuation remain separately attributed to the exact run and marker.",
  "Architecture note three: tools execute only through the authenticated loopback bridge and every call gets exactly one result.",
  "Architecture note four: image bytes remain local while canonical evidence preserves identity, media type, and ordering.",
  "Architecture note five: compaction is a projection over immutable history and records before and after token estimates.",
  "Architecture note six: restart recovery reopens durable state without asking the user to repeat facts.",
  "Architecture note seven: fully offline means cached text, image, tool, compaction, restart, and terminal evidence with no cloud dependency.",
  "Architecture note eight: promotion compares matching frozen suite hashes and leaves unresolved human judgments unresolved.",
];
const messages = [];
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  for (const [index, note] of notes.entries()) {
    messages.push({
      role: "user",
      content: `Cycle ${cycle}. ${note} Preserve this named note as durable context.`,
    });
    messages.push({
      role: "assistant",
      content: `Recorded cycle ${cycle}, architecture note ${index + 1}; its named fact remains durable.`,
    });
  }
}
messages.push({
  role: "user",
  content:
    "After compacting, state only the three owners from architecture note one and exactly what each owns.",
});

const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-compaction-soak-"));
const previousHome = process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME;
process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME = runtimeHome;
const invocation = Date.now();
const events = [];
try {
  await runPiConversation(
    {
      run_id: `production-compaction-${invocation}`,
      session_id: `production-compaction-${invocation}`,
      base_url: baseUrl,
      model,
      role: "primary",
      messages,
      max_output_tokens: 256,
      context_window_tokens: logicalContext,
      provider_context_window_tokens: providerContext,
      max_tool_rounds: 0,
      runtime_backend: "pi",
    },
    (event) => events.push(event),
  );
} finally {
  if (previousHome === undefined) {
    delete process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME;
  } else {
    process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME = previousHome;
  }
  rmSync(runtimeHome, { recursive: true, force: true });
}

validateRuntimeTrace(events);
const answer = events
  .filter((event) => event.event === "delta")
  .map((event) => String(event.data.text))
  .join("");
const boundary = events.find((event) => event.event === "compaction_boundary")?.data;
const terminalError = events.findLast((event) => event.event === "error")?.data;
const requiredAnswer = [
  "desktop",
  "presentation and consent",
  "runtime",
  "ordered conversation events",
  "evidence ledger",
  "immutable attribution",
];
const result = {
  format: "understudy-production-compaction-soak-v1",
  generated_at: new Date().toISOString(),
  passed:
    Boolean(boundary) &&
    Number(boundary?.estimated_tokens_after) <
      Number(boundary?.estimated_tokens_before) &&
    requiredAnswer.every((term) => answer.toLowerCase().includes(term)),
  run_id: events[0]?.run_id,
  session_id: events[0]?.session_id,
  runtime_id: events[0]?.runtime_id,
  model,
  artifact_id: artifactId,
  logical_context_window_tokens: logicalContext,
  provider_context_window_tokens: providerContext,
  source_message_count: boundary?.source_message_count ?? null,
  retained_message_count: boundary?.retained_message_count ?? null,
  estimated_tokens_before: boundary?.estimated_tokens_before ?? null,
  estimated_tokens_after: boundary?.estimated_tokens_after ?? null,
  summary_sha256: boundary?.summary_sha256 ?? null,
  answer,
  terminal_event: events.at(-1)?.event,
  terminal_error: terminalError
    ? {
        stage: String(terminalError.stage ?? "unknown"),
        code: String(terminalError.code ?? "unknown"),
        message: String(terminalError.message ?? "unknown error").slice(0, 1_000),
        recoverable: terminalError.recoverable === true,
      }
    : null,
};
const rendered = `${JSON.stringify(result, null, 2)}\n`;
if (output) writeFileSync(output, rendered, { mode: 0o600 });
process.stdout.write(rendered);
if (!result.passed) process.exitCode = 1;
