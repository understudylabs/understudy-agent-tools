import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import {
  CATALOG_SCHEMA_VERSION,
  VERIFIED_SNAPSHOT_MODELS,
  fetchSnapshotCatalog,
  pullSnapshotModel,
} from "../dist/model-snapshots.js";

const cli = ["node", resolve("dist/bin.js")];
const DEAD_CATALOG_URL = "http://127.0.0.1:1/catalog";

const EXPECTED_PULLABLE_IDS = [
  "gemma-4-e2b-it-qat-mlx-vlm-understudy",
  "gemma-4-e4b-it-qat-mlx-vlm-understudy",
  "gemma-4-12b-it-qat-mlx-vlm-understudy",
  "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

async function withCatalogUrl(url, fn) {
  const previous = process.env.UNDERSTUDY_CATALOG_URL;
  process.env.UNDERSTUDY_CATALOG_URL = url;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.UNDERSTUDY_CATALOG_URL;
    else process.env.UNDERSTUDY_CATALOG_URL = previous;
  }
}

function runCli(args, env) {
  return spawnSync(cli[0], [cli[1], ...args], {
    encoding: "utf8",
    env: { ...process.env, UNDERSTUDY_TELEMETRY: "0", ...env },
  });
}

// spawnSync blocks the test process's event loop, which deadlocks any test
// whose CLI child must talk to an HTTP server hosted by this same process.
function runCliAsync(args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cli[0], [cli[1], ...args], {
      env: { ...process.env, UNDERSTUDY_TELEMETRY: "0", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

describe("fetchSnapshotCatalog", () => {
  it("uses live catalog rows when the endpoint serves a valid v1 catalog", async () => {
    const catalog = {
      schema_version: CATALOG_SCHEMA_VERSION,
      models: [
        {
          id: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
          name: "Gemma 4 E2B QAT (live)",
          approx_gb: 9.9,
          loader: "mlx_vlm",
          default_rung: true,
          short_name: "understudy-small",
          certified: true,
          family: "gemma-4",
          tier: "e2b",
          quant: "qat-4bit-g32",
          session_url:
            "https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy&ttl=21600",
          file_count: 11,
        },
        { id: "brand-new-live-model", name: "Brand New", approx_gb: 1.2, loader: "mlx_vlm" },
      ],
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"abc"' });
      res.end(JSON.stringify(catalog));
    });
    const port = await listen(server);
    try {
      const result = await withCatalogUrl(`http://127.0.0.1:${port}/catalog`, () => fetchSnapshotCatalog());
      assert.equal(result.source, "live");
      // Live rows win over the compiled-in table.
      assert.equal(result.models["gemma-4-e2b-it-qat-mlx-vlm-understudy"].approxGb, 9.9);
      assert.equal(result.models["gemma-4-e2b-it-qat-mlx-vlm-understudy"].name, "Gemma 4 E2B QAT (live)");
      assert.equal(result.models["gemma-4-e2b-it-qat-mlx-vlm-understudy"].shortName, "understudy-small");
      assert.equal(result.models["gemma-4-e2b-it-qat-mlx-vlm-understudy"].certified, true);
      assert.equal(result.models["brand-new-live-model"].approxGb, 1.2);
      // The live catalog is authoritative: bundled-only ids do not leak back in.
      assert.deepEqual(Object.keys(result.models).sort(), ["brand-new-live-model", "gemma-4-e2b-it-qat-mlx-vlm-understudy"]);
      // Rows without a session_url get the conventional one derived from the id.
      assert.match(result.models["brand-new-live-model"].sessionUrl, /session\?model=brand-new-live-model&ttl=21600$/);
    } finally {
      await close(server);
    }
  });

  it("falls back to the bundled table when the endpoint is unreachable", async () => {
    const result = await withCatalogUrl(DEAD_CATALOG_URL, () => fetchSnapshotCatalog());
    assert.equal(result.source, "fallback");
    assert.deepEqual(result.models, VERIFIED_SNAPSHOT_MODELS);
    assert.deepEqual(Object.keys(result.models).sort(), [...EXPECTED_PULLABLE_IDS].sort());
    assert.equal(Object.keys(result.models).length, 4);
  });

  it("falls back on schema_version mismatch and on non-200 responses", async () => {
    let mode = "wrong-schema";
    const server = createServer((req, res) => {
      if (mode === "wrong-schema") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schema_version: "understudy.model_catalog.v2", models: [{ id: "x" }] }));
      } else {
        res.writeHead(500);
        res.end("boom");
      }
    });
    const port = await listen(server);
    try {
      const url = `http://127.0.0.1:${port}/catalog`;
      const mismatch = await withCatalogUrl(url, () => fetchSnapshotCatalog());
      assert.equal(mismatch.source, "fallback");
      mode = "http-500";
      const failure = await withCatalogUrl(url, () => fetchSnapshotCatalog());
      assert.equal(failure.source, "fallback");
    } finally {
      await close(server);
    }
  });
});

