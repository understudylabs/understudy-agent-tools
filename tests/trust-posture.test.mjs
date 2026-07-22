import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_TRUST_POSTURE,
  TRUST_LEVELS,
  TRUST_POSTURE_SCHEMA,
  raiseTrustHint,
  readTrustPosture,
  resolveTrustBoundaries,
  trustAtLeast,
  trustPosturePath,
  writeTrustPosture,
} from "../dist/config/trust.js";
import { DEFAULT_REVIEW_POLICY, readReviewPolicy } from "../dist/benchmark-artifacts.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trust-posture-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const envWith = (name) => ({ UNDERSTUDY_TRUST_FILE: path.join(tmp, name) });

describe("trust posture file", () => {
  it("defaults to local_sandbox with NO overrides when the file is absent", () => {
    const posture = readTrustPosture(envWith("absent.json"));
    assert.deepEqual(posture, { ...DEFAULT_TRUST_POSTURE, overrides: {} });
  });

  it("is tolerant: unreadable / wrong-schema / junk fields never widen autonomy", () => {
    const env = envWith("junk.json");
    fs.writeFileSync(trustPosturePath(env), "not json");
    assert.equal(readTrustPosture(env).level, "local_sandbox");
    fs.writeFileSync(trustPosturePath(env), JSON.stringify({ schema_version: "wrong", level: "hosted_ops" }));
    assert.equal(readTrustPosture(env).level, "local_sandbox");
    fs.writeFileSync(
      trustPosturePath(env),
      JSON.stringify({
        schema_version: TRUST_POSTURE_SCHEMA,
        level: "yolo_mode",
        overrides: { allow_spend_usd_per_run: -5, allow_provider_upload: "yes" },
      }),
    );
    const posture = readTrustPosture(env);
    assert.equal(posture.level, "local_sandbox");
    assert.deepEqual(posture.overrides, {});
  });

  it("writeTrustPosture merge-writes and round-trips; null clears an override", () => {
    const env = envWith("write.json");
    writeTrustPosture({ level: "bounded_experiments", overrides: { allow_spend_usd_per_run: 25 } }, env);
    let posture = readTrustPosture(env);
    assert.equal(posture.level, "bounded_experiments");
    assert.equal(posture.overrides.allow_spend_usd_per_run, 25);
    assert.ok(posture.set_at, "set_at stamped");
    writeTrustPosture({ overrides: { allow_provider_upload: true } }, env);
    posture = readTrustPosture(env);
    assert.equal(posture.level, "bounded_experiments", "level preserved on override-only write");
    assert.equal(posture.overrides.allow_spend_usd_per_run, 25, "existing override preserved");
    assert.equal(posture.overrides.allow_provider_upload, true);
    writeTrustPosture({ overrides: { allow_spend_usd_per_run: null } }, env);
    assert.equal(readTrustPosture(env).overrides.allow_spend_usd_per_run, undefined, "null clears back to default");
  });
});

describe("posture resolution matrix", () => {
  const at = (level, overrides = {}) => ({ schema_version: TRUST_POSTURE_SCHEMA, level, set_at: null, overrides });

  it("levels order local_sandbox < bounded_experiments < hosted_ops", () => {
    assert.deepEqual(TRUST_LEVELS, ["local_sandbox", "bounded_experiments", "hosted_ops"]);
    assert.equal(trustAtLeast(at("local_sandbox"), "bounded_experiments"), false);
    assert.equal(trustAtLeast(at("bounded_experiments"), "bounded_experiments"), true);
    assert.equal(trustAtLeast(at("hosted_ops"), "bounded_experiments"), true);
    assert.equal(trustAtLeast(at("bounded_experiments"), "hosted_ops"), false);
  });

  it("level defaults: upload/traffic open only at hosted_ops; spend has NO cap at ANY level", () => {
    for (const [level, expected] of [
      ["local_sandbox", false],
      ["bounded_experiments", false],
      ["hosted_ops", true],
    ]) {
      const resolved = resolveTrustBoundaries(at(level));
      assert.equal(resolved.allow_provider_upload, expected, `${level} upload`);
      assert.equal(resolved.allow_traffic_changes, expected, `${level} traffic`);
      assert.equal(resolved.spend_stop_loss_usd, null, `${level} has no default spend cap`);
    }
  });

  it("explicit per-boundary overrides always win over the level default", () => {
    const widened = resolveTrustBoundaries(at("local_sandbox", { allow_provider_upload: true, allow_spend_usd_per_run: 10 }));
    assert.equal(widened.allow_provider_upload, true);
    assert.equal(widened.spend_stop_loss_usd, 10);
    const narrowed = resolveTrustBoundaries(at("hosted_ops", { allow_traffic_changes: false, allow_provider_upload: false }));
    assert.equal(narrowed.allow_traffic_changes, false);
    assert.equal(narrowed.allow_provider_upload, false);
  });

  it("raiseTrustHint is the ONE action a blocked gate offers", () => {
    assert.equal(raiseTrustHint("bounded_experiments"), "understudy trust set bounded_experiments");
  });
});

describe("born-accepted review default (no pending-first path)", () => {
  it("default_decision is accept by default and for any absent/invalid sidecar", () => {
    assert.equal(DEFAULT_REVIEW_POLICY.default_decision, "accept");
    assert.equal(readReviewPolicy(tmp).default_decision, "accept", "absent sidecar → accept");
    fs.writeFileSync(path.join(tmp, "review-policy.json"), JSON.stringify({ schema_version: "understudy.review_policy.v1", default_decision: "sometimes" }));
    assert.equal(readReviewPolicy(tmp).default_decision, "accept", "unrecognized value → accept");
    fs.writeFileSync(path.join(tmp, "review-policy.json"), JSON.stringify({ schema_version: "understudy.review_policy.v1", default_decision: "pending" }));
    assert.equal(readReviewPolicy(tmp).default_decision, "pending", "pending remains available ONLY as explicit config");
  });

  it("no code path writes a pending-first review policy (explicit config only)", () => {
    // The writer surface: grep-equivalent — reviewPolicyPath is read-only in src.
    const srcFiles = fs
      .readdirSync("src", { recursive: true })
      .filter((f) => String(f).endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join("src", String(f)), "utf8"))
      .join("\n");
    assert.doesNotMatch(srcFiles, /default_decision"?\s*:\s*"pending"/, "nothing ships a pending-first policy");
  });
});
