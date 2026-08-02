import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { evaluatePromotion } from "../dist/adapter-portfolio/gate.js";
import {
  addEvidence,
  emptyRegistry,
  registerAdapter,
  saveRegistry,
  updateAdapter,
} from "../dist/adapter-portfolio/store.js";

const roots = [];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const holdoutSha = sha("sealed holdout");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "understudy-adapter-portfolio-"));
  roots.push(root);
  return { root, registryPath: join(root, "portfolio.json") };
}

function add(path, name, input) {
  return addEvidence(name, input, { registryPath: path });
}

function candidateFixture(policy = {}) {
  const data = fixture();
  saveRegistry(emptyRegistry({
    metric: "band_mean_score",
    min_dev_score: 0.7,
    min_holdout_score: 0.7,
    ...policy,
  }), { registryPath: data.registryPath });
  registerAdapter({
    name: "adapter-a", adapterPath: "./adapter-a", baseModel: "base-model",
    suite: "workload-band-a", method: "sft-lora",
    holdout: { path: "./holdout.jsonl", sha256: holdoutSha, row_count: 2 },
  }, { registryPath: data.registryPath });
  updateAdapter("adapter-a", { status: "candidate" }, { registryPath: data.registryPath });
  return data;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adapter portfolio", () => {
  it("blocks without transfer evidence, then promotes after sealed dev/holdout and rechecks", () => {
    const data = fixture();
    saveRegistry(emptyRegistry({ metric: "band_mean_score", min_dev_score: 0.8, min_holdout_score: 0.78 }), { registryPath: data.registryPath });
    registerAdapter({
      name: "adapter-a", adapterPath: "./adapter-a", baseModel: "base-model",
      suite: "workload-band-a", method: "sft-lora",
      holdout: { path: "./holdout.jsonl", sha256: holdoutSha, row_count: 2 },
    }, { registryPath: data.registryPath });
    updateAdapter("adapter-a", { status: "candidate" }, { registryPath: data.registryPath });
    const base = {
      suite: "workload-band-a", split: "holdout", score: 0.8, metric: "band_mean_score",
      dataset_sha256: holdoutSha, row_count: 2, context: { loaded_adapters: [] },
    };
    add(data.registryPath, "adapter-a", { ...base, subject: "base", recorded_at: "2026-01-01T00:00:00.000Z" });
    add(data.registryPath, "adapter-a", {
      ...base, subject: "adapter", adapter_name: "adapter-a", split: "dev",
      score: 0.85, dataset_sha256: sha("dev"), recorded_at: "2026-01-01T00:01:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      ...base, subject: "adapter", adapter_name: "adapter-a", score: 0.82,
      recorded_at: "2026-01-01T00:02:00.000Z",
    });
    let decision = evaluatePromotion(JSON.parse(readFileSync(data.registryPath)), "adapter-a");
    assert.equal(decision.decision, "blocked");
    assert.equal(decision.checks.find((item) => item.check === "no_forgetting").status, "missing_evidence");
    add(data.registryPath, "adapter-a", { ...base, subject: "base", score: 0.8, recorded_at: "2026-01-01T00:03:00.000Z", context: { loaded_adapters: ["adapter-a"] } });
    decision = evaluatePromotion(JSON.parse(readFileSync(data.registryPath)), "adapter-a");
    assert.equal(decision.decision, "promote");
    assert.equal(statSync(data.registryPath).mode & 0o777, 0o600);
  });

  it("exposes init/register/list/gate through the CLI", () => {
    const data = fixture();
    const cli = resolve("dist/bin.js");
    const init = spawnSync(process.execPath, [cli, "adapter-portfolio", "init", "--registry-path", data.registryPath, "--json"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const register = spawnSync(process.execPath, [cli, "adapter-portfolio", "register", "--registry-path", data.registryPath, "--name", "adapter-cli", "--path", "./a", "--base", "base", "--suite", "suite", "--json"], { encoding: "utf8" });
    assert.equal(register.status, 0, register.stderr);
    const listed = spawnSync(process.execPath, [cli, "adapter-portfolio", "list", "--registry-path", data.registryPath, "--json"], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].name, "adapter-cli");
  });

  it("scores the worst holdout rerun instead of rescuing a failing candidate", () => {
    const data = candidateFixture();
    add(data.registryPath, "adapter-a", {
      subject: "base", suite: "workload-band-a", split: "dev", score: 0.7,
      metric: "band_mean_score", dataset_sha256: sha("base-dev"), row_count: 2,
      context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:00:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a",
      split: "dev", score: 0.8, metric: "band_mean_score", dataset_sha256: sha("dev"),
      row_count: 2, context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:01:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "base", suite: "workload-band-a", split: "holdout", score: 0.7,
      metric: "band_mean_score", dataset_sha256: holdoutSha, row_count: 2,
      context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:02:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a",
      split: "holdout", score: 0.65, metric: "band_mean_score", dataset_sha256: holdoutSha,
      row_count: 2, context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:03:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a",
      split: "holdout", score: 0.99, metric: "band_mean_score", dataset_sha256: holdoutSha,
      row_count: 2, context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:04:00.000Z",
    });

    const decision = evaluatePromotion(JSON.parse(readFileSync(data.registryPath)), "adapter-a");
    const holdoutCheck = decision.checks.find((item) => item.check === "holdout_pass");
    assert.equal(decision.decision, "blocked");
    assert.equal(holdoutCheck.status, "fail");
    assert.match(holdoutCheck.detail, /2 holdout runs recorded; scoring the worst/);
    assert.match(holdoutCheck.detail, /0\.65/);
  });

  it("blocks holdout evidence that misses the required lift over base", () => {
    const data = candidateFixture({ min_lift_vs_base: 0.05 });
    add(data.registryPath, "adapter-a", {
      subject: "base", suite: "workload-band-a", split: "dev", score: 0.7,
      metric: "band_mean_score", dataset_sha256: sha("base-dev"), row_count: 2,
      context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:00:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a",
      split: "dev", score: 0.8, metric: "band_mean_score", dataset_sha256: sha("dev"),
      row_count: 2, context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:01:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "base", suite: "workload-band-a", split: "holdout", score: 0.8,
      metric: "band_mean_score", dataset_sha256: holdoutSha, row_count: 2,
      context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:02:00.000Z",
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a",
      split: "holdout", score: 0.82, metric: "band_mean_score", dataset_sha256: holdoutSha,
      row_count: 2, context: { loaded_adapters: [] }, recorded_at: "2026-01-01T00:03:00.000Z",
    });

    const decision = evaluatePromotion(JSON.parse(readFileSync(data.registryPath)), "adapter-a");
    const holdoutCheck = decision.checks.find((item) => item.check === "holdout_pass");
    assert.equal(decision.decision, "blocked");
    assert.equal(holdoutCheck.status, "fail");
    assert.match(holdoutCheck.detail, /required lift 0\.05/);
  });
});