describe("models snapshots CLI", () => {
  it("lists the four certified bundled models offline and notes the fallback source", () => {
    const result = runCli(["models", "snapshots", "--json"], { UNDERSTUDY_CATALOG_URL: DEAD_CATALOG_URL });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.source, "fallback");
    assert.equal(parsed.models.length, 4);
    assert.deepEqual(parsed.models.map((m) => m.id).sort(), [...EXPECTED_PULLABLE_IDS].sort());
    assert.equal(parsed.models.filter((m) => m.default).length, 1);
    assert.equal(parsed.models.filter((m) => m.certified).length, 4);

    const human = runCli(["models", "snapshots"], { UNDERSTUDY_CATALOG_URL: DEAD_CATALOG_URL });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /source: bundled fallback/);
    assert.match(human.stdout, /understudy-small/);
  });

  it("prefers the live catalog and says so", async () => {
    const catalog = {
      schema_version: CATALOG_SCHEMA_VERSION,
      models: [{ id: "live-only-model", name: "Live Only", approx_gb: 2, loader: "mlx_vlm", default_rung: true }],
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(catalog));
    });
    const port = await listen(server);
    try {
      const env = { UNDERSTUDY_CATALOG_URL: `http://127.0.0.1:${port}/catalog` };
      const result = await runCliAsync(["models", "snapshots", "--json"], env);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.source, "live");
      assert.deepEqual(parsed.models.map((m) => m.id), ["live-only-model"]);

      const human = await runCliAsync(["models", "snapshots"], env);
      assert.match(human.stdout, /source: live catalog \(http:\/\/127\.0\.0\.1/);
    } finally {
      await close(server);
    }
  });

  it("keeps the --session-url escape hatch working without any catalog", () => {
    const result = runCli(
      ["models", "pull", "some-custom-model", "--session-url", "http://127.0.0.1:9/session", "--dry-run"],
      { UNDERSTUDY_CATALOG_URL: DEAD_CATALOG_URL },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /catalog: bundled fallback/);
    assert.match(result.stdout, /dry-run some-custom-model/);
    assert.match(result.stdout, /session: http:\/\/127\.0\.0\.1:9\/session/);
  });
});

