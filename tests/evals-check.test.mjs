import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runEvalCheck } from "../dist/evals/check.js";
import { deriveWorkloadEvalId } from "../dist/eval-project.js";
import { buildEvalProject as buildProject } from "./helpers/eval-project.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function rewriteProof(project, mutate) {
  const manifestPath = join(project, "eval-project.json");
  const proofPath = join(project, "source/export-proof.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  mutate({ manifest, proof });
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  writeFileSync(proofPath, body, { mode: 0o600 });
  manifest.source.export_proof_sha256 = sha(body);
  writeJson(manifestPath, manifest);
}

function rewriteExecutionIndex(project, mutate) {
  const indexPath = join(project, "benchmark/execution-index.jsonl");
  const rows = readFileSync(indexPath, "utf8").trim().split("\n").map(JSON.parse);
  mutate(rows);
  const body = `${rows.map(JSON.stringify).join("\n")}\n`;
  writeFileSync(indexPath, body, { mode: 0o600 });
  const coveragePath = join(project, "coverage.json");
  const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
  coverage.lineage.execution_index_sha256 = sha(body);
  writeJson(coveragePath, coverage);
}

test("evals check hashes module trees in global code-unit path order", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-module-order-"));
  try {
    const { project } = buildProject(root);
    mkdirSync(join(project, "environment/a"));
    writeFileSync(join(project, "environment/a.js"), "export const sibling = true;\n");
    writeFileSync(join(project, "environment/a/z.mjs"), "export const nested = true;\n");
    const result = await runEvalCheck(project, { now: new Date("2026-08-30T13:00:00.000Z") });
    assert.equal(result.status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check replays representative/good/wrong fixtures without a provider and binds final approval after the report", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-"));
  try {
    const { marker, project } = buildProject(root);
    const first = await runEvalCheck(project, { now: new Date("2026-08-30T13:00:00.000Z") });
    assert.equal(first.status, "passed");
    assert.equal(first.publishable, false);
    assert.equal(first.report.representative_replay.provider_called, false);
    assert.equal(first.report.oracle_fixture.result, "passed");
    assert.equal(first.report.wrong_fixture.result, "rejected");
    const proof = JSON.parse(readFileSync(join(project, "source/export-proof.json"), "utf8"));
    const projectManifest = JSON.parse(readFileSync(join(project, "eval-project.json"), "utf8"));
    assert.equal(first.report.source.export_proof_sha256, sha(proof.verified_receipt.source_attestation));
    assert.notEqual(
      first.report.source.export_proof_sha256,
      projectManifest.source.export_proof_sha256,
      "the hosted source proof binds the durable attestation, while the private project hash binds the local proof file",
    );
    assert.equal(existsSync(marker), false, "trace text is inert evidence, never an instruction");
    const firstReport = readFileSync(join(project, "checks/report.json"), "utf8");

    const approval = JSON.parse(readFileSync(join(project, "approval.json"), "utf8"));
    writeJson(join(project, "approval.json"), {
      ...approval,
      approved_at: "2026-08-30T13:05:00.000Z",
      eval_set_sha256: first.hashes.eval_set_sha256,
      coverage_sha256: first.hashes.coverage_sha256,
      environment_sha256: first.hashes.environment_sha256,
      verifier_sha256: first.hashes.verifier_sha256,
      check_report_sha256: first.hashes.check_report_sha256,
    });
    const second = await runEvalCheck(project, { now: new Date("2026-08-30T14:00:00.000Z") });
    assert.equal(second.publishable, true);
    assert.equal(readFileSync(join(project, "checks/report.json"), "utf8"), firstReport, "an unchanged check preserves its report hash");

    const harness = JSON.parse(readFileSync(join(project, "harness.json"), "utf8"));
    writeJson(join(project, "harness.json"), { ...harness, timeout_ms: 4_000 });
    await assert.rejects(
      () => runEvalCheck(project, { now: new Date("2026-08-30T15:00:00.000Z") }),
      /Final owner approval is stale/,
      "changing any checked input invalidates the final approval",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check rejects incumbent output as oracle evidence and uncovered material modes without owner acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-gates-"));
  try {
    const noOracle = buildProject(join(root, "no-oracle"), { goodEvidence: { kind: "incumbent_trace", reference: "req-1", statement: "The incumbent emitted it." } });
    await assert.rejects(() => runEvalCheck(noOracle.project), /independent correctness evidence|Invalid check fixtures/i);

    const noCoverage = buildProject(join(root, "no-coverage"), { coverage: {
      schema_version: "understudy.eval-coverage.v1",
      lineage: { execution_index_sha256: "0".repeat(64), counts: { complete: 1, ambiguous: 0, unlinked: 0 } },
      execution_modes: [{ name: "bulk write", observed_count: 5, task_ids: [], disposition: "covered" }],
      failure_classes: [],
    } });
    await assert.rejects(() => runEvalCheck(noCoverage.project), /covered.*task|coverage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check never gives fixture descriptors or correctness evidence to replay or verifier modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-cheating-"));
  try {
    const cheating = buildProject(root, {
      environmentSource: `
export function replay(input) {
  return { fixture_descriptor_visible: Object.prototype.hasOwnProperty.call(input, "fixture") };
}
`,
      verifierSource: `
export function verify(input) {
  const visible = Object.prototype.hasOwnProperty.call(input, "fixture") || input.replay.fixture_descriptor_visible;
  return { passed: visible, feedback: visible ? "fixture evidence leaked" : "fixture descriptor unavailable" };
}
`,
    });
    await assert.rejects(
      () => runEvalCheck(cheating.project),
      /Representative provider-free replay failed: fixture descriptor unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check runs authored modules without host capabilities or forgeable IPC and kills timeouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-sandbox-"));
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-provider-key-must-not-reach-child";
  try {
    const scrubbed = buildProject(join(root, "scrubbed"), {
      environmentSource: `
import { cloneState } from "./state-helper.mjs";
export function replay({ candidate, state }) {
  const finalState = cloneState(state);
  for (const call of candidate.tool_calls ?? []) {
    if (call.name === "update-record") finalState.records[String(call.arguments.id)] = call.arguments.status;
  }
  let escaped = false;
  try { escaped = Boolean(globalThis.constructor.constructor("return process")()); } catch {}
  return {
    final_state: finalState,
    deterministic_runtime: Date.now() === 0 && new Date().getTime() === 0 && Math.random() === 0.5,
    host_capability_visible: [typeof process, typeof fetch, typeof WebSocket, typeof require, typeof Buffer, typeof console].some((value) => value !== "undefined") || escaped,
  };
}
`,
      verifierSource: `
export function verify({ replay }) {
  const passed = replay.deterministic_runtime && !replay.host_capability_visible && replay.final_state.records["7"] === "done" && replay.final_state.records["9"] === "pending";
  return { passed, feedback: passed ? "host capabilities absent and state correct" : "host capability leaked or state wrong" };
}
`,
    });
    writeFileSync(join(scrubbed.project, "environment/state-helper.mjs"), "export const cloneState = (value) => structuredClone(value);\n", { mode: 0o600 });
    assert.equal((await runEvalCheck(scrubbed.project)).status, "passed");

    const directFetch = buildProject(join(root, "direct-fetch"), {
      environmentSource: `
export async function replay() {
  await fetch("http://127.0.0.1:9/provider-call");
  return { unreachable: true };
}
`,
    });
    await assert.rejects(() => runEvalCheck(directFetch.project), /fetch is not (?:defined|a function)/i);

    const builtinImport = buildProject(join(root, "builtin-import"), {
      environmentSource: `
import "node:net";
export function replay() { return { unreachable: true }; }
`,
    });
    await assert.rejects(() => runEvalCheck(builtinImport.project), /relative modules.*node:net/i);

    const forgedIpc = buildProject(join(root, "forged-ipc"), {
      environmentSource: `
export function replay() {
  process.send({ ok: true, replay: {}, verification: { passed: true, feedback: "forged" } });
  return { unreachable: true };
}
`,
    });
    await assert.rejects(() => runEvalCheck(forgedIpc.project), /process is not (?:defined|an object)|cannot read.*send/i);

    const dynamicBuiltin = buildProject(join(root, "dynamic-builtin"), {
      environmentSource: `
export async function replay() {
  await import("node:net");
  return { unreachable: true };
}
`,
    });
    await assert.rejects(() => runEvalCheck(dynamicBuiltin.project), /dynamic import|callback|not supported/i);

    const timeout = buildProject(join(root, "timeout"), {
      timeoutMs: 150,
      environmentSource: `
export function replay() {
  while (true) {}
}
`,
    });
    await assert.rejects(() => runEvalCheck(timeout.project), /exceeded 150ms and was terminated/);

    const oversizedModule = buildProject(join(root, "oversized-module"));
    writeFileSync(join(oversizedModule.project, "environment/oversized.mjs"), " ".repeat(256 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(() => runEvalCheck(oversizedModule.project), /module exceeds the 262144-byte limit/);

    const oversizedResult = buildProject(join(root, "oversized-result"), {
      environmentSource: `
export function replay({ state }) {
  return { final_state: state, padding: "x".repeat(2 * 1024 * 1024) };
}
`,
    });
    await assert.rejects(() => runEvalCheck(oversizedResult.project), /Sandbox result exceeds its byte limit/);
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check requires task and failure-taxonomy coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-coverage-"));
  try {
    const missingTaxonomy = buildProject(join(root, "taxonomy"), { coverage: {
      schema_version: "understudy.eval-coverage.v1",
      lineage: { execution_index_sha256: "0".repeat(64), counts: { complete: 1, ambiguous: 0, unlinked: 0 } },
      execution_modes: [{ name: "single deterministic write", observed_count: 1, task_ids: ["task-synthetic-write"], disposition: "covered" }],
      failure_classes: [{ name: "missing_write", observed_count: 1, task_ids: ["task-synthetic-write"], disposition: "covered" }],
    } });
    await assert.rejects(() => runEvalCheck(missingTaxonomy.project), /metric failure class wrong_record/);

    const uncoveredTask = buildProject(join(root, "task"), { coverage: {
      schema_version: "understudy.eval-coverage.v1",
      lineage: { execution_index_sha256: "0".repeat(64), counts: { complete: 1, ambiguous: 0, unlinked: 0 } },
      execution_modes: [{ name: "unclassified mode", observed_count: 1, task_ids: [], disposition: "owner_accepted_uncovered", owner_note: "Owner accepts this mode is not represented yet." }],
      failure_classes: [
        { name: "missing_write", observed_count: 1, task_ids: ["task-synthetic-write"], disposition: "covered" },
        { name: "wrong_record", observed_count: 1, task_ids: ["task-synthetic-write"], disposition: "covered" },
        { name: "wrong_status", observed_count: 1, task_ids: ["task-synthetic-write"], disposition: "covered" },
      ],
    } });
    await assert.rejects(() => runEvalCheck(uncoveredTask.project), /execution modes do not account for eval task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check rejects unknown task references, mismatched lineage, and duplicate execution groups", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-index-"));
  try {
    const updateIndex = (project, extraRow) => {
      const indexPath = join(project, "benchmark/execution-index.jsonl");
      const first = JSON.parse(readFileSync(indexPath, "utf8"));
      const body = [first, { ...first, ...extraRow }].map(JSON.stringify).join("\n") + "\n";
      writeFileSync(indexPath, body, { mode: 0o600 });
      const coveragePath = join(project, "coverage.json");
      const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
      coverage.lineage.execution_index_sha256 = sha(body);
      coverage.lineage.counts.complete = 2;
      writeJson(coveragePath, coverage);
    };

    const unknown = buildProject(join(root, "unknown"));
    updateIndex(unknown.project, { schema_version: "understudy.eval-execution-index-row.v1", execution_group: "exec-synthetic-2", lineage_status: "complete", capture_count: 1, task_id: "task-not-in-eval" });
    await assert.rejects(() => runEvalCheck(unknown.project), /references unknown eval task task-not-in-eval/);

    const duplicate = buildProject(join(root, "duplicate"));
    updateIndex(duplicate.project, { schema_version: "understudy.eval-execution-index-row.v1", execution_group: "exec-synthetic-1", lineage_status: "complete", capture_count: 1, task_id: "task-synthetic-write" });
    await assert.rejects(() => runEvalCheck(duplicate.project), /duplicate execution group exec-synthetic-1/);

    const mismatched = buildProject(join(root, "mismatched"));
    const tasksPath = join(mismatched.project, "benchmark/tasks.jsonl");
    const task = JSON.parse(readFileSync(tasksPath, "utf8"));
    task.execution_group = "exec-unrelated";
    writeFileSync(tasksPath, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    await assert.rejects(() => runEvalCheck(mismatched.project), /does not match complete execution group exec-synthetic-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check binds deterministic identity and the exact verified seven-day export proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-proof-"));
  try {
    const stable = buildProject(join(root, "stable"));
    const stableManifest = JSON.parse(readFileSync(join(stable.project, "eval-project.json"), "utf8"));
    assert.equal(
      deriveWorkloadEvalId({
        name: stableManifest.name,
        identity: { workload_name: stableManifest.identity.workload_name, workload_id: stableManifest.identity.workload_id, project_id: stableManifest.identity.project_id, org_id: stableManifest.identity.org_id },
        sourceWindow: { ingestion_cutoff: stableManifest.source.window.ingestion_cutoff, to: stableManifest.source.window.to, from: stableManifest.source.window.from, workload_id: stableManifest.source.window.workload_id, project_id: stableManifest.source.window.project_id, org_id: stableManifest.source.window.org_id, selector: stableManifest.source.window.selector, schema_version: stableManifest.source.window.schema_version },
      }),
      stableManifest.eval_id,
      "eval identity derivation is independent of caller object key order",
    );

    const delayedIngestion = buildProject(join(root, "delayed-ingestion"));
    rewriteProof(delayedIngestion.project, ({ manifest, proof }) => {
      manifest.source.window.ingestion_cutoff = "2026-08-30T12:00:01.000Z";
      proof.canonical_scope = manifest.source.window;
      proof.verified_receipt.canonical_scope = proof.canonical_scope;
      proof.verified_receipt.scope_hash = sha(JSON.stringify(proof.canonical_scope));
      manifest.eval_id = deriveWorkloadEvalId({
        name: manifest.name,
        identity: manifest.identity,
        sourceWindow: manifest.source.window,
      });
    });
    assert.equal((await runEvalCheck(delayedIngestion.project)).status, "passed");

    const prematureCutoff = buildProject(join(root, "premature-cutoff"));
    rewriteProof(prematureCutoff.project, ({ manifest, proof }) => {
      manifest.source.window.ingestion_cutoff = "2026-08-30T11:59:59.999Z";
      proof.canonical_scope = manifest.source.window;
      proof.verified_receipt.canonical_scope = proof.canonical_scope;
      proof.verified_receipt.scope_hash = sha(JSON.stringify(proof.canonical_scope));
      manifest.eval_id = deriveWorkloadEvalId({
        name: manifest.name,
        identity: manifest.identity,
        sourceWindow: manifest.source.window,
      });
    });
    await assert.rejects(
      () => runEvalCheck(prematureCutoff.project),
      /ingestion cutoff must be at or after the frozen window end/i,
    );

    const arbitraryId = buildProject(join(root, "id"));
    const arbitraryManifestPath = join(arbitraryId.project, "eval-project.json");
    const arbitraryManifest = JSON.parse(readFileSync(arbitraryManifestPath, "utf8"));
    arbitraryManifest.eval_id = `eval_${"f".repeat(24)}`;
    writeJson(arbitraryManifestPath, arbitraryManifest);
    await assert.rejects(() => runEvalCheck(arbitraryId.project), /Eval id does not match/);

    const renamed = buildProject(join(root, "name"));
    const renamedManifestPath = join(renamed.project, "eval-project.json");
    const renamedManifest = JSON.parse(readFileSync(renamedManifestPath, "utf8"));
    renamedManifest.name = "renamed after materialization";
    writeJson(renamedManifestPath, renamedManifest);
    await assert.rejects(() => runEvalCheck(renamed.project), /Eval id does not match/);

    const shortWindow = buildProject(join(root, "window"));
    rewriteProof(shortWindow.project, ({ manifest, proof }) => {
      manifest.source.window.from = "2026-08-24T12:00:00.000Z";
      proof.canonical_scope = manifest.source.window;
      proof.verified_receipt.canonical_scope = manifest.source.window;
      manifest.eval_id = deriveWorkloadEvalId({ name: manifest.name, identity: manifest.identity, sourceWindow: manifest.source.window });
    });
    await assert.rejects(() => runEvalCheck(shortWindow.project), /exactly seven days/);

    const scopeMismatch = buildProject(join(root, "scope"));
    rewriteProof(scopeMismatch.project, ({ proof }) => {
      proof.canonical_scope = { ...proof.canonical_scope, workload_id: "different-workload" };
      proof.verified_receipt.canonical_scope = proof.canonical_scope;
    });
    await assert.rejects(() => runEvalCheck(scopeMismatch.project), /proof canonical scope does not match/i);

    const unverified = buildProject(join(root, "unverified"));
    rewriteProof(unverified.project, ({ proof }) => { proof.verified_receipt.verified = false; });
    await assert.rejects(() => runEvalCheck(unverified.project), /Invalid export-proof|verified/i);

    const chain = buildProject(join(root, "chain"));
    rewriteProof(chain.project, ({ proof }) => { proof.verified_receipt.manifest_sha256 = "d".repeat(64); });
    await assert.rejects(() => runEvalCheck(chain.project), /terminal manifest does not match/i);

    const scopeHash = buildProject(join(root, "scope-hash"));
    rewriteProof(scopeHash.project, ({ proof }) => { proof.verified_receipt.scope_hash = "b".repeat(64); });
    await assert.rejects(() => runEvalCheck(scopeHash.project), /receipt scope hash does not match/i);

    const totals = buildProject(join(root, "totals"));
    rewriteProof(totals.project, ({ manifest, proof }) => {
      manifest.source.exported_capture_count = 2;
      proof.verified_receipt.cumulative_exported = 2;
    });
    await assert.rejects(() => runEvalCheck(totals.project), /Local eval source totals do not match/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check reconciles every execution row to every frozen source file exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-source-accounting-"));
  try {
    const observed = buildProject(join(root, "observed"));
    const observedCoveragePath = join(observed.project, "coverage.json");
    const observedCoverage = JSON.parse(readFileSync(observedCoveragePath, "utf8"));
    observedCoverage.execution_modes[0].observed_count = 2;
    writeJson(observedCoveragePath, observedCoverage);
    await assert.rejects(() => runEvalCheck(observed.project), /observed counts do not match the execution index/);

    const fabricated = buildProject(join(root, "fabricated"));
    rewriteExecutionIndex(fabricated.project, (rows) => {
      rows[0].source_files[0].local_path = "source/traces/fabricated.jsonl";
    });
    await assert.rejects(() => runEvalCheck(fabricated.project), /source binding .* is not present/i);

    const duplicate = buildProject(join(root, "duplicate"));
    rewriteExecutionIndex(duplicate.project, (rows) => {
      rows.push({ ...structuredClone(rows[0]), execution_group: "exec-synthetic-2", lineage_status: "unlinked", task_id: null, exclusion_reasons: ["missing_valid_trace_context"] });
    });
    const duplicateCoveragePath = join(duplicate.project, "coverage.json");
    const duplicateCoverage = JSON.parse(readFileSync(duplicateCoveragePath, "utf8"));
    duplicateCoverage.lineage.counts.unlinked = 1;
    duplicateCoverage.execution_modes[0].observed_count = 2;
    writeJson(duplicateCoveragePath, duplicateCoverage);
    await assert.rejects(() => runEvalCheck(duplicate.project), /binds source file .* more than once/i);

    const omitted = buildProject(join(root, "omitted"));
    const secondBody = `${JSON.stringify({ request_id: "req-synthetic-2", customer_request_body: {}, response_body: {} })}\n`;
    writeFileSync(join(omitted.project, "source/traces/capture-2.json"), secondBody, { mode: 0o600 });
    const sourceIndexPath = join(omitted.project, "source/index.jsonl");
    const sourceRows = readFileSync(sourceIndexPath, "utf8").trim().split("\n").map(JSON.parse);
    sourceRows.push({
      schema_version: "understudy.eval-source-capture.v1",
      request_id: "req-synthetic-2",
      capture_key: "captures/synthetic/capture-2.json",
      size_bytes: Buffer.byteLength(secondBody),
      content_sha256: sha(secondBody),
      local_path: "source/traces/capture-2.json",
    });
    const sourceIndexBody = `${sourceRows.map(JSON.stringify).join("\n")}\n`;
    writeFileSync(sourceIndexPath, sourceIndexBody, { mode: 0o600 });
    rewriteProof(omitted.project, ({ manifest, proof }) => {
      manifest.source.capture_count = 2;
      manifest.source.size_bytes += Buffer.byteLength(secondBody);
      manifest.source.index_sha256 = sha(sourceIndexBody);
      manifest.source.exported_capture_count = 2;
      manifest.source.exported_total_bytes = manifest.source.size_bytes;
      proof.verified_receipt.cumulative_exported = 2;
      proof.verified_receipt.total_bytes = manifest.source.size_bytes;
    });
    await assert.rejects(() => runEvalCheck(omitted.project), /capture total does not match|does not account for every frozen source file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check enforces created, metric, intent, check, and final approval chronology", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-time-"));
  try {
    const beforeCreation = buildProject(join(root, "creation"));
    const beforeCreationManifestPath = join(beforeCreation.project, "eval-project.json");
    const beforeCreationManifest = JSON.parse(readFileSync(beforeCreationManifestPath, "utf8"));
    beforeCreationManifest.created_at = "2026-08-30T12:01:00.000Z";
    writeJson(beforeCreationManifestPath, beforeCreationManifest);
    await assert.rejects(() => runEvalCheck(beforeCreation.project), /Metric approval cannot occur before eval project creation/);

    const metricAfterIntent = buildProject(join(root, "metric"));
    const metricPath = join(metricAfterIntent.project, "metric.json");
    const metric = JSON.parse(readFileSync(metricPath, "utf8"));
    metric.approved_at = "2026-08-30T12:01:00.000Z";
    writeJson(metricPath, metric);
    const intentPath = join(metricAfterIntent.project, "approval.json");
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.metric_sha256 = sha(readFileSync(metricPath));
    writeJson(intentPath, intent);
    await assert.rejects(() => runEvalCheck(metricAfterIntent.project), /Intent confirmation cannot occur before metric approval/);

    const finalAtCheck = buildProject(join(root, "final"));
    const first = await runEvalCheck(finalAtCheck.project, { now: new Date("2026-08-30T13:00:00.000Z") });
    const finalApprovalPath = join(finalAtCheck.project, "approval.json");
    const finalApproval = JSON.parse(readFileSync(finalApprovalPath, "utf8"));
    writeJson(finalApprovalPath, {
      ...finalApproval,
      approved_at: first.report.checked_at,
      eval_set_sha256: first.hashes.eval_set_sha256,
      coverage_sha256: first.hashes.coverage_sha256,
      environment_sha256: first.hashes.environment_sha256,
      verifier_sha256: first.hashes.verifier_sha256,
      check_report_sha256: first.hashes.check_report_sha256,
    });
    await assert.rejects(() => runEvalCheck(finalAtCheck.project, { now: new Date("2026-08-30T14:00:00.000Z") }), /must occur after the current check report/);

    const rollback = buildProject(join(root, "rollback"));
    const future = await runEvalCheck(rollback.project, { now: new Date("2026-08-30T14:00:00.000Z") });
    assert.equal(future.report.checked_at, "2026-08-30T14:00:00.000Z");
    const rewound = await runEvalCheck(rollback.project, { now: new Date("2026-08-30T13:00:00.000Z") });
    assert.equal(rewound.report.checked_at, "2026-08-30T13:00:00.000Z");
    const rollbackApprovalPath = join(rollback.project, "approval.json");
    writeJson(rollbackApprovalPath, {
      ...JSON.parse(readFileSync(rollbackApprovalPath, "utf8")),
      approved_at: "2026-08-30T13:05:00.000Z",
      eval_set_sha256: rewound.hashes.eval_set_sha256,
      coverage_sha256: rewound.hashes.coverage_sha256,
      environment_sha256: rewound.hashes.environment_sha256,
      verifier_sha256: rewound.hashes.verifier_sha256,
      check_report_sha256: rewound.hashes.check_report_sha256,
    });
    const approvedAfterRollback = await runEvalCheck(rollback.project, { now: new Date("2026-08-30T13:06:00.000Z") });
    assert.equal(approvedAfterRollback.publishable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check requires dedicated disjoint executable trees with all source and fixture data outside", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-roots-"));
  try {
    const projectRootVerifier = buildProject(join(root, "project-root"));
    const projectRootManifestPath = join(projectRootVerifier.project, "eval-project.json");
    const projectRootManifest = JSON.parse(readFileSync(projectRootManifestPath, "utf8"));
    projectRootManifest.artifacts.verifier = ".";
    writeJson(projectRootManifestPath, projectRootManifest);
    await assert.rejects(() => runEvalCheck(projectRootVerifier.project), /dedicated project-local directories|normalized, project-relative paths/);

    const overlapping = buildProject(join(root, "overlap"));
    writeFileSync(join(overlapping.project, "environment/check.mjs"), readFileSync(join(overlapping.project, "verifier/check.mjs")));
    const overlapManifestPath = join(overlapping.project, "eval-project.json");
    const overlapManifest = JSON.parse(readFileSync(overlapManifestPath, "utf8"));
    overlapManifest.artifacts.verifier = "environment";
    writeJson(overlapManifestPath, overlapManifest);
    const overlapHarnessPath = join(overlapping.project, "harness.json");
    const overlapHarness = JSON.parse(readFileSync(overlapHarnessPath, "utf8"));
    overlapHarness.verifier_entrypoint = "environment/check.mjs";
    writeJson(overlapHarnessPath, overlapHarness);
    const overlapMetricPath = join(overlapping.project, "metric.json");
    const overlapMetric = JSON.parse(readFileSync(overlapMetricPath, "utf8"));
    overlapMetric.validator.entrypoint = "environment/check.mjs";
    writeJson(overlapMetricPath, overlapMetric);
    const overlapApprovalPath = join(overlapping.project, "approval.json");
    const overlapApproval = JSON.parse(readFileSync(overlapApprovalPath, "utf8"));
    overlapApproval.metric_sha256 = sha(readFileSync(overlapMetricPath));
    writeJson(overlapApprovalPath, overlapApproval);
    await assert.rejects(() => runEvalCheck(overlapping.project), /must be disjoint/);

    const nested = buildProject(join(root, "nested-overlap"));
    mkdirSync(join(nested.project, "environment/verifier"), { recursive: true, mode: 0o700 });
    writeFileSync(join(nested.project, "environment/verifier/check.mjs"), readFileSync(join(nested.project, "verifier/check.mjs")), { mode: 0o600 });
    const nestedManifestPath = join(nested.project, "eval-project.json");
    const nestedManifest = JSON.parse(readFileSync(nestedManifestPath, "utf8"));
    nestedManifest.artifacts.verifier = "environment/verifier";
    writeJson(nestedManifestPath, nestedManifest);
    const nestedHarnessPath = join(nested.project, "harness.json");
    const nestedHarness = JSON.parse(readFileSync(nestedHarnessPath, "utf8"));
    nestedHarness.verifier_entrypoint = "environment/verifier/check.mjs";
    writeJson(nestedHarnessPath, nestedHarness);
    const nestedMetricPath = join(nested.project, "metric.json");
    const nestedMetric = JSON.parse(readFileSync(nestedMetricPath, "utf8"));
    nestedMetric.validator.entrypoint = "environment/verifier/check.mjs";
    writeJson(nestedMetricPath, nestedMetric);
    const nestedApprovalPath = join(nested.project, "approval.json");
    const nestedApproval = JSON.parse(readFileSync(nestedApprovalPath, "utf8"));
    nestedApproval.metric_sha256 = sha(readFileSync(nestedMetricPath));
    writeJson(nestedApprovalPath, nestedApproval);
    await assert.rejects(() => runEvalCheck(nested.project), /must be disjoint/);

    for (const kind of ["descriptor", "candidate", "state", "report", "source"]) {
      const item = buildProject(join(root, kind));
      if (kind === "descriptor") {
        writeFileSync(join(item.project, "environment/fixtures.json"), readFileSync(join(item.project, "checks/fixtures.json")));
        const environmentPath = join(item.project, "environment.json");
        const environment = JSON.parse(readFileSync(environmentPath, "utf8"));
        environment.fixtures = "environment/fixtures.json";
        writeJson(environmentPath, environment);
      } else if (kind === "candidate" || kind === "state") {
        const fixturesPath = join(item.project, "checks/fixtures.json");
        const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
        const path = `verifier/${kind}.js`;
        writeJson(join(item.project, path), kind === "candidate" ? { tool_calls: [] } : { records: {} });
        fixtures.representative[kind] = path;
        writeJson(fixturesPath, fixtures);
      } else if (kind === "report") {
        const manifestPath = join(item.project, "eval-project.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.artifacts.check_report = "verifier/report.json";
        writeJson(manifestPath, manifest);
      } else {
        const sourceBody = readFileSync(join(item.project, "source/traces/capture.json"));
        writeFileSync(join(item.project, "environment/capture.js"), sourceBody);
        const indexPath = join(item.project, "source/index.jsonl");
        const sourceRow = JSON.parse(readFileSync(indexPath, "utf8"));
        sourceRow.local_path = "environment/capture.js";
        const body = `${JSON.stringify(sourceRow)}\n`;
        writeFileSync(indexPath, body);
        const manifestPath = join(item.project, "eval-project.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.source.index_sha256 = sha(body);
        writeJson(manifestPath, manifest);
        rewriteExecutionIndex(item.project, (rows) => {
          rows[0].source_files[0].local_path = "environment/capture.js";
        });
      }
      await assert.rejects(() => runEvalCheck(item.project), /must remain outside executable module trees/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals check fails closed on escaped artifact paths and stale intent hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-evals-check-integrity-"));
  try {
    const escaped = buildProject(join(root, "escaped"));
    const manifestPath = join(escaped.project, "eval-project.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.artifacts.metric = "../../outside.json";
    writeJson(manifestPath, manifest);
    await assert.rejects(() => runEvalCheck(escaped.project), /remain inside|artifact path/i);

    const stale = buildProject(join(root, "stale"));
    writeFileSync(join(stale.project, "workload-profile.md"), "# Changed after confirmation\n", { mode: 0o600 });
    await assert.rejects(() => runEvalCheck(stale.project), /intent approval.*workload profile|hash/i);

    const linked = buildProject(join(root, "symlink"));
    rmSync(join(linked.project, "environment/replay.mjs"));
    symlinkSync(join(linked.project, "verifier/check.mjs"), join(linked.project, "environment/replay.mjs"));
    await assert.rejects(() => runEvalCheck(linked.project), /symbolic link/i);

    const externalRoot = join(root, "external-report-root");
    mkdirSync(externalRoot, { recursive: true });
    const reportLink = buildProject(join(root, "report-link"));
    const reportManifestPath = join(reportLink.project, "eval-project.json");
    const reportManifest = JSON.parse(readFileSync(reportManifestPath, "utf8"));
    reportManifest.artifacts.check_report = "external-link/nested/report.json";
    writeJson(reportManifestPath, reportManifest);
    symlinkSync(externalRoot, join(reportLink.project, "external-link"), "dir");
    await assert.rejects(() => runEvalCheck(reportLink.project), /check report artifact path cannot traverse symbolic links/i);
    assert.equal(existsSync(join(externalRoot, "nested")), false, "checking never creates a report directory outside the project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
