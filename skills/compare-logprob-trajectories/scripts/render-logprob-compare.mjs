#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function usage() {
  console.error(`Usage:
  node render-logprob-compare.mjs --small-run RUN --large-run RUN --output OUT.html [--input-id ID]
`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    args[key.slice(2)] = value;
    index += 1;
  }
  if (!args["small-run"] || !args["large-run"] || !args.output) usage();
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRows(runDir) {
  const rowsPath = join(runDir, "rows.jsonl");
  return readFileSync(rowsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readSignals(runDir) {
  const dir = join(runDir, "private", "training-signals");
  const signals = new Map();
  if (!existsSync(dir)) return signals;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const payload = readJson(join(dir, file));
    if (typeof payload.input_id === "string") {
      signals.set(payload.input_id, payload);
    }
  }
  return signals;
}

function resolveFromRun(runDir, candidatePath) {
  if (!candidatePath) return null;
  if (candidatePath.startsWith("/")) return existsSync(candidatePath) ? candidatePath : null;
  let cursor = runDir;
  while (cursor && cursor !== dirname(cursor)) {
    const resolved = join(cursor, candidatePath);
    if (existsSync(resolved)) return resolved;
    cursor = dirname(cursor);
  }
  return null;
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tryReadJsonl(path) {
  if (!existsSync(path)) return [];
  return readJsonl(path);
}

function readInputManifest(runDir, runJson) {
  const manifestPath = resolveFromRun(runDir, runJson.eval_input_manifest);
  if (!manifestPath) return { manifest: null, manifestPath: null, inputs: new Map(), sourceTrajectory: null };
  const manifest = readJson(manifestPath);
  const inputsPath = resolveFromRun(runDir, manifest.inputs_path) || join(dirname(manifestPath), "inputs.jsonl");
  const inputs = existsSync(inputsPath)
    ? new Map(readJsonl(inputsPath).map((row) => [row.input_id, row]))
    : new Map();
  const sourceTrajectory = readSourceTrajectory(manifest, runDir);
  return { manifest, manifestPath, inputs, sourceTrajectory };
}

function readSourceTrajectory(manifest, runDir) {
  const sourceDir = resolveFromRun(runDir, manifest?.source_run_dir);
  const trajectoryPath = sourceDir ? join(sourceDir, "trajectories.jsonl") : null;
  if (!trajectoryPath || !existsSync(trajectoryPath)) return null;
  return { path: trajectoryPath, rows: readJsonl(trajectoryPath) };
}

function taskIdFromInputId(inputId) {
  return String(inputId || "").split("::")[0] || "";
}

function turnFromInputId(inputId) {
  const match = String(inputId || "").match(/::turn-(\d+)::call-(\d+)/);
  return match ? { turn: Number(match[1]), call: Number(match[2]) } : { turn: null, call: null };
}

function fullTrajectoryMessages(sourceTrajectory, inputId) {
  const taskId = taskIdFromInputId(inputId);
  if (!sourceTrajectory || !taskId) return [];
  const row = sourceTrajectory.rows.find((candidate) => candidate.example_id === taskId);
  if (!row) return [];
  if (Array.isArray(row.messages)) return row.messages;
  if (Array.isArray(row.logs?.messages)) return row.logs.messages;
  return [];
}

function normalizeToolCall(call) {
  let parsed = call;
  if (typeof call === "string") {
    try {
      parsed = JSON.parse(call);
    } catch {
      return { name: "tool_call", arguments: call };
    }
  }
  const fn = parsed?.function || parsed;
  let args = fn?.arguments ?? parsed?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // Keep raw argument strings when the provider encoded a non-JSON call.
    }
  }
  return {
    id: parsed?.id || parsed?.tool_call_id || "",
    name: fn?.name || parsed?.name || "tool_call",
    arguments: args,
  };
}

function compactValue(value, limit = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function buildTrajectory(inputRow, sourceMessages, inputId, expectedCall) {
  const prefixMessages = inputRow?.input?.prefix_messages || [];
  const messages = sourceMessages.length ? sourceMessages : prefixMessages;
  const active = turnFromInputId(inputId);
  const userMessage = messages.find((message) => message.role === "user")?.content || "";
  const steps = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const calls = message.tool_calls.map(normalizeToolCall);
    steps.push({
      turn: index,
      calls,
      active: active.turn === index,
      phase: active.turn === null ? "context" : index < active.turn ? "before" : index === active.turn ? "active" : "after",
    });
  }
  if (active.turn !== null && !steps.some((step) => step.turn === active.turn)) {
    steps.push({
      turn: active.turn,
      calls: [expectedCall],
      active: true,
      phase: "active",
    });
  }
  steps.sort((a, b) => a.turn - b.turn);
  return {
    userMessage,
    messagesCount: messages.length,
    prefixCount: prefixMessages.length,
    sourceComplete: sourceMessages.length > prefixMessages.length,
    active,
    steps,
  };
}

function callScore(row) {
  const expected = row.expected_tool_call || {};
  const predicted = row.predicted_tool_call || null;
  const expectedArgs = expected.arguments || {};
  const predictedArgs = predicted?.arguments || {};
  const expectedKeys = Object.keys(expectedArgs);
  const predictedKeys = Object.keys(predictedArgs);
  const keyUnion = new Set([...expectedKeys, ...predictedKeys]);
  const common = expectedKeys.filter((key) => predictedKeys.includes(key));
  const valueMatches = common.filter((key) => JSON.stringify(expectedArgs[key]) === JSON.stringify(predictedArgs[key]));
  return {
    toolCorrect: Boolean(predicted && predicted.name === expected.name),
    keyJaccard: keyUnion.size === 0 ? 1 : common.length / keyUnion.size,
    valueMatch: common.length === 0 ? 0 : valueMatches.length / common.length,
  };
}

function chooseRow(smallRows, largeRows, requestedId) {
  const largeById = new Map(largeRows.map((row) => [row.input_id, row]));
  const pairs = smallRows
    .map((small) => ({ small, large: largeById.get(small.input_id) }))
    .filter((pair) => pair.large);
  if (requestedId) {
    const pair = pairs.find((candidate) => candidate.small.input_id === requestedId);
    if (!pair) throw new Error(`input_id not present in both runs: ${requestedId}`);
    return pair;
  }
  const ranked = pairs
    .map((pair) => {
      const smallScore = callScore(pair.small);
      const largeScore = callScore(pair.large);
      const inputTokens = Number(pair.small.usage?.input_tokens || pair.large.usage?.input_tokens || 0);
      let rank = 0;
      if (!smallScore.toolCorrect && largeScore.toolCorrect) rank += 1000;
      if (largeScore.keyJaccard > smallScore.keyJaccard) rank += 200 * (largeScore.keyJaccard - smallScore.keyJaccard);
      if (largeScore.valueMatch > smallScore.valueMatch) rank += 100 * (largeScore.valueMatch - smallScore.valueMatch);
      if (!smallScore.toolCorrect) rank += 50;
      rank += Math.min(inputTokens / 1000, 50);
      return { ...pair, rank };
    })
    .sort((a, b) => b.rank - a.rank);
  if (!ranked[0]) throw new Error("no overlapping rows found");
  return ranked[0];
}

function tokenText(signal) {
  const content = signal?.signals?.logprobs?.content;
  if (!Array.isArray(content)) return [];
  return content.map((entry) => ({
    token: String(entry.token ?? ""),
    logprob: Number.isFinite(entry.logprob) ? entry.logprob : null,
  }));
}

function reconstruct(tokens) {
  return tokens.map((token) => token.token === "<|tool_call>" ? "call:" : token.token).join("");
}

function expectedLine(row) {
  return `call:${row.expected_tool_call?.name || ""}${JSON.stringify(row.expected_tool_call?.arguments || {})}`;
}

function firstDiffIndex(actual, expected) {
  const limit = Math.min(actual.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return actual.length === expected.length ? -1 : limit;
}

function tokenAtOffset(tokens, offset) {
  if (offset < 0) return -1;
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index].token === "<|tool_call>" ? "call:" : tokens[index].token;
    const next = cursor + text.length;
    if (offset >= cursor && offset < next) return index;
    cursor = next;
  }
  return -1;
}

function findNeedleToken(tokens, needle) {
  if (!needle) return -1;
  const normalizedNeedle = String(needle);
  const text = reconstruct(tokens);
  let offset = text.indexOf(normalizedNeedle);
  if (offset >= 0) return tokenAtOffset(tokens, offset);
  for (const part of normalizedNeedle.split(/[^A-Za-z0-9_./:-]+/).filter((value) => value.length >= 3)) {
    offset = text.indexOf(part);
    if (offset >= 0) return tokenAtOffset(tokens, offset);
  }
  return -1;
}

function failureNeedle(row) {
  const expected = row.expected_tool_call || {};
  const predicted = row.predicted_tool_call || null;
  if (!predicted) return "";
  if (predicted.name !== expected.name) return predicted.name || "";
  const expectedArgs = expected.arguments || {};
  const predictedArgs = predicted.arguments || {};
  for (const key of Object.keys(predictedArgs)) {
    if (!Object.prototype.hasOwnProperty.call(expectedArgs, key)) return key;
  }
  for (const key of Object.keys(expectedArgs)) {
    if (!Object.prototype.hasOwnProperty.call(predictedArgs, key)) return key;
    if (JSON.stringify(expectedArgs[key]) !== JSON.stringify(predictedArgs[key])) {
      return String(predictedArgs[key] ?? key);
    }
  }
  return "";
}

