import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runEvalCheck } from "../dist/evals/check.js";
import {
  EvalPublicationSchema,
  EvalReleaseSchema,
} from "../dist/evals/release-contracts.js";
import {
  deriveEvalReleaseId,
  deterministicUstarByteLength,
  prepareEvalPublication,
  previewEvalPublication,
  publishEvalRelease,
} from "../dist/evals/publish.js";
import { EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES } from "../dist/evals/release-contracts.js";
import { buildEvalProject, writeJson } from "./helpers/eval-project.mjs";

async function finalizeApproval(project) {
  const checked = await runEvalCheck(project, { now: new Date("2026-08-30T13:00:00.000Z") });
  const approvalPath = join(project, "approval.json");
  writeJson(approvalPath, {
    ...JSON.parse(readFileSync(approvalPath, "utf8")),
    approved_at: "2026-08-30T13:05:00.000Z",
    eval_set_sha256: checked.hashes.eval_set_sha256,
    coverage_sha256: checked.hashes.coverage_sha256,
    environment_sha256: checked.hashes.environment_sha256,
    verifier_sha256: checked.hashes.verifier_sha256,
    check_report_sha256: checked.hashes.check_report_sha256,
  });
}

function tarEntries(compressed) {
  const tar = gunzipSync(compressed);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name;
    entries.push({ path, header, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function multipartFile(body, contentType, name) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  assert.ok(boundary, "multipart boundary is present");
  const marker = Buffer.from(`name="${name}"`, "utf8");
  const markerOffset = body.indexOf(marker);
  assert.notEqual(markerOffset, -1, `multipart field ${name} is present`);
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), markerOffset);
  assert.notEqual(headerEnd, -1, `multipart field ${name} has complete headers`);
  const bodyStart = headerEnd + 4;
  const bodyEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), bodyStart);
  assert.notEqual(bodyEnd, -1, `multipart field ${name} has a closing boundary`);
  return body.subarray(bodyStart, bodyEnd);
}

function releaseFor(publication, overrides = {}) {
  const { schema_version: _schemaVersion, ...payload } = publication;
  const release = {
    schema_version: "understudy.eval-release.v1",
    ...payload,
    release_number: 1,
    sealed_by_user_id: "api_key:key_synthetic",
    sealed_at: "2026-08-30T14:00:00.000Z",
    ...overrides,
  };
  const { schema_version: _releaseSchema, release_number: _number, sealed_by_user_id: _sealedBy, sealed_at: _sealedAt, release_id: _overrideId, ...releasePayload } = release;
  return {
    ...release,
    release_id: overrides.release_id ?? deriveEvalReleaseId(EvalPublicationSchema.parse({ schema_version: "understudy.eval-publication.v1", ...releasePayload })),
  };
}

test("deterministic USTAR sizing includes headers, padding, and terminators", () => {
  assert.equal(deterministicUstarByteLength([]), 1_024);
  assert.equal(deterministicUstarByteLength([0]), 1_536);
  assert.equal(deterministicUstarByteLength([1, 512, 513]), 4_608);

  const boundaryBodies = Array.from({ length: 1_024 }, () => 64 * 1_024);
  assert.equal(boundaryBodies.reduce((sum, size) => sum + size, 0), EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES);
  assert.ok(deterministicUstarByteLength(boundaryBodies) > EVAL_RELEASE_MAX_UNCOMPRESSED_BYTES);
});

