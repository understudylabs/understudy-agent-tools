import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  applyAutoAccepts,
  buildTaskFeedbackHandoff,
  deriveAutoReviewProposals,
  loadProposedEntryFromDir,
  submitReview,
  submitTaskFeedback,
  MAX_FEEDBACK_LENGTH,
} from "../dist/benchmark-hub-core.js";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICY_SCHEMA,
  meetsConfidenceBar,
  readReviewPolicy,
  TASK_FEEDBACK_SCHEMA,
  feedbackBelongsTo,
  isTaskFeedback,
  latestReviewByTask,
  makeTaskFeedback,
  readReviews,
  readTaskFeedback,
  serializeTaskFeedbackLine,
} from "../dist/benchmark-artifacts.js";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exception-review-"));
  tmpDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* Pure policy matrix                                                  */
/* ------------------------------------------------------------------ */

function task(id, overrides = {}) {
  return {
    schema_version: "understudy.benchmark_task.v1",
    task_id: id,
    execution_group: "g1",
    title: `task ${id}`,
    status: "machine_proposed",
    split: "construction",
    candidate_boundary: "b",
    machine_confidence: "high",
    close_call: false,
    tool_surface: [],
    outcome_contract: { required: [], preserved: [], forbidden: [], grading: "final_state" },
    world_model: {},
    source: { node_ids: [], edges: [], captures: [] },
    claims: [],
    sentinels: [],
    review: { decision: "pending" },
    ...overrides,
  };
}

function entryWith(overrides = {}) {
  return {
    kind: "proposed",
    slug: "data--x",
    source: "data-dir",
    readOnly: false,
    dir: "/tmp/x",
    manifestPath: "/tmp/x/manifest.json",
    foundry: { schema_version: "understudy.trace_foundry.v1" },
    tasks: [],
    dag: null,
    captureIndex: [],
    rows: [],
    reviews: [],
    latestReviewByTask: {},
    diagnostics: { skippedLines: 0, droppedRows: 0, foreignRows: 0, foreignFlags: 0 },
    crossCheckErrors: [],
    overview: null,
    calibration: null,
    ...overrides,
  };
}