function firstFailure(row) {
  const expected = row.expected_tool_call || {};
  const predicted = row.predicted_tool_call || null;
  if (!predicted) {
    return { kind: "missing_tool", label: "no parsed tool call", target: expected.name || "expected tool" };
  }
  const expectedArgs = expected.arguments || {};
  const predictedArgs = predicted.arguments || {};
  if (predicted.name !== expected.name) {
    return {
      kind: "wrong_tool",
      label: `wrong tool: predicted ${predicted.name || "<none>"} but expected ${expected.name || "<none>"}`,
      target: expected.name || "expected tool",
    };
  }
  for (const key of Object.keys(expectedArgs)) {
    if (!Object.prototype.hasOwnProperty.call(predictedArgs, key)) {
      return { kind: "missing_arg_key", label: `missing argument key: ${key}`, target: key };
    }
  }
  for (const key of Object.keys(predictedArgs)) {
    if (!Object.prototype.hasOwnProperty.call(expectedArgs, key)) {
      return { kind: "extra_arg_key", label: `extra argument key: ${key}`, target: key };
    }
  }
  for (const key of Object.keys(expectedArgs)) {
    if (JSON.stringify(expectedArgs[key]) !== JSON.stringify(predictedArgs[key])) {
      return {
        kind: "wrong_arg_value",
        label: `wrong value for ${key}`,
        target: `${key} = ${JSON.stringify(expectedArgs[key])}`,
      };
    }
  }
  return { kind: "none", label: "no semantic mismatch found", target: "none" };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function attrEscape(value) {
  return htmlEscape(value).replaceAll("'", "&#39;");
}

function lpClass(logprob) {
  if (logprob === null) return "none";
  if (logprob <= -2) return "bad";
  if (logprob <= -0.75) return "warn";
  return "good";
}

function probability(logprob) {
  return Number.isFinite(logprob) ? Math.exp(logprob) : null;
}

function topLogprobText(topLogprobs) {
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) return "";
  return topLogprobs
    .slice(0, 3)
    .map((entry) => {
      const lp = Number.isFinite(entry.logprob) ? entry.logprob.toFixed(3) : "n/a";
      const p = probability(entry.logprob);
      const pct = p === null ? "n/a" : `${(p * 100).toFixed(1)}%`;
      return `${String(entry.token ?? "")} (${pct}, lp ${lp})`;
    })
    .join("\n");
}

function logprobSummary(tokens) {
  const values = tokens.map((token) => token.logprob).filter((value) => Number.isFinite(value));
  if (values.length === 0) return { count: 0, mean: null, min: null };
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
  };
}

function officialStats(call) {
  if (!call) return { count: 0, mean: null, min: null, low: 0 };
  const summary = logprobSummary(call.tokens);
  return {
    ...summary,
    low: call.tokens.filter((token) => Number.isFinite(token.logprob) && token.logprob <= -2).length,
  };
}

function lowestLogprobWindow(tokens, windowSize = 10) {
  const scored = tokens
    .map((token, index) => ({ ...token, index }))
    .filter((token) => Number.isFinite(token.logprob));
  if (!scored.length) return { tokens: [], min: null };
  const lowest = scored.sort((a, b) => a.logprob - b.logprob)[0];
  const start = Math.max(0, lowest.index - windowSize);
  const end = Math.min(tokens.length, lowest.index + windowSize + 1);
  return {
    min: lowest.logprob,
    tokens: tokens.slice(start, end).map((token, offset) => ({
      ...token,
      index: start + offset,
      selected: start + offset === lowest.index,
    })),
  };
}

function renderLogprobWindow(label, tokens) {
  const window = lowestLogprobWindow(tokens);
  if (!window.tokens.length) return "";
  const tokenHtml = window.tokens.map((token) => {
    const classes = ["tok", lpClass(token.logprob)];
    if (token.selected) classes.push("selected");
    const lp = Number.isFinite(token.logprob) ? token.logprob.toFixed(3) : "n/a";
    return `<span class="${classes.join(" ")}" title="logprob ${htmlEscape(lp)}">${htmlEscape(token.token)}</span>`;
  }).join("");
  return `
    <section class="logprob-window">
      <div class="window-head">
        <h2>${htmlEscape(label)}</h2>
        <span>lowest small-model token logprob: ${htmlEscape(window.min?.toFixed(3) ?? "n/a")}</span>
      </div>
      <div class="tokens">${tokenHtml}</div>
    </section>`;
}

function simpleDiagnosis(pair, smallTokens, largeTokens) {
  const smallScore = callScore(pair.small);
  const largeScore = callScore(pair.large);
  const smallFailure = firstFailure(pair.small);
  const largeFailure = firstFailure(pair.large);
  const smallSummary = logprobSummary(smallTokens);
  const confidence = smallSummary.min !== null && smallSummary.min > -1
    ? "high-confidence"
    : "mixed-confidence";
  const startLine = smallTokens.length && largeTokens.length
    ? "Both outputs start in the same broad contract: a JSON-like tool call. They do not start with the same semantic action."
    : "Both runs are comparable by row, but one or both are missing token logprobs.";
  const target = smallScore.toolCorrect
    ? smallFailure.target
    : `${pair.small.expected_tool_call?.name || "expected tool"} with ${JSON.stringify(pair.small.expected_tool_call?.arguments || {})}`;
  const verdict = largeScore.toolCorrect && !smallScore.toolCorrect
    ? "The comparison model fixes the tool choice, so this row is useful evidence for quantization/model-capacity damage."
    : largeScore.toolCorrect && smallScore.toolCorrect
      ? "Both models know the tool family; the useful training signal is exact argument construction."
      : "The larger comparison model is not a clean teacher here; use the oracle expected call as the target.";
  return { smallFailure, largeFailure, confidence, startLine, target, verdict };
}

function renderLane(label, row, tokens, markerIndex) {
  const score = callScore(row);
  const summary = logprobSummary(tokens);
  const tokenHtml = tokens.map((token, index) => {
    const classes = ["tok", lpClass(token.logprob)];
    if (index === markerIndex) classes.push("marker");
    const title = token.logprob === null ? "no logprob" : `logprob ${token.logprob.toFixed(4)}`;
    return `<span class="${classes.join(" ")}" style="--i:${index}" title="${htmlEscape(title)}">${htmlEscape(token.token)}</span>`;
  }).join("");
  return `
    <section class="lane">
      <div class="lane-head">
        <h2>${htmlEscape(label)}</h2>
        <div class="metrics">
          <span>tool ${score.toolCorrect ? "ok" : "miss"}</span>
          <span>key ${score.keyJaccard.toFixed(2)}</span>
          <span>value ${score.valueMatch.toFixed(2)}</span>
          <span>in ${row.usage?.input_tokens ?? "?"}</span>
          <span>out ${row.usage?.output_tokens ?? "?"}</span>
          <span>lp ${summary.count ? summary.mean.toFixed(3) : "n/a"}</span>
          <span>min ${summary.min === null ? "n/a" : summary.min.toFixed(3)}</span>
        </div>
      </div>
      <pre class="call">${htmlEscape(JSON.stringify(row.predicted_tool_call, null, 2))}</pre>
      <div class="tokens">${tokenHtml || "<span class='empty'>No token logprobs found.</span>"}</div>
    </section>`;
}

function renderTrajectory(trajectory) {
  if (!trajectory.steps.length) {
    return `
      <section class="panel">
        <h2>Task Trajectory</h2>
        <p class="muted">No multi-turn trajectory context was found for this row. The comparison below is still row-aligned, but cannot show the surrounding task steps.</p>
      </section>`;
  }
  const activeLabel = trajectory.active.turn === null
    ? "active turn unknown"
    : `active compared step: turn ${String(trajectory.active.turn).padStart(3, "0")} / call ${String(trajectory.active.call || 1).padStart(2, "0")}`;
  const stepsHtml = trajectory.steps.map((step, index) => {
    const calls = step.calls.map((call, callIndex) => `
      <div class="step-call">
        <span>${htmlEscape(call.name)}</span>
        <code>${htmlEscape(compactValue(call.arguments, 130))}</code>
      </div>`).join("");
    const classes = ["step", step.phase];
    if (step.active) classes.push("selected");
    const firstLabel = index === 0 ? "first action" : step.phase;
    return `
      <article class="${classes.join(" ")}">
        <div class="step-head">
          <strong>turn ${String(step.turn).padStart(3, "0")}</strong>
          <span>${htmlEscape(firstLabel)} · ${step.calls.length} call${step.calls.length === 1 ? "" : "s"}</span>
        </div>
        ${calls}
      </article>`;
  }).join("");
  const sourceLabel = trajectory.sourceComplete
    ? `full teacher trajectory: ${trajectory.messagesCount} messages`
    : `prefix available to model: ${trajectory.prefixCount} messages`;
  return `
    <section class="panel trajectory-panel">
      <div class="section-head">
        <h2>Task Trajectory</h2>
        <div class="subtle">${htmlEscape(activeLabel)} · ${htmlEscape(sourceLabel)}</div>
      </div>
      <div class="task-start">
        <strong>Starting user request</strong>
        <p>${htmlEscape(compactValue(trajectory.userMessage, 520))}</p>
      </div>
      <div class="rail">${stepsHtml}</div>
    </section>`;
}