test("evals publish preview exposes the exact non-uploaded release and binds the later upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-publish-preview-"));
  try {
    const { project } = buildEvalProject(root);
    await finalizeApproval(project);
    const preview = await previewEvalPublication(project);
    assert.equal(preview.schema_version, "understudy.eval-publication-preview.v1");
    assert.equal(preview.upload_performed, false);
    assert.equal(preview.expected_release_id, deriveEvalReleaseId(preview.manifest));
    assert.equal(preview.manifest_size_bytes, Buffer.byteLength(JSON.stringify(preview.manifest)));
    assert.equal(preview.bundle.sha256, preview.manifest.artifacts.bundle_sha256);
    assert.equal(preview.bundle.size_bytes > 0, true);
    assert.equal(preview.bundle.r2_key, preview.manifest.artifacts.bundle_r2_key);
    assert.deepEqual(preview.bundle.files, preview.manifest.bundle_files);
    assert.match(preview.local_only.policy, /exactly two objects.*publication manifest.*gzip bundle.*every other file.*stays local/i);
    assert.deepEqual(preview.local_only.explicitly_excluded, [
      ".understudy/",
      "benchmark/analysis.md",
      "benchmark/execution-index.jsonl",
      "captures/",
      "eval-project.json",
      "source/",
      "traces/",
    ]);

    const home = join(root, "empty-home");
    mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, UNDERSTUDY_TELEMETRY: "0" };
    delete env.UNDERSTUDY_API_KEY;
    delete env.UNDERSTUDY_GATEWAY_URL;
    delete env.FORCE_COLOR;
    const cli = spawnSync(process.execPath, [
      resolve("dist/bin.js"), "--json", "evals", "publish", "--project", project, "--preview",
    ], { encoding: "utf8", env });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), preview);

    const missingExpectation = spawnSync(process.execPath, [
      resolve("dist/bin.js"), "evals", "publish", "--project", project,
    ], { encoding: "utf8", env });
    assert.notEqual(missingExpectation.status, 0);
    assert.match(missingExpectation.stderr, /preview.*expect-release-id/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals publish deterministically packages exactly the checked release allowlist", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-publish-"));
  try {
    const { project } = buildEvalProject(root);
    await finalizeApproval(project);
    writeFileSync(join(project, "unreferenced-owner-note.txt"), "must remain local\n");

    const first = await prepareEvalPublication(project);
    const second = await prepareEvalPublication(project);
    assert.deepEqual(second.publication, first.publication);
    assert.deepEqual(second.bundle, first.bundle);
    assert.deepEqual([...first.bundle.subarray(4, 8)], [0, 0, 0, 0], "gzip mtime is normalized");
    assert.equal(first.bundle[9], 255, "gzip OS byte is normalized");
    assert.equal(EvalPublicationSchema.safeParse(first.publication).success, true);
    assert.equal(first.publication.runtime.format, "local_module.v1");
    assert.deepEqual(first.publication.artifact_layout, {
      workload_profile: "workload-profile.md",
      coverage: "coverage.json",
      harness: "harness.json",
      environment: "environment.json",
      metric: "metric.json",
      splits: "splits.json",
      tasks: "benchmark/tasks.jsonl",
      check_fixtures: "checks/fixtures.json",
      approval: "approval.json",
      check_report: "checks/report.json",
      fixtures: {
        representative: { candidate: "fixtures/good.json", state: "fixtures/state.json" },
        known_good: { candidate: "fixtures/good.json", state: "fixtures/state.json" },
        intentionally_wrong: { candidate: "fixtures/wrong.json", state: "fixtures/state.json" },
      },
      environment_root: "environment",
      verifier_root: "verifier",
    });

    const expectedPaths = [
      "approval.json",
      "benchmark/tasks.jsonl",
      "checks/fixtures.json",
      "checks/report.json",
      "coverage.json",
      "environment.json",
      "environment/replay.mjs",
      "fixtures/good.json",
      "fixtures/state.json",
      "fixtures/wrong.json",
      "harness.json",
      "metric.json",
      "splits.json",
      "verifier/check.mjs",
      "workload-profile.md",
    ];
    assert.deepEqual(first.publication.bundle_files.map((file) => file.path), expectedPaths);
    const archived = tarEntries(first.bundle);
    assert.deepEqual(archived.map((file) => file.path), expectedPaths);
    for (const { header } of archived) {
      const octal = (start, length) => Number.parseInt(header.subarray(start, start + length).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
      assert.equal(octal(100, 8), 0o644);
      assert.equal(octal(108, 8), 0);
      assert.equal(octal(116, 8), 0);
      assert.equal(octal(136, 12), 0);
      assert.equal(header.subarray(156, 157).toString("ascii"), "0");
      assert.equal(header.subarray(257, 263).toString("ascii"), "ustar\0");
      assert.equal(header.subarray(263, 265).toString("ascii"), "00");
      assert.ok(header.subarray(157, 257).every((byte) => byte === 0));
      assert.ok(header.subarray(265, 345).every((byte) => byte === 0));
      assert.ok(header.subarray(500, 512).every((byte) => byte === 0));
    }
    for (const forbidden of [
      "eval-project.json",
      "source/index.jsonl",
      "source/export-proof.json",
      "source/traces/capture.json",
      "benchmark/execution-index.jsonl",
      "benchmark/analysis.md",
      "unreferenced-owner-note.txt",
    ]) {
      assert.equal(first.publication.bundle_files.some((file) => file.path === forbidden), false, forbidden);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals publish reruns the check and refuses stale approval or symlinked release artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-publish-gates-"));
  try {
    const stale = buildEvalProject(join(root, "stale"));
    await finalizeApproval(stale.project);
    writeFileSync(join(stale.project, "workload-profile.md"), "# changed after approval\n");
    await assert.rejects(() => prepareEvalPublication(stale.project), /approval|hash|stale/i);

    const symlinked = buildEvalProject(join(root, "symlinked"));
    await finalizeApproval(symlinked.project);
    rmSync(join(symlinked.project, "fixtures/good.json"));
    symlinkSync(join(symlinked.project, "fixtures/wrong.json"), join(symlinked.project, "fixtures/good.json"));
    await assert.rejects(() => prepareEvalPublication(symlinked.project), /symbolic link/i);

    const privateFixture = buildEvalProject(join(root, "private-fixture"));
    mkdirSync(join(privateFixture.project, "captures"), { recursive: true });
    writeFileSync(join(privateFixture.project, "captures/good.json"), readFileSync(join(privateFixture.project, "fixtures/good.json")));
    const fixturesPath = join(privateFixture.project, "checks/fixtures.json");
    const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
    fixtures.representative.candidate = "captures/good.json";
    fixtures.known_good.candidate = "captures/good.json";
    writeJson(fixturesPath, fixtures);
    await finalizeApproval(privateFixture.project);
    await assert.rejects(() => prepareEvalPublication(privateFixture.project), /source or mutable authoring evidence/i);

    const postCheckMutation = buildEvalProject(join(root, "post-check-mutation"));
    await finalizeApproval(postCheckMutation.project);
    await assert.rejects(
      () => prepareEvalPublication(postCheckMutation.project, {
        afterCheck: () => writeFileSync(join(postCheckMutation.project, "fixtures/good.json"), "{\n  \"tool_calls\": [{\"name\":\"update-record\",\"arguments\":{\"id\":7,\"status\":\"done\"}}]\n}\n"),
      }),
      /candidate changed after the passing eval check/i,
    );

    const sourceIndexMutation = buildEvalProject(join(root, "source-index-mutation"));
    await finalizeApproval(sourceIndexMutation.project);
    await assert.rejects(
      () => prepareEvalPublication(sourceIndexMutation.project, {
        afterCheck: () => writeFileSync(join(sourceIndexMutation.project, "source/index.jsonl"), "\n", { flag: "a" }),
      }),
      /source index changed after the passing eval check/i,
    );

    const moduleMutation = buildEvalProject(join(root, "module-mutation"));
    await finalizeApproval(moduleMutation.project);
    await assert.rejects(
      () => prepareEvalPublication(moduleMutation.project, {
        afterCheck: () => writeFileSync(join(moduleMutation.project, "verifier/check.mjs"), " ".repeat(256 * 1_024 + 1)),
      }),
      /module limit/i,
    );

    const manifestMutation = buildEvalProject(join(root, "manifest-mutation"));
    await finalizeApproval(manifestMutation.project);
    await assert.rejects(
      () => prepareEvalPublication(manifestMutation.project, {
        afterCheck: () => {
          const path = join(manifestMutation.project, "eval-project.json");
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          writeJson(path, { ...manifest, name: `${manifest.name} changed` });
        },
      }),
      /manifest changed while the final publication check was running/i,
    );

    const approvalMutation = buildEvalProject(join(root, "approval-mutation"));
    await finalizeApproval(approvalMutation.project);
    await assert.rejects(
      () => prepareEvalPublication(approvalMutation.project, {
        afterCheck: () => {
          const path = join(approvalMutation.project, "approval.json");
          const approval = JSON.parse(readFileSync(path, "utf8"));
          writeJson(path, { ...approval, approver: "different-owner" });
        },
      }),
      /final owner approval changed while the publication check was running/i,
    );

    const invalidUtf8 = buildEvalProject(join(root, "invalid-utf8"));
    writeFileSync(join(invalidUtf8.project, "fixtures/good.json"), Buffer.concat([
      Buffer.from('{"tool_calls":[{"name":"update-record","arguments":{"id":7,"status":"done"}}],"note":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]));
    await finalizeApproval(invalidUtf8.project);
    await assert.rejects(() => prepareEvalPublication(invalidUtf8.project), /not valid UTF-8/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals publish sends raw multipart bytes and fails closed on a mismatched release response", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-publish-http-"));
  const previousKey = process.env.UNDERSTUDY_API_KEY;
  const previousGateway = process.env.UNDERSTUDY_GATEWAY_URL;
  const previousHome = process.env.HOME;
  let responseWorkload = "workload_synthetic";
  let responseReleaseId;
  let received;
  let expectedPrepared;
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks),
      };
      const release = releaseFor(expectedPrepared.publication, { workload_id: responseWorkload, ...(responseReleaseId === undefined ? {} : { release_id: responseReleaseId }) });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(release));
    });
  });
  try {
    const { project } = buildEvalProject(root);
    await finalizeApproval(project);
    expectedPrepared = await prepareEvalPublication(project);
    const expectedReleaseId = deriveEvalReleaseId(expectedPrepared.publication);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.UNDERSTUDY_API_KEY = "sk_synthetic";
    process.env.UNDERSTUDY_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.HOME = root;

    const release = await publishEvalRelease(project, { expectedReleaseId });
    assert.equal(EvalReleaseSchema.safeParse(release).success, true);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/admin/v1/orgs/org_synthetic/projects/proj_synthetic/workloads/workload_synthetic/eval-releases");
    assert.equal(received.authorization, "Bearer sk_synthetic");
    assert.match(received.contentType, /^multipart\/form-data; boundary=/);
    assert.match(received.body.toString("latin1"), /name="manifest"/);
    assert.match(received.body.toString("latin1"), /name="bundle"; filename="eval_[a-f0-9]{24}\.tar\.gz"/);
    assert.deepEqual(
      multipartFile(received.body, received.contentType, "manifest"),
      Buffer.from(JSON.stringify(expectedPrepared.publication)),
    );
    assert.deepEqual(
      multipartFile(received.body, received.contentType, "bundle"),
      expectedPrepared.bundle,
    );

    await assert.rejects(
      () => publishEvalRelease(project, { expectedReleaseId: "release_ffffffffffffffffffffffff" }),
      /does not match the approved preview/i,
    );
    assert.equal(requestCount, 1, "a preview identity mismatch must fail before POST");

    responseWorkload = "workload_other";
    await assert.rejects(() => publishEvalRelease(project, { expectedReleaseId }), /does not match the submitted publication/i);

    responseWorkload = "workload_synthetic";
    responseReleaseId = "release_ffffffffffffffffffffffff";
    await assert.rejects(() => publishEvalRelease(project, { expectedReleaseId }), /release id does not match the submitted publication identity/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousKey === undefined) delete process.env.UNDERSTUDY_API_KEY;
    else process.env.UNDERSTUDY_API_KEY = previousKey;
    if (previousGateway === undefined) delete process.env.UNDERSTUDY_GATEWAY_URL;
    else process.env.UNDERSTUDY_GATEWAY_URL = previousGateway;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
