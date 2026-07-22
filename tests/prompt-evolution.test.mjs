import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  PROMPT_EVOLUTION_SCHEMA,
  appendEvolutionRecord,
  buildProposalPrompt,
  classifyRejection,
  collectArmEvidence,
  evolutionArmLabel,
  evolvePrompts,
  extractRejectionError,
  journalRejections,
  loadTaskContracts,
  meanScore,
  pairedVerdict,
  parseProposedSuffixes,
  queueEvolutionRun,
  readEvolutionRecords,
  waitForRun,
} from "../dist/prompt-evolution.js";
import { promptSuffixHash, readRunRequest, runRequestPath, writeRunRequest } from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** Minimal promoted benchmark dir with frozen train/dev/holdout splits + contract sidecars. */
function makeBenchmarkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-evo-"));
  roots.push(dir);
  const tasks = [
    { task_id: "tr1", split: "train" },
    { task_id: "tr2", split: "train" },
    { task_id: "dv1", split: "dev" },
    { task_id: "ho1", split: "holdout" },
    { task_id: "ho2", split: "holdout" },
  ];
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "evo-bench",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: tasks.map((t) => ({ ...t, category_id: "cat-a", genesis: "replayed" })),
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
    }),
  );
  const sidecar = tasks.map((t) => ({
    schema_version: "understudy.benchmark_task.v1",
    task_id: t.task_id,
    outcome_contract: {
      required: [
        { type: "state_effect", tool: "update-record", observed_arguments: { id: "r1" } },
        { type: "response_obligation", kind: "json_parses" },
      ],
      preserved: [],
      forbidden: [],
      grading: "final_state_and_obligations",
    },
  }));
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), sidecar.map((t) => JSON.stringify(t)).join("\n") + "\n");
  return dir;
}