function modelLabel(runJson, runDir) {
  const model = runJson?.candidate?.model || runJson?.candidate_spec || runDir;
  const clean = String(model).replace(/^local\//, "");
  return basename(clean);
}

function rowsForTask(rows, inputId) {
  const taskId = taskIdFromInputId(inputId);
  return rows
    .filter((row) => taskIdFromInputId(row.input_id) === taskId)
    .sort((a, b) => {
      const aTurn = turnFromInputId(a.input_id);
      const bTurn = turnFromInputId(b.input_id);
      return (aTurn.turn ?? 0) - (bTurn.turn ?? 0) || (aTurn.call ?? 0) - (bTurn.call ?? 0);
    });
}

function renderCallSummary(call) {
  if (!call) return "<span class=\"empty\">no parsed tool call</span>";
  return `
    <div class="call-name">${htmlEscape(call.name || "tool_call")}</div>
    <code>${htmlEscape(compactValue(call.arguments || {}, 260))}</code>`;
}

function renderTurnList(label, rows, activeInputId) {
  const cards = rows.map((row) => {
    const turn = turnFromInputId(row.input_id);
    const score = callScore(row);
    const status = score.toolCorrect ? "tool ok" : `expected ${row.expected_tool_call?.name || "tool"}`;
    const classes = ["turn-card", score.toolCorrect ? "ok" : "miss"];
    if (row.input_id === activeInputId) classes.push("active");
    return `
      <article class="${classes.join(" ")}">
        <div class="turn-head">
          <strong>turn ${String(turn.turn ?? "?").padStart(3, "0")}</strong>
          <span>${htmlEscape(status)}</span>
        </div>
        ${renderCallSummary(row.predicted_tool_call)}
      </article>`;
  }).join("");
  return `
    <section class="model-column">
      <h2>${htmlEscape(label)}</h2>
      <div class="turn-list">${cards || "<p class=\"empty\">No rows for this task.</p>"}</div>
    </section>`;
}

function rowsByTurn(rows) {
  const mapped = new Map();
  for (const row of rows) {
    const turn = turnFromInputId(row.input_id);
    if (turn.turn !== null) mapped.set(turn.turn, row);
  }
  return mapped;
}

function signalSummary(signals, inputId) {
  const summary = logprobSummary(tokenText(signals.get(inputId)));
  if (!summary.count) return "lp n/a";
  return `min lp ${summary.min.toFixed(2)}`;
}

function renderSequenceColumn(label, steps, rows, signals, activeInputId) {
  const rowByTurn = rowsByTurn(rows);
  const cards = steps.map((step) => {
    const row = rowByTurn.get(step.turn);
    const teacherCall = step.calls[0] || null;
    const active = row?.input_id === activeInputId;
    const classes = ["turn-card"];
    if (!row) classes.push("missing");
    if (row) classes.push(callScore(row).toolCorrect ? "ok" : "miss");
    if (active) classes.push("active");
    const status = row
      ? `${callScore(row).toolCorrect ? "tool ok" : "tool miss"} · ${signalSummary(signals, row.input_id)}`
      : "not evaluated";
    const predicted = row
      ? renderCallSummary(row.predicted_tool_call)
      : "<span class=\"empty\">No local-model output in this targeted logprob slice.</span>";
    return `
      <article class="${classes.join(" ")}">
        <div class="turn-head">
          <strong>turn ${String(step.turn).padStart(3, "0")}</strong>
          <span>${htmlEscape(status)}</span>
        </div>
        <div class="teacher">
          <span>teacher</span>
          ${renderCallSummary(teacherCall)}
        </div>
        <div class="prediction">
          <span>model</span>
          ${predicted}
        </div>
      </article>`;
  }).join("");
  return `
    <section class="model-column">
      <h2>${htmlEscape(label)}</h2>
      <div class="turn-list">${cards}</div>
    </section>`;
}

function readOfficialRun(runDir) {
  const result = existsSync(join(runDir, "result.json")) ? readJson(join(runDir, "result.json")) : {};
  const report = existsSync(join(runDir, "report.md")) ? readFileSync(join(runDir, "report.md"), "utf8") : "";
  const events = tryReadJsonl(join(runDir, "model-call-events.jsonl"));
  const agentPolicyPath = join(runDir, "agent-policy.txt");
  const agentPolicyText = existsSync(agentPolicyPath) ? readFileSync(agentPolicyPath, "utf8") : "";
  const trajectory = tryReadJsonl(join(runDir, "trajectories.jsonl"))[0] || {};
  const messages = Array.isArray(trajectory.messages) ? trajectory.messages : trajectory.logs?.messages || [];
  const assistantTurns = messages
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.role === "assistant");
  const assertionResults = trajectory.logs?.assertion_results || [];
  const userMessage = messages.find((message) => message.role === "user")?.content
    || events[0]?.request?.prompt?.find?.((message) => message.role === "user")?.content
    || "";
  const systemMessage = messages.find((message) => message.role === "system")?.content
    || events[0]?.request?.prompt?.find?.((message) => message.role === "system")?.content
    || "";
  const calls = events.map((event, index) => {
    const value = event.observability?.value || {};
    const content = value.choice_logprobs?.content || [];
    const promptMessages = Array.isArray(event.request?.prompt) ? event.request.prompt : [];
    const assistantTurn = assistantTurns[index] || {};
    const toolCalls = (assistantTurn.message?.tool_calls || []).map(normalizeToolCall);
    return {
      index,
      messageIndex: assistantTurn.messageIndex ?? null,
      finishReason: value.finish_reason || "",
      usage: value.usage || {},
      tokens: content.map((entry) => ({
        token: String(entry.token ?? ""),
        logprob: Number.isFinite(entry.logprob) ? entry.logprob : null,
        topLogprobs: Array.isArray(entry.top_logprobs) ? entry.top_logprobs : [],
      })),
      promptMessages,
      latestToolResponses: latestToolResponses(promptMessages),
      promptToolResponseCount: promptMessages.filter((message) => message.role === "tool").length,
      reconstructed: content.map((entry) => String(entry.token ?? "")).join(""),
      toolCalls,
      assistantContent: assistantTurn.message?.content || "",
    };
  });
  const missed = assertionResults.filter((assertion) => !assertion.passed);
  const passCount = assertionResults.filter((assertion) => assertion.passed).length;
  return {
    dir: runDir,
    runId: basename(runDir),
    report,
    result,
    trajectory,
    messages,
    calls,
    userMessage,
    systemMessage,
    assertionResults,
    missed,
    passCount,
    assertionCount: assertionResults.length,
    failureClass: trajectory.logs?.failure_class || "unknown",
    model: trajectory.requested_model || trajectory.model || result.model || "model",
    provider: trajectory.provider || result.provider || "",
    estimatedCostUsd: result.estimated_spend_usd ?? trajectory.usage?.estimated_spend_usd,
    agentPolicyText,
    candidatePolicyText: candidatePolicyText(events, agentPolicyText),
  };
}

function candidatePolicyText(events, fallback = "") {
  const system = events[0]?.request?.prompt?.find?.((message) => message.role === "system")?.content || "";
  const marker = "AutomationBench candidate policy:";
  const index = system.indexOf(marker);
  if (index < 0) return fallback;
  return system.slice(index + marker.length).trim();
}

function latestToolResponses(messages) {
  const responses = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool") break;
    responses.push({
      index,
      content: message.content,
      toolCallId: message.tool_call_id || message.tool_call?.id || "",
      name: message.name || message.tool_name || "",
    });
  }
  return responses.reverse();
}

function callContains(call, needle) {
  return String(call.reconstructed || "") .includes(needle)
    || JSON.stringify(call.toolCalls || {}).includes(needle)
    || String(call.assistantContent || "").includes(needle);
}

function defaultOfficialSelection(weaker, stronger) {
  const strongSlack = stronger.calls.find((call) => callContains(call, "chat.postMessage"))
    || stronger.calls.find((call) => callContains(call, "AE: Jordan Park"))
    || stronger.calls[stronger.calls.length - 1];
  const weakSlack = weaker.calls.find((call) => callContains(call, "chat.postMessage"))
    || weaker.calls.find((call) => callContains(call, "Deal Win Alert"))
    || weaker.calls[Math.min(strongSlack?.index ?? 0, weaker.calls.length - 1)];
  return {
    weak: Math.max(0, weakSlack?.index ?? 0),
    strong: Math.max(0, strongSlack?.index ?? 0),
  };
}

function officialTokenSummary(call) {
  const summary = logprobSummary(call.tokens);
  const count = call.tokens.length;
  const low = call.tokens.filter((token) => Number.isFinite(token.logprob) && token.logprob <= -2).length;
  const mean = summary.mean === null ? "n/a" : summary.mean.toFixed(3);
  const min = summary.min === null ? "n/a" : summary.min.toFixed(3);
  return `${count} tokens · mean lp ${mean} · min lp ${min} · low-confidence ${low}`;
}

function renderOfficialCallCard(runKey, call, selectedIndex) {
  const classes = ["turn-card", call.toolCalls.length ? "ok" : "missing"];
  if (call.index === selectedIndex) classes.push("active");
  const names = call.toolCalls.map((toolCall) => toolCall.name).join(", ") || call.finishReason || "final";
  const summary = officialTokenSummary(call);
  const callText = call.toolCalls.length
    ? call.toolCalls.map((toolCall) => `${toolCall.name} ${compactValue(toolCall.arguments, 180)}`).join("\n")
    : compactValue(call.assistantContent, 220) || "no tool call";
  return `
    <button class="${classes.join(" ")} official-card" data-run="${htmlEscape(runKey)}" data-call="${call.index}" type="button">
      <div class="turn-head">
        <strong>call ${String(call.index + 1).padStart(2, "0")}</strong>
        <span>${htmlEscape(summary)}</span>
      </div>
      <div class="call-name">${htmlEscape(names)}</div>
      <code>${htmlEscape(callText)}</code>
    </button>`;
}

