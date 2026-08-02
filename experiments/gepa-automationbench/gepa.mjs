import { assertionSatisfied, TASKS, taskPool, splitSha256 } from "../../dist/automationbench-offline.js";
import { rolloutModel } from "./runner.mjs";
import { sha256 } from "./artifacts.mjs";

export const DEFAULT_PROMPT = "You are a careful API agent. Complete the user's request using the available tools. Make only necessary changes, verify results when useful, and emit <finish/> only when the request is complete. Request protocol: emit exactly one JSON tool call inside <tool_call>, like <tool_call>{\"name\":\"api_search\",\"arguments\":{\"query\":\"...\"}}</tool_call>.";

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current == null ? undefined : current[key], value);
}

function actualAssertion(state, assertion) {
  if (assertion.kind === "equals") return readPath(state, assertion.path);
  const collection = readPath(state, assertion.collection);
  const entries = collection && typeof collection === "object" ? Object.values(collection) : [];
  const matches = entries.filter((entry) => Object.entries(assertion.match).every(([key, expected]) => entry?.[key] === expected));
  return { matching_entries: matches };
}

function expectedAssertion(assertion) {
  if (assertion.kind === "equals") return { path: assertion.path, equals: assertion.equals };
  return { [assertion.kind]: { collection: assertion.collection, match: assertion.match } };
}

export function feedback(task, result) {
  const unsatisfied = task.assertions
    .filter((assertion) => !assertionSatisfied(result.finalState, assertion))
    .map((assertion) => ({ expected: expectedAssertion(assertion), actual: actualAssertion(result.finalState, assertion) }));
  return [
    `Task: ${task.prompt}`,
    `Actions taken: ${JSON.stringify(result.actions)}`,
    `Tool responses: ${result.transcript.filter((message) => message.role === "tool").map((message) => message.content).join(" | ")}`,
    `Final reward: ${result.reward}`,
    `Unsatisfied final-state conditions: ${JSON.stringify(unsatisfied)}`,
    `Failure surface: ${JSON.stringify({ parse_failures: result.parseFailures, no_call_turns: result.noCallTurns, step_cap_exhausted: result.stepCapExhausted, premature_finish: result.prematureFinish, multiple_tool_call_turns: result.multipleToolCallTurns })}`,
    `Representative failed assistant turns: ${JSON.stringify(result.failureExamples)}`,
    `Forbidden-effect paths: ${JSON.stringify(result.forbiddenEffects)}`,
  ].join("\n");
}

export function failureModeTally(results) {
  return results.reduce((tally, result) => ({
    parse_failures: tally.parse_failures + result.parseFailures,
    no_call_turns: tally.no_call_turns + result.noCallTurns,
    step_cap_exhaustion: tally.step_cap_exhaustion + Number(result.stepCapExhausted),
    premature_finish: tally.premature_finish + Number(result.prematureFinish),
    forbidden_effects: tally.forbidden_effects + result.forbiddenEffects.length,
    multiple_tool_call_turns: tally.multiple_tool_call_turns + result.multipleToolCallTurns,
  }), { parse_failures: 0, no_call_turns: 0, step_cap_exhaustion: 0, premature_finish: 0, forbidden_effects: 0, multiple_tool_call_turns: 0 });
}

function failureExamples(results, limit = 6) {
  return results.flatMap((result) => result.failureExamples.map((example) => ({ task_id: result.taskId, ...example }))).slice(0, limit);
}

function stringsIn(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsIn(entry, output));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => stringsIn(entry, output));
  return output;
}

const fixturePhrases = [...new Set(TASKS.flatMap((task) => {
  const statePhrases = stringsIn(task.initialState).filter((value) => /\s/.test(value) && value.trim().split(/\s+/).length >= 2);
  const promptPhrases = task.prompt.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|["'][^"']{3,}["'])\b/g) ?? [];
  return [...statePhrases, ...promptPhrases];
}).filter((value) => value.length >= 8))];
const personaNames = [...new Set(TASKS.flatMap((task) => Object.values(task.initialState.crm.contacts).map((contact) => contact.name)))];

