import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  auditObservationLeakage,
  getTask,
  reset as offlineReset,
} from "../dist/automationbench-offline.js";
import {
  AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT,
  ACTION_PROTOCOL_SYSTEM_PROMPT,
  startEnvService,
} from "../dist/automationbench-rl-service.js";

let server;
let baseUrl;

beforeEach(async () => {
  const started = await startEnvService({ port: 0 });
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    baseUrl = undefined;
  }
});

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null };
}

describe("AutomationBench RL service", () => {
  it("runs an AutomationBench episode over HTTP", async () => {
    const taskListing = await json("/tasks?split=train");
    assert.equal(taskListing.response.status, 200);
    assert.equal(taskListing.body.length, 48);
    const task = taskListing.body[0];
    const resetResponse = await json("/reset", {
      method: "POST",
      body: JSON.stringify({ task_id: task.task_id }),
    });
    assert.equal(resetResponse.response.status, 200);
    assert.equal(resetResponse.body.system_prompt, AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT);
    const stepResponse = await json("/step", {
      method: "POST",
      body: JSON.stringify({
        episode_id: resetResponse.body.episode_id,
        action: { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts", body: {} } },
      }),
    });
    assert.equal(stepResponse.response.status, 200);
    assert.equal(typeof stepResponse.body.observation, "string");
    const finish = await json("/finish", {
      method: "POST",
      body: JSON.stringify({ episode_id: resetResponse.body.episode_id }),
    });
    assert.equal(finish.response.status, 200);
    assert.equal(typeof finish.body.reward, "number");
    assert.equal(finish.body.forbidden_effects.length, 0);
  });

  it("serves benchmark-specific system prompts", async () => {
    const automationProtocol = await json("/protocol");
    assert.equal(automationProtocol.body.system_prompt, AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT);
    assert.ok(automationProtocol.body.system_prompt.includes("Endpoints: /crm/contacts"));
    assert.ok(automationProtocol.body.system_prompt.includes("Each tool result is returned to you as JSON"));

    const synthetic = await startEnvService({ port: 0, benchmark: "synthetic-workflow" });
    const syntheticBaseUrl = `http://127.0.0.1:${synthetic.port}`;
    try {
      const syntheticProtocolResponse = await fetch(`${syntheticBaseUrl}/protocol`);
      const syntheticProtocol = await syntheticProtocolResponse.json();
      assert.equal(syntheticProtocol.system_prompt, ACTION_PROTOCOL_SYSTEM_PROMPT);
      assert.notEqual(syntheticProtocol.system_prompt, automationProtocol.body.system_prompt);

      const resetResponse = await fetch(`${syntheticBaseUrl}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: "workflow-route-01" }),
      });
      const reset = await resetResponse.json();
      assert.equal(reset.system_prompt, ACTION_PROTOCOL_SYSTEM_PROMPT);
    } finally {
      await new Promise((resolve) => synthetic.server.close(resolve));
    }
  });

  it("keeps task listings and observations free of grader leakage strings", async () => {
    const tasks = await json("/tasks?split=train");
    const taskPayload = JSON.stringify(tasks.body);
    for (const forbidden of ["assertions", "oracle", "allowedWrites"]) {
      assert.doesNotMatch(taskPayload, new RegExp(forbidden));
    }

    const task = tasks.body[0];
    const resetResponse = await json("/reset", {
      method: "POST",
      body: JSON.stringify({ task_id: task.task_id }),
    });
    assert.deepEqual(auditObservationLeakage(offlineReset(task.task_id).obs, getTask(task.task_id)), []);
    const observationPayload = JSON.stringify(resetResponse.body);
    for (const forbidden of ["assertions", "oracle", "allowedWrites"]) {
      assert.doesNotMatch(observationPayload, new RegExp(forbidden));
    }
  });
});