function renderOfficialRunColumn(runKey, label, run, selectedIndex) {
  const missed = run.missed.map((assertion) => `${assertion.type} ${JSON.stringify(assertion.params)}`).join("\n");
  const status = run.assertionCount
    ? `${run.passCount}/${run.assertionCount} assertions · ${run.failureClass}`
    : run.failureClass;
  const cards = run.calls.map((call) => renderOfficialCallCard(runKey, call, selectedIndex)).join("");
  return `
    <section class="model-column">
      <div class="column-head">
        <h2>${htmlEscape(label)}</h2>
        <span>${htmlEscape(run.model)}</span>
      </div>
      <div class="run-status ${run.failureClass === "pass" ? "pass" : "fail"}">${htmlEscape(status)}</div>
      ${missed ? `<pre class="missed">${htmlEscape(missed)}</pre>` : ""}
      <div class="turn-list">${cards}</div>
    </section>`;
}

function officialCallLabel(call) {
  if (!call) return "not present";
  const names = call.toolCalls.map((toolCall) => toolCall.name).join(", ");
  return names || call.finishReason || "final";
}

function officialCallPreview(call, limit = 260) {
  if (!call) return "No model call in this trace.";
  if (call.toolCalls.length) {
    return call.toolCalls
      .map((toolCall) => `${toolCall.name} ${compactValue(toolCall.arguments, limit)}`)
      .join("\n");
  }
  return compactValue(call.assistantContent || call.reconstructed || "final answer", limit);
}

function parseJsonLike(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeNestedJson(value) {
  const parsed = parseJsonLike(value);
  if (Array.isArray(parsed)) return parsed.map(normalizeNestedJson);
  if (parsed && typeof parsed === "object") {
    return Object.fromEntries(
      Object.entries(parsed).map(([key, entry]) => [key, normalizeNestedJson(entry)]),
    );
  }
  return parsed;
}

function prettyJson(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function renderParsedValue(value) {
  if (value === null) return "<span class=\"json-null\">null</span>";
  if (typeof value === "boolean" || typeof value === "number") {
    return `<span class="json-scalar">${htmlEscape(String(value))}</span>`;
  }
  if (typeof value === "string") return `<span>${htmlEscape(value)}</span>`;
  return `<pre class="json-pre">${htmlEscape(prettyJson(value))}</pre>`;
}

function renderParsedToolCall(call) {
  if (!call) {
    return `<div class="parsed-empty">No call in this trace.</div>`;
  }
  const args = normalizeNestedJson(call.arguments);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `
      <article class="parsed-call">
        <div class="parsed-call-head">${htmlEscape(call.name || "tool_call")}</div>
        <pre class="json-pre">${htmlEscape(prettyJson(args))}</pre>
      </article>`;
  }
  const entries = Object.entries(args);
  const shortRows = entries
    .filter(([key, value]) => {
      const parsed = normalizeNestedJson(value);
      return parsed === null || typeof parsed !== "object";
    })
    .map(([key, value]) => `
      <div class="field-row">
        <dt>${htmlEscape(key)}</dt>
        <dd>${renderParsedValue(normalizeNestedJson(value))}</dd>
      </div>`)
    .join("");
  const objectRows = entries
    .filter(([, value]) => {
      const parsed = normalizeNestedJson(value);
      return parsed && typeof parsed === "object";
    })
    .map(([key, value]) => `
      <details class="json-section" open>
        <summary>${htmlEscape(key)}</summary>
        <pre class="json-pre">${htmlEscape(prettyJson(normalizeNestedJson(value)))}</pre>
      </details>`)
    .join("");
  return `
    <article class="parsed-call">
      <div class="parsed-call-head">${htmlEscape(call.name || "tool_call")}</div>
      <dl class="field-list">${shortRows}</dl>
      ${objectRows}
    </article>`;
}

function renderParsedCallPanel(runKey, label, run, selectedIndex) {
  const panels = run.calls.map((call) => {
    const parsedCalls = call.toolCalls.length
      ? call.toolCalls.map(renderParsedToolCall).join("")
      : `<div class="parsed-empty">${htmlEscape(call.assistantContent || call.reconstructed || "No tool call.")}</div>`;
    return `
      <article class="parsed-call-panel" data-run-human="${htmlEscape(runKey)}" data-call-human="${call.index}" ${call.index === selectedIndex ? "" : "hidden"}>
        <div class="token-head">
          <div>
            <h3>${htmlEscape(label)} · call ${call.index + 1}</h3>
            <p>${htmlEscape(officialTokenSummary(call))}</p>
          </div>
          <span>${htmlEscape(call.finishReason || "")}</span>
        </div>
        <div class="parsed-calls">${parsedCalls}</div>
      </article>`;
  }).join("");
  return `<section class="parsed-column">${panels}</section>`;
}

function responseSummary(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(value.results)) {
      const labels = value.results
        .slice(0, 4)
        .map((row) => row?.id || row?.Name || row?.name || row?.title || row?.description)
        .filter(Boolean);
      return `${value.results.length} search result${value.results.length === 1 ? "" : "s"}${labels.length ? `: ${labels.join(", ")}` : ""}`;
    }
    if (Array.isArray(value.files)) {
      return `${value.files.length} file${value.files.length === 1 ? "" : "s"}`;
    }
    if (Array.isArray(value.channels)) {
      const labels = value.channels.slice(0, 4).map((row) => row?.name || row?.id).filter(Boolean);
      return `${value.channels.length} Slack channel${value.channels.length === 1 ? "" : "s"}${labels.length ? `: ${labels.join(", ")}` : ""}`;
    }
    if (value.ok === true && value.message) {
      const text = value.message.text || value.message.channel || value.message.ts || "message";
      return `ok: ${text}`;
    }
    if (value.error) {
      const message = value.error.message || value.error.code || JSON.stringify(value.error);
      return `error: ${message}`;
    }
    const label = value.Name || value.name || value.title || value.Id || value.id;
    if (label) return String(label);
    const keys = Object.keys(value);
    if (keys.length) return `object keys: ${keys.slice(0, 5).join(", ")}`;
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value === null) return "null";
  return compactValue(value, 180);
}

function renderResultList(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.results)) return "";
  const rows = value.results.slice(0, 6).map((row, index) => {
    const title = row?.id || row?.Name || row?.name || row?.title || `result ${index + 1}`;
    const description = row?.description || row?.Description || row?.method || row?.url || "";
    return `
      <li>
        <strong>${htmlEscape(title)}</strong>
        ${description ? `<span>${htmlEscape(compactValue(description, 220))}</span>` : ""}
      </li>`;
  }).join("");
  const more = value.results.length > 6 ? `<li class="more">+${value.results.length - 6} more</li>` : "";
  return `<ol class="result-list">${rows}${more}</ol>`;
}

function renderToolResponse(response, ordinal) {
  const parsed = normalizeNestedJson(response.content);
  const summary = responseSummary(parsed);
  return `
    <article class="response-card">
      <div class="response-head">
        <strong>tool response ${ordinal + 1}</strong>
        <span>${htmlEscape(summary)}</span>
      </div>
      ${renderResultList(parsed)}
      <details class="json-section">
        <summary>full response JSON</summary>
        <pre class="json-pre">${htmlEscape(prettyJson(parsed))}</pre>
      </details>
    </article>`;
}

function environmentResponsesAfterCall(run, call) {
  if (!call || call.messageIndex === null || call.messageIndex === undefined) return [];
  const toolLabels = toolCallLabelMap(run.messages);
  const responses = [];
  for (let index = call.messageIndex + 1; index < run.messages.length; index += 1) {
    const message = run.messages[index];
    if (!message || message.role !== "tool") break;
    const toolCallId = message.tool_call_id || message.tool_call?.id || "";
    responses.push({
      index,
      content: message.content,
      toolCallId,
      name: message.name || message.tool_name || toolLabels.get(toolCallId) || "tool response",
    });
  }
  return responses;
}

function renderEnvironmentResponse(response, ordinal) {
  const parsed = normalizeNestedJson(response.content);
  const summary = responseSummary(parsed);
  return `
    <article class="env-response">
      <div class="response-head">
        <strong>${String(ordinal + 1).padStart(2, "0")} · ${htmlEscape(response.name || "tool response")}</strong>
        <span>${htmlEscape(summary)}</span>
      </div>
      ${renderResultList(parsed)}
      <details class="json-section">
        <summary>actual environment response JSON${response.toolCallId ? ` · ${htmlEscape(response.toolCallId)}` : ""}</summary>
        <pre class="json-pre">${htmlEscape(prettyJson(parsed))}</pre>
      </details>
    </article>`;
}

function renderTurnOneColumn(runKey, label, run, policyText) {
  const call = run.calls[0] || null;
  const stats = actionBlockStats(call);
  const responses = environmentResponsesAfterCall(run, call);
  const hits = policyHitLabels(call, policyText);
  const hitHtml = hits.length
    ? `<div class="policy-hits">${hits.map((hit) => `<span>${htmlEscape(hit)}</span>`).join("")}</div>`
    : "";
  const responsesHtml = responses.length
    ? responses.map(renderEnvironmentResponse).join("")
    : "<div class=\"parsed-empty\">No environment responses were recorded after this turn.</div>";
  return `
    <section class="turn-one-column">
      <div class="column-head">
        <h2>${htmlEscape(label)}</h2>
        <span>${call ? officialTokenSummary(call) : "no first call"}</span>
      </div>
      <div class="turn-one-card" data-run-delta="${htmlEscape(runKey)}" data-call-delta="${call ? call.index : ""}">
        <div class="action-stats ${stats.confidenceClass}">${htmlEscape(stats.label)}</div>
        ${hitHtml}
        ${renderCompactActionCalls(call)}
        ${renderLowestTokenChips(call)}
      </div>
      <div class="env-responses">
        <h3>Environment responses returned after turn 1</h3>
        ${responsesHtml}
      </div>
    </section>`;
}

