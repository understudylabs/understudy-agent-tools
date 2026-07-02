import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  expandFileSource,
  readTail,
  recordReview,
  runCheck,
  sha256,
} from "../skills/watch-logs/scripts/watch-logs.mjs";

const script = resolve("skills/watch-logs/scripts/watch-logs.mjs");
const schema = JSON.parse(readFileSync(resolve("schemas/understudy.eval_result.v1.schema.json"), "utf8"));

let dir;
let stateDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "understudy-watch-logs-"));
  stateDir = join(dir, "watch-state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(sources, watchId = "ops") {
  const path = join(dir, "watch.json");
  writeFileSync(path, `${JSON.stringify({ watch_id: watchId, sources }, null, 2)}\n`);
  return path;
}

function check(configPath) {
  return spawnSync("node", [script, "check", "--config", configPath, "--state-dir", stateDir, "--json"], {
    encoding: "utf8",
  });
}

describe("watch-logs check trigger", () => {
  it("first run exits 1 (changed) and writes state + a baseline snapshot", () => {
    const log = join(dir, "app.log");
    writeFileSync(log, "line one\n");
    const configPath = writeConfig([{ id: "app", type: "file", path: log }]);

    const result = check(configPath);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.changed, true);
    assert.equal(payload.first_run, true);
    assert.deepEqual(payload.changed_sources, ["app"]);
    assert.ok(existsSync(join(stateDir, "state", "ops.json")));
    const snapshot = JSON.parse(readFileSync(payload.snapshot_path, "utf8"));
    assert.equal(snapshot.schema_version, "understudy.watch_logs_snapshot.v1");
    assert.match(snapshot.changed[0].content, /line one/);
  });

  it("unchanged second run exits 0 and writes no new snapshot", () => {
    const log = join(dir, "app.log");
    writeFileSync(log, "steady\n");
    const configPath = writeConfig([{ id: "app", type: "file", path: log }]);

    assert.equal(check(configPath).status, 1);
    const snapshotsBefore = readdirSync(join(stateDir, "snapshots")).length;
    const second = check(configPath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).changed, false);
    assert.equal(readdirSync(join(stateDir, "snapshots")).length, snapshotsBefore);
  });

  it("detects an appended log line and snapshots only the changed source", () => {
    const app = join(dir, "app.log");
    const quiet = join(dir, "quiet.log");
    writeFileSync(app, "boot\n");
    writeFileSync(quiet, "nothing here\n");
    const configPath = writeConfig([
      { id: "app", type: "file", path: app },
      { id: "quiet", type: "file", path: quiet },
    ]);

    assert.equal(check(configPath).status, 1);
    appendFileSync(app, "ERROR: kaboom\n");
    const result = check(configPath);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.changed_sources, ["app"]);
    const snapshot = JSON.parse(readFileSync(payload.snapshot_path, "utf8"));
    assert.equal(snapshot.changed.length, 1);
    assert.match(snapshot.changed[0].content, /ERROR: kaboom/);
    assert.deepEqual(snapshot.unchanged, ["quiet"]);
  });

  it("glob sources register new matching files as change", () => {
    const logs = join(dir, "workers");
    mkdirSync(logs);
    writeFileSync(join(logs, "w1.log"), "w1 ok\n");
    const configPath = writeConfig([{ id: "workers", type: "file", glob: join(logs, "*.log") }]);

    assert.equal(check(configPath).status, 1);
    assert.equal(check(configPath).status, 0);
    writeFileSync(join(logs, "w2.log"), "w2 up\n");
    writeFileSync(join(logs, "ignore.txt"), "not a log\n");
    const result = check(configPath);
    assert.equal(result.status, 1);
    const snapshot = JSON.parse(readFileSync(JSON.parse(result.stdout).snapshot_path, "utf8"));
    assert.match(snapshot.changed[0].content, /w2 up/);
    assert.doesNotMatch(snapshot.changed[0].content, /not a log/);
  });

  it("command sources hash exit code and output", () => {
    const probe = join(dir, "probe.txt");
    writeFileSync(probe, "healthy\n");
    const configPath = writeConfig([{ id: "probe", type: "command", command: `cat ${probe}` }]);

    assert.equal(check(configPath).status, 1);
    assert.equal(check(configPath).status, 0);
    writeFileSync(probe, "connection refused\n");
    const result = check(configPath);
    assert.equal(result.status, 1);
    const snapshot = JSON.parse(readFileSync(JSON.parse(result.stdout).snapshot_path, "utf8"));
    assert.match(snapshot.changed[0].content, /exit=0/);
    assert.match(snapshot.changed[0].content, /connection refused/);
  });

  it("respects tail_bytes so huge logs stay cheap", () => {
    const log = join(dir, "big.log");
    writeFileSync(log, `${"x".repeat(10_000)}\nTAIL-MARKER\n`);
    const config = { watch_id: "big", sources: [{ id: "big", type: "file", path: log, tail_bytes: 64 }] };
    const result = runCheck({ config, stateDir });
    assert.equal(result.changed, true);
    const snapshot = JSON.parse(readFileSync(result.snapshot_path, "utf8"));
    assert.match(snapshot.changed[0].content, /TAIL-MARKER/);
    assert.ok(snapshot.changed[0].content.length < 200);
  });

  it("missing config exits 2", () => {
    const result = check(join(dir, "nope.json"));
    assert.equal(result.status, 2);
  });
});

