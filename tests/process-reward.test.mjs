import assert from "node:assert/strict";
import test from "node:test";

import {
  createProcessRewardEpisode,
  DEFAULT_PROCESS_REWARD_CONFIG,
  potential,
} from "../dist/process-reward.js";
import { startEnvService } from "../dist/automationbench-rl-service.js";
import { V2_TASKS, v2SplitSha256 } from "../dist/automationbench-v2.js";

const checker = (state, assertion) => state[assertion.path] === assertion.equals;

function fixture(overrides = {}) {
  return {
    taskId: "process-fixture",
    split: "train",
    band: "multi-write",
    initialState: { first: false, second: false },
    assertions: [
      { kind: "equals", path: "first", equals: true },
      { kind: "equals", path: "second", equals: true },
    ],
    allowedWrites: ["first", "second"],
    oracle: [
      { name: "api_fetch", arguments: { method: "PATCH", url: "/first" } },
      { name: "api_fetch", arguments: { method: "PATCH", url: "/second" } },
    ],
    ...overrides,
  };
}

function runOracle(task = fixture(), config) {
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker, config });
  let before = structuredClone(task.initialState);
  let environment = { forbiddenEffects: [] };
  for (const [index, action] of task.oracle.entries()) {
    const after = structuredClone(before);
    after[index === 0 ? "first" : "second"] = true;
    episode.step(before, action, after, environment, environment);
    before = after;
  }
  return episode.finish({
    finalState: before,
    terminal: 1,
    explicitlyFinished: true,
    truncated: false,
  });
}

test("telescoping progress equals final minus initial potential", () => {
  const task = fixture();
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  let before = structuredClone(task.initialState);
  let environment = { forbiddenEffects: [] };
  for (const [index, action] of task.oracle.entries()) {
    const after = structuredClone(before);
    after[index === 0 ? "first" : "second"] = true;
    episode.step(before, action, after, environment, environment);
    before = after;
  }
  const progress = episode.breakdown.reduce((sum, row) => sum + row.progress, 0);
  assert.equal(
    progress,
    DEFAULT_PROCESS_REWARD_CONFIG.progressWeight *
      (potential(task, before, checker) - potential(task, task.initialState, checker)),
  );
});

test("oracle beats no-op and has positive process reward", () => {
  const oracle = runOracle();
  const noopEpisode = createProcessRewardEpisode({ task: fixture(), assertionChecker: checker });
  const noop = noopEpisode.finish({
    finalState: fixture().initialState,
    terminal: 0,
    explicitlyFinished: true,
    truncated: false,
  });
  assert.ok(oracle.processTotal > 0);
  assert.ok(noop.combined <= 1e-9);
  assert.ok(oracle.combined > noop.combined);
});

test("search spam is capped and net negative", () => {
  const task = fixture({ oracle: [
    { name: "api_search", arguments: { query: "first" } },
    { name: "api_fetch", arguments: { method: "PATCH", url: "/first" } },
  ] });
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  const state = structuredClone(task.initialState);
  const env = { forbiddenEffects: [] };
  for (let i = 0; i < 12; i += 1) {
    episode.step(state, { name: "api_search", arguments: { query: `record-${i}` } }, state, env, env,
      `{"results":[{"id":"record-${i}"}]}`);
  }
  const result = episode.finish({ finalState: state, terminal: 0, explicitlyFinished: false, truncated: true });
  assert.ok(result.breakdown.reduce((sum, row) => sum + row.discovery, 0) <= 0.15);
  assert.ok(result.processTotal < 0);
});

test("forbidden write is penalized at its offending step and remains terminal zero", () => {
  const task = fixture();
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  const before = structuredClone(task.initialState);
  const after = structuredClone(before);
  const row = episode.step(
    before,
    { name: "api_fetch", arguments: { method: "PATCH", url: "/guard" } },
    after,
    { forbiddenEffects: [] },
    { forbiddenEffects: ["guard"] },
  );
  const result = episode.finish({ finalState: after, terminal: 0, explicitlyFinished: true, truncated: false });
  assert.equal(row.stepIndex, 0);
  assert.equal(row.forbidden, -DEFAULT_PROCESS_REWARD_CONFIG.lambdaForbidden);
  assert.equal(result.terminal, 0);
  assert.ok(result.processTotal < 0);
});

test("long adversarial trajectories are clipped", () => {
  const task = fixture();
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  const state = structuredClone(task.initialState);
  const env = { forbiddenEffects: [] };
  for (let i = 0; i < 100; i += 1) {
    episode.step(state, { name: "api_fetch", arguments: { method: "GET", url: `/read/${i}` } }, state, env, env);
  }
  const result = episode.finish({ finalState: state, terminal: 0, explicitlyFinished: false, truncated: true });
  assert.ok(result.processTotal <= DEFAULT_PROCESS_REWARD_CONFIG.kappa);
  assert.ok(result.processTotal >= -DEFAULT_PROCESS_REWARD_CONFIG.kappa);
});

test("default structural gating disables single-step tasks and allowlist excludes named bands", () => {
  const single = fixture({ oracle: [{ name: "api_fetch", arguments: { method: "PATCH", url: "/first" } }] });
  const singleResult = runOracle(single);
  assert.equal(singleResult.processTotal, 0);
  const excluded = runOracle(fixture(), { bands: ["discovery"] });
  assert.equal(excluded.processTotal, 0);
});