function renderTurnOneEnvironment(weakRun, strongRun, prompt) {
  const strongPolicy = strongRun.agentPolicyText || strongRun.candidatePolicyText || "";
  return `
    <section class="turn-one-section">
      <div class="section-title">
        <h2>Start Here: Original Prompt + Turn 1</h2>
        <span>actual recorded tool responses from the environment after the first assistant action</span>
      </div>
      <article class="original-prompt">
        <strong>Original user request</strong>
        <p>${htmlEscape(prompt)}</p>
      </article>
      <div class="turn-one-grid">
        ${renderTurnOneColumn("weak", "31B baseline turn 1", weakRun, "")}
        ${renderTurnOneColumn("strong", "31B + GEPA turn 1", strongRun, strongPolicy)}
      </div>
    </section>`;
}

function renderToolResponsesPanel(runKey, label, run, selectedIndex) {
  const panels = run.calls.map((call) => {
    const body = call.latestToolResponses.length
      ? call.latestToolResponses.map(renderToolResponse).join("")
      : `<div class="parsed-empty">First model call: no tool responses had been fed back yet.</div>`;
    return `
      <article class="responses-panel" data-run-responses="${htmlEscape(runKey)}" data-call-responses="${call.index}" ${call.index === selectedIndex ? "" : "hidden"}>
        <div class="token-head">
          <div>
            <h3>${htmlEscape(label)} · responses before call ${call.index + 1}</h3>
            <p>${call.latestToolResponses.length} new response${call.latestToolResponses.length === 1 ? "" : "s"} · ${call.promptToolResponseCount} total tool response${call.promptToolResponseCount === 1 ? "" : "s"} in prompt</p>
          </div>
          <span>fed into LLM</span>
        </div>
        <div class="responses-list">${body}</div>
      </article>`;
  }).join("");
  return `<section class="responses-column">${panels}</section>`;
}

function renderOfficialTraceMatrix(weakRun, strongRun, selected) {
  const length = Math.max(weakRun.calls.length, strongRun.calls.length);
  const rows = Array.from({ length }, (_, index) => {
    const weak = weakRun.calls[index] || null;
    const strong = strongRun.calls[index] || null;
    const selectedRow = (weak?.index ?? -1) === selected.weak
      || (strong?.index ?? -1) === selected.strong;
    const classes = ["trace-row"];
    if (selectedRow) classes.push("active");
    const weakCall = weak ? weak.index : "";
    const strongCall = strong ? strong.index : "";
    return `
      <button class="${classes.join(" ")}" type="button" data-pair-weak="${weakCall}" data-pair-strong="${strongCall}">
        <div class="trace-index">#${String(index + 1).padStart(2, "0")}</div>
        <div class="trace-cell">
          <strong>${htmlEscape(officialCallLabel(weak))}</strong>
          <span>${htmlEscape(weak ? officialTokenSummary(weak) : "")}</span>
          <code>${htmlEscape(officialCallPreview(weak, 210))}</code>
        </div>
        <div class="trace-cell">
          <strong>${htmlEscape(officialCallLabel(strong))}</strong>
          <span>${htmlEscape(strong ? officialTokenSummary(strong) : "")}</span>
          <code>${htmlEscape(officialCallPreview(strong, 210))}</code>
        </div>
      </button>`;
  }).join("");
  return `
    <section class="trace-compare">
      <div class="section-title">
        <h2>Double Trace Alignment</h2>
        <span>click a paired row to update both token streams</span>
      </div>
      <div class="trace-head">
        <span></span>
        <strong>31B baseline</strong>
        <strong>31B + GEPA policy repair</strong>
      </div>
      <div class="trace-list">${rows}</div>
    </section>`;
}

function fieldStrings(value, path = "") {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return text.length >= 3 ? [{ key: path, value: text }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => fieldStrings(entry, path ? `${path}.${index}` : String(index)));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => fieldStrings(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

function policyHitLabels(call, policyText) {
  if (!call || !policyText) return [];
  const seen = new Set();
  const hits = [];
  for (const toolCall of call.toolCalls) {
    const args = normalizeNestedJson(toolCall.arguments);
    for (const field of fieldStrings(args)) {
      const value = String(field.value);
      if (value.length < 6 || !policyText.includes(value)) continue;
      const key = field.key.split(".").slice(-1)[0] || "value";
      const label = `${key}: ${compactValue(value, 88)}`;
      if (!seen.has(label)) {
        seen.add(label);
        hits.push(label);
      }
    }
  }
  return hits.slice(0, 8);
}

function actionBlockStats(call) {
  const stats = officialStats(call);
  const mean = stats.mean === null ? "n/a" : stats.mean.toFixed(3);
  const min = stats.min === null ? "n/a" : stats.min.toFixed(3);
  return {
    label: `${stats.count} tok · mean ${mean} · min ${min} · low ${stats.low}`,
    confidenceClass: stats.min === null ? "none" : stats.min <= -2 ? "bad" : stats.min <= -0.75 ? "warn" : "good",
  };
}

function renderLowestTokenChips(call) {
  if (!call) return "";
  const tokens = call.tokens
    .map((token, index) => ({ ...token, index }))
    .filter((token) => Number.isFinite(token.logprob))
    .sort((a, b) => a.logprob - b.logprob)
    .slice(0, 5);
  if (!tokens.length) return "";
  const chips = tokens.map((token) => `
    <span class="low-token ${lpClass(token.logprob)}" title="token ${token.index}">${htmlEscape(token.token)} <b>${token.logprob.toFixed(2)}</b></span>`).join("");
  return `<div class="low-token-row">${chips}</div>`;
}

function renderCompactActionCalls(call) {
  if (!call) return "<div class=\"parsed-empty\">No model call in this trace.</div>";
  if (!call.toolCalls.length) {
    const content = call.assistantContent || call.reconstructed || "final answer";
    return `<pre class="message-text">${htmlEscape(compactValue(content, 520))}</pre>`;
  }
  return call.toolCalls.map((toolCall) => {
    const args = normalizeNestedJson(toolCall.arguments);
    const fields = fieldStrings(args)
      .filter((field) => String(field.value).length > 0)
      .slice(0, 5)
      .map((field) => `
        <div class="action-field">
          <dt>${htmlEscape(field.key.split(".").slice(-1)[0] || "value")}</dt>
          <dd>${htmlEscape(compactValue(field.value, 120))}</dd>
        </div>`)
      .join("");
    return `
      <article class="action-call">
        <strong>${htmlEscape(toolCall.name || "tool_call")}</strong>
        <dl>${fields}</dl>
      </article>`;
  }).join("");
}

function renderActionDeltaCell(runKey, call, policyText, selectedIndex = null) {
  const stats = actionBlockStats(call);
  const hits = policyHitLabels(call, policyText);
  const hitHtml = hits.length
    ? `<div class="policy-hits">${hits.map((hit) => `<span>${htmlEscape(hit)}</span>`).join("")}</div>`
    : "";
  const callIndex = call ? call.index : "";
  const classes = ["action-cell"];
  if (call && call.index === selectedIndex) classes.push("active");
  return `
    <div class="${classes.join(" ")}" data-run-delta="${htmlEscape(runKey)}" data-call-delta="${callIndex}">
      <div class="action-stats ${stats.confidenceClass}">${htmlEscape(stats.label)}</div>
      ${hitHtml}
      ${renderCompactActionCalls(call)}
      ${renderLowestTokenChips(call)}
    </div>`;
}

function renderPolicyIntervention(weakRun, strongRun) {
  const weakPolicy = weakRun.candidatePolicyText || "No candidate policy found.";
  const strongPolicy = strongRun.agentPolicyText || strongRun.candidatePolicyText || "No repaired policy found.";
  return `
    <section class="policy-section">
      <div class="section-title">
        <h2>GEPA Policy Intervention</h2>
        <span>the repaired run receives privileged replay guidance; the baseline does not</span>
      </div>
      <div class="policy-grid">
        <article class="policy-card">
          <h3>Baseline candidate policy</h3>
          <p class="subtle">This is the old prompt wrapper state for this archived run.</p>
          <details>
            <summary>show baseline candidate policy</summary>
            <pre>${htmlEscape(weakPolicy)}</pre>
          </details>
        </article>
        <article class="policy-card repair">
          <h3>GEPA repair policy</h3>
          <p class="subtle">Exact teacher setup and side-effect examples used as the intervention.</p>
          <details open>
            <summary>show repaired policy script</summary>
            <pre>${htmlEscape(strongPolicy)}</pre>
          </details>
        </article>
      </div>
    </section>`;
}

function renderPolicyActionDelta(weakRun, strongRun, selected) {
  const strongPolicy = strongRun.agentPolicyText || strongRun.candidatePolicyText || "";
  const length = Math.max(weakRun.calls.length, strongRun.calls.length);
  const rows = Array.from({ length }, (_, index) => {
    const weak = weakRun.calls[index] || null;
    const strong = strongRun.calls[index] || null;
    const hits = policyHitLabels(strong, strongPolicy);
    const matchLabel = hits.length
      ? `${hits.length} exact policy match${hits.length === 1 ? "" : "es"}`
      : "no exact policy string match";
    return `
      <article class="action-delta-row">
        <div class="action-index">
          <strong>#${String(index + 1).padStart(2, "0")}</strong>
          <span>${htmlEscape(matchLabel)}</span>
        </div>
        ${renderActionDeltaCell("weak", weak, "", selected.weak)}
        ${renderActionDeltaCell("strong", strong, strongPolicy, selected.strong)}
      </article>`;
  }).join("");
  return `
    <section class="action-delta">
      <div class="section-title">
        <h2>Turn-By-Turn Action Delta</h2>
        <span>action blocks are aligned by model call; logprobs are from the emitted completion tokens</span>
      </div>
      <div class="action-delta-head">
        <span></span>
        <strong>31B baseline actions + logprobs</strong>
        <strong>31B + GEPA actions + logprobs</strong>
      </div>
      <div class="action-delta-list">${rows}</div>
    </section>`;
}

function renderOfficialTokenPanel(runKey, label, run, selectedIndex) {
  const panels = run.calls.map((call) => {
    const summary = officialTokenSummary(call);
    const tokenHtml = call.tokens.map((token, index) => {
      const classes = ["tok", lpClass(token.logprob)];
      const lp = token.logprob === null ? "n/a" : token.logprob.toFixed(4);
      const p = probability(token.logprob);
      const pct = p === null ? "n/a" : `${(p * 100).toFixed(2)}%`;
      const top = topLogprobText(token.topLogprobs);
      const title = `token ${index}\nprob ${pct}\nlogprob ${lp}${top ? `\n\ntop alternatives:\n${top}` : ""}`;
      return `<span class="${classes.join(" ")}" title="${attrEscape(title)}">${htmlEscape(token.token)}</span>`;
    }).join("");
    const toolText = call.toolCalls.length
      ? JSON.stringify(call.toolCalls, null, 2)
      : call.assistantContent || call.reconstructed;
    return `
      <article class="token-call-panel" data-run-panel="${htmlEscape(runKey)}" data-call-panel="${call.index}" ${call.index === selectedIndex ? "" : "hidden"}>
        <div class="token-head">
          <div>
            <h3>${htmlEscape(label)} · call ${call.index + 1}</h3>
            <p>${htmlEscape(summary)}</p>
          </div>
          <span>${htmlEscape(call.finishReason || "")}</span>
        </div>
        <pre class="generated">${htmlEscape(toolText)}</pre>
        <div class="tokens">${tokenHtml || "<span class='empty'>No token logprobs found.</span>"}</div>
      </article>`;
  }).join("");
  return `<section class="token-column">${panels}</section>`;
}

function renderOfficialTurnTimeline(label, run) {
  const assistantTurns = run.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "assistant");
  const rows = assistantTurns.map(({ message, index }, callIndex) => {
    const calls = (message.tool_calls || []).map(normalizeToolCall);
    const content = calls.length
      ? calls.map((call) => `${call.name} ${compactValue(call.arguments, 160)}`).join("\n")
      : compactValue(message.content || "", 220);
    return `
      <article class="timeline-row">
        <strong>turn ${String(index).padStart(2, "0")} · call ${String(callIndex + 1).padStart(2, "0")}</strong>
        <code>${htmlEscape(content || "final answer")}</code>
      </article>`;
  }).join("");
  return `
    <section class="timeline-column">
      <h2>${htmlEscape(label)}</h2>
      <div class="timeline-list">${rows}</div>
    </section>`;
}

function toolCallLabelMap(messages) {
  const labels = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const rawCall of message.tool_calls) {
      const call = normalizeToolCall(rawCall);
      if (call.id) labels.set(call.id, call.name || "tool_call");
    }
  }
  return labels;
}

