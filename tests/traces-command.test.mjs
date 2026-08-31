import assert from "node:assert/strict";
import test from "node:test";

import { resolveBenchmarkReferenceTime } from "../dist/commands/traces.js";

test("provable-lineage compilation requires the frozen eval reference time", () => {
  assert.throws(
    () => resolveBenchmarkReferenceTime(undefined, true),
    /requires --reference-time from eval-project\.json source\.window\.to/i,
  );
  assert.equal(
    resolveBenchmarkReferenceTime("2026-08-30T12:00:00.000Z", true).toISOString(),
    "2026-08-30T12:00:00.000Z",
  );
});

test("ordinary local compilation retains its current-time default", () => {
  const fallback = new Date("2026-08-31T12:00:00.000Z");
  assert.equal(resolveBenchmarkReferenceTime(undefined, false, fallback), fallback);
});