describe("rejection classification", () => {
  it("classifies the generated world's _validate error strings", () => {
    assert.equal(classifyRejection("unknown tool 'foo'"), "unknown_tool");
    assert.equal(classifyRejection("missing required field 'id'"), "missing_required_field");
    assert.equal(classifyRejection("missing field 'meta.user' — required by observed usage (9/9 calls)"), "missing_by_observation");
    assert.equal(classifyRejection("field 'count' must be integer"), "type_mismatch");
    assert.equal(classifyRejection('field \'status\' must be one of ["open"] — required by observed usage'), "enum_by_observation");
    assert.equal(classifyRejection("network exploded"), "other");
  });

  it("extracts errors from all three rejection reply styles", () => {
    assert.equal(extractRejectionError('ERROR: missing required field \'id\''), "missing required field 'id'");
    assert.equal(extractRejectionError('{"success": false, "error": "field \'x\' must be string"}'), "field 'x' must be string");
    assert.equal(extractRejectionError('{"ok": false, "error": "unknown tool \'z\'"}'), "unknown tool 'z'");
    assert.equal(extractRejectionError('{"ok": true}'), null);
    assert.equal(extractRejectionError(undefined), null);
  });

  it("counts per-class rejections from a live journal", () => {
    const journal = [
      { kind: "call", tool: "update-record", status: "ok", arguments: "{}" },
      { kind: "result", tool: "update-record", status: "ok", content: '{"ok": true}' },
      { kind: "call", tool: "update-record", status: "error", arguments: "{}" },
      { kind: "result", tool: "update-record", status: "error", content: '{"ok": false, "error": "missing required field \'id\'"}' },
      { kind: "call", tool: "close-ticket", status: "error", arguments: "{}" },
      { kind: "result", tool: "close-ticket", status: "error", content: "ERROR: field 'status' must be one of [\"open\"] — required by observed usage" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const evidence = journalRejections(journal);
    assert.equal(evidence.calls, 3);
    assert.equal(evidence.rejected, 2);
    assert.deepEqual(evidence.by_class, { missing_required_field: 1, enum_by_observation: 1 });
    assert.equal(evidence.examples.length, 2);
    assert.match(evidence.examples[0], /update-record: missing required field/);
  });
});

describe("proposal prompt construction", () => {
  it("builds the authoring prompt from fixture journals + contracts and asks for strict JSON", () => {
    const dir = makeBenchmarkDir();
    const contracts = loadTaskContracts(dir);
    const rows = [
      { run_id: "r", task_id: "tr1", status: "ok", score: 0, model: "m" },
      { run_id: "r", task_id: "tr2", status: "ok", score: 1, model: "m" },
    ];
    const journal = JSON.stringify({ kind: "call", tool: "update-record", status: "error" }) + "\n" + JSON.stringify({ kind: "result", tool: "update-record", status: "error", content: 'ERROR: missing required field \'id\'' }) + "\n";
    const evidence = collectArmEvidence("m", rows, journal, contracts);
    assert.equal(evidence.mean_score, 0.5);
    assert.equal(evidence.failed_tasks.length, 1);
    assert.equal(evidence.failed_tasks[0].task_id, "tr1");
    assert.match(evidence.failed_tasks[0].required.join(" "), /state_effect\(update-record\)/);
    assert.match(evidence.failed_tasks[0].required.join(" "), /response_obligation\(json_parses\)/);

    const messages = buildProposalPrompt({
      benchmarkId: "evo-bench",
      baseModel: "m",
      generation: 1,
      variants: 3,
      bare: evidence,
      population: [{ arm_label: "m+evo-g1v1", system_prompt_suffix: "Always include ids.", mean_score: 0.6 }],
      evidence: [],
    });
    assert.equal(messages.length, 2);
    const prompt = messages[1].content;
    assert.match(prompt, /missing_required_field=1/);
    assert.match(prompt, /tr1 \(score 0\.00\)/);
    assert.match(prompt, /Always include ids\./);
    assert.match(prompt, /exactly 3 NEW system-prompt suffixes/);
    assert.match(prompt, /JSON array of 3 objects/);
  });

  it("parses proposals from noisy replies, dedupes, and caps at the requested count", () => {
    const reply = 'Sure! Here you go:\n[{"system_prompt_suffix": "A"}, {"system_prompt_suffix": "A"}, "B", {"system_prompt_suffix": "C"}, {"system_prompt_suffix": "D"}]';
    assert.deepEqual(parseProposedSuffixes(reply, 3), ["A", "B", "C"]);
    assert.deepEqual(parseProposedSuffixes("no json here", 3), []);
    assert.deepEqual(parseProposedSuffixes('{"not": "an array"}', 3), []);
  });
});

describe("queueing + split sealing", () => {
  it("queues a train run with override arms through the shared createRunRequest", () => {
    const dir = makeBenchmarkDir();
    const run = queueEvolutionRun(dir, {
      baseModel: "m",
      split: "train",
      overrides: [{ arm_label: evolutionArmLabel("m", 1, 1), model: "m", system_prompt_suffix: "Be precise." }],
      rolloutsPerTask: 1,
      purpose: "evolve",
    });
    assert.equal(run.status, "queued");
    assert.equal(run.split, "train");
    assert.deepEqual(run.models, ["m"]);
    assert.ok(run.requires.includes("prompt_overrides"));
    const onDisk = readRunRequest(runRequestPath(dir, run.run_id));
    assert.equal(onDisk.prompt_overrides[0].arm_label, "m+evo-g1v1");
  });

  it("hard-blocks holdout (and 'all') from evolve-purpose runs", () => {
    const dir = makeBenchmarkDir();
    assert.throws(() => queueEvolutionRun(dir, { baseModel: "m", split: "holdout", rolloutsPerTask: 1, purpose: "evolve" }), /split sealing violation/);
    assert.throws(() => queueEvolutionRun(dir, { baseModel: "m", split: "all", rolloutsPerTask: 1, purpose: "evolve" }), /split sealing violation/);
    // final purpose may touch holdout — exactly once, by the driver.
    const final = queueEvolutionRun(dir, { baseModel: "m", split: "holdout", rolloutsPerTask: 1, purpose: "final" });
    assert.equal(final.split, "holdout");
  });

  it("waitForRun polls the request file to completion and warns once when nothing claims it", async () => {
    const dir = makeBenchmarkDir();
    const run = queueEvolutionRun(dir, { baseModel: "m", split: "train", rolloutsPerTask: 1, purpose: "evolve" });
    let idleWarnings = 0;
    let polls = 0;
    const settled = await waitForRun(dir, run.run_id, {
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 6) writeRunRequest(dir, { ...run, status: "done" });
      },
      onIdle: () => {
        idleWarnings += 1;
      },
    });
    assert.equal(settled.status, "done");
    assert.equal(idleWarnings, 1); // instruct the user to start `runs execute --watch`; never spawn one
  });
});