function renderMessageContent(message) {
  const content = message?.content;
  if (content === null || content === undefined || content === "") return "";
  const parsed = normalizeNestedJson(content);
  if (parsed && typeof parsed === "object") {
    return `
      <div class="message-json-summary">${htmlEscape(responseSummary(parsed))}</div>
      ${renderResultList(parsed)}
      <details class="json-section">
        <summary>full message JSON</summary>
        <pre class="json-pre">${htmlEscape(prettyJson(parsed))}</pre>
      </details>`;
  }
  return `<pre class="message-text">${htmlEscape(String(content))}</pre>`;
}

function renderConversationToolResponse(message, toolLabels) {
  const parsed = normalizeNestedJson(message.content);
  const toolCallId = message.tool_call_id || message.tool_call?.id || "";
  const name = message.name || message.tool_name || toolLabels.get(toolCallId) || "tool response";
  return `
    <div class="conversation-tool-response">
      <div class="response-head">
        <strong>${htmlEscape(name)}</strong>
        <span>${htmlEscape(responseSummary(parsed))}</span>
      </div>
      ${renderResultList(parsed)}
      <details class="json-section">
        <summary>full response JSON${toolCallId ? ` · ${htmlEscape(toolCallId)}` : ""}</summary>
        <pre class="json-pre">${htmlEscape(prettyJson(parsed))}</pre>
      </details>
    </div>`;
}