describe("deriveAutoReviewProposals — classification matrix", () => {
  it("high confidence + clean self_check + no calibration ⇒ auto_accept", () => {
    const proposals = deriveAutoReviewProposals(entryWith({ tasks: [task("t1")] }));
    assert.deepEqual(proposals, [{ task_id: "t1", verdict: "auto_accept", reasons: [] }]);
  });

  it("absent self_check block counts as clean (pre-self-check builds)", () => {
    const t = task("t1");
    delete t.self_check;
    const [p] = deriveAutoReviewProposals(entryWith({ tasks: [t] }));
    assert.equal(p.verdict, "auto_accept");
  });

  it("confidence below the bar ⇒ exception(low_confidence), for medium and low", () => {
    for (const level of ["medium", "low"]) {
      const [p] = deriveAutoReviewProposals(entryWith({ tasks: [task("t1", { machine_confidence: level })] }));
      assert.equal(p.verdict, "exception");
      assert.deepEqual(p.reasons, ["low_confidence"]);
    }
  });

  it("a high-confidence close_call is still low_confidence", () => {
    const [p] = deriveAutoReviewProposals(entryWith({ tasks: [task("t1", { close_call: true })] }));
    assert.deepEqual(p.reasons, ["low_confidence"]);
  });

  it("failed self_check ⇒ exception(self_check_failed); passing self_check stays clean", () => {
    const failed = task("t1", { self_check: { ok: false, failures: [{ check: "empty_contract", detail: "d" }] } });
    const passed = task("t2", { self_check: { ok: true, failures: [] } });
    const proposals = deriveAutoReviewProposals(entryWith({ tasks: [failed, passed] }));
    assert.deepEqual(proposals[0].reasons, ["self_check_failed"]);
    assert.equal(proposals[1].verdict, "auto_accept");
  });

  it("calibration present: incumbent pass ⇒ auto_accept, fail ⇒ incumbent_failed, unlisted ⇒ no evidence", () => {
    const calibration = {
      schema_version: "understudy.calibration.v1",
      benchmark_id: "b",
      run_id: "r",
      incumbent_models: ["m"],
      threshold: 0.5,
      started_at: null,
      finished_at: null,
      tasks: [
        { task_id: "t-pass", score: 1, passed: true, rollouts: 1 },
        { task_id: "t-fail", score: 0, passed: false, rollouts: 1 },
      ],
      passed_count: 1,
      failed_count: 1,
      failed_task_ids: ["t-fail"],
    };
    const proposals = deriveAutoReviewProposals(
      entryWith({ tasks: [task("t-pass"), task("t-fail"), task("t-unlisted")], calibration }),
    );
    assert.equal(proposals[0].verdict, "auto_accept");
    assert.deepEqual(proposals[1].reasons, ["incumbent_failed"]);
    assert.equal(proposals[2].verdict, "auto_accept");
  });

  it("cross-check disagreement ⇒ schema_conflict; anomalous eval row ⇒ anomaly", () => {
    const proposals = deriveAutoReviewProposals(
      entryWith({
        tasks: [task("t-conflict"), task("t-anomaly")],
        crossCheckErrors: ["t-conflict missing from benchmark.json"],
        rows: [
          { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "t-anomaly", status: "ok", anomaly: { kind: "runaway", detail: "d" } },
        ],
      }),
    );
    assert.deepEqual(proposals[0].reasons, ["schema_conflict"]);
    assert.deepEqual(proposals[1].reasons, ["anomaly"]);
  });

  it("reasons compound (low_confidence + self_check_failed + incumbent_failed)", () => {
    const calibration = {
      schema_version: "understudy.calibration.v1",
      benchmark_id: "b",
      run_id: "r",
      incumbent_models: ["m"],
      threshold: 0.5,
      started_at: null,
      finished_at: null,
      tasks: [{ task_id: "t1", score: 0, passed: false, rollouts: 1 }],
      passed_count: 0,
      failed_count: 1,
      failed_task_ids: ["t1"],
    };
    const [p] = deriveAutoReviewProposals(
      entryWith({
        tasks: [task("t1", { machine_confidence: "low", self_check: { ok: false, failures: [] } })],
        calibration,
      }),
    );
    assert.deepEqual(p.reasons, ["low_confidence", "self_check_failed", "incumbent_failed"]);
  });

  it("already-decided tasks are skipped — auto never re-decides (newest-wins respected)", () => {
    const proposals = deriveAutoReviewProposals(
      entryWith({
        tasks: [task("t1"), task("t2")],
        latestReviewByTask: {
          t1: { schema_version: "understudy.benchmark_review.v1", benchmark_id: "b", task_id: "t1", decision: "reject", note: "", created_at: "x" },
        },
      }),
    );
    assert.deepEqual(proposals.map((p) => p.task_id), ["t2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Write path: applyAutoAccepts over a real foundry dir                */
/* ------------------------------------------------------------------ */

function writeFoundryDir(dir, tasks) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: "understudy.trace_foundry.v1",
      freshness: { max_age_days: 30, cutoff_utc: "2026-07-01T00:00:00Z", newest_capture_utc: "2026-07-20T00:00:00Z" },
      counts: { source_files: 1, captures: 1, tasks: tasks.length, edges: 0, stale_filtered: 0, invalid_timestamp_filtered: 0 },
    }),
  );
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark_proposal.v1",
      benchmark_id: "prop-bench",
      tasks: tasks.map((t) => ({ task_id: t.task_id })),
    }),
  );
}

describe("applyAutoAccepts — write path", () => {
  it("appends accept lines stamped source:'auto' for auto-accepts only, on explicit call", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t-clean"), task("t-shaky", { machine_confidence: "low" })]);
    const entry = loadProposedEntryFromDir(dir, "data-dir", "data--prop", false);

    const result = applyAutoAccepts(entry);
    assert.equal(result.ok, true);
    assert.deepEqual(result.applied, ["t-clean"]);
    assert.equal(result.exceptions, 1);

    const { reviews, skipped } = readReviews(path.join(dir, "reviews.jsonl"));
    assert.equal(skipped, 0);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].task_id, "t-clean");
    assert.equal(reviews[0].decision, "accept");
    assert.equal(reviews[0].source, "auto");
    assert.equal(reviews[0].benchmark_id, "prop");
  });

  it("is idempotent (second apply writes nothing) and reversible (human line supersedes)", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t-clean")]);
    applyAutoAccepts(loadProposedEntryFromDir(dir, "data-dir", "data--prop", false));

    // Second apply: the task is already decided — no new lines.
    const again = applyAutoAccepts(loadProposedEntryFromDir(dir, "data-dir", "data--prop", false));
    assert.equal(again.ok, true);
    assert.deepEqual(again.applied, []);
    assert.equal(readReviews(path.join(dir, "reviews.jsonl")).reviews.length, 1);

    // Human override through the SAME shared submitReview: newest line wins.
    const entry = loadProposedEntryFromDir(dir, "data-dir", "data--prop", false);
    const override = submitReview(entry, { task_id: "t-clean", decision: "reject", note: "bad gold after all" });
    assert.equal(override.ok, true);
    const { reviews } = readReviews(path.join(dir, "reviews.jsonl"));
    assert.equal(reviews.length, 2);
    assert.equal(latestReviewByTask(reviews)["t-clean"].decision, "reject");
    assert.equal(latestReviewByTask(reviews)["t-clean"].source, undefined);
  });

  it("rejects read-only and non-proposed entries", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t1")]);
    const readOnly = loadProposedEntryFromDir(dir, "fixture", "fixture--prop", true);
    assert.equal(applyAutoAccepts(readOnly).status, 403);
    assert.equal(applyAutoAccepts(null).status, 404);
  });
});

