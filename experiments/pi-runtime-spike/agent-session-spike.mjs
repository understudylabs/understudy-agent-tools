import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import { EVENT_SCHEMA, validateRuntimeTrace } from "../../dist/runtime/conversation/contract.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const PNG_ID = createHash("sha256").update(PNG_BYTES).digest("hex");

function canonicalWriter(runId, sessionId) {
  const events = [];
  return {
    events,
    emit(event, data) {
      const sequence = events.length;
      events.push({
        schema_version: EVENT_SCHEMA,
        event_id: `${runId}:${sequence}`,
        run_id: runId,
        session_id: sessionId,
        runtime_id: "pi-agent-session",
        sequence,
        emitted_at: new Date().toISOString(),
        event,
        data,
      });
    },
  };
}

function completionChunk(model, delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function sendSse(response, chunks, delayMs = 0) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  let index = 0;
  const send = () => {
    if (response.destroyed) return;
    if (index >= chunks.length) {
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${JSON.stringify(chunks[index++])}\n\n`);
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
  send();
}

async function fixtureServer(handler) {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    await handler(JSON.parse(raw), response);
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    close: () => new Promise((accept) => server.close(accept)),
  };
}

function model(port, id, contextWindow = 32_768) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "understudy-local",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  };
}

async function createUnderstudySession({
  root,
  selectedModel,
  sessionManager,
  tools = [],
  compaction = { enabled: false, reserveTokens: 64, keepRecentTokens: 16 },
}) {
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(selectedModel.provider, "local-fixture-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory(
    {
      compaction,
      retry: { enabled: false, maxRetries: 0 },
      images: { autoResize: false, blockImages: false },
      quietStartup: true,
    },
    { projectTrusted: false },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are the Understudy conversation runtime. Use only explicitly provided tools.",
  });
  await resourceLoader.reload();
  return createAgentSession({
    cwd,
    agentDir,
    model: selectedModel,
    thinkingLevel: "off",
    tools: tools.map((tool) => tool.name),
    noTools: "all",
    customTools: tools,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage,
    modelRegistry,
  });
}

function usageData(message, role, modelId) {
  const usage = message.usage ?? {};
  const input = Number.isFinite(usage.input) ? usage.input : 0;
  const output = Number.isFinite(usage.output) ? usage.output : 0;
  const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : input + output;
  const complete = Number.isFinite(usage.input) && Number.isFinite(usage.output) && Number.isFinite(usage.totalTokens);
  return {
    role,
    model: modelId,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: Number.isFinite(usage.reasoning) ? usage.reasoning : 0,
    cached_input_tokens: Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0,
    total_tokens: Math.max(total, input + output),
    source: complete ? "provider" : "unavailable",
    complete,
  };
}

function attachCanonicalAdapter(session, writer, options = {}) {
  let compactionSourceMessages = 0;
  return session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        writer.emit("delta", {
          role: options.role ?? "primary",
          text: update.delta,
          model: session.model?.id ?? null,
        });
        options.onTextDelta?.(update.delta);
      } else if (update.type === "thinking_delta") {
        writer.emit("reasoning_delta", {
          role: options.role ?? "primary",
          text: update.delta,
          model: session.model?.id ?? null,
        });
      }
    } else if (event.type === "tool_execution_start") {
      writer.emit("tool_call", {
        call_id: event.toolCallId,
        name: event.toolName,
        raw_arguments: JSON.stringify(event.args),
        parsed_arguments: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      writer.emit("tool_result", {
        call_id: event.toolCallId,
        name: event.toolName,
        ok: !event.isError,
        result: event.result,
      });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      writer.emit(
        "usage",
        usageData(event.message, options.role ?? "primary", session.model?.id ?? "unknown"),
      );
      if (event.message.stopReason === "aborted" && !options.plannedAbort?.()) {
        writer.emit("cancellation", {
          stage: "model_stream",
          reason: event.message.errorMessage || "aborted",
        });
      } else if (event.message.stopReason === "error") {
        writer.emit("error", {
          stage: "model_stream",
          code: "pi_agent_session_error",
          message: event.message.errorMessage || "Pi AgentSession error",
          recoverable: false,
        });
      }
    } else if (event.type === "compaction_start") {
      compactionSourceMessages = session.messages.length;
    } else if (event.type === "compaction_end" && event.result) {
      const retained = session.messages.length;
      const before = Math.max(0, event.result.tokensBefore);
      const after = Math.min(
        before,
        Math.max(0, event.result.estimatedTokensAfter ?? Math.ceil(event.result.summary.length / 4)),
      );
      writer.emit("compaction_boundary", {
        source_message_count: Math.max(compactionSourceMessages, retained),
        retained_message_count: retained,
        estimated_tokens_before: before,
        estimated_tokens_after: after,
        summary_sha256: createHash("sha256").update(event.result.summary).digest("hex"),
      });
    }
  });
}

function assertEvents(writer, required) {
  validateRuntimeTrace(writer.events);
  const emitted = new Set(writer.events.map((event) => event.event));
  for (const event of required) assert.ok(emitted.has(event), `missing ${event}`);
}

async function toolImageScenario() {
  let requestCount = 0;
  let imageReachedProvider = false;
  const server = await fixtureServer((body, response) => {
    requestCount += 1;
    imageReachedProvider ||= JSON.stringify(body.messages).includes("data:image/png;base64,");
    if (requestCount === 1) {
      sendSse(response, [
        completionChunk("pi-tool-image", {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-pi-status",
              type: "function",
              function: { name: "status", arguments: "{\"query\":\"runtime\"}" },
            },
          ],
        }),
        completionChunk("pi-tool-image", {}, "tool_calls", {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        }),
      ]);
    } else {
      sendSse(response, [
        completionChunk("pi-tool-image", { role: "assistant", content: "Local runtime is healthy." }),
        completionChunk("pi-tool-image", {}, "stop", {
          prompt_tokens: 18,
          completion_tokens: 5,
          total_tokens: 23,
        }),
      ]);
    }
  });
  const root = mkdtempSync(join(tmpdir(), "understudy-pi-tool-image-"));
  const sessionManager = SessionManager.create(join(root, "cwd"), join(root, "sessions"));
  const statusTool = defineTool({
    name: "status",
    label: "Runtime status",
    description: "Read local runtime status.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(toolCallId, params) {
      assert.equal(toolCallId, "call-pi-status");
      assert.deepEqual(params, { query: "runtime" });
      return {
        content: [{ type: "text", text: "runtime: healthy" }],
        details: { healthy: true },
      };
    },
  });
  const { session } = await createUnderstudySession({
    root,
    selectedModel: model(server.port, "pi-tool-image"),
    sessionManager,
    tools: [statusTool],
  });
  const writer = canonicalWriter("run-pi-tool-image", "session-pi-tool-image");
  writer.emit("image_attachment", {
    attachment_id: PNG_ID,
    filename: "pixel.png",
    media_type: "image/png",
    byte_count: PNG_BYTES.length,
  });
  writer.emit("message", { role: "user", text: "Check image and runtime status.", model: null });
  const unsubscribe = attachCanonicalAdapter(session, writer);
  try {
    await session.prompt("Check image and runtime status.", {
      images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      expandPromptTemplates: false,
    });
    assertEvents(writer, ["image_attachment", "message", "tool_call", "tool_result", "delta", "usage"]);
    assert.equal(requestCount, 2);
    assert.equal(imageReachedProvider, true);
    const sessionFile = session.sessionFile;
    assert.ok(sessionFile);
    const persisted = readFileSync(sessionFile, "utf8");
    assert.match(persisted, /call-pi-status/);
    assert.match(persisted, /runtime: healthy/);
  } finally {
    unsubscribe();
    session.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
  return writer.events;
}

async function cancellationScenario() {
  const server = await fixtureServer((_body, response) => {
    sendSse(
      response,
      [
        completionChunk("pi-cancel", { role: "assistant", content: "partial " }),
        completionChunk("pi-cancel", { content: "late output" }),
        completionChunk("pi-cancel", {}, "stop", {
          prompt_tokens: 2,
          completion_tokens: 5,
          total_tokens: 7,
        }),
      ],
      150,
    );
  });
  const root = mkdtempSync(join(tmpdir(), "understudy-pi-cancel-"));
  const { session } = await createUnderstudySession({
    root,
    selectedModel: model(server.port, "pi-cancel"),
    sessionManager: SessionManager.inMemory(join(root, "cwd")),
  });
  const writer = canonicalWriter("run-pi-cancel", "session-pi-cancel");
  writer.emit("message", { role: "user", text: "Start, then cancel.", model: null });
  let abortPromise;
  const unsubscribe = attachCanonicalAdapter(session, writer, {
    onTextDelta() {
      abortPromise ??= session.abort();
    },
  });
  try {
    await session.prompt("Start, then cancel.", { expandPromptTemplates: false });
    await abortPromise;
    assertEvents(writer, ["message", "delta", "usage", "cancellation"]);
    assert.equal(writer.events.at(-1)?.event, "cancellation");
  } finally {
    unsubscribe();
    session.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
  return writer.events;
}

async function compactionRestartScenario() {
  let requestCount = 0;
  const server = await fixtureServer((body, response) => {
    requestCount += 1;
    const isCompaction = JSON.stringify(body.messages).includes("conversation history");
    const text = isCompaction
      ? "We established that the inventory threshold is seven units."
      : requestCount > 4
        ? "After restart: the inventory threshold remains seven units."
        : `Recorded long-chat fact ${requestCount}: threshold is seven units. `.repeat(3);
    sendSse(response, [
      completionChunk("pi-long-chat", { role: "assistant", content: text }),
      completionChunk("pi-long-chat", {}, "stop", {
        prompt_tokens: 40 + requestCount * 10,
        completion_tokens: Math.ceil(text.length / 4),
        total_tokens: 40 + requestCount * 10 + Math.ceil(text.length / 4),
      }),
    ]);
  });
  const root = mkdtempSync(join(tmpdir(), "understudy-pi-long-chat-"));
  const sessionDir = join(root, "sessions");
  const writer = canonicalWriter("run-pi-long-chat", "session-pi-long-chat");
  let sessionFile;
  let firstSession;
  try {
    const created = await createUnderstudySession({
      root,
      selectedModel: model(server.port, "pi-long-chat", 512),
      sessionManager: SessionManager.create(join(root, "cwd"), sessionDir),
      compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
    });
    firstSession = created.session;
    const unsubscribe = attachCanonicalAdapter(firstSession, writer);
    for (let turn = 1; turn <= 3; turn += 1) {
      writer.emit("message", {
        role: "user",
        text: `Long chat turn ${turn}: remember the threshold.`,
        model: null,
      });
      await firstSession.prompt(`Long chat turn ${turn}: remember the threshold.`, {
        expandPromptTemplates: false,
      });
    }
    const result = await firstSession.compact("Preserve the inventory threshold exactly.");
    assert.match(result.summary, /seven units/);
    sessionFile = firstSession.sessionFile;
    assert.ok(sessionFile);
    unsubscribe();
    firstSession.dispose();
    firstSession = undefined;

    const reopenedManager = SessionManager.open(sessionFile, sessionDir, join(root, "cwd"));
    const reopened = await createUnderstudySession({
      root,
      selectedModel: model(server.port, "pi-long-chat", 512),
      sessionManager: reopenedManager,
      compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
    });
    const restartSession = reopened.session;
    const unsubscribeRestart = attachCanonicalAdapter(restartSession, writer);
    writer.emit("message", {
      role: "user",
      text: "After restart, what inventory threshold did we establish?",
      model: null,
    });
    await restartSession.prompt("After restart, what inventory threshold did we establish?", {
      expandPromptTemplates: false,
    });
    assert.match(restartSession.messages.at(-1)?.content?.[0]?.text ?? "", /seven units/);
    unsubscribeRestart();
    restartSession.dispose();
    const persisted = readFileSync(sessionFile, "utf8");
    assert.match(persisted, /"type":"compaction"/);
    assert.match(persisted, /seven units/);
    assertEvents(writer, ["message", "delta", "usage", "compaction_boundary"]);
  } finally {
    firstSession?.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
  return writer.events;
}

function flattenTree(nodes) {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

async function treeBranchScenario() {
  let requestCount = 0;
  const server = await fixtureServer((_body, response) => {
    requestCount += 1;
    const text = requestCount === 1 ? "Original continuation: route A." : "Alternate continuation: route B.";
    sendSse(response, [
      completionChunk("pi-tree", { role: "assistant", content: text }),
      completionChunk("pi-tree", {}, "stop", {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      }),
    ]);
  });
  const root = mkdtempSync(join(tmpdir(), "understudy-pi-tree-"));
  const sessionDir = join(root, "sessions");
  const writer = canonicalWriter("run-pi-tree", "session-pi-tree");
  const prompt = "Choose a route from this shared request.";
  let session;
  try {
    const manager = SessionManager.create(join(root, "cwd"), sessionDir);
    session = (
      await createUnderstudySession({
        root,
        selectedModel: model(server.port, "pi-tree"),
        sessionManager: manager,
      })
    ).session;
    const unsubscribe = attachCanonicalAdapter(session, writer);
    writer.emit("message", { role: "user", text: prompt, model: null });
    await session.prompt(prompt, { expandPromptTemplates: false });
    unsubscribe();
    const sessionFile = session.sessionFile;
    assert.ok(sessionFile);
    const firstUser = manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    assert.ok(firstUser, "Pi did not persist the shared user request");
    const branchFromId = firstUser.parentId;
    session.dispose();
    session = undefined;

    const branchedManager = SessionManager.open(sessionFile, sessionDir, join(root, "cwd"));
    if (branchFromId) branchedManager.branch(branchFromId);
    else branchedManager.resetLeaf();
    session = (
      await createUnderstudySession({
        root,
        selectedModel: model(server.port, "pi-tree"),
        sessionManager: branchedManager,
      })
    ).session;
    const unsubscribeBranch = attachCanonicalAdapter(session, writer);
    writer.emit("message", { role: "user", text: prompt, model: null });
    await session.prompt(prompt, { expandPromptTemplates: false });
    unsubscribeBranch();

    const allNodes = flattenTree(branchedManager.getTree());
    const sharedRequestEntries = allNodes.filter(
      ({ entry }) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        (typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")) === prompt,
    );
    assert.equal(sharedRequestEntries.length, 2);
    const branchRoot = branchFromId
      ? allNodes.find(({ entry }) => entry.id === branchFromId)
      : { children: branchedManager.getTree() };
    assert.ok(branchRoot, "Pi lost the selected branch point");
    const sharedRequestIds = new Set(sharedRequestEntries.map(({ entry }) => entry.id));
    const requestBranches = branchRoot.children.filter((child) =>
      flattenTree([child]).some(({ entry }) => sharedRequestIds.has(entry.id)),
    );
    assert.equal(requestBranches.length, 2);
    const persisted = readFileSync(sessionFile, "utf8");
    assert.match(persisted, /Original continuation: route A/);
    assert.match(persisted, /Alternate continuation: route B/);
    assertEvents(writer, ["message", "delta", "usage"]);
    assert.equal(requestCount, 2);
  } finally {
    session?.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
  return writer.events;
}

async function supervisorTakeoverScenario() {
  const server = await fixtureServer((body, response) => {
    const selected = body.model;
    if (selected === "pi-student") {
      sendSse(
        response,
        [
          completionChunk(selected, { role: "assistant", content: "Paris is in Germany" }),
          completionChunk(selected, { content: ", according to the map." }),
          completionChunk(selected, {}, "stop", {
            prompt_tokens: 8,
            completion_tokens: 10,
            total_tokens: 18,
          }),
        ],
        150,
      );
    } else {
      sendSse(response, [
        completionChunk(selected, { role: "assistant", content: "; correction: Paris is in France." }),
        completionChunk(selected, {}, "stop", {
          prompt_tokens: 22,
          completion_tokens: 8,
          total_tokens: 30,
        }),
      ]);
    }
  });
  const root = mkdtempSync(join(tmpdir(), "understudy-pi-supervisor-"));
  const writer = canonicalWriter("run-pi-supervisor", "session-pi-supervisor");
  const markerId = "run-pi-supervisor:intervention:0";
  let plannedAbort = false;
  let partial = "";
  let abortPromise;
  let student;
  let teacher;
  try {
    student = (
      await createUnderstudySession({
        root: join(root, "student"),
        selectedModel: model(server.port, "pi-student"),
        sessionManager: SessionManager.inMemory(join(root, "student", "cwd")),
      })
    ).session;
    writer.emit("message", { role: "user", text: "Which country contains Paris?", model: null });
    const unsubscribeStudent = attachCanonicalAdapter(student, writer, {
      role: "student",
      plannedAbort: () => plannedAbort,
      onTextDelta(delta) {
        partial += delta;
        if (abortPromise) return;
        plannedAbort = true;
        writer.emit("supervisor_verdict", {
          verdict: "interrupt",
          source: "model",
          marker_id: markerId,
          reason: "The answer places Paris in the wrong country.",
          probabilities: { interrupt: 0.98, continue: 0.02 },
        });
        writer.emit("student_interruption", {
          marker_id: markerId,
          reason: "The answer places Paris in the wrong country.",
          partial_text: partial,
          after_chars: partial.length,
        });
        abortPromise = student.abort();
      },
    });
    await student.prompt("Which country contains Paris?", { expandPromptTemplates: false });
    await abortPromise;
    unsubscribeStudent();
    student.dispose();
    student = undefined;

    teacher = (
      await createUnderstudySession({
        root: join(root, "teacher"),
        selectedModel: model(server.port, "pi-teacher"),
        sessionManager: SessionManager.inMemory(join(root, "teacher", "cwd")),
      })
    ).session;
    writer.emit("teacher_continuation", {
      marker_id: markerId,
      reason: "The answer places Paris in the wrong country.",
      teacher_model: "pi-teacher",
      from_partial_chars: partial.length,
    });
    const unsubscribeTeacher = attachCanonicalAdapter(teacher, writer, { role: "teacher" });
    await teacher.prompt(
      `Continue seamlessly after this interrupted partial and correct it:\n${partial}`,
      { expandPromptTemplates: false },
    );
    unsubscribeTeacher();
    assert.equal(partial, "Paris is in Germany");
    assertEvents(writer, [
      "message",
      "delta",
      "supervisor_verdict",
      "student_interruption",
      "teacher_continuation",
      "usage",
    ]);
    assert.equal(
      writer.events.some((event) => ["cancellation", "error"].includes(event.event)),
      false,
    );
  } finally {
    student?.dispose();
    teacher?.dispose();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
  return writer.events;
}

const started = performance.now();
const scenarios = [
  ["tool-image", await toolImageScenario()],
  ["cancellation", await cancellationScenario()],
  ["compaction-restart", await compactionRestartScenario()],
  ["tree-branch", await treeBranchScenario()],
  ["supervisor-takeover", await supervisorTakeoverScenario()],
];
process.stdout.write(
  `${JSON.stringify(
    {
      contender: "@earendil-works/pi-coding-agent@0.80.6",
      node: process.version,
      passed: true,
      elapsed_ms: Math.round(performance.now() - started),
      scenarios: scenarios.map(([id, events]) => ({
        id,
        event_count: events.length,
        events: events.map((event) => event.event),
      })),
    },
    null,
    2,
  )}\n`,
);