describe("evolution.jsonl round-trip", () => {
  it("appends and re-reads generation records, dropping foreign schema lines", () => {
    const dir = makeBenchmarkDir();
    const record = {
      schema_version: PROMPT_EVOLUTION_SCHEMA,
      benchmark_id: "evo-bench",
      generation: 1,
      split: "train",
      run_id: "run-x",
      base_model: "m",
      author_model: "author",
      created_at: new Date(0).toISOString(),
      variants: [{ arm_label: "m+evo-g1v1", system_prompt_suffix: "S", system_prompt_suffix_sha256: promptSuffixHash("S"), mean_score: 0.5, rows: 2 }],
      bare: { mean_score: 0.4, rows: 2 },
      champion: "m+evo-g1v1",
    };
    appendEvolutionRecord(dir, record);
    fs.appendFileSync(path.join(dir, "evolution.jsonl"), JSON.stringify({ schema_version: "something.else" }) + "\n");
    const records = readEvolutionRecords(dir);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], record);
  });
});

describe("paired holdout verdict", () => {
  it("computes paired diffs with a CI and only calls a CI-positive result a win", () => {
    const rows = (model, scores) => Object.entries(scores).map(([task_id, score]) => ({ run_id: "r", task_id, model, status: "ok", score }));
    const win = pairedVerdict("champ", rows("champ", { a: 1, b: 1, c: 1, d: 1, e: 1 }), rows("m", { a: 0, b: 0, c: 0, d: 0, e: 1 }));
    assert.equal(win.verdict, "win");
    assert.equal(win.paired_tasks, 5);
    const inconclusive = pairedVerdict("champ", rows("champ", { a: 1, b: 0 }), rows("m", { a: 0, b: 1 }));
    assert.equal(inconclusive.verdict, "inconclusive");
    const empty = pairedVerdict("champ", [], []);
    assert.equal(empty.verdict, "inconclusive");
    assert.equal(empty.paired_tasks, 0);
  });
});