export function promptHygieneFindings(prompt) {
  const findings = [];
  if (/\bsimple-api-[a-z0-9-]+\b/i.test(prompt)) findings.push("task id");
  if (/\b(?:c|d|m)-\d+\b/i.test(prompt)) findings.push("fixture record id");
  if (/@example\.test\b/i.test(prompt)) findings.push("fixture address");
  for (const name of personaNames) if (prompt.toLowerCase().includes(name.toLowerCase())) findings.push(`persona name: ${name}`);
  for (const task of TASKS) {
    for (const assertion of task.assertions) {
      const path = assertion.kind === "equals" ? assertion.path : assertion.collection;
      if (prompt.includes(path)) findings.push(`assertion path: ${path}`);
    }
  }
  for (const value of fixturePhrases) if (prompt.toLowerCase().includes(value.toLowerCase())) findings.push(`fixture phrase: ${value}`);
  return [...new Set(findings)];
}

function logHygieneDrop({ generation, attempt, findings }) {
  console.error(JSON.stringify({ event: "prompt_hygiene_drop", generation, attempt, findings }));
}

export async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length || 1) }, worker));
  return results;
}

function trainOrder(train) {
  return [...train].sort((a, b) => sha256(`7:${a.taskId}`).localeCompare(sha256(`7:${b.taskId}`)));
}

export function minibatchForGeneration(train, generation, size) {
  const ordered = trainOrder(train);
  const count = Math.min(size, ordered.length);
  const start = (generation * count) % ordered.length;
  return Array.from({ length: count }, (_, index) => ordered[(start + index) % ordered.length]);
}

function candidate(prompt, generation = 0) {
  return { prompt, prompt_sha256: sha256(prompt), generation, scores: {}, mean: 0, evaluated_tasks: [] };
}

function updateArchive(archive, entry) {
  const existing = archive.get(entry.prompt_sha256);
  if (!existing || entry.evaluated_tasks.length > existing.evaluated_tasks.length || entry.mean > existing.mean) archive.set(entry.prompt_sha256, entry);
}

function paretoArchive(archive) {
  const entries = [...archive.values()];
  return entries.filter((candidateEntry) => !entries.some((other) => {
    if (other === candidateEntry) return false;
    const tasks = new Set([...Object.keys(candidateEntry.scores), ...Object.keys(other.scores)]);
    let strictlyBetter = false;
    for (const task of tasks) {
      const left = other.scores[task] ?? -1;
      const right = candidateEntry.scores[task] ?? -1;
      if (left < right) return false;
      if (left > right) strictlyBetter = true;
    }
    return strictlyBetter;
  }));
}

function selectBest(candidates) {
  return [...candidates].sort((a, b) => b.mean - a.mean || a.prompt_sha256.localeCompare(b.prompt_sha256))[0];
}

