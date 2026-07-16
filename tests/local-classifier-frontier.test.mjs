import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  compareClassifierWithFrontier,
  FRONTIER_CLASSIFICATION_SCHEMA,
} from "../dist/local-classifier/frontier.js";

const roots = [];
const fakeAuth = {
  token: "sk_test",
  mode: "api_key",
  gatewayUrl: "https://api.understudylabs.com",
  orgId: "org_test",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "understudy-frontier-classifier-"));
  roots.push(root);
  const datasetRoot = join(root, "dataset");
  const runRoot = join(root, "runs", "desktop-frontier-test");
  mkdirSync(datasetRoot, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  const rows = [
    {
      schema_version: "understudy.classification_example.v2",
      example_id: "example-ham",
      group_id: "a".repeat(24),
      text: "See you at lunch",
      label: "ham",
    },
    {
      schema_version: "understudy.classification_example.v2",
      example_id: "example-spam",
      group_id: "b".repeat(24),
      text: "Claim your prize now",
      label: "spam",
    },
  ];
  const holdoutRaw = `${rows.map(JSON.stringify).join("\n")}\n`;
  const holdoutPath = join(datasetRoot, "holdout.jsonl");
  writeFileSync(holdoutPath, holdoutRaw);
  const datasetManifestPath = join(datasetRoot, "dataset-manifest.json");
  writeFileSync(datasetManifestPath, "{}\n");
  const runManifestPath = join(runRoot, "run-manifest.json");
  const runManifest = {
    schema_version: "understudy.capture_import.classification_run.v1",
    run_id: "desktop-frontier-test",
    status: "completed",
    local_only: true,
    manifest_path: runManifestPath,
    dataset: {
      manifest_path: datasetManifestPath,
      splits: {
        holdout: {
          path: holdoutPath,
          row_count: rows.length,
          sha256: sha256(holdoutRaw),
        },
      },
    },
    model: { labels: ["ham", "spam"] },
    heldout: { row_count: rows.length },
  };
  writeFileSync(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
  return { root, rows, holdoutPath, runManifestPath };
}

function frontierFetch({ servedModel = "glm-5.2" } = {}) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const examples = JSON.parse(request.messages[1].content).examples;
    const predictions = examples.map((example) => ({
      example_id: example.example_id,
      label: example.example_id === "example-spam" ? "ham" : "ham",
    }));
    return new Response(JSON.stringify({
      model: servedModel,
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ predictions })}\n\`\`\`` } }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-understudy-effective-model": servedModel,
        "x-understudy-mode": "managed",
        "x-understudy-route": "primary",
        "x-understudy-request-id": `request-${requests.length}`,
      },
    });
  };
  return { fetchImpl, requests };
}

describe("frontier classification comparison", () => {
  it("requires explicit remote consent before reading or sending held-out examples", async () => {
    const data = fixture();
    const { fetchImpl, requests } = frontierFetch();
    await assert.rejects(
      compareClassifierWithFrontier({
        runManifestPath: data.runManifestPath,
        confirmRemote: false,
        auth: fakeAuth,
        fetchImpl,
      }),
      /requires --confirm-remote/,
    );
    assert.equal(requests.length, 0);
  });

  it("rejects a holdout outside the immutable prepared dataset even when the path shares its prefix", async () => {
    const data = fixture();
    const escapedRoot = join(data.root, "dataset-escaped");
    mkdirSync(escapedRoot, { recursive: true });
    const escapedHoldout = join(escapedRoot, "holdout.jsonl");
    const holdoutRaw = readFileSync(data.holdoutPath);
    writeFileSync(escapedHoldout, holdoutRaw);
    const manifest = JSON.parse(readFileSync(data.runManifestPath, "utf8"));
    manifest.dataset.splits.holdout.path = escapedHoldout;
    writeFileSync(data.runManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const { fetchImpl, requests } = frontierFetch();

    await assert.rejects(
      compareClassifierWithFrontier({
        runManifestPath: data.runManifestPath,
        confirmRemote: true,
        auth: fakeAuth,
        fetchImpl,
      }),
      /outside the immutable prepared dataset/,
    );
    assert.equal(requests.length, 0);
  });

  it("scores the exact immutable holdout and records bounded comparison evidence", async () => {
    const data = fixture();
    const { fetchImpl, requests } = frontierFetch();
    const events = [];
    const result = await compareClassifierWithFrontier({
      runManifestPath: data.runManifestPath,
      confirmRemote: true,
      auth: fakeAuth,
      fetchImpl,
      concurrency: 1,
      onEvent: (event) => events.push(event),
      now: new Date("2026-07-15T19:00:00.000Z"),
    });

    assert.equal(result.schema_version, FRONTIER_CLASSIFICATION_SCHEMA);
    assert.equal(result.run_id, "desktop-frontier-test");
    assert.equal(result.requested_model, "glm-5.2");
    assert.equal(result.served_model, "glm-5.2");
    assert.equal(result.exact_same_holdout, true);
    assert.equal(result.holdout_sha256, sha256(readFileSync(data.holdoutPath)));
    assert.equal(result.row_count, 2);
    assert.equal(result.heldout.accuracy, 0.5);
    assert.equal(result.heldout.failure_count, 1);
    assert.equal(result.heldout.failures.length, 1);
    assert.equal(result.data_boundary.training_examples_uploaded, false);
    assert.equal(result.data_boundary.holdout_examples_uploaded, true);
    assert.equal(requests.length, 3, "one quality batch plus two real latency probes");
    assert.ok(requests.every((request) => request.model === "glm-5.2"));
    assert.ok(requests.every((request) => request.chat_template_kwargs.thinking === false));
    assert.ok(requests.every((request) => !JSON.stringify(request).includes("training-only-sentinel")));
    assert.ok(events.some((event) => event.phase === "comparing"));
    assert.ok(events.some((event) => event.phase === "measuring"));
    assert.ok(existsSync(result.artifact_path));
    assert.deepEqual(JSON.parse(readFileSync(result.artifact_path, "utf8")), result);
  });

  it("fails closed and persists terminal evidence when the gateway serves a different model", async () => {
    const data = fixture();
    const { fetchImpl } = frontierFetch({ servedModel: "not-glm" });
    await assert.rejects(
      compareClassifierWithFrontier({
        runManifestPath: data.runManifestPath,
        confirmRemote: true,
        auth: fakeAuth,
        fetchImpl,
      }),
      /requested glm-5\.2, but the gateway served not-glm/,
    );
    const comparisonRoot = join(dirname(data.runManifestPath), "frontier-comparisons", "glm-5.2");
    const failures = readdirSync(comparisonRoot).filter((name) => name.endsWith(".failed.json"));
    assert.equal(failures.length, 1);
    const failure = JSON.parse(readFileSync(join(comparisonRoot, failures[0]), "utf8"));
    assert.equal(failure.status, "failed");
    assert.equal(failure.exact_same_holdout, true);
    assert.equal(failure.holdout_sha256, sha256(readFileSync(data.holdoutPath)));
  });
});
