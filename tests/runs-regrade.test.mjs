import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isRowStale, latestBreakingBumps } from "../dist/benchmark-staleness.js";
import { allocateRegradeRunId, formatRegradeDelta, loadRetainedTraces, regradeRuns, traceEvidence } from "../dist/regrade.js";
import { rowsFilePath, verifiersWorkDir } from "../dist/run-executor.js";

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/**
 * Fixture benchmark dir: replayable verifier, three tasks whose CURRENT
 * contracts are response obligations (a fake but real-scorer-compatible
 * replayable verifier), one finished run with retained traces for t1/t2
 * (none for t3), and one trivial-arm rows file with no traces at all.
 */
function makeFixture({ replayable = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "regrade-fixture-"));
  writeFileSync(
    join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "bench-regrade",
      provenance: { origin: "derived-from-traces", source_refs: [] },
      taxonomy: [{ category_id: "cat" }],
      tasks: [
        { task_id: "t1", category_id: "cat", genesis: "replayed", split: "train", gold: { kind: "final-state", ref: "tasks.jsonl#t1" } },
        { task_id: "t2", category_id: "cat", genesis: "replayed", split: "dev", gold: { kind: "final-state", ref: "tasks.jsonl#t2" } },
        { task_id: "t3", category_id: "cat", genesis: "replayed", split: "holdout", gold: { kind: "final-state", ref: "tasks.jsonl#t3" } },
      ],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit", replayable },
    }),
  );
  // CURRENT verifier definitions (contracts as they stand NOW — already edited
  // since the run): t1 now expects "blue", t2 now expects "red".
  writeFileSync(
    join(dir, "tasks.jsonl"),
    jsonl([
      // t1 is born-versioned (foundry-stamped): regraded rows must carry its
      // CURRENT version + content hashes in provenance.
      { task_id: "t1", version: "1.1.0", content_hashes: { env_sha256: "a".repeat(64), verifier_sha256: "b".repeat(64), meta_sha256: "c".repeat(64) }, outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "blue" }], forbidden: [] } },
      { task_id: "t2", outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "red" }], forbidden: [] } },
      { task_id: "t3", outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: "green" }], forbidden: [] } },
    ]),
  );
  // Rows from the original run (old verifier): t1 scored 0, t2 scored 1, t3 scored 1.
  const runId = "run-abc";
  const model = "gpt-x";
  const mkRow = (task_id, split, score, extra = {}) => ({
    schema_version: "understudy.eval_result.v1",
    run_id: runId,
    task_id,
    split,
    score,
    subscores: { final_state: score },
    status: "ok",
    model,
    arm_kind: "candidate",
    route: "gateway",
    latency_ms: 1234,
    cost: 0.05,
    created_at: "2026-07-01T00:00:00.000Z",
    benchmark_id: "bench-regrade",
    category_id: "cat",
    rollout: 0,
    writes: [],
    ...extra,
  });
  writeFileSync(rowsFilePath(dir, runId, model), jsonl([mkRow("t1", "train", 0), mkRow("t2", "dev", 1), mkRow("t3", "holdout", 1)]));
  // A trivial arm with rows but NO retained traces.
  writeFileSync(rowsFilePath(dir, runId, "null_agent"), jsonl([mkRow("t1", "train", 0, { model: "null_agent", arm_kind: "null_agent" })]));
  // Retained traces for the model arm: t1 answered "blue" (now passes), t2
  // answered "green" (now fails); t3 has no retained trace.
  const outDir = join(verifiersWorkDir(dir, `${runId}--${model}`), "outputs", "evals", "x");
  mkdirSync(outDir, { recursive: true });
  const trace = (task_id, text, tool_calls = []) => ({
    task: { data: { task_id } },
    nodes: [{ message: { role: "assistant", content: text, tool_calls } }],
  });
  writeFileSync(
    join(outDir, "traces.jsonl"),
    jsonl([
      {
        traces: [
          trace("t1", "the answer is blue", [{ function: { name: "world_toolset_lookup_thing", arguments: '{"q":1}' } }]),
          trace("t2", "the answer is green"),
        ],
      },
    ]),
  );
  return { dir, runId, model };
}