export async function optimize({ modelClient, reflectionClient, model, reflectionModel, generations = 1, minibatch = 16, candidatesPerGeneration = 1, maxRollouts = Infinity, store, seedPrompt = DEFAULT_PROMPT, concurrency = 8, maxSteps = 12, maxTokens = 2048, phase = "optimize", usdPerGpuHour = 7, gpuCount = 1, reflectionMaxTokens = 4096 }) {
  const train = taskPool({ split: "train" });
  const archive = new Map();
  const generationFailureModes = [];
  let best = candidate(seedPrompt);
  let rollouts = 0;
  for (let generation = 0; generation < generations; generation += 1) {
    if (rollouts >= maxRollouts) break;
    const batch = minibatchForGeneration(train, generation, minibatch).slice(0, Math.max(0, maxRollouts - rollouts));
    const failures = [];
    const initialResults = await Promise.all(batch.map((task) => rolloutModel({ taskId: task.taskId, prompt: best.prompt, modelClient, model, store, phase, maxSteps, maxTokens, usdPerGpuHour, gpuCount })));
    rollouts += initialResults.length;
    best = { ...best, scores: { ...best.scores, ...Object.fromEntries(initialResults.map((result) => [result.taskId, result.reward])) }, evaluated_tasks: [...new Set([...best.evaluated_tasks, ...batch.map((task) => task.taskId)])], mean: initialResults.reduce((sum, result) => sum + result.reward, 0) / Math.max(1, initialResults.length) };
    const tally = failureModeTally(initialResults);
    generationFailureModes.push({ generation, ...tally });
    for (const [index, result] of initialResults.entries()) if (result.reward < 1) failures.push(feedback(batch[index], result));
    updateArchive(archive, best);
    const live = [best];
    if (failures.length && reflectionClient && rollouts < maxRollouts) {
      for (let index = 0; index < candidatesPerGeneration; index += 1) {
        const messages = [
          { role: "system", content: "You are performing a GEPA reflective rewrite of a general system prompt for an API tool agent. The transcript-level failures below are evidence about the agent's protocol behavior. Rewrite the entire prompt to target the observed failure modes while remaining task-agnostic. Never include task ids, record ids, addresses, persona names, assertion paths, fixture subjects, or fixture context strings. Return only a full replacement system prompt." },
          { role: "user", content: `Current system prompt:\n${best.prompt}\n\nFailure-mode tally for this minibatch:\n${JSON.stringify(tally)}\n\nRepresentative failure traces:\n${JSON.stringify(failureExamples(initialResults))}\n\nDetailed grader feedback:\n${failures.join("\n\n")}\n\nProduce a full replacement prompt. Candidate ${index + 1} should take a distinct approach to the failure modes.` },
        ];
        let proposal;
        for (let attempt = 0; attempt < 3 && !proposal; attempt += 1) {
          const retryNote = attempt === 0 ? [] : [{ role: "user", content: "The previous proposal was rejected (fixture-specific details, empty, or cut off mid-prompt). Return a complete, self-contained, task-agnostic replacement prompt that ends cleanly." }];
          const response = await reflectionClient.chat([...messages, ...retryNote], { model: reflectionModel, temperature: 0.8, maxTokens: reflectionMaxTokens });
          const text = response.message?.content?.trim();
          const truncated = response.finishReason === "length";
          const findings = text ? promptHygieneFindings(text) : ["empty proposal"];
          if (truncated) findings.push("truncated proposal (finish_reason=length)");
          if (text && findings.length === 0) proposal = text;
          else logHygieneDrop({ generation, attempt: attempt + 1, findings });
        }
        if (proposal) live.push(candidate(proposal, generation));
      }
    }
    const evaluated = await Promise.all(live.slice(1).map(async (entry) => {
      const remaining = Math.max(0, maxRollouts - rollouts);
      const results = await Promise.all(batch.slice(0, remaining).map((task) => rolloutModel({ taskId: task.taskId, prompt: entry.prompt, modelClient, model, store, phase, maxSteps, maxTokens, usdPerGpuHour, gpuCount })));
      rollouts += results.length;
      return { ...entry, scores: { ...entry.scores, ...Object.fromEntries(results.map((result) => [result.taskId, result.reward])) }, evaluated_tasks: [...new Set([...entry.evaluated_tasks, ...batch.map((task) => task.taskId)])], mean: results.reduce((sum, result) => sum + result.reward, 0) / Math.max(1, results.length) };
    }));
    for (const entry of evaluated) updateArchive(archive, entry);
    best = selectBest([best, ...evaluated]);
    if (rollouts >= maxRollouts) break;
  }
  const pareto = paretoArchive(archive);
  return { best, archive: [...archive.values()], pareto_archive: pareto, train_split_sha256: splitSha256("train"), rollouts, failure_modes: generationFailureModes };
}

export async function selectDev({ archive, modelClient, model, store, concurrency = 8, maxSteps = 12, maxTokens = 2048, phase = "dev-selection", usdPerGpuHour = 7, gpuCount = 1 }) {
  const dev = taskPool({ split: "dev" });
  const scored = await Promise.all(archive.map(async (entry) => {
    const results = await Promise.all(dev.map((task) => rolloutModel({ taskId: task.taskId, prompt: entry.prompt, modelClient, model, store, phase, maxSteps, maxTokens, usdPerGpuHour, gpuCount })));
    return {
      ...entry,
      dev_mean: results.reduce((sum, result) => sum + result.reward, 0) / results.length,
      dev_scores: Object.fromEntries(results.map((result) => [result.taskId, result.reward])),
      eval_rows: store?.evalRows({ runId: `dev-selection-${entry.prompt_sha256.slice(0, 12)}`, model, split: "dev", results }) ?? [],
    };
  }));
  return scored.sort((a, b) => b.dev_mean - a.dev_mean || a.prompt_sha256.localeCompare(b.prompt_sha256));
}