function renderConversationMessage(message, index, toolLabels) {
  const role = message?.role || "unknown";
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map(normalizeToolCall)
    : [];
  const classes = ["message", `role-${role}`];
  const toolCallHtml = toolCalls.length
    ? `<div class="message-tool-calls">${toolCalls.map(renderParsedToolCall).join("")}</div>`
    : "";
  const body = role === "tool"
    ? renderConversationToolResponse(message, toolLabels)
    : `${renderMessageContent(message)}${toolCallHtml}`;
  return `
    <article class="${classes.join(" ")}">
      <div class="message-head">
        <strong>${String(index).padStart(2, "0")} · ${htmlEscape(role)}</strong>
        <span>${toolCalls.length ? `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <div class="message-body">${body || "<span class=\"parsed-empty\">empty message</span>"}</div>
    </article>`;
}

function renderOfficialConversation(label, run) {
  const toolLabels = toolCallLabelMap(run.messages);
  const counts = run.messages.reduce((acc, message) => {
    const role = message?.role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const countLabel = Object.entries(counts)
    .map(([role, count]) => `${count} ${role}`)
    .join(" · ");
  const messages = run.messages.map((message, index) => renderConversationMessage(message, index, toolLabels)).join("");
  return `
    <section class="conversation-column">
      <div class="column-head">
        <h2>${htmlEscape(label)}</h2>
        <span>${htmlEscape(countLabel || "no messages")}</span>
      </div>
      <div class="conversation-list">${messages || "<p class=\"empty\">No conversation messages found.</p>"}</div>
    </section>`;
}

function renderOfficial(args) {
  const weakRun = readOfficialRun(resolve(args["small-run"]));
  const strongRun = readOfficialRun(resolve(args["large-run"]));
  const selected = defaultOfficialSelection(weakRun, strongRun);
  const systemSnippet = compactValue(weakRun.systemMessage || strongRun.systemMessage || "", 1800);
  const prompt = weakRun.userMessage || strongRun.userMessage;
  const title = weakRun.trajectory.task_id || strongRun.trajectory.task_id || "AutomationBench token logprobs";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Understudy Token-Level GEPA Compare</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f6f2; color: #17191c; }
    main { max-width: 1440px; margin: 0 auto; padding: 22px; }
    header { border-bottom: 1px solid #d8d9d2; margin-bottom: 16px; padding-bottom: 14px; }
    h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: 0; }
    h2 { font-size: 17px; margin: 0; letter-spacing: 0; }
    h3 { font-size: 15px; margin: 0; letter-spacing: 0; }
    p { margin: 0; }
    .subtle { color: #5d646b; font-size: 13px; line-height: 1.45; }
    .prompt { background: #fff; border: 1px solid #d8d9d2; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
    .prompt strong { display: block; font-size: 12px; color: #596067; margin-bottom: 7px; text-transform: uppercase; }
    .prompt p { font-size: 14px; line-height: 1.48; }
    details { margin-top: 12px; color: #4f565e; font-size: 12px; }
    details pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
    .models, .tokens-grid, .timeline-grid, .parsed-grid, .responses-grid, .conversation-grid, .policy-grid, .turn-one-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .model-column, .token-column, .timeline-column, .trace-compare, .parsed-column, .responses-column, .conversation-column, .policy-section, .action-delta, .turn-one-section, .turn-one-column { background: #fff; border: 1px solid #d8d9d2; border-radius: 8px; padding: 13px; min-width: 0; }
    .column-head, .token-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .column-head span, .token-head span, .token-head p { color: #5d646b; font-size: 12px; }
    .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .section-title span { color: #5d646b; font-size: 12px; }
    .run-status { margin-top: 9px; font-size: 12px; font-weight: 700; }
    .run-status.pass { color: #1f7a39; }
    .run-status.fail { color: #b42318; }
    .missed { margin: 10px 0 0; padding: 9px; border-radius: 6px; background: #fff0ee; color: #8a1f16; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .turn-list { display: grid; gap: 9px; margin-top: 12px; }
    .turn-card { width: 100%; text-align: left; border: 1px solid #dedfd9; border-left-width: 5px; border-radius: 8px; padding: 10px; background: #fbfbf8; color: inherit; cursor: pointer; }
    .turn-card.ok { border-left-color: #2da44e; }
    .turn-card.missing { border-left-color: #b9bfc5; }
    .turn-card.active { box-shadow: 0 0 0 2px #0969da inset; background: #f2f7ff; }
    .turn-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
    .turn-head strong { font-size: 13px; }
    .turn-head span { color: #5d646b; font-size: 11px; text-align: right; }
    .call-name { font-weight: 750; font-size: 13px; margin-bottom: 4px; }
    code { display: block; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #4e565f; white-space: normal; overflow-wrap: anywhere; }
    .trace-compare { margin-top: 14px; }
    .trace-head, .trace-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: stretch; }
    .trace-head { color: #5d646b; font-size: 12px; margin-bottom: 7px; padding: 0 8px; }
    .trace-row { width: 100%; text-align: left; color: inherit; background: #fbfbf8; border: 1px solid #dedfd9; border-radius: 8px; padding: 8px; cursor: pointer; }
    .trace-row + .trace-row { margin-top: 8px; }
    .trace-row.active { box-shadow: 0 0 0 2px #0969da inset; background: #f2f7ff; }
    .trace-index { color: #6a737d; font-weight: 750; font-size: 12px; padding-top: 3px; }
    .trace-cell { min-width: 0; border-left: 1px solid #e4e5df; padding-left: 10px; }
    .trace-cell strong { display: block; font-size: 12px; margin-bottom: 3px; }
    .trace-cell span { display: block; color: #5d646b; font-size: 11px; margin-bottom: 5px; }
    .turn-one-section { margin-top: 14px; border-left: 5px solid #0969da; }
    .original-prompt { border: 1px solid #e1e2dc; border-radius: 8px; background: #fbfbf8; padding: 11px; margin-bottom: 12px; }
    .original-prompt strong { display: block; font-size: 12px; color: #596067; text-transform: uppercase; margin-bottom: 6px; }
    .original-prompt p { font-size: 14px; line-height: 1.48; }
    .turn-one-column { background: #fbfbf8; }
    .turn-one-card { border: 1px solid #e1e2dc; border-radius: 8px; background: #fff; padding: 10px; margin-top: 10px; }
    .turn-one-card.active { box-shadow: 0 0 0 2px #0969da inset; background: #f2f7ff; }
    .env-responses { margin-top: 12px; }
    .env-responses h3 { margin-bottom: 8px; }
    .env-response { border: 1px solid #e1e2dc; border-radius: 8px; overflow: hidden; background: #fff; margin-top: 8px; }
    .policy-section, .action-delta { margin-top: 14px; }
    .policy-card { border: 1px solid #e1e2dc; border-radius: 8px; padding: 10px; background: #fbfbf8; }
    .policy-card.repair { border-left: 5px solid #2da44e; }
    .policy-card h3 { margin-bottom: 5px; }
    .policy-card pre { max-height: 340px; overflow: auto; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #2f363d; }
    .action-delta-head, .action-delta-row { display: grid; grid-template-columns: 88px minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: stretch; }
    .action-delta-head { color: #5d646b; font-size: 12px; padding: 0 8px 7px; }
    .action-delta-row { border-top: 1px solid #e4e5df; padding: 10px 0; }
    .action-delta-row:first-child { border-top: 0; padding-top: 0; }
    .action-index strong { display: block; font-size: 13px; margin-bottom: 5px; }
    .action-index span { display: block; color: #5d646b; font-size: 11px; line-height: 1.3; }
    .action-cell { border: 1px solid #e1e2dc; border-radius: 8px; background: #fbfbf8; padding: 9px; min-width: 0; }
    .action-cell.active { box-shadow: 0 0 0 2px #0969da inset; background: #f2f7ff; }
    .action-stats { display: inline-flex; align-items: center; border: 1px solid #d2d5cf; border-radius: 999px; padding: 3px 8px; margin-bottom: 8px; font-size: 11px; font-weight: 750; }
    .action-stats.good { background: #e4f3df; border-color: #a8d89e; }
    .action-stats.warn { background: #fff0bf; border-color: #dfbf56; }
    .action-stats.bad { background: #ffd9d6; border-color: #e79b94; }
    .action-stats.none { background: #eceeeb; border-color: #d2d5cf; }
    .policy-hits { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .policy-hits span { display: inline-flex; border: 1px solid #a8d89e; background: #e4f3df; color: #1f5f32; border-radius: 999px; padding: 2px 7px; font-size: 11px; max-width: 100%; overflow-wrap: anywhere; }
    .action-call { border-top: 1px solid #ecede8; padding-top: 8px; margin-top: 8px; }
    .action-call:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
    .action-call strong { display: block; font-size: 12px; margin-bottom: 5px; }
    .action-call dl { margin: 0; display: grid; gap: 4px; }
    .action-field { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 6px; font-size: 12px; }
    .action-field dt { color: #5d646b; font-weight: 750; overflow-wrap: anywhere; }
    .action-field dd { margin: 0; overflow-wrap: anywhere; }
    .low-token-row { display: flex; flex-wrap: wrap; gap: 5px; border-top: 1px solid #ecede8; padding-top: 8px; margin-top: 8px; }
    .low-token { border: 1px solid #d2d5cf; border-radius: 5px; padding: 2px 5px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .low-token.good { background: #e4f3df; border-color: #a8d89e; }
    .low-token.warn { background: #fff0bf; border-color: #dfbf56; }
    .low-token.bad { background: #ffd9d6; border-color: #e79b94; }
    .low-token.none { background: #eceeeb; border-color: #d2d5cf; }
    .low-token b { font-weight: 750; color: #4e565f; }
    .parsed-grid { margin-top: 14px; }
    .parsed-call-panel { display: block; }
    .parsed-call-panel[hidden] { display: none; }
    .parsed-calls { display: grid; gap: 10px; margin-top: 10px; }
    .parsed-call { border: 1px solid #e1e2dc; border-radius: 8px; overflow: hidden; background: #fbfbf8; }
    .parsed-call-head { background: #eef1ec; border-bottom: 1px solid #e1e2dc; padding: 8px 10px; font-size: 12px; font-weight: 800; }
    .field-list { margin: 0; }
    .field-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); border-bottom: 1px solid #ecede8; }
    .field-row dt { padding: 8px 10px; color: #5d646b; font-size: 12px; font-weight: 750; border-right: 1px solid #ecede8; }
    .field-row dd { margin: 0; padding: 8px 10px; font-size: 13px; overflow-wrap: anywhere; }
    .json-section { border-top: 1px solid #ecede8; }
    .json-section summary { cursor: pointer; padding: 8px 10px; font-size: 12px; font-weight: 750; color: #5d646b; }
    .json-pre { margin: 0; padding: 9px 10px; background: #f7f8f4; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #2f363d; }
    .json-null { color: #8250df; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .json-scalar { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .parsed-empty { padding: 10px; color: #5d646b; font-size: 13px; background: #fbfbf8; border: 1px solid #e1e2dc; border-radius: 8px; overflow-wrap: anywhere; }
    .responses-grid { margin-top: 14px; }
    .responses-panel { display: block; }
    .responses-panel[hidden] { display: none; }
    .responses-list { display: grid; gap: 10px; margin-top: 10px; }
    .response-card { border: 1px solid #e1e2dc; border-radius: 8px; overflow: hidden; background: #fbfbf8; }
    .response-head { padding: 8px 10px; border-bottom: 1px solid #e1e2dc; background: #eef1ec; }
    .response-head strong { display: block; font-size: 12px; margin-bottom: 3px; }
    .response-head span { display: block; color: #4e565f; font-size: 12px; overflow-wrap: anywhere; }
    .result-list { margin: 0; padding: 8px 10px 8px 30px; border-bottom: 1px solid #ecede8; }
    .result-list li { margin: 0 0 7px; font-size: 12px; }
    .result-list li:last-child { margin-bottom: 0; }
    .result-list strong { display: block; margin-bottom: 2px; }
    .result-list span { display: block; color: #5d646b; line-height: 1.35; }
    .result-list .more { color: #5d646b; }
    .conversation-section { margin-top: 14px; }
    .conversation-grid { margin-top: 10px; }
    .conversation-list { display: grid; gap: 10px; margin-top: 12px; }
    .message { border: 1px solid #e1e2dc; border-left-width: 5px; border-radius: 8px; overflow: hidden; background: #fbfbf8; }
    .message.role-system { border-left-color: #6f7782; }
    .message.role-user { border-left-color: #0969da; }
    .message.role-assistant { border-left-color: #8250df; }
    .message.role-tool { border-left-color: #2da44e; }
    .message-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; padding: 8px 10px; background: #eef1ec; border-bottom: 1px solid #e1e2dc; }
    .message-head strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    .message-head span { color: #5d646b; font-size: 11px; text-align: right; }
    .message-body { display: grid; gap: 9px; padding: 10px; }
    .message-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #2f363d; }
    .message-json-summary { color: #2f363d; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
    .message-tool-calls { display: grid; gap: 8px; }
    .conversation-tool-response { border: 1px solid #e1e2dc; border-radius: 8px; overflow: hidden; background: #fff; }
    .tokens-grid { margin-top: 14px; }
    .token-call-panel { display: block; }
    .token-call-panel[hidden] { display: none; }
    .generated { margin: 10px 0; padding: 10px; max-height: 190px; overflow: auto; border-radius: 6px; background: #f7f8f4; border: 1px solid #e2e3dd; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tokens { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 2.15; overflow-wrap: anywhere; }
    .tok { display: inline-block; margin: 1px 2px; padding: 2px 4px; border-radius: 4px; border: 1px solid transparent; }
    .tok.good { background: #e4f3df; border-color: #a8d89e; }
    .tok.warn { background: #fff0bf; border-color: #dfbf56; }
    .tok.bad { background: #ffd9d6; border-color: #e79b94; }
    .tok.none { background: #eceeeb; border-color: #d2d5cf; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; color: #596067; font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .dot { width: 12px; height: 12px; border-radius: 3px; border: 1px solid #bbb; display: inline-block; }
    .dot.good { background: #e4f3df; border-color: #a8d89e; }
    .dot.warn { background: #fff0bf; border-color: #dfbf56; }
    .dot.bad { background: #ffd9d6; border-color: #e79b94; }
    .timeline-grid { margin-top: 14px; }
    .timeline-list { display: grid; gap: 8px; margin-top: 10px; }
    .timeline-row { border-top: 1px solid #e4e5df; padding-top: 8px; }
    .timeline-row strong { display: block; font-size: 12px; margin-bottom: 4px; }
    @media (max-width: 980px) {
      main { padding: 14px; }
      .models, .tokens-grid, .timeline-grid, .parsed-grid, .responses-grid, .conversation-grid, .policy-grid, .turn-one-grid { grid-template-columns: 1fr; }
      .action-delta-head, .action-delta-row { grid-template-columns: 1fr; }
      .trace-head, .trace-row { grid-template-columns: 34px minmax(0, 1fr); }
      .trace-head strong:last-child, .trace-row .trace-cell:last-child { grid-column: 2; }
      .field-row { grid-template-columns: 1fr; }
      .field-row dt { border-right: 0; border-bottom: 1px solid #ecede8; padding-bottom: 4px; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${htmlEscape(title)}</h1>
    <div class="subtle">Same task prompt, same Lilac 31B model family. Left is the original failed replay; right is the GEPA-derived repaired policy replay. Token color is model confidence from completion logprobs; hover a token for probability and top alternatives.</div>
  </header>
  <section class="prompt">
    <strong>Starting user request</strong>
    <p>${htmlEscape(prompt)}</p>
    <details>
      <summary>System and harness policy prefix</summary>
      <pre>${htmlEscape(systemSnippet)}</pre>
    </details>
  </section>
  ${renderTurnOneEnvironment(weakRun, strongRun, prompt)}
  ${renderPolicyIntervention(weakRun, strongRun)}
  ${renderPolicyActionDelta(weakRun, strongRun, selected)}
  <section class="conversation-section" aria-label="Full conversations">
    <div class="section-title">
      <h2>Full Conversations</h2>
      <span>every system, user, assistant, and tool message from trajectories.jsonl</span>
    </div>
    <div class="conversation-grid">
      ${renderOfficialConversation("31B baseline full conversation", weakRun)}
      ${renderOfficialConversation("31B + GEPA policy repair full conversation", strongRun)}
    </div>
  </section>
  ${renderOfficialTraceMatrix(weakRun, strongRun, selected)}
  <section class="models">
    ${renderOfficialRunColumn("weak", "31B baseline", weakRun, selected.weak)}
    ${renderOfficialRunColumn("strong", "31B + GEPA policy repair", strongRun, selected.strong)}
  </section>
  <section class="parsed-grid">
    ${renderParsedCallPanel("weak", "31B baseline", weakRun, selected.weak)}
    ${renderParsedCallPanel("strong", "31B + GEPA policy repair", strongRun, selected.strong)}
  </section>
  <section class="responses-grid">
    ${renderToolResponsesPanel("weak", "31B baseline", weakRun, selected.weak)}
    ${renderToolResponsesPanel("strong", "31B + GEPA policy repair", strongRun, selected.strong)}
  </section>
  <div class="legend">
    <span><i class="dot good"></i> high probability</span>
    <span><i class="dot warn"></i> moderate uncertainty</span>
    <span><i class="dot bad"></i> low probability / surprise token</span>
  </div>
  <section class="tokens-grid">
    ${renderOfficialTokenPanel("weak", "31B baseline", weakRun, selected.weak)}
    ${renderOfficialTokenPanel("strong", "31B + GEPA policy repair", strongRun, selected.strong)}
  </section>
  <section class="timeline-grid">
    ${renderOfficialTurnTimeline("Baseline full replay turns", weakRun)}
    ${renderOfficialTurnTimeline("Repaired full replay turns", strongRun)}
  </section>
</main>
<script>
  const selected = { weak: ${selected.weak}, strong: ${selected.strong} };
  function selectCall(run, call) {
    if (call === '' || call === null || call === undefined) return;
    selected[run] = Number(call);
    document.querySelectorAll('[data-run="' + run + '"]').forEach((card) => {
      card.classList.toggle('active', Number(card.dataset.call) === selected[run]);
    });
    document.querySelectorAll('[data-run-panel="' + run + '"]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.callPanel) !== selected[run];
    });
    document.querySelectorAll('[data-run-human="' + run + '"]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.callHuman) !== selected[run];
    });
    document.querySelectorAll('[data-run-responses="' + run + '"]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.callResponses) !== selected[run];
    });
    document.querySelectorAll('[data-run-delta="' + run + '"]').forEach((cell) => {
      cell.classList.toggle('active', Number(cell.dataset.callDelta) === selected[run]);
    });
    document.querySelectorAll('[data-pair-weak]').forEach((row) => {
      const weakMatch = row.dataset.pairWeak !== '' && Number(row.dataset.pairWeak) === selected.weak;
      const strongMatch = row.dataset.pairStrong !== '' && Number(row.dataset.pairStrong) === selected.strong;
      row.classList.toggle('active', weakMatch || strongMatch);
    });
  }
  function selectPair(row) {
    selectCall('weak', row.dataset.pairWeak);
    selectCall('strong', row.dataset.pairStrong);
  }
  document.querySelectorAll('[data-run]').forEach((card) => {
    card.addEventListener('click', () => selectCall(card.dataset.run, card.dataset.call));
  });
  document.querySelectorAll('[data-pair-weak]').forEach((row) => {
    row.addEventListener('click', () => selectPair(row));
  });
</script>
</body>
</html>`;
}