describe("traceEvidence", () => {
  it("extracts all calls (prefix stripped, string args parsed) and the final assistant text", () => {
    const { taskId, evidence } = traceEvidence({
      task: { data: { task_id: "t1" } },
      nodes: [
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "world_toolset_get_a", arguments: '{"k":"v"}' } }] } },
        { message: { role: "tool", content: "ok" } },
        { message: { role: "assistant", content: "done: blue" } },
      ],
    });
    assert.equal(taskId, "t1");
    assert.deepEqual(evidence.calls, [{ name: "get_a", arguments: { k: "v" } }]);
    assert.equal(evidence.finalResponse, "done: blue");
  });
});

describe("regradeRuns", () => {
  it("rescores retained traces against the CURRENT verifier and writes provenance-stamped rows under a new run id", () => {
    const { dir, runId, model } = makeFixture();
    const summaries = regradeRuns(dir, { now: () => new Date("2026-07-23T00:00:00.000Z") });
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.equal(summary.run_id, runId);
    assert.equal(summary.new_run_id, `${runId}-regrade-1`);
    assert.equal(summary.dry_run, false);
    assert.equal(summary.rows_considered, 4);
    // t1 up (0 -> 1), t2 down (1 -> 0); t3 (no trace) + null_agent (no traces at all) skipped.
    assert.equal(summary.regraded.length, 2);
    const t1 = summary.regraded.find((r) => r.task_id === "t1");
    const t2 = summary.regraded.find((r) => r.task_id === "t2");
    assert.deepEqual({ old: t1.old_score, next: t1.new_score, changed: t1.changed }, { old: 0, next: 1, changed: true });
    assert.deepEqual({ old: t2.old_score, next: t2.new_score, changed: t2.changed }, { old: 1, next: 0, changed: true });
    assert.deepEqual(summary.delta, { changed: 2, up: 1, down: 1, mean_before: 0.5, mean_after: 0.5 });
    assert.deepEqual(
      summary.skipped.map((s) => [s.task_id, s.model, s.reason]).sort(),
      [["t1", "null_agent", "trace_missing"], ["t3", model, "no_trace_for_task"]],
    );

    // New rows landed in the executor's own layout, one file per (run, model).
    const rowsFile = rowsFilePath(dir, `${runId}-regrade-1`, model);
    assert.ok(existsSync(rowsFile));
    const rows = readFileSync(rowsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    const rowT1 = rows.find((r) => r.task_id === "t1");
    assert.equal(rowT1.run_id, `${runId}-regrade-1`);
    assert.equal(rowT1.score, 1);
    assert.equal(rowT1.status, "ok");
    // Regrade provenance points back at the exact source row.
    assert.deepEqual(rowT1.provenance.source_run, {
      action: "regrade",
      run_id: runId,
      row_ref: `rows-${runId}-${model.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl#0`,
    });
    // Cost/latency/model/route PRESERVED — recorded, never re-incurred.
    assert.equal(rowT1.cost, 0.05);
    assert.equal(rowT1.latency_ms, 1234);
    assert.equal(rowT1.model, model);
    assert.equal(rowT1.route, "gateway");
    assert.equal(rowT1.created_at, "2026-07-23T00:00:00.000Z");
    // Subscores reflect the shared accumulation verdict.
    assert.equal(rowT1.subscores.final_state, 1);
    assert.equal(rowT1.subscores.recall, 1);

    // The delta line is human-parseable.
    assert.match(formatRegradeDelta(summary), /2 changed \(1 up, 1 down\), mean reward 0\.5 -> 0\.5/);
  });

  it("--dry-run computes the identical plan without writing rows or a versions.jsonl bump", () => {
    const { dir, runId, model } = makeFixture();
    const before = readdirSync(dir).filter((n) => n.startsWith("rows-")).sort();
    const [summary] = regradeRuns(dir, { dryRun: true });
    assert.equal(summary.dry_run, true);
    assert.equal(summary.new_run_id, `${runId}-regrade-1`);
    assert.equal(summary.regraded.length, 2);
    assert.equal(summary.version_entry, null);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("rows-")).sort(), before);
    assert.ok(!existsSync(rowsFilePath(dir, `${runId}-regrade-1`, model)));
    assert.ok(!existsSync(join(dir, "versions.jsonl")));
  });

  it("appends one MINOR versions.jsonl bump so source rows go stale and regraded rows stay fresh", () => {
    const { dir, runId } = makeFixture();
    const [summary] = regradeRuns(dir, { now: () => new Date("2026-07-23T00:00:00.000Z") });

    // Exactly one understudy.benchmark_version.v1 line, MINOR per regraded task.
    const lines = readFileSync(join(dir, "versions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.schema_version, "understudy.benchmark_version.v1");
    assert.equal(entry.created_at, "2026-07-23T00:00:00.000Z");
    assert.equal(entry.version, "1.1.0"); // benchmark-level MINOR from the 1.0.0 default
    assert.deepEqual(entry.task_bumps.map((b) => [b.task_id, b.bump]), [["t1", "minor"], ["t2", "minor"]]);
    assert.match(entry.note, /regrade/);
    assert.deepEqual(summary.version_entry, entry);

    // The staleness gate now supersedes the old-verifier rows: source rows
    // (created 2026-07-01) are stale, the regraded rows are not — no
    // double-counting in leaderboard aggregates.
    const bumps = latestBreakingBumps(lines);
    assert.equal(isRowStale({ task_id: "t1", created_at: "2026-07-01T00:00:00.000Z" }, bumps), true);
    assert.equal(isRowStale({ task_id: "t2", created_at: "2026-07-01T00:00:00.000Z" }, bumps), true);
    assert.equal(isRowStale({ task_id: "t1", created_at: "2026-07-23T00:00:00.000Z" }, bumps), false);
    // t3 was never regraded: its rows keep counting.
    assert.equal(isRowStale({ task_id: "t3", created_at: "2026-07-01T00:00:00.000Z" }, bumps), false);
  });

  it("skips every row with an explicit reason when the verifier is not replayable", () => {
    const { dir } = makeFixture({ replayable: false });
    const [summary] = regradeRuns(dir, {});
    assert.equal(summary.regraded.length, 0);
    assert.equal(summary.new_run_id, null);
    assert.equal(summary.skipped.length, 4);
    assert.ok(summary.skipped.every((s) => s.reason === "verifier_not_replayable"));
  });

  it("honors --task filtering and explicit --run selection", () => {
    const { dir, runId } = makeFixture();
    const [summary] = regradeRuns(dir, { runId, taskIds: ["t1"] });
    assert.equal(summary.rows_considered, 2); // t1 row on model arm + t1 row on null_agent arm
    assert.deepEqual(summary.regraded.map((r) => r.task_id), ["t1"]);
    assert.throws(() => regradeRuns(dir, { runId: "no-such-run" }), /no rows found for run no-such-run/);
  });

  it("never re-regrades regrade output rows by default and allocates the next -regrade-<n> id", () => {
    const { dir, runId } = makeFixture();
    const first = regradeRuns(dir, {});
    assert.equal(first[0].new_run_id, `${runId}-regrade-1`);
    const second = regradeRuns(dir, {});
    // Source run regrades again (regrade-2); the regrade-1 rows are skipped as already_regraded_row.
    const bySource = new Map(second.map((s) => [s.run_id, s]));
    assert.equal(bySource.get(runId).new_run_id, `${runId}-regrade-2`);
    const derived = bySource.get(`${runId}-regrade-1`);
    assert.equal(derived.regraded.length, 0);
    assert.ok(derived.skipped.every((s) => s.reason === "already_regraded_row"));
  });

  it("allocateRegradeRunId skips ids already present in rows files or known runs", () => {
    const { dir, runId } = makeFixture();
    writeFileSync(join(dir, `rows-${runId}-regrade-1-whatever.jsonl`), "");
    assert.equal(allocateRegradeRunId(dir, runId, new Set([`${runId}-regrade-2`])), `${runId}-regrade-3`);
  });

  it("stamps regraded rows with the CURRENT task version + content hashes (stamped tasks only)", () => {
    const { dir, runId, model } = makeFixture();
    regradeRuns(dir, { now: () => new Date("2026-07-23T00:00:00.000Z") });
    const rows = readFileSync(rowsFilePath(dir, `${runId}-regrade-1`, model), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rowT1 = rows.find((r) => r.task_id === "t1");
    assert.equal(rowT1.provenance.task_version, "1.1.0");
    assert.deepEqual(rowT1.provenance.task_content_hashes, {
      env_sha256: "a".repeat(64),
      verifier_sha256: "b".repeat(64),
      meta_sha256: "c".repeat(64),
    });
    // t2's sidecar task is unstamped — its regraded row carries no stamp
    // (staleness falls back to created_at for such rows), never a fake one.
    const rowT2 = rows.find((r) => r.task_id === "t2");
    assert.equal(rowT2.provenance.task_version, undefined);
    assert.equal(rowT2.provenance.task_content_hashes, undefined);
    // A stamped row matching the current task stays fresh through the
    // hash-preferred gate even though a MINOR bump was just appended.
    const lines = readFileSync(join(dir, "versions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bumps = latestBreakingBumps(lines);
    const currentTasks = { t1: { version: "1.1.0", content_hashes: rowT1.provenance.task_content_hashes } };
    assert.equal(isRowStale(rowT1, bumps, currentTasks), false);
    // A row stamped with DIFFERENT env hashes is stale regardless of created_at.
    const oldStamped = { task_id: "t1", created_at: "2027-01-01T00:00:00.000Z", provenance: { task_content_hashes: { env_sha256: "d".repeat(64), verifier_sha256: "b".repeat(64), meta_sha256: "c".repeat(64) } } };
    assert.equal(isRowStale(oldStamped, bumps, currentTasks), true);
  });

  it("snapshots per-task version/hash stamps onto the appended versions.jsonl entry", () => {
    const { dir } = makeFixture();
    const [summary] = regradeRuns(dir, { now: () => new Date("2026-07-23T00:00:00.000Z") });
    const entry = summary.version_entry;
    assert.ok(Array.isArray(entry.tasks));
    assert.deepEqual(entry.tasks.map((t) => t.task_id), ["t1", "t2", "t3"]);
    const t1 = entry.tasks.find((t) => t.task_id === "t1");
    assert.equal(t1.version, "1.1.0");
    assert.equal(t1.content_hashes.env_sha256, "a".repeat(64));
    // Unstamped tasks snapshot honestly as nulls (no invented hashes).
    const t2 = entry.tasks.find((t) => t.task_id === "t2");
    assert.equal(t2.version, null);
    assert.equal(t2.content_hashes, null);
  });

  it("appends first-class regrade events to runs/events.jsonl (claimed + completed)", () => {
    const { dir, runId } = makeFixture();
    regradeRuns(dir, { now: () => new Date("2026-07-23T00:00:00.000Z") });
    const eventsFile = join(dir, "runs", "events.jsonl");
    assert.ok(existsSync(eventsFile));
    const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.schema_version, "understudy.run_event.v1");
      assert.equal(event.type, "regrade");
      assert.equal(event.run_id, `${runId}-regrade-1`);
      assert.equal(event.source_run_id, runId);
      assert.equal(event.ts, "2026-07-23T00:00:00.000Z");
      assert.equal(typeof event.executor_version, "string");
    }
    assert.deepEqual(events[0].progress, { completed: 0, total: 2 });
    assert.equal(events[0].status, "claimed");
    assert.equal(events[1].status, "completed");
    assert.deepEqual(events[1].progress, { completed: 2, total: 2 });
    assert.equal(events[1].rows_considered, 4);
    assert.equal(events[1].skipped, 2);
    // Dry runs journal nothing.
    const { dir: dryDir } = makeFixture();
    regradeRuns(dryDir, { dryRun: true });
    assert.ok(!existsSync(join(dryDir, "runs", "events.jsonl")));
  });

  it("loadRetainedTraces is empty for an arm without a structural work dir", () => {
    const { dir, runId } = makeFixture();
    assert.equal(loadRetainedTraces(dir, runId, "null_agent").size, 0);
    assert.equal(loadRetainedTraces(dir, runId, "gpt-x").size, 2);
  });
});