describe("watch-logs unit helpers", () => {
  it("sha256 is stable and content-sensitive", () => {
    assert.equal(sha256("abc"), sha256("abc"));
    assert.notEqual(sha256("abc"), sha256("abd"));
  });

  it("expandFileSource matches basename globs only, sorted", () => {
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "b.log"), "");
    writeFileSync(join(dir, "logs", "a.log"), "");
    writeFileSync(join(dir, "logs", "c.txt"), "");
    const matched = expandFileSource({ glob: join(dir, "logs", "*.log") });
    assert.deepEqual(matched, [join(dir, "logs", "a.log"), join(dir, "logs", "b.log")]);
    assert.deepEqual(expandFileSource({ glob: join(dir, "absent", "*.log") }), []);
    assert.throws(() => expandFileSource({ glob: join(dir, "*", "x.log") }), /basename/);
  });

  it("readTail returns only the last N bytes", () => {
    const path = join(dir, "tail.log");
    writeFileSync(path, "0123456789");
    assert.deepEqual(readTail(path, 4), { text: "6789", size: 10 });
    assert.deepEqual(readTail(path, 100).text, "0123456789");
  });
});

describe("watch-logs record (eval rows)", () => {
  const review = {
    watch_id: "ops",
    snapshot_id: "ops-2026-07-02T09-05-00-000Z",
    verdict: "anomaly",
    summary: "Worker restart loop after deploy.",
    anomalies: [{ source_id: "app", line: "ERROR: kaboom", note: "crash", severity: "high" }],
    model: "gemma-4-e2b",
    route: "local",
    latency_ms: 840,
    prompt_sha256: sha256("prompt-v1"),
    snapshot_path: "/tmp/example-snapshot.json",
  };

  it("appends a schema-valid understudy.eval_result.v1 row", () => {
    const { row, reviews_path } = recordReview({ review, stateDir });
    for (const field of schema.required) {
      assert.ok(row[field] !== undefined && row[field] !== null, `missing required ${field}`);
    }
    assert.equal(row.schema_version, schema.properties.schema_version.const);
    assert.ok(schema.properties.status.enum.includes(row.status));
    assert.equal(row.run_id, "watch-logs:ops");
    assert.equal(row.task_id, review.snapshot_id);
    assert.equal(row.split, "none");
    assert.equal(row.score, null);
    assert.equal(row.status, "unscored");
    assert.equal(row.provenance.harness_sha256, review.prompt_sha256);
    assert.deepEqual(row.provenance.artifact_refs, [review.snapshot_path]);
    assert.equal(row.review.verdict, "anomaly");

    const lines = readFileSync(reviews_path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).review.anomalies, review.anomalies);
  });

  it("a scored row becomes status ok; review-failed becomes error", () => {
    const scored = recordReview({ review: { ...review, score: 1 }, stateDir }).row;
    assert.equal(scored.status, "ok");
    assert.equal(scored.score, 1);
    const failed = recordReview({ review: { ...review, verdict: "review-failed" }, stateDir }).row;
    assert.equal(failed.status, "error");
  });

  it("CLI record appends via --row and accumulates JSONL", () => {
    const rowPath = join(dir, "review.json");
    writeFileSync(rowPath, JSON.stringify(review));
    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync("node", [script, "record", "--state-dir", stateDir, "--row", rowPath], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const lines = readFileSync(join(stateDir, "reviews", "reviews.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("rejects rows without a verdict, summary, or identifiers", () => {
    assert.throws(() => recordReview({ review: { ...review, verdict: "maybe" }, stateDir }), /verdict/);
    assert.throws(() => recordReview({ review: { ...review, summary: "" }, stateDir }), /summary/);
    assert.throws(() => recordReview({ review: { ...review, anomalies: [] }, stateDir }), /at least one/);
    assert.throws(
      () => recordReview({ review: { ...review, verdict: "nothing-wrong" }, stateDir }),
      /empty anomalies/,
    );
    // an honest all-clear review records cleanly
    const clear = recordReview({
      review: { ...review, verdict: "nothing-wrong", anomalies: [], summary: "Deploy noise only; healthy." },
      stateDir,
    }).row;
    assert.equal(clear.review.verdict, "nothing-wrong");
    assert.throws(
      () => recordReview({ review: { ...review, watch_id: undefined, snapshot_id: undefined }, stateDir }),
      /run_id|task_id/,
    );
    const result = spawnSync("node", [script, "record", "--state-dir", stateDir, "--row", join(dir, "missing.json")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
  });
});
