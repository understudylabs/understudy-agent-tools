import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SYSTEM,
  actionSignature,
  divergenceIndex,
  minePairsForTask,
} from "../experiments/workload-automation/scripts/mine-near-hit-pairs.mjs";

/** Pull the same literal out of the scorer so the two can never drift apart. */
function scorerSystemPrompt() {
  const source = readFileSync("scripts/automationbench-v2-zeroshot.mjs", "utf8");
  const match = source.match(/const SYSTEM = \[([\s\S]*?)\]\.join\("\\n"\);/);
  assert.ok(match, "scorer no longer declares SYSTEM as a joined array");
  return new Function(`return [${match[1]}].join("\\n");`)();
}

const turn = (text) => ({ prefix: [{ role: "user", content: "p" }], text, signature: actionSignature(text) });
const call = (method, url, body) => JSON.stringify({ tool: "api_fetch", arguments: { method, url, body } });
const search = (query) => JSON.stringify({ tool: "api_search", arguments: { query } });

test("mined pairs are trained on exactly the prompt the scorer serves", () => {
  assert.equal(SYSTEM, scorerSystemPrompt());
});

test("action signature ignores wording and argument order, not effects", () => {
  assert.equal(
    actionSignature(`thinking out loud ${call("POST", "/crm/deals/d-1", { stage: "won", owner: "rae" })}`),
    actionSignature(call("post", "/crm/deals/d-1", { owner: "rae", stage: "won" })),
  );
  assert.notEqual(actionSignature(call("POST", "/crm/deals/d-1", { stage: "won" })), actionSignature(call("POST", "/crm/deals/d-2", { stage: "won" })));
  assert.equal(actionSignature("I will now update the deal."), "malformed");
  assert.equal(actionSignature(JSON.stringify({ tool: "finish", arguments: {} })), "finish");
});

test("divergence is the first differing action, -1 when one run is a prefix", () => {
  const winner = [turn(search("crm")), turn(call("POST", "/crm/deals/d-1", { stage: "won" }))];
  assert.equal(divergenceIndex(winner, [turn(search("crm")), turn(call("POST", "/crm/deals/d-2", { stage: "won" }))]), 1);
  assert.equal(divergenceIndex(winner, [turn(search("crm"))]), -1);
});

test("a pair is emitted only where the two turns took different actions", () => {
  const chosen = { score: 1, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-1", { stage: "won" }))] };
  // Same action, different prose: cosmetic, and must not become a preference.
  const cosmetic = {
    score: 0,
    forbidden_effects: 0,
    turns: [turn(`sure — ${search("crm")}`), turn(`let me do it: ${call("POST", "/crm/deals/d-1", { stage: "won" })}`)],
  };
  assert.deepEqual(minePairsForTask({ taskId: "t", family: "f", band: "b", rollouts: [chosen, cosmetic] }), []);

  const wrongRecord = { score: 0, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-2", { stage: "won" }))] };
  const pairs = minePairsForTask({ taskId: "t", family: "f", band: "b", rollouts: [chosen, wrongRecord] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].metadata.divergence_turn, 1);
  assert.equal(pairs[0].chosen[0].content, chosen.turns[1].text);
  assert.equal(pairs[0].rejected[0].content, wrongRecord.turns[1].text);
});

test("no winner, no pairs — and a full-credit over-action is never the winner", () => {
  const overActing = { score: 1, forbidden_effects: 2, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-9", {}))] };
  const missed = { score: 0, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-2", {}))] };
  assert.deepEqual(minePairsForTask({ taskId: "t", family: "f", band: "b", rollouts: [overActing, missed] }), []);
});

test("over-actions outrank plain misses and collapses are dropped", () => {
  const chosen = { score: 1, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-1", { stage: "won" }))] };
  const overActing = { score: 0, forbidden_effects: 1, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-8", { stage: "won" }))] };
  const plainMiss = { score: 0, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-2", { stage: "won" }))] };
  const collapse = { score: 0, forbidden_effects: 0, turns: [turn("no idea"), turn("still thinking")] };
  const pairs = minePairsForTask({
    taskId: "t",
    family: "f",
    band: "b",
    rollouts: [chosen, plainMiss, overActing, collapse],
    maxPairs: 3,
  });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].metadata.rejected_forbidden_effects, 1);
  assert.ok(pairs.every((pair) => pair.metadata.rejected_action !== "malformed"));
});

test("malformed rejections are capped so the file cannot become a formatting lesson", () => {
  const chosen = { score: 1, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-1", {}))] };
  const rollouts = [chosen];
  for (const text of ["nope", "hmm", "well"]) {
    rollouts.push({ score: 0, forbidden_effects: 0, turns: [turn(search("crm")), turn(text), turn(call("GET", "/crm/deals", null))] });
  }
  const pairs = minePairsForTask({ taskId: "t", family: "f", band: "b", rollouts, maxPairs: 5, maxMalformed: 1 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].metadata.rejected_action, "malformed");
});

test("a pair carries its fixture task id and the winner's own prefix", () => {
  const chosen = { score: 1, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-1", {}))] };
  const missed = { score: 0, forbidden_effects: 0, turns: [turn(search("crm")), turn(call("POST", "/crm/deals/d-2", {}))] };
  const [pair] = minePairsForTask({ taskId: "simple-api-crm-close-01", family: "crm-close", band: "single-write", rollouts: [chosen, missed] });
  assert.equal(pair.task_id, "simple-api-crm-close-01");
  assert.equal(pair.prompt_conversation, chosen.turns[1].prefix);
});
