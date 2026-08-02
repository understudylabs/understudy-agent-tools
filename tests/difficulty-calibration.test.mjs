import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildCalibrationReport,
  resolveBand,
  summarizeBands,
} from "../dist/difficulty-calibration.js";

describe("difficulty calibration", () => {
  it("resolves explicit, fixture-derived, and unknown bands", () => {
    assert.equal(resolveBand({ task_id: "x-01", band: "explicit" }), "explicit");
    assert.equal(resolveBand({ task_id: "simple-api-crm-close-01" }, "v1"), "single-write");
    assert.equal(resolveBand({ task_id: "hard-api-ticket-owner-route-01" }, "v2"), "cross-record");
    assert.equal(resolveBand({ task_id: "unparseable" }), "unknown");
  });

  it("flags saturated, measurable, insufficient, unknown, and unscored rows", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => ({ task_id: `sat-${index}`, band: "saturated", score: 1, split: "train" })),
      ...Array.from({ length: 10 }, (_, index) => ({ task_id: `meas-${index}`, band: "measurable", score: index / 20, split: "train" })),
      { task_id: "small-01", band: "small", score: 0.2, split: "train" },
      { task_id: "unknown-01", score: 0.4, split: "train" },
      { task_id: "unscored-01", band: "measurable", score: null, split: "train" },
      { task_id: "malformed-score", band: "measurable", score: "bad", split: "train" },
      { band: "missing-task-id", score: 1 },
    ];

    const report = buildCalibrationReport(rows, {
      fixture: "auto",
      model: "synthetic",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(report.schema_version, "understudy.difficulty_calibration.v1");
    assert.deepEqual(report.source_run, { path: null, sha256: null });
    assert.equal(report.overall.tasks, 24);
    assert.equal(report.overall.scored, 22);
    assert.equal(report.bands.saturated.status, "saturated");
    assert.equal(report.bands.saturated.verdict, "block_training");
    assert.equal(report.bands.measurable.status, "measurable");
    assert.equal(report.bands.measurable.verdict, "invest");
    assert.equal(report.bands.small.status, "insufficient_sample");
    assert.equal(report.bands.small.verdict, "caution");
    assert.equal(report.bands.unknown.mean_score, 0.4);
    assert.equal(report.gate.worth_investing, true);
  });

  it("computes confidence intervals and configurable sample gates", () => {
    const bands = summarizeBands(
      [{ task_id: "a-01", band: "a", score: 0 }, { task_id: "a-02", band: "a", score: 1 }],
      { minSample: 2 },
    );
    assert.deepEqual(bands.a.ci, { lower: 0, upper: 1 });
    assert.equal(bands.a.low_sample, false);
    assert.throws(() => summarizeBands([], { threshold: 0 }), /threshold/);
    assert.throws(() => summarizeBands([], { minSample: 0 }), /minSample/);
  });

  it("builds a report from a committed v2 run artifact", () => {
    const artifact = JSON.parse(readFileSync("outputs/zeroshot-qwen3p7-plus-dev.json", "utf8"));
    const report = buildCalibrationReport(artifact.rows, {
      model: artifact.model,
      split: artifact.split,
      fixture: "auto",
      source: {
        path: "outputs/zeroshot-qwen3p7-plus-dev.json",
        sha256: "fixture-sha256",
      },
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(report.schema_version, "understudy.difficulty_calibration.v1");
    assert.deepEqual(report.source_run, {
      path: "outputs/zeroshot-qwen3p7-plus-dev.json",
      sha256: "fixture-sha256",
    });
    assert.equal(report.fixture, "automationbench-simple-api-offline-v2");
    assert.ok(Object.keys(report.bands).length > 0);
    assert.ok(report.bands["cross-record"]);
  });
});