describe("evolvePrompts driver (mocked gateway + executor)", () => {
  /** Fake executor: queue for real (split-sealing exercised), then synthesize rows. */
  function fakeIo(dir, { scores }) {
    const queued = [];
    const rowsByRun = new Map();
    return {
      requests: queued,
      io: {
        queue: (input) => {
          const run = queueEvolutionRun(dir, input);
          queued.push({ ...input, run_id: run.run_id });
          const splitTasks = { train: ["tr1", "tr2"], dev: ["dv1"], holdout: ["ho1", "ho2"] }[input.split];
          const rows = [];
          const arms = [{ label: input.baseModel, key: "bare" }, ...(input.overrides ?? []).map((o) => ({ label: o.arm_label, key: "variant" }))];
          for (const arm of arms) {
            for (const taskId of splitTasks) {
              rows.push({ run_id: run.run_id, task_id: taskId, model: arm.label, status: "ok", score: scores(arm.key, taskId, input.split) });
            }
          }
          rowsByRun.set(run.run_id, rows);
          return run;
        },
        wait: async (runId) => ({ schema_version: "understudy.run_request.v1", run_id: runId, status: "done", benchmark_id: "evo-bench" }),
        rows: (runId) => rowsByRun.get(runId) ?? [],
        journal: () => JSON.stringify({ kind: "result", tool: "update-record", status: "error", content: "ERROR: missing required field 'id'" }) + "\n",
        client: async ({ messages }) => {
          assert.match(messages[1].content, /missing_required_field/); // proposal prompt carries journal evidence
          return { content: '[{"system_prompt_suffix": "Include the record id."}, {"system_prompt_suffix": "Reply in JSON."}]', usage: { prompt_tokens: 10, completion_tokens: 10 } };
        },
        log: () => {},
        now: () => new Date(0),
      },
    };
  }

  it("runs the full loop, seals holdout to exactly one final run, and records every generation", async () => {
    const dir = makeBenchmarkDir();
    const { io, requests } = fakeIo(dir, { scores: (key) => (key === "variant" ? 1 : 0) });
    const result = await evolvePrompts(dir, {
      model: "m",
      authorModel: "author-model",
      generations: 2,
      variants: 2,
      io,
    });
    // Request task-list discipline: holdout appears ONLY in the single final run.
    const holdoutRuns = requests.filter((r) => r.split === "holdout");
    assert.equal(holdoutRuns.length, 1);
    assert.equal(holdoutRuns[0].purpose, "final");
    assert.ok(requests.filter((r) => r.purpose === "evolve").every((r) => r.split === "train" || r.split === "dev"));
    assert.equal(requests.length, 5); // baseline + 2 generations + dev select + holdout final
    assert.equal(result.runs_queued, 5);
    assert.equal(result.verdict.verdict, "win");
    assert.equal(result.champion.system_prompt_suffix, "Include the record id.");
    const records = readEvolutionRecords(dir);
    assert.deepEqual(records.map((r) => r.generation), [0, 1, 2, "dev_select", "holdout_final"]);
    assert.ok(records[1].variants.every((v) => v.system_prompt_suffix_sha256 === promptSuffixHash(v.system_prompt_suffix)));
    assert.equal(records.at(-1).verdict.verdict, "win");
  });

  it("keeps the holdout sealed and reports no_win when the champion loses on dev", async () => {
    const dir = makeBenchmarkDir();
    const { io, requests } = fakeIo(dir, { scores: (key) => (key === "variant" ? 0 : 1) });
    const result = await evolvePrompts(dir, { model: "m", authorModel: "author-model", generations: 1, variants: 2, io });
    assert.equal(requests.filter((r) => r.split === "holdout").length, 0);
    assert.equal(result.verdict.verdict, "no_win");
  });

  it("refuses to report a win under --no-final (holdout untouched, verdict unverified)", async () => {
    const dir = makeBenchmarkDir();
    const { io, requests } = fakeIo(dir, { scores: (key) => (key === "variant" ? 1 : 0) });
    const result = await evolvePrompts(dir, { model: "m", authorModel: "author-model", generations: 1, variants: 2, final: false, io });
    assert.equal(requests.filter((r) => r.split === "holdout").length, 0);
    assert.equal(result.verdict.verdict, "unverified");
  });

  it("enforces --budget-runs before queueing past the cap", async () => {
    const dir = makeBenchmarkDir();
    const { io } = fakeIo(dir, { scores: () => 1 });
    await assert.rejects(
      evolvePrompts(dir, { model: "m", authorModel: "author-model", generations: 3, variants: 2, budgetRuns: 2, io }),
      /--budget-runs exhausted/,
    );
  });

  it("scoring helper ignores anomalous and errored rows", () => {
    const { mean, rows } = meanScore([
      { status: "ok", score: 1 },
      { status: "ok", score: 0, anomaly: { kind: "x" } },
      { status: "error", score: 1 },
      { status: "ok", score: 0 },
    ]);
    assert.equal(rows, 2);
    assert.equal(mean, 0.5);
  });
});
