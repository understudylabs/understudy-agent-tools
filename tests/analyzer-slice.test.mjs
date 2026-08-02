import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANALYZER_SEVERITIES,
  ANALYZER_SIGNALS,
  ANALYZER_STATUSES,
  ANALYZER_TASKS,
  analyzerFixtureSha256,
  analyzerSplitSha256,
  analyzerTaskBands,
  analyzerTaskPool,
  constantPolicy,
  nullPolicy,
  oraclePolicy,
  scoreVerdict,
  sentinelPolicy,
} from "../dist/analyzer-slice.js";

const counts = ANALYZER_TASKS.reduce((result, task) => {
  result[task.split] += 1;
  return result;
}, { train: 0, dev: 0, holdout: 0 });

describe("analyzer slice", () => {
  it("has the requested split counts and family bands", () => {
    assert.deepEqual(counts, { train: 54, dev: 18, holdout: 36 });
    assert.deepEqual(analyzerTaskBands(), {
      "owner-unresponsive": "single-signal",
      "dependency-stalled": "single-signal",
      "budget-exceeded": "single-signal",
      "recency-conflict": "conflicting-signals",
      "severity-conflict": "conflicting-signals",
      "superseded-record": "conflicting-signals",
      "unrelated-chatter": "insufficient-evidence",
      "truncated-record": "insufficient-evidence",
      "ambiguous-owner": "insufficient-evidence",
    });
  });

  it("scores oracle, sentinel, and null policies correctly", () => {
    for (const task of ANALYZER_TASKS) {
      assert.equal(scoreVerdict(task, oraclePolicy(task.taskId)(task)).score, 1, task.taskId);
      const sentinel = scoreVerdict(task, sentinelPolicy()(task));
      assert.equal(sentinel.score, 0, task.taskId);
      assert.deepEqual(sentinel.forbidden, ["over_claim"], task.taskId);
      assert.ok(task.evidence.some((item) => item.id === JSON.parse(sentinelPolicy()(task)).citations[0]));
      assert.equal(scoreVerdict(task, nullPolicy()(task)).score, 0, task.taskId);
    }
  });

  it("zeroes over-claims and hallucinated citations", () => {
    const task = ANALYZER_TASKS.find((candidate) => candidate.family === "owner-unresponsive");
    assert.ok(task);
    const perfect = JSON.stringify(task.gold);
    const overClaim = JSON.stringify({ ...task.gold, citations: [...task.gold.citations, "ev-02"] });
    const hallucinated = JSON.stringify({ ...task.gold, citations: ["ev-99"] });
    assert.equal(scoreVerdict(task, perfect).score, 1);
    assert.deepEqual(scoreVerdict(task, overClaim).forbidden, ["over_claim"]);
    assert.deepEqual(scoreVerdict(task, hallucinated).forbidden, ["hallucinated_citation"]);
  });

  it("rejects invalid key sets and preserves the quarter-step score lattice", () => {
    const task = ANALYZER_TASKS[0];
    assert.equal(scoreVerdict(task, JSON.stringify({ ...task.gold, extra: true })).score, 0);
    const variants = [
      task.gold,
      { ...task.gold, status: "on_track" },
      { ...task.gold, status: "on_track", severity: "none" },
      { ...task.gold, status: "on_track", severity: "none", primary_signal: "no_signal" },
      { ...task.gold, status: "on_track", severity: "none", primary_signal: "no_signal", citations: ["ev-01"] },
      { ...task.gold, citations: ["ev-99"] },
    ];
    const scores = variants.map((variant) => scoreVerdict(task, JSON.stringify(variant)).score);
    assert.deepEqual([...new Set(scores)].sort((a, b) => a - b), [0, 0.25, 0.5, 0.75, 1]);
  });

  it("keeps evidence free of verdict, family, and band vocabulary", () => {
    const vocabulary = [...ANALYZER_STATUSES, ...ANALYZER_SEVERITIES, ...ANALYZER_SIGNALS];
    const bands = analyzerTaskBands();
    const compact = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const words = (value) => `_${value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_`;
    let upperHalf = 0;
    for (const task of ANALYZER_TASKS) {
      const text = task.evidence.map((item) => item.text).join("\n");
      for (const token of vocabulary) assert.equal(words(text).includes(`_${words(token).slice(1, -1)}_`), false, `${task.taskId} leaks ${token}`);
      for (const [family, band] of Object.entries(bands)) {
        assert.equal(compact(text).includes(compact(family)), false, `${task.taskId} leaks ${family}`);
        assert.equal(compact(text).includes(compact(band)), false, `${task.taskId} leaks ${band}`);
      }
      for (const citation of task.gold.citations) {
        const index = task.evidence.findIndex((item) => item.id === citation);
        assert.ok(index >= 0);
        if (index >= Math.ceil(task.evidence.length / 2)) upperHalf += 1;
      }
    }
    assert.ok(upperHalf / ANALYZER_TASKS.length >= 0.3);
  });

  it("uses one shared prompt instruction with only the workstream name varying", () => {
    const normalized = new Set(ANALYZER_TASKS.map((task) => task.prompt.replace(/for the [A-Za-z]+ workstream/, "for the {workstream} workstream")));
    assert.equal(normalized.size, 1);
    assert.match(ANALYZER_TASKS[0].prompt, /on_track/);
    assert.match(ANALYZER_TASKS[0].prompt, /most recent dated item supersedes earlier ones/);
    assert.match(ANALYZER_TASKS[0].prompt, /replacement record supersedes/);
  });

  it("keeps the dominant gold triple below the concentration threshold", () => {
    const counts = new Map();
    for (const task of ANALYZER_TASKS) {
      const triple = JSON.stringify([task.gold.status, task.gold.severity, task.gold.primary_signal]);
      counts.set(triple, (counts.get(triple) ?? 0) + 1);
    }
    const dominant = Math.max(...counts.values()) / ANALYZER_TASKS.length;
    assert.ok(dominant <= 0.4);
  });

  it("keeps conflict evidence separate and gives the conflict families distinct golds", () => {
    const recency = ANALYZER_TASKS.find((task) => task.family === "recency-conflict");
    const severity = ANALYZER_TASKS.find((task) => task.family === "severity-conflict");
    const superseded = ANALYZER_TASKS.find((task) => task.family === "superseded-record");
    assert.ok(recency && severity && superseded);
    for (const task of [recency, severity, superseded]) {
      assert.equal(task.gold.citations.length, 2);
      const indexes = task.gold.citations.map((citation) => task.evidence.findIndex((item) => item.id === citation));
      assert.ok(Math.abs(indexes[1] - indexes[0]) >= Math.floor(task.evidence.length / 2));
    }
    assert.notDeepEqual(recency.gold, superseded.gold);
    assert.equal(recency.gold.status, "on_track");
    assert.equal(superseded.gold.primary_signal, "scope_expanded");
    for (const task of [recency, severity, superseded]) {
      const workstream = /for the ([A-Za-z]+) workstream/.exec(task.prompt)[1];
      const dates = task.gold.citations.map((citation) => {
        const item = task.evidence.find((candidate) => candidate.id === citation);
        assert.match(item.text, new RegExp(workstream));
        return Date.parse(/([A-Z][a-z]+ \d{1,2}, 2026)/.exec(item.text)[1]);
      });
      assert.ok(dates[1] > dates[0]);
    }
  });

  it("is deterministic and refuses unapproved holdout reads", () => {
    assert.equal(analyzerFixtureSha256(), analyzerFixtureSha256());
    assert.equal(analyzerSplitSha256("train"), analyzerSplitSha256("train"));
    assert.throws(() => analyzerTaskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => analyzerTaskPool({ split: "holdout", frozenHoldoutSha256: "wrong" }), /frozen-holdout refusal/);
    const holdout = analyzerTaskPool({ split: "holdout", frozenHoldoutSha256: analyzerSplitSha256("holdout") });
    assert.equal(holdout.length, 36);
  });

  it("supports fenced JSON and closed vocabularies", () => {
    const task = ANALYZER_TASKS[0];
    const fenced = `\`\`\`json\n${JSON.stringify(task.gold)}\n\`\`\``;
    assert.equal(scoreVerdict(task, fenced).score, 1);
    assert.equal(scoreVerdict(task, JSON.stringify({ ...task.gold, status: "unknown" })).score, 0);
    assert.equal(scoreVerdict(task, JSON.stringify({ ...task.gold, severity: "critical" })).score, 0);
    assert.equal(scoreVerdict(task, JSON.stringify({ ...task.gold, primary_signal: "unknown" })).score, 0);
    assert.equal(scoreVerdict(task, JSON.stringify({ ...task.gold, citations: ["ev-01", 3] })).score, 0);
  });

  it("extracts the last balanced JSON object while preserving format diagnostics", () => {
    const task = ANALYZER_TASKS[0];
    const wrapped = `The answer is:\n${JSON.stringify(task.gold)}\nEnd of answer.`;
    const extracted = scoreVerdict(task, wrapped);
    assert.equal(extracted.score, 1);
    assert.equal(extracted.flags.preamble_stripped, true);
    assert.equal(extracted.flags.strict_format, false);
    const invalidVocabulary = scoreVerdict(task, `The answer is ${JSON.stringify({ ...task.gold, status: "completed" })}`);
    assert.equal(invalidVocabulary.score, 0);
    assert.deepEqual(invalidVocabulary.forbidden, ["invalid_output"]);
    assert.equal(invalidVocabulary.flags.preamble_stripped, true);
    assert.equal(scoreVerdict(task, "No JSON answer was returned.").score, 0);
  });

  it("exposes the closed vocabularies", () => {
    assert.deepEqual(ANALYZER_STATUSES, ["on_track", "at_risk", "blocked", "insufficient_evidence"]);
    assert.deepEqual(ANALYZER_SEVERITIES, ["none", "low", "medium", "high"]);
    assert.deepEqual(ANALYZER_SIGNALS, [
      "no_signal",
      "owner_unresponsive",
      "scope_expanded",
      "dependency_stalled",
      "budget_exceeded",
      "approval_pending",
      "data_conflict",
    ]);
  });

  it("can construct constant verdict policies", () => {
    const task = ANALYZER_TASKS[0];
    const verdict = { status: "on_track", severity: "none", primary_signal: "no_signal", citations: [] };
    assert.equal(typeof constantPolicy(verdict)(task), "string");
  });
});
