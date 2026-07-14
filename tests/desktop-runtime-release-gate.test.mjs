import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  defaultDesktopConformanceEvidencePath,
  defaultDesktopReadinessEvidencePath,
  evaluateDesktopRuntimeReleaseEvidence,
} from "../dist/runtime/conversation/release-gate.js";

test("desktop release evidence defaults are bound to the exact app and runtime versions", () => {
  assert.equal(
    defaultDesktopConformanceEvidencePath("0.3.14"),
    ".understudy/capture-evidence/desktop-runtime-conformance-0.3.14.json",
  );
  assert.equal(
    defaultDesktopReadinessEvidencePath("0.3.14"),
    ".understudy/capture-evidence/desktop-runtime-readiness-0.3.14.json",
  );

  const report = evaluateDesktopRuntimeReleaseEvidence({
    app_version: "0.3.14",
    runtime_version: "0.3.14",
  });
  assert.equal(
    report.conformance.path,
    resolve(".understudy/capture-evidence/desktop-runtime-conformance-0.3.14.json"),
  );
  assert.equal(
    report.readiness.path,
    resolve(".understudy/capture-evidence/desktop-runtime-readiness-0.3.14.json"),
  );
});

test("desktop release evidence filenames sanitize non-version path characters", () => {
  assert.equal(
    defaultDesktopConformanceEvidencePath(" release/0.3.14 candidate "),
    ".understudy/capture-evidence/desktop-runtime-conformance-release-0.3.14-candidate.json",
  );
  assert.equal(
    defaultDesktopReadinessEvidencePath("   "),
    ".understudy/capture-evidence/desktop-runtime-readiness-unknown.json",
  );
});
