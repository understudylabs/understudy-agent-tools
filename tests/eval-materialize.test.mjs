import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_CAPTURE_BYTES,
  MAX_COHORT_BYTES,
  reserveDownloadedChunk,
} from "../dist/evals/materialize.js";

describe("eval materialization byte budgets", () => {
  it("accepts exact limits and rejects the next byte before reserving it", () => {
    const exactCapture = { used: MAX_COHORT_BYTES - MAX_CAPTURE_BYTES };
    assert.equal(
      reserveDownloadedChunk("req_exact", 0, MAX_CAPTURE_BYTES, exactCapture),
      MAX_CAPTURE_BYTES,
    );
    assert.equal(exactCapture.used, MAX_COHORT_BYTES);

    const captureOverflow = { used: 0 };
    assert.throws(
      () => reserveDownloadedChunk("req_capture", MAX_CAPTURE_BYTES, 1, captureOverflow),
      /Capture req_capture exceeds/,
    );
    assert.equal(captureOverflow.used, 0);

    const cohortOverflow = { used: MAX_COHORT_BYTES };
    assert.throws(
      () => reserveDownloadedChunk("req_cohort", 0, 1, cohortOverflow),
      /Cohort payloads exceed/,
    );
    assert.equal(cohortOverflow.used, MAX_COHORT_BYTES);
  });
});