test("service default mode preserves terminal-only response shape and values", async () => {
  const { server, port } = await startEnvService();
  try {
    const tasks = await fetch(`http://127.0.0.1:${port}/tasks?split=train`).then((response) => response.json());
    const reset = await fetch(`http://127.0.0.1:${port}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: tasks[0].task_id }),
    }).then((response) => response.json());
    const step = await fetch(`http://127.0.0.1:${port}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        episode_id: reset.episode_id,
        action: { name: "api_search", arguments: { query: "crm" } },
      }),
    }).then((response) => response.json());
    assert.deepEqual(Object.keys(step).sort(), ["done", "observation", "step"]);
    const finish = await fetch(`http://127.0.0.1:${port}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ episode_id: reset.episode_id }),
    }).then((response) => response.json());
    assert.deepEqual(Object.keys(finish).sort(), ["forbidden_effects", "reward", "steps"]);
    assert.equal(finish.reward, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("service opt-in mode returns server-side process breakdown and reproducibility hash", async () => {
  const { server, port } = await startEnvService();
  try {
    const protocol = await fetch(`http://127.0.0.1:${port}/protocol`).then((response) => response.json());
    assert.equal(protocol.process_reward.default_mode, "terminal");
    assert.equal(protocol.process_reward.config_sha256.length, 64);
    const tasks = await fetch(`http://127.0.0.1:${port}/tasks?split=train`).then((response) => response.json());
    const reset = await fetch(`http://127.0.0.1:${port}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: tasks[0].task_id, reward_mode: "terminal+process" }),
    }).then((response) => response.json());
    assert.equal(reset.reward_mode, "terminal+process");
    assert.equal(reset.process_config_sha256.length, 64);
    const step = await fetch(`http://127.0.0.1:${port}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        episode_id: reset.episode_id,
        action: { name: "api_search", arguments: { query: "crm" } },
      }),
    }).then((response) => response.json());
    assert.equal(typeof step.reward, "number");
    assert.equal(typeof step.process_reward.progress, "number");
    const finish = await fetch(`http://127.0.0.1:${port}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ episode_id: reset.episode_id, explicit_finished: true }),
    }).then((response) => response.json());
    assert.equal(typeof finish.terminal_reward, "number");
    assert.equal(typeof finish.process_total, "number");
    assert.equal(typeof finish.combined, "number");
    assert.ok(Array.isArray(finish.process_breakdown));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("online step rewards plus finish reward equal terminal plus clipped process", async () => {
  const { server, port } = await startEnvService();
  try {
    const tasks = await fetch(`http://127.0.0.1:${port}/tasks?split=train`).then((response) => response.json());
    const task = tasks[0];
    const oracleTask = (await import("../dist/automationbench-offline.js")).TASKS.find(
      (candidate) => candidate.taskId === task.task_id,
    );
    const trajectories = [
      {
        actions: oracleTask.oracle,
        finish: { explicit_finished: true },
      },
      {
        actions: Array.from({ length: 12 }, (_, index) => ({
          name: "api_search",
          arguments: { query: `spam-${index}` },
        })),
        finish: { explicit_finished: false, truncated: true },
      },
      {
        actions: [{
          name: "api_fetch",
          arguments: { method: "PATCH", url: "/crm/contacts/c-0", body: { owner: "u-0" } },
        }],
        finish: { explicit_finished: true },
      },
      {
        actions: [],
        finish: { explicit_finished: false, truncated: true },
      },
    ];
    for (const trajectory of trajectories) {
      const reset = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: task.task_id, reward_mode: "terminal+process" }),
      }).then((response) => response.json());
      let streamTotal = 0;
      for (const action of trajectory.actions) {
        const step = await fetch(`http://127.0.0.1:${port}/step`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ episode_id: reset.episode_id, action }),
        }).then((response) => response.json());
        streamTotal += step.reward;
      }
      const finish = await fetch(`http://127.0.0.1:${port}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episode_id: reset.episode_id, ...trajectory.finish }),
      }).then((response) => response.json());
      assert.equal(streamTotal + finish.reward, finish.combined);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v2 hard-family tasks run through both service reward modes and holdout remains hash-gated", async () => {
  const task = V2_TASKS.find((candidate) => candidate.taskId.startsWith("hard-api-churn-cascade-"));
  assert.ok(task);
  const { server, port } = await startEnvService({ benchmark: "automationbench-v2" });
  try {
    const hashes = await fetch(`http://127.0.0.1:${port}/hashes`).then((response) => response.json());
    assert.deepEqual(hashes.counts, { train: 120, dev: 36, holdout: 60 });
    for (const rewardMode of ["terminal", "terminal+process"]) {
      const reset = await fetch(`http://127.0.0.1:${port}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: task.taskId, reward_mode: rewardMode }),
      }).then((response) => response.json());
      assert.ok(reset.episode_id);
      let streamReward = 0;
      for (const action of task.oracle) {
        const step = await fetch(`http://127.0.0.1:${port}/step`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ episode_id: reset.episode_id, action }),
        }).then((response) => response.json());
        assert.equal(typeof step.done, "boolean");
        if (rewardMode === "terminal+process") streamReward += step.reward;
      }
      const finish = await fetch(`http://127.0.0.1:${port}/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episode_id: reset.episode_id, explicit_finished: true }),
      }).then((response) => response.json());
      assert.equal(finish.terminal_reward ?? finish.reward, 1);
      if (rewardMode === "terminal+process") assert.equal(streamReward + finish.reward, finish.combined);
    }
    const holdoutTask = V2_TASKS.find((candidate) => candidate.split === "holdout");
    const refused = await fetch(`http://127.0.0.1:${port}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: holdoutTask.taskId }),
    });
    assert.equal(refused.status, 400);
    const accepted = await fetch(`http://127.0.0.1:${port}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_id: holdoutTask.taskId,
        frozen_holdout_sha256: v2SplitSha256("holdout"),
      }),
    });
    assert.equal(accepted.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