function render(args) {
  if (
    existsSync(join(resolve(args["small-run"]), "model-call-events.jsonl"))
    && existsSync(join(resolve(args["large-run"]), "model-call-events.jsonl"))
    && !existsSync(join(resolve(args["small-run"]), "rows.jsonl"))
  ) {
    return renderOfficial(args);
  }

  const smallRun = resolve(args["small-run"]);
  const largeRun = resolve(args["large-run"]);
  const smallRows = readRows(smallRun);
  const largeRows = readRows(largeRun);
  const smallSignals = readSignals(smallRun);
  const largeSignals = readSignals(largeRun);
  const pair = chooseRow(smallRows, largeRows, args["input-id"]);
  const smallRunJson = existsSync(join(smallRun, "run.json")) ? readJson(join(smallRun, "run.json")) : {};
  const largeRunJson = existsSync(join(largeRun, "run.json")) ? readJson(join(largeRun, "run.json")) : {};
  const inputContext = readInputManifest(smallRun, smallRunJson);
  const inputRow = inputContext.inputs.get(pair.small.input_id);
  const trajectory = buildTrajectory(
    inputRow,
    fullTrajectoryMessages(inputContext.sourceTrajectory, pair.small.input_id),
    pair.small.input_id,
    pair.small.expected_tool_call || {},
  );
  const smallTaskRows = rowsForTask(smallRows, pair.small.input_id);
  const largeTaskRows = rowsForTask(largeRows, pair.large.input_id);
  const smallActiveTokens = tokenText(smallSignals.get(pair.small.input_id));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Understudy Turn Compare</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #1b1d1f; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { border-bottom: 1px solid #d7d8d2; padding-bottom: 14px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: 0; }
    h2 { font-size: 17px; margin: 0; letter-spacing: 0; }
    .subtle { color: #5f666d; font-size: 13px; line-height: 1.4; }
    .request { background: #fff; border: 1px solid #dadbd5; border-radius: 8px; padding: 14px; margin: 0 0 16px; }
    .request strong { display: block; font-size: 12px; color: #596067; margin-bottom: 6px; }
    .request p { margin: 0; font-size: 14px; line-height: 1.45; }
    .models { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .model-column { background: #fff; border: 1px solid #d6d7d0; border-radius: 8px; padding: 14px; min-width: 0; }
    .turn-list { display: grid; gap: 10px; margin-top: 12px; }
    .turn-card { border: 1px solid #dedfd9; border-left-width: 5px; border-radius: 8px; padding: 10px; background: #fafaf7; }
    .turn-card.ok { border-left-color: #2da44e; }
    .turn-card.miss { border-left-color: #cf222e; }
    .turn-card.missing { border-left-color: #b9bfc5; opacity: .74; }
    .turn-card.active { box-shadow: 0 0 0 2px #1f6feb inset; background: #f3f8ff; }
    .turn-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .turn-head strong { font-size: 13px; }
    .turn-head span { color: #5f666d; font-size: 12px; white-space: nowrap; }
    .call-name { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
    .teacher, .prediction { border-top: 1px solid #e4e5df; padding-top: 8px; margin-top: 8px; }
    .teacher > span, .prediction > span { display: block; color: #687078; font-size: 11px; font-weight: 700; margin-bottom: 4px; text-transform: uppercase; }
    .logprob-window { background: #fff; border: 1px solid #d6d7d0; border-radius: 8px; padding: 14px; margin-top: 16px; }
    .window-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .window-head span { color: #5f666d; font-size: 13px; }
    .tokens { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 2.2; overflow-wrap: anywhere; }
    .tok { display: inline-block; margin: 1px 2px; padding: 2px 4px; border-radius: 4px; border: 1px solid transparent; }
    .tok.good { background: #e4f3df; border-color: #a8d89e; }
    .tok.warn { background: #fff0bf; border-color: #e2c15b; }
    .tok.bad { background: #ffd9d6; border-color: #e79b94; }
    .tok.none { background: #eceeeb; border-color: #d2d5cf; }
    .tok.selected { outline: 3px solid #1f6feb; outline-offset: 2px; }
    code { display: block; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #4f565e; white-space: normal; overflow-wrap: anywhere; }
    .empty { color: #737980; }
    @media (max-width: 980px) {
      .models { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${htmlEscape(taskIdFromInputId(pair.small.input_id))}</h1>
    <div class="subtle">Compared row: ${htmlEscape(pair.small.input_id)}</div>
  </header>
  <section class="request">
    <strong>Starting user request</strong>
    <p>${htmlEscape(trajectory.userMessage)}</p>
  </section>
  <section class="models">
    ${renderSequenceColumn(modelLabel(smallRunJson, smallRun), trajectory.steps, smallTaskRows, smallSignals, pair.small.input_id)}
    ${renderSequenceColumn(modelLabel(largeRunJson, largeRun), trajectory.steps, largeTaskRows, largeSignals, pair.large.input_id)}
  </section>
  ${renderLogprobWindow("Small-model low-confidence window at highlighted turn", smallActiveTokens)}
</main>
</body>
</html>`;
}

const args = parseArgs(process.argv.slice(2));
const output = resolve(args.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, render(args));
console.log(output);
