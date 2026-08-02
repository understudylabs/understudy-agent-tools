import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  auditObservationLeakage,
  getTask,
  oraclePolicy,
  reset as offlineReset,
  splitSha256,
} from "../dist/automationbench-offline.js";
import {
  ACTION_PROTOCOL_SYSTEM_PROMPT,
  AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT_NEMOTRON_V1,
  parseAgentAction,
  replayOracleTrajectory,
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

describe("parseAgentAction", () => {
  it("accepts clean JSON, fenced JSON, prose-wrapped JSON, and rejects garbage", () => {
    assert.deepEqual(parseAgentAction('{"tool":"api_search","arguments":{"query":"x"}}'), {
      name: "api_search",
      arguments: { query: "x" },
    });
    assert.deepEqual(parseAgentAction('```json\n{"tool":"finish","arguments":{}}\n```'), { finish: true });
    assert.deepEqual(parseAgentAction('Sure — {"tool":"api_fetch","arguments":{"method":"GET","url":"/crm/contacts"}} thanks'), {
      name: "api_fetch",
      arguments: { method: "GET", url: "/crm/contacts" },
    });
    assert.match(String(parseAgentAction("no json").error), /balanced JSON object/);
  });
});

describe("AutomationBench RL service", () => {
  it("keeps the base prompt default and pins the Nemotron prompt variant", async () => {
    const protocol = await json("/protocol");
    assert.equal(protocol.body.system_prompt, ACTION_PROTOCOL_SYSTEM_PROMPT);
    assert.equal(protocol.body.prompt_variant, "default");
    assert.equal(
      AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT_NEMOTRON_V1,
      `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`,
    );
    const nemotronProtocol = await json("/protocol?prompt_variant=nemotron-v1");
    assert.equal(nemotronProtocol.body.system_prompt, AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT_NEMOTRON_V1);
    assert.equal(nemotronProtocol.body.prompt_variant, "nemotron-v1");
  });

  it("supports the generalized synthetic-workflow adapter", async () => {
    const synthetic = await startEnvService({ port: 0, benchmark: "synthetic-workflow" });
    try {
      const response = await fetch(`http://127.0.0.1:${synthetic.port}/health`);
      assert.deepEqual(await response.json(), { ok: true, benchmark: "synthetic-workflow" });
    } finally {
      await new Promise((resolve) => synthetic.server.close(resolve));
    }
  });

  it("refuses holdout listing without the frozen hash and allows it with the hash", async () => {
    const denied = await json("/tasks?split=holdout");
    assert.equal(denied.response.status, 400);
    assert.match(denied.text, /frozen-holdout/i);

    const allowed = await json(`/tasks?split=holdout&frozen_holdout_sha256=${splitSha256("holdout")}`);
    assert.equal(allowed.response.status, 200);
    assert.equal(Array.isArray(allowed.body), true);
    assert.equal(allowed.body.length, 12);
  });

  it("runs an oracle episode over HTTP and scores 1.0", async () => {
    const taskListing = await json("/tasks?split=train");
    assert.equal(taskListing.response.status, 200);
    assert.equal(taskListing.body.length, 48);
    const task = taskListing.body[0];
    const resetResponse = await json("/reset", {
      method: "POST",
      body: JSON.stringify({ task_id: task.task_id }),
    });
    assert.equal(resetResponse.response.status, 200);
    assert.equal(resetResponse.body.system_prompt, ACTION_PROTOCOL_SYSTEM_PROMPT);
    assert.equal(replayOracleTrajectory(task.task_id).reward, 1);
    const policy = oraclePolicy(task.task_id);
    let obs = offlineReset(task.task_id).obs;
    for (;;) {
      const action = policy(obs);
      if (!action) break;
      const stepResponse = await json("/step", {
        method: "POST",
        body: JSON.stringify({ episode_id: resetResponse.body.episode_id, action }),
      });
      assert.equal(stepResponse.response.status, 200);
      assert.equal(typeof stepResponse.body.observation, "string");
      obs = { ...obs, step: stepResponse.body.step };
      if (stepResponse.body.done) break;
    }
    const finish = await json("/finish", {
      method: "POST",
      body: JSON.stringify({ episode_id: resetResponse.body.episode_id }),
    });
    assert.equal(finish.response.status, 200);
    assert.equal(finish.body.reward, 1);
    assert.equal(finish.body.forbidden_effects.length, 0);
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