describe("pullSnapshotModel cached-file verification", () => {
  // The /session manifest carries no file sizes or hashes, so a leftover file
  // of the right name from a *different* snapshot used to be accepted as
  // "cached". SHA256SUMS is now always refetched and cached files are
  // verified against it, re-downloading on mismatch.
  const GOOD_WEIGHTS = "GOOD-WEIGHTS-0123456789";
  const EVIL_WEIGHTS = "EVIL-WEIGHTS-0123456789"; // same byte length: defeats size checks
  const CONFIG = '{"model_type":"test"}';

  function makeSnapshotServer({ withSums }) {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const respond = (body) => {
        res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
        res.end(req.method === "HEAD" ? undefined : body);
      };
      if (req.url === "/session") {
        const files = [
          ...(withSums ? [{ name: "SHA256SUMS", url: `http://127.0.0.1:${server.address().port}/files/SHA256SUMS` }] : []),
          { name: "config.json", url: `http://127.0.0.1:${server.address().port}/files/config.json` },
          { name: "model.safetensors", url: `http://127.0.0.1:${server.address().port}/files/model.safetensors` },
        ];
        respond(JSON.stringify({ files }));
      } else if (req.url === "/files/SHA256SUMS" && withSums) {
        respond(`${sha256(CONFIG)}  config.json\n${sha256(GOOD_WEIGHTS)}  model.safetensors\n`);
      } else if (req.url === "/files/config.json") {
        respond(CONFIG);
      } else if (req.url === "/files/model.safetensors") {
        respond(GOOD_WEIGHTS);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    return { server, requests };
  }

  const tmp = mkdtempSync(join(tmpdir(), "understudy-pull-test-"));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("re-downloads a stale same-size cached file when SHA256SUMS disagrees", async () => {
    const { server, requests } = makeSnapshotServer({ withSums: true });
    const port = await listen(server);
    const dest = join(tmp, "verified");
    mkdirSync(dest, { recursive: true });
    // Leftovers from a different snapshot pulled into the same dest: wrong
    // weights of the right name and size, plus a stale sums file that matches
    // the wrong weights (so only a *fresh* SHA256SUMS can catch it).
    writeFileSync(join(dest, "model.safetensors"), EVIL_WEIGHTS);
    writeFileSync(join(dest, "SHA256SUMS"), `${sha256(EVIL_WEIGHTS)}  model.safetensors\n`);
    const logs = [];
    try {
      const result = await pullSnapshotModel({
        modelId: "test-snapshot-model",
        sessionUrl: `http://127.0.0.1:${port}/session`,
        dest,
        logDir: join(tmp, "logs"),
        onLog: (line) => logs.push(line),
      });
      assert.equal(result.files, 3);
      assert.equal(readFileSync(join(dest, "model.safetensors"), "utf8"), GOOD_WEIGHTS);
      assert.equal(readFileSync(join(dest, "config.json"), "utf8"), CONFIG);
      assert.ok(
        requests.some((r) => r === "GET /files/model.safetensors"),
        `stale weights must be re-downloaded, saw: ${requests.join(", ")}`,
      );
      assert.ok(logs.some((line) => line.includes("model.safetensors sha256 mismatch; re-downloading")), logs.join("\n"));
      const metadata = JSON.parse(readFileSync(join(dest, ".understudy-snapshot.json"), "utf8"));
      const weights = metadata.files.find((f) => f.name === "model.safetensors");
      assert.equal(weights.cached, false);
      assert.equal(weights.verified, true);
    } finally {
      await close(server);
    }
  });

  it("accepts a hash-matching cached file without re-downloading it", async () => {
    const { server, requests } = makeSnapshotServer({ withSums: true });
    const port = await listen(server);
    const dest = join(tmp, "cached-ok");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "model.safetensors"), GOOD_WEIGHTS);
    try {
      const result = await pullSnapshotModel({
        modelId: "test-snapshot-model",
        sessionUrl: `http://127.0.0.1:${port}/session`,
        dest,
        logDir: join(tmp, "logs"),
      });
      assert.equal(result.files, 3);
      assert.ok(!requests.some((r) => r === "GET /files/model.safetensors"), requests.join(", "));
      const metadata = JSON.parse(readFileSync(join(dest, ".understudy-snapshot.json"), "utf8"));
      const weights = metadata.files.find((f) => f.name === "model.safetensors");
      assert.equal(weights.cached, true);
      assert.equal(weights.verified, true);
    } finally {
      await close(server);
    }
  });

  it("warns when a snapshot has no SHA256SUMS to verify cached files against", async () => {
    const { server } = makeSnapshotServer({ withSums: false });
    const port = await listen(server);
    const dest = join(tmp, "no-sums");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "model.safetensors"), EVIL_WEIGHTS);
    const logs = [];
    try {
      await pullSnapshotModel({
        modelId: "test-snapshot-model",
        sessionUrl: `http://127.0.0.1:${port}/session`,
        dest,
        logDir: join(tmp, "logs"),
        onLog: (line) => logs.push(line),
      });
      // Unverifiable cache keeps its previous behavior, loudly.
      assert.ok(logs.some((line) => line.includes("no SHA256SUMS")), logs.join("\n"));
      assert.ok(
        logs.some((line) => line.includes("kept without sha256 verification")),
        logs.join("\n"),
      );
    } finally {
      await close(server);
    }
  });
});
