#!/usr/bin/env node
/**
 * Verifier service for the GRPO rung: the same AutomationBench v2 environment
 * the eval runner scores through, exposed over loopback HTTP so the Tinker
 * trainer (Python) can roll episodes against it.
 *
 * It is deliberately narrow. The service is started for exactly one split and
 * refuses every task outside it, so an RL loop physically cannot roll an
 * episode on dev or on the sealed holdout. Rewards come from the same
 * `partialCredit` terminal scorer used by the eval runner — one verifier, one
 * reward, no second implementation.
 *
 *   node experiments/multi-base-bakeoff/env-service.mjs --split train --port 8200
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { finish, partialCredit, reset, step } from "../../dist/automationbench-offline.js";
import { v2SplitSha256, v2TaskBands, v2TaskPool, v2FixtureSha256 } from "../../dist/automationbench-v2.js";
import { CONTRACT_ID, PARAMS, SYSTEM, contractSha256, parseAction, taskFamily } from "./contract.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const split = argValue("--split", "train");
const port = Number(argValue("--port", "8200"));
const frozenHoldout = argValue("--frozen-holdout");
if (split !== "train") {
  // RL trains on the train split. Anything else has to be an explicit,
  // deliberate act by the operator, not a default.
  if (argValue("--i-know-this-is-not-train") !== "yes") {
    throw new Error(`refusing to serve split=${split} for rollouts: pass --i-know-this-is-not-train yes`);
  }
}
const pool = v2TaskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const allowed = new Map(pool.map((task) => [task.taskId, task]));
const BANDS = v2TaskBands();
const episodes = new Map();

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  (async () => {
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, split, tasks: pool.length });
    if (request.method === "GET" && url.pathname === "/contract") {
      return send(response, 200, {
        contract_id: CONTRACT_ID,
        contract_sha256: contractSha256(),
        system: SYSTEM,
        params: PARAMS,
        fixture_sha256: v2FixtureSha256(),
        split,
        split_sha256: v2SplitSha256(split),
      });
    }
    if (request.method === "GET" && url.pathname === "/tasks") {
      return send(response, 200, pool.map((task) => ({
        task_id: task.taskId,
        split: task.split,
        prompt: task.prompt,
        family: taskFamily(task.taskId),
        band: BANDS[taskFamily(task.taskId)] ?? "unknown",
        tier: task.taskId.startsWith("hard-") ? "hard" : "v1",
      })));
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      const body = await readJson(request);
      const task = allowed.get(String(body.task_id ?? ""));
      if (!task) return send(response, 400, { error: `task is not in the ${split} split: ${body.task_id}` });
      const { handle } = reset(task.taskId);
      const episodeId = randomUUID();
      episodes.set(episodeId, { handle, taskId: task.taskId });
      return send(response, 200, { episode_id: episodeId, task_id: task.taskId, prompt: task.prompt, system: SYSTEM });
    }
    if (request.method === "POST" && url.pathname === "/step") {
      const body = await readJson(request);
      const episode = episodes.get(String(body.episode_id ?? ""));
      if (!episode) return send(response, 404, { error: "unknown episode" });
      const action = body.action;
      if (!action || typeof action !== "object" || Array.isArray(action)) return send(response, 400, { error: "action must be an object" });
      const result = step(episode.handle, { name: action.name, arguments: action.arguments ?? {} });
      return send(response, 200, {
        observation: String(result.obs.messages.at(-1).content).slice(0, PARAMS.observation_char_budget),
        step: result.obs.step,
        done: result.done,
      });
    }
    if (request.method === "POST" && url.pathname === "/act") {
      // One assistant emission, parsed by the contract's own parser so the RL
      // rollout and the eval runner can never drift apart on what counts as a
      // well-formed tool call.
      const body = await readJson(request);
      const episode = episodes.get(String(body.episode_id ?? ""));
      if (!episode) return send(response, 404, { error: "unknown episode" });
      const parsed = parseAction(String(body.text ?? ""));
      if (parsed.finish) return send(response, 200, { kind: "finish", done: true });
      if (parsed.error) {
        return send(response, 200, {
          kind: "rejected",
          done: false,
          reason: parsed.error,
          message: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.`,
        });
      }
      const result = step(episode.handle, parsed.action);
      return send(response, 200, {
        kind: "observation",
        done: result.done,
        step: result.obs.step,
        observation: String(result.obs.messages.at(-1).content).slice(0, PARAMS.observation_char_budget),
      });
    }
    if (request.method === "POST" && url.pathname === "/finish") {
      const body = await readJson(request);
      const episode = episodes.get(String(body.episode_id ?? ""));
      if (!episode) return send(response, 404, { error: "unknown episode" });
      const { handle } = episode;
      const reward = handle.done ? partialCredit(handle) : finish(handle).reward;
      episodes.delete(String(body.episode_id));
      return send(response, 200, {
        reward,
        steps: handle.step,
        forbidden_effects: handle.forbiddenEffects.length,
      });
    }
    return send(response, 404, { error: "not found" });
  })().catch((error) => send(response, 500, { error: String(error?.message ?? error) }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`bakeoff env service on :${port} split=${split} tasks=${pool.length} contract=${contractSha256().slice(0, 12)}`);
});
