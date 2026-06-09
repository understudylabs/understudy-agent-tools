#!/usr/bin/env node

// Token-logprob comparison lens for two same-family eval runs on the same row.
// See ../references/logprob-lens.md for the artifact contract this expects:
// rows.jsonl, run.json, and optional private/training-signals/*.json sidecars.

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

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lpClass(logprob) {
  if (logprob === null) return "none";
  if (logprob <= -2) return "bad";
  if (logprob <= -0.75) return "warn";
  return "good";
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

function render(args) {
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