/* ------------------------------------------------------------------ */
/* Task feedback: append + schema + handoff                            */
/* ------------------------------------------------------------------ */

const feedbackSchema = JSON.parse(
  fs.readFileSync(path.resolve("schemas", "understudy.task_feedback.v1.schema.json"), "utf8"),
);

function schemaErrors(schema, value, at = "$") {
  const errors = [];
  if ("const" in schema && value !== schema.const) errors.push(`${at}: expected const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (schema.type === "object" || schema.properties || schema.required) {
    if (typeof value === "object" && value !== null) {
      for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value) errors.push(...schemaErrors(sub, value[key], `${at}.${key}`));
      }
    }
  }
  if (schema.type === "string" && typeof value !== "string") errors.push(`${at}: not a string`);
  return errors;
}

describe("task feedback contract (understudy.task_feedback.v1)", () => {
  it("make→serialize→read roundtrips and validates against the schema file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "feedback.jsonl");
    const fb = makeTaskFeedback({
      benchmark_id: "prop",
      task_id: "t1",
      feedback: "the gold contract is over-specified\nrelax the id match",
      created_at: "2026-07-22T00:00:00.000Z",
    });
    assert.equal(fb.schema_version, TASK_FEEDBACK_SCHEMA);
    fs.writeFileSync(file, serializeTaskFeedbackLine(fb));
    const read = readTaskFeedback(file);
    assert.equal(read.skipped, 0);
    assert.deepEqual(read.feedback, [fb]);
    assert.ok(isTaskFeedback(fb));
    assert.deepEqual(schemaErrors(feedbackSchema, fb), []);
  });

  it("submitTaskFeedback validates, appends, and returns the regenerate-env handoff", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t1")]);
    const entry = loadProposedEntryFromDir(dir, "data-dir", "data--prop", false);

    assert.equal(submitTaskFeedback(entry, { task_id: "t1", feedback: "" }).status, 400);
    assert.equal(submitTaskFeedback(entry, { task_id: "nope", feedback: "x" }).status, 404);
    assert.equal(submitTaskFeedback(entry, { task_id: "t1", feedback: "x".repeat(MAX_FEEDBACK_LENGTH + 1) }).status, 413);

    const result = submitTaskFeedback(entry, { task_id: "t1", feedback: "  wrong required tool  " });
    assert.equal(result.ok, true);
    assert.equal(result.feedback.feedback, "wrong required tool");
    assert.equal(result.feedback.status, "open");
    assert.deepEqual(schemaErrors(feedbackSchema, result.feedback), []);

    const read = readTaskFeedback(path.join(dir, "feedback.jsonl"));
    assert.equal(read.feedback.length, 1);
    assert.equal(read.feedback[0].task_id, "t1");

    // The handoff is a concrete agent prompt: dir, task, the user's words, the CLI verb.
    assert.ok(result.handoff.includes(`understudy traces regenerate-env --benchmark ${dir}`));
    assert.ok(result.handoff.includes("wrong required tool"));
    assert.ok(result.handoff.includes("t1"));
    assert.equal(result.handoff, buildTaskFeedbackHandoff(dir, "t1", "wrong required tool"));
  });

  it("records the manifest benchmark_id (not the dir basename), falling back to the basename without benchmark.json", () => {
    const dir = path.join(tmpDir(), "cedar-automation");
    writeFoundryDir(dir, [task("t1")]);
    const entry = loadProposedEntryFromDir(dir, "data-dir", "data--cedar-automation", false);
    const result = submitTaskFeedback(entry, { task_id: "t1", feedback: "wrong tool" });
    assert.equal(result.ok, true);
    assert.equal(result.feedback.benchmark_id, "prop-bench", "the proposal-stamped benchmark_id wins over the dir basename");

    // Fallback: no benchmark.json → dir basename (the legacy convention).
    const bare = path.join(tmpDir(), "cedar-automation");
    writeFoundryDir(bare, [task("t1")]);
    fs.rmSync(path.join(bare, "benchmark.json"));
    const bareEntry = loadProposedEntryFromDir(bare, "data-dir", "data--cedar-automation", false);
    const bareResult = submitTaskFeedback(bareEntry, { task_id: "t1", feedback: "wrong tool" });
    assert.equal(bareResult.ok, true);
    assert.equal(bareResult.feedback.benchmark_id, "cedar-automation");
  });

  it("feedbackBelongsTo accepts BOTH the manifest id and the legacy dir-basename id", () => {
    const legacy = makeTaskFeedback({ benchmark_id: "cedar-automation", task_id: "t1", feedback: "old line" });
    const modern = makeTaskFeedback({ benchmark_id: "trace-23a3902b7a7b6126", task_id: "t1", feedback: "new line" });
    const ids = { benchmarkId: "trace-23a3902b7a7b6126", dirBasename: "cedar-automation" };
    assert.ok(feedbackBelongsTo(legacy, ids));
    assert.ok(feedbackBelongsTo(modern, ids));
    assert.ok(!feedbackBelongsTo(makeTaskFeedback({ benchmark_id: "other", task_id: "t1", feedback: "x" }), ids));
    assert.ok(!feedbackBelongsTo(legacy, { benchmarkId: null, dirBasename: null }));
  });

  it("rejects read-only entries and non-proposed stages", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t1")]);
    const readOnly = loadProposedEntryFromDir(dir, "fixture", "fixture--prop", true);
    assert.equal(submitTaskFeedback(readOnly, { task_id: "t1", feedback: "x" }).status, 403);
    assert.equal(submitTaskFeedback(null, { task_id: "t1", feedback: "x" }).status, 404);
  });
});

/* ------------------------------------------------------------------ */
/* Configurable review policy (understudy.review_policy.v1 sidecar)    */
/* ------------------------------------------------------------------ */

const policySchema = JSON.parse(
  fs.readFileSync(path.resolve("schemas", "understudy.review_policy.v1.schema.json"), "utf8"),
);

describe("readReviewPolicy — sidecar codec", () => {
  it("absent / unreadable / wrong-schema files yield the defaults (pre-policy behavior)", () => {
    const dir = tmpDir();
    assert.deepEqual(readReviewPolicy(dir), DEFAULT_REVIEW_POLICY);
    fs.writeFileSync(path.join(dir, "review-policy.json"), "{not json");
    assert.deepEqual(readReviewPolicy(dir), DEFAULT_REVIEW_POLICY);
    fs.writeFileSync(path.join(dir, "review-policy.json"), JSON.stringify({ min_confidence: "low" }));
    assert.deepEqual(readReviewPolicy(dir), DEFAULT_REVIEW_POLICY, "no schema stamp ⇒ defaults");
  });

  it("recognized fields override individually; unrecognized values never loosen the bar", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "review-policy.json"),
      JSON.stringify({ schema_version: REVIEW_POLICY_SCHEMA, min_confidence: "medium" }),
    );
    assert.deepEqual(readReviewPolicy(dir), { ...DEFAULT_REVIEW_POLICY, min_confidence: "medium" });
    fs.writeFileSync(
      path.join(dir, "review-policy.json"),
      JSON.stringify({ schema_version: REVIEW_POLICY_SCHEMA, min_confidence: "yolo", require_incumbent_pass: "no" }),
    );
    assert.deepEqual(readReviewPolicy(dir), DEFAULT_REVIEW_POLICY, "typo'd values fall back per field");
    assert.deepEqual(
      schemaErrors(policySchema, { schema_version: REVIEW_POLICY_SCHEMA, min_confidence: "medium", require_incumbent_pass: false }),
      [],
    );
  });

  it("defaults match the historical hardcoded bar and confidence ordering is high > medium > low", () => {
    assert.equal(DEFAULT_REVIEW_POLICY.min_confidence, "high");
    assert.equal(DEFAULT_REVIEW_POLICY.require_incumbent_pass, true);
    assert.equal(meetsConfidenceBar("high", "high"), true);
    assert.equal(meetsConfidenceBar("medium", "high"), false);
    assert.equal(meetsConfidenceBar("medium", "medium"), true);
    assert.equal(meetsConfidenceBar("low", "medium"), false);
    assert.equal(meetsConfidenceBar("low", "low"), true);
    assert.equal(meetsConfidenceBar("bogus", "low"), false, "unknown levels never clear any bar");
  });
});

describe("deriveAutoReviewProposals — policy matrix (non-default review_policy)", () => {
  const failCalibration = {
    schema_version: "understudy.calibration.v1",
    benchmark_id: "b",
    run_id: "r",
    incumbent_models: ["m"],
    threshold: 0.5,
    started_at: null,
    finished_at: null,
    tasks: [{ task_id: "t1", score: 0, passed: false, rollouts: 1 }],
    passed_count: 0,
    failed_count: 1,
    failed_task_ids: ["t1"],
  };

  it("min_confidence medium auto-accepts medium, still excepts low and close calls", () => {
    const reviewPolicy = { ...DEFAULT_REVIEW_POLICY, min_confidence: "medium" };
    const proposals = deriveAutoReviewProposals(
      entryWith({
        reviewPolicy,
        tasks: [
          task("t-high"),
          task("t-med", { machine_confidence: "medium" }),
          task("t-low", { machine_confidence: "low" }),
          task("t-close", { machine_confidence: "high", close_call: true }),
        ],
      }),
    );
    assert.deepEqual(proposals.map((p) => p.verdict), ["auto_accept", "auto_accept", "exception", "exception"]);
    assert.deepEqual(proposals[3].reasons, ["low_confidence"], "close_call always excepts regardless of the bar");
  });

  it("require_incumbent_pass=false drops the incumbent gate; other gates still hold", () => {
    const reviewPolicy = { ...DEFAULT_REVIEW_POLICY, require_incumbent_pass: false };
    const [p] = deriveAutoReviewProposals(entryWith({ reviewPolicy, tasks: [task("t1")], calibration: failCalibration }));
    assert.equal(p.verdict, "auto_accept", "incumbent failure no longer blocks");
    const [q] = deriveAutoReviewProposals(
      entryWith({
        reviewPolicy,
        tasks: [task("t1", { self_check: { ok: false, failures: [] } })],
        calibration: failCalibration,
      }),
    );
    assert.deepEqual(q.reasons, ["self_check_failed"], "incumbent_failed absent even when compounding");
  });

  it("an entry without reviewPolicy behaves exactly like the defaults", () => {
    const [withDefault] = deriveAutoReviewProposals(
      entryWith({ tasks: [task("t1", { machine_confidence: "medium" })] }),
    );
    const [withExplicit] = deriveAutoReviewProposals(
      entryWith({ reviewPolicy: { ...DEFAULT_REVIEW_POLICY }, tasks: [task("t1", { machine_confidence: "medium" })] }),
    );
    assert.deepEqual(withDefault, withExplicit);
    assert.deepEqual(withDefault.reasons, ["low_confidence"]);
  });
});

describe("review policy — end to end over a real foundry dir", () => {
  it("loadProposedEntryFromDir picks up review-policy.json and applyAutoAccepts honors it", () => {
    const dir = path.join(tmpDir(), "prop");
    writeFoundryDir(dir, [task("t-med", { machine_confidence: "medium" }), task("t-low", { machine_confidence: "low" })]);

    // Default policy: nothing auto-accepts.
    const before = applyAutoAccepts(loadProposedEntryFromDir(dir, "data-dir", "data--prop", false));
    assert.deepEqual(before.applied, []);
    assert.equal(before.exceptions, 2);

    fs.writeFileSync(
      path.join(dir, "review-policy.json"),
      JSON.stringify({ schema_version: REVIEW_POLICY_SCHEMA, min_confidence: "medium" }),
    );
    const entry = loadProposedEntryFromDir(dir, "data-dir", "data--prop", false);
    assert.deepEqual(entry.reviewPolicy, { ...DEFAULT_REVIEW_POLICY, min_confidence: "medium" });
    const result = applyAutoAccepts(entry);
    assert.deepEqual(result.applied, ["t-med"]);
    assert.equal(result.exceptions, 1);
    const { reviews } = readReviews(path.join(dir, "reviews.jsonl"));
    assert.equal(reviews[0].source, "auto");
    assert.ok(reviews[0].note.includes("≥ medium"), "auto note names the policy bar in force");
  });
});
