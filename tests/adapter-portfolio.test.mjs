import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { evaluatePromotion } from "../dist/adapter-portfolio/gate.js";
import { workflowIdentityRefs } from "../dist/adapter-portfolio/contract.js";
import {
  evaluateAdapterPortfolioStep,
  promotionEvents,
} from "../dist/adapter-portfolio/step.js";
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

  it("runs the documented dev-to-holdout-to-gate CLI sequence", () => {
    const data = fixture();
    const cli = resolve("dist/bin.js");
    const run = (...args) => spawnSync(
      process.execPath,
      [cli, "adapter-portfolio", ...args, "--registry-path", data.registryPath, "--json"],
      { encoding: "utf8" },
    );
    const init = run("init", "--min-dev-score", "0.8", "--min-holdout-score", "0.78");
    assert.equal(init.status, 0, init.stderr);
    const register = run(
      "register", "--name", "adapter-docs", "--path", "./adapter-docs",
      "--base", "base-model", "--suite", "workload-band-docs", "--method", "sft-lora",
      "--holdout-path", "./holdout.jsonl", "--holdout-sha256", holdoutSha, "--holdout-rows", "2",
    );
    assert.equal(register.status, 0, register.stderr);
    assert.equal(run("candidate", "adapter-docs").status, 0);
    const dev = run(
      "evidence", "add", "--adapter", "adapter-docs", "--suite", "workload-band-docs",
      "--split", "dev", "--score", "0.84", "--metric", "score",
      "--dataset-sha256", sha("dev-docs"), "--rows", "2", "--seed", "7",
    );
    assert.equal(dev.status, 0, dev.stderr);
    const holdout = run(
      "evidence", "add", "--adapter", "adapter-docs", "--suite", "workload-band-docs",
      "--split", "holdout", "--score", "0.81", "--metric", "score",
      "--dataset-sha256", holdoutSha, "--rows", "2", "--seed", "7",
    );
    assert.equal(holdout.status, 0, holdout.stderr);
    const missingBaseOwner = run(
      "evidence", "add", "--base", "--suite", "workload-band-docs",
      "--split", "holdout", "--score", "0.8", "--metric", "score",
      "--dataset-sha256", holdoutSha, "--rows", "2",
    );
    assert.equal(missingBaseOwner.status, 1);
    assert.match(JSON.parse(missingBaseOwner.stdout).error, /requires --for <adapter>/);
    const gate = run("gate", "adapter-docs");
    assert.equal(gate.status, 1);
    assert.equal(JSON.parse(gate.stdout).decision, "blocked");
    const promote = run("promote", "adapter-docs", "--dry-run");
    assert.equal(promote.status, 1);
    assert.equal(JSON.parse(promote.stdout).decision.decision, "blocked");
  });

  it("keeps canonical executor identity projections structurally holdout-free", () => {
    const data = candidateFixture();
    const registry = JSON.parse(readFileSync(data.registryPath));
    registry.adapters["adapter-a"].workload = {
      id: "workload-a",
      dataset_manifest_ref: "artifact://workload-a",
      dataset_manifest_sha256: sha("workload-manifest"),
      verifier_environment: "verifier-a",
      verifier_revision: "rev-1",
    };
    registry.adapters["adapter-a"].splits = {
      train_manifest_ref: "artifact://train-a",
      train_manifest_sha256: sha("train-manifest"),
      dev_manifest_ref: "artifact://dev-a",
      dev_manifest_sha256: sha("dev-manifest"),
    };
    saveRegistry(registry, { registryPath: data.registryPath });
    const adapter = JSON.parse(readFileSync(data.registryPath)).adapters["adapter-a"];
    const projection = workflowIdentityRefs(adapter);
    const serialized = JSON.stringify(projection);
    assert.deepEqual(Object.keys(projection).sort(), ["splits", "workload"]);
    assert.doesNotMatch(serialized, /holdout|score|row_count/i);
    assert.equal(projection.workload.dataset_manifest_ref, "artifact://workload-a");
    assert.equal(projection.splits.dev_manifest_ref, "artifact://dev-a");
    assert.equal(projection.splits.dev_manifest_sha256, sha("dev-manifest"));
  });

  it("blocks promotion when the sealed holdout is marked executed", () => {
    const data = candidateFixture();
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a", split: "dev",
      score: 0.9, metric: "band_mean_score", dataset_sha256: sha("dev"), row_count: 2,
      recorded_at: "2026-01-01T00:00:00.000Z", context: { loaded_adapters: [] },
    });
    add(data.registryPath, "adapter-a", {
      subject: "adapter", adapter_name: "adapter-a", suite: "workload-band-a", split: "holdout",
      score: 0.9, metric: "band_mean_score", dataset_sha256: holdoutSha, row_count: 2,
      recorded_at: "2026-01-01T00:01:00.000Z", context: { loaded_adapters: [] },
    });
    const registry = JSON.parse(readFileSync(data.registryPath));
    registry.adapters["adapter-a"].holdout_executed = true;
    registry.adapters["adapter-a"].holdout_clean = false;
    saveRegistry(registry, { registryPath: data.registryPath });
    const decision = evaluatePromotion(JSON.parse(readFileSync(data.registryPath)), "adapter-a");
    const sealed = decision.checks.find((item) => item.check === "holdout_sealed");
    assert.equal(decision.decision, "blocked");
    assert.equal(sealed.status, "fail");
    assert.match(sealed.detail, /executed|dirtied/i);
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

  it("is byte-identical on Workflow retries and emits redacted gate events", () => {
    const data = candidateFixture();
    const registry = JSON.parse(readFileSync(data.registryPath));
    const input = {
      experiment_id: "experiment-1",
      candidate_id: "adapter-a",
      attempt: 2,
      evaluated_at: "2026-01-01T00:00:00.000Z",
      registry,
    };
    const first = evaluateAdapterPortfolioStep(input);
    const second = evaluateAdapterPortfolioStep(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.idempotency_key, "experiment-1:adapter-a:2");
    assert.equal(first.inputs.registry.uri, "inline:adapter-portfolio-registry");
    assert.match(first.inputs.registry.sha256, /^[a-f0-9]{64}$/);

    const events = promotionEvents(input, first);
    assert.equal(events.length, first.checks.length + 1);
    assert.equal(events.at(-1).type, "promotion_decision");
    assert.equal(events.at(-1).phase, "terminal");
    assert.ok(events.every((event) => !("detail" in event.details)));
    assert.ok(events.every((event) => event.details.registry_sha256 === first.inputs.registry.sha256));
  });
});
