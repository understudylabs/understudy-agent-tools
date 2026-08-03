import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCalibrationReport, resolveBand, summarizeBands } from "../dist/difficulty-calibration.js";
const source = { path: "synthetic.json", sha256: "a".repeat(64) };
describe("difficulty calibration", () => {
  it("uses generic explicit bands only", () => { assert.equal(resolveBand({ task_id: "x", band: "hard" }), "hard"); assert.equal(resolveBand({ task_id: "simple-api-crm-close-01" }), "unknown"); });
  it("lets insufficient sample override saturation", () => { const s = summarizeBands([{ task_id: "x", band: "easy", score: 1 }]); assert.equal(s.easy.status, "insufficient_sample"); assert.equal(s.easy.verdict, "caution"); });
  it("requires a source binding hash and supports synthetic headroom", () => { assert.throws(() => buildCalibrationReport([{ task_id: "x", band: "hard", score: 0 }], { source: { path: "x", sha256: "bad" } }), /source/); const rows = Array.from({ length: 10 }, (_, i) => ({ task_id: `x-${i}`, band: "hard", score: i / 20 })); const r = buildCalibrationReport(rows, { source, model: "synthetic", split: "dev", generatedAt: "2026-08-03T00:00:00.000Z" }); assert.equal(r.bands.hard.status, "measurable"); assert.equal(r.gate.worth_investing, true); });
});
