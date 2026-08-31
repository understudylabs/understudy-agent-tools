import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  EvalApprovalSchema,
  EvalCheckFixturesSchema,
  EvalCheckReportSchema,
  EvalCoverageSchema,
  EvalEnvironmentSchema,
  EvalExecutionIndexRowSchema,
  EvalExportProofSchema,
  EvalHarnessSchema,
  EvalMetricSchema,
  EvalSplitsSchema,
  WorkloadEvalProjectSchema,
} from "../dist/evals/authoring-contracts.js";

const sha = "a".repeat(64);
const timestamp = "2026-08-30T12:00:00.000Z";
const pathPatternValue = "environment/replay.mjs";
const scope = { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: "org", project_id: "project", workload_id: "workload", from: timestamp, to: timestamp, ingestion_cutoff: timestamp };

function schemaAccepts(root, value) {
  const validate = (schema, current) => {
    if (schema.$ref) {
      const name = schema.$ref.match(/^#\/\$defs\/(.+)$/)?.[1];
      return name !== undefined && validate(root.$defs[name], current);
    }
    if (schema.allOf && !schema.allOf.every((part) => validate(part, current))) return false;
    if (schema.anyOf && !schema.anyOf.some((part) => validate(part, current))) return false;
    if (schema.oneOf && schema.oneOf.filter((part) => validate(part, current)).length !== 1) return false;
    if (schema.not && validate(schema.not, current)) return false;
    if (schema.if && validate(schema.if, current) && schema.then && !validate(schema.then, current)) return false;
    if (Object.hasOwn(schema, "const") && current !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(current)) return false;

    if (schema.type === "object") {
      if (current === null || typeof current !== "object" || Array.isArray(current)) return false;
    } else if (schema.type === "array") {
      if (!Array.isArray(current)) return false;
    } else if (schema.type === "string") {
      if (typeof current !== "string") return false;
    } else if (schema.type === "integer") {
      if (!Number.isInteger(current)) return false;
    } else if (schema.type === "number") {
      if (typeof current !== "number" || !Number.isFinite(current)) return false;
    } else if (schema.type === "null" && current !== null) return false;

    if (typeof current === "string") {
      if (schema.minLength !== undefined && current.length < schema.minLength) return false;
      if (schema.maxLength !== undefined && current.length > schema.maxLength) return false;
      if (schema.pattern !== undefined && !(new RegExp(schema.pattern, "u")).test(current)) return false;
      if (schema.format === "date-time" && (Number.isNaN(Date.parse(current)) || !/^\d{4}-\d{2}-\d{2}T/.test(current))) return false;
    }
    if (typeof current === "number") {
      if (schema.minimum !== undefined && current < schema.minimum) return false;
      if (schema.maximum !== undefined && current > schema.maximum) return false;
      if (schema.exclusiveMinimum !== undefined && current <= schema.exclusiveMinimum) return false;
    }
    if (Array.isArray(current)) {
      if (schema.minItems !== undefined && current.length < schema.minItems) return false;
      if (schema.maxItems !== undefined && current.length > schema.maxItems) return false;
      if (schema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) return false;
      if (schema.items && !current.every((item) => validate(schema.items, item))) return false;
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      if ((schema.required ?? []).some((key) => !Object.hasOwn(current, key))) return false;
      const properties = schema.properties ?? {};
      for (const [key, item] of Object.entries(current)) {
        if (properties[key] && !validate(properties[key], item)) return false;
        if (!properties[key] && schema.additionalProperties === false) return false;
      }
    }
    return true;
  };
  return validate(root, value);
}

const evidence = { kind: "workload_invariant", reference: "metric#invariant", statement: "The invariant independently establishes correctness." };
const outcome = {
  task_id: "task-1",
  input_provenance: "owner-fixture",
  evidence,
  candidate_sha256: sha,
  state_sha256: null,
  replay_sha256: sha,
  result: "passed",
  feedback: "correct",
};
const samples = {
  "project.v2": {
    runtime: WorkloadEvalProjectSchema,
    value: {
      schema_version: "understudy.eval-project.v2",
      eval_id: "eval_0123456789abcdef01234567",
      name: "weekly eval",
      status: "authoring",
      created_at: timestamp,
      identity: { org_id: "org", project_id: "project", workload_id: "workload", workload_name: "support" },
      source: {
        window: scope,
        capture_count: 1, size_bytes: 12, index: "source/index.jsonl", index_sha256: sha,
        export_proof: "source/export-proof.json", export_proof_sha256: sha, exported_capture_count: 1, exported_total_bytes: 12,
        terminal_receipt_verified: true,
      },
      artifacts: { workload_profile: "workload-profile.md", coverage: "coverage.json", harness: "harness.json", environment: "environment.json", metric: "metric.json", splits: "splits.json", tasks: "benchmark/tasks.jsonl", execution_index: "benchmark/execution-index.jsonl", analysis: "benchmark/analysis.md", verifier: "verifier", approval: "approval.json", check_report: "checks/report.json" },
      authoring: { owner: "coding_agent", semantic_preparation_performed: true },
      privacy: { local_only: true, contains_customer_payloads: true, upload_performed: false, provider_called: false },
    },
    reject: (value) => { value.eval_id = "random-id"; },
  },
  "coverage.v1": {
    runtime: EvalCoverageSchema,
    value: { schema_version: "understudy.eval-coverage.v1", lineage: { execution_index_sha256: sha, counts: { complete: 1, ambiguous: 0, unlinked: 0 } }, execution_modes: [{ name: "write", observed_count: 1, task_ids: ["task-1"], disposition: "covered" }], failure_classes: [{ name: "wrong", observed_count: 0, task_ids: [], disposition: "owner_accepted_uncovered", owner_note: "Owner accepts this current gap." }] },
    reject: (value) => { value.execution_modes = []; },
  },
  "export-proof.v1": {
    runtime: EvalExportProofSchema,
    value: {
      schema_version: "understudy.eval-export-proof.v1",
      canonical_scope: scope,
      segment_manifest_sha256: [sha],
      terminal_receipt: "signed receipt",
      verified_receipt: {
        verified: true,
        scope_hash: sha,
        chain_id: "chain",
        segment_id: sha,
        segment_index: 0,
        manifest_sha256: sha,
        previous_manifest_sha256: null,
        cumulative_scanned: 1,
        cumulative_matched: 1,
        cumulative_exported: 1,
        total_bytes: 12,
        expires_at: timestamp,
        canonical_scope: scope,
      },
    },
    reject: (value) => { value.verified_receipt.verified = false; },
  },
  "execution-index-row.v1": {
    runtime: EvalExecutionIndexRowSchema,
    value: { schema_version: "understudy.eval-execution-index-row.v1", source_status: "included", execution_group: "execution-1", lineage_status: "complete", capture_count: 1, source_files: [{ local_path: "source/traces/one.jsonl", content_sha256: sha }], task_id: "task-1", exclusion_reasons: [] },
    reject: (value) => { value.source_status = "excluded"; },
  },
  "metric.v1": {
    runtime: EvalMetricSchema,
    value: { schema_version: "understudy.eval-metric.v1", name: "state", description: "State matches", validator: { kind: "local_verifier", entrypoint: "verifier/check.mjs" }, pass_threshold: 1, failure_taxonomy: ["wrong"], approved: true, approved_by: "owner", approved_at: timestamp },
    reject: (value) => { value.validator.entrypoint = "../outside.mjs"; },
  },
  "harness.v1": {
    runtime: EvalHarnessSchema,
    value: { schema_version: "understudy.eval-harness.v1", format: "local_module.v1", environment_entrypoint: pathPatternValue, verifier_entrypoint: "verifier/check.mjs", timeout_ms: 5_000 },
    reject: (value) => { value.timeout_ms = 0; },
  },
  "environment.v1": {
    runtime: EvalEnvironmentSchema,
    value: { schema_version: "understudy.eval-environment.v1", kind: "basic", description: "Deterministic local replay", adapter: pathPatternValue, fixtures: "checks/fixtures.json", provider_calls: false },
    reject: (value) => { value.provider_calls = true; },
  },
  "splits.v1": {
    runtime: EvalSplitsSchema,
    value: { schema_version: "understudy.eval-splits.v1", construction: ["task-1"], fit: [], heldout: [] },
    reject: (value) => { value.extra = []; },
  },
  "check-fixtures.v1": {
    runtime: EvalCheckFixturesSchema,
    value: { schema_version: "understudy.eval-check-fixtures.v1", representative: { task_id: "task-1", input_provenance: "trace", candidate: "fixtures/good.json", correctness_evidence: evidence }, known_good: { task_id: "task-1", input_provenance: "owner", candidate: "fixtures/good.json", correctness_evidence: evidence }, intentionally_wrong: { task_id: "task-1", input_provenance: "owner", candidate: "fixtures/wrong.json", incorrectness_evidence: evidence } },
    reject: (value) => { value.known_good.correctness_evidence.kind = "incumbent_trace"; },
  },
  "approval.v1": {
    runtime: EvalApprovalSchema,
    value: { schema_version: "understudy.eval-approval.v1", approver: "owner", intent_confirmed_at: timestamp, workload_profile_sha256: sha, metric_sha256: sha },
    reject: (value) => { value.approved_at = timestamp; },
  },
  "check.v1": {
    runtime: EvalCheckReportSchema,
    value: { schema_version: "understudy.eval-check.v1", checked_at: timestamp, status: "passed", task_count: 1, representative_replay: { ...outcome, provider_called: false }, oracle_fixture: outcome, wrong_fixture: { ...outcome, result: "rejected", feedback: "wrong" }, source: { scope, scope_sha256: sha, index_sha256: sha, export_proof_sha256: sha, capture_count: 1, size_bytes: 12 }, check_input_sha256: sha, eval_set_sha256: sha, coverage_sha256: sha, environment_sha256: sha, verifier_sha256: sha },
    reject: (value) => { value.wrong_fixture.result = "passed"; },
  },
};

for (const [name, sample] of Object.entries(samples)) {
  test(`${name} packaged schema and runtime contract accept and reject the same golden artifacts`, () => {
    const schema = JSON.parse(readFileSync(resolve("schemas", `understudy.eval-${name}.schema.json`), "utf8"));
    assert.equal(sample.runtime.safeParse(sample.value).success, true, "runtime accepts golden artifact");
    assert.equal(schemaAccepts(schema, sample.value), true, "packaged schema accepts golden artifact");

    const rejected = structuredClone(sample.value);
    sample.reject(rejected);
    assert.equal(sample.runtime.safeParse(rejected).success, false, "runtime rejects drift artifact");
    assert.equal(schemaAccepts(schema, rejected), false, "packaged schema rejects drift artifact");

    const extra = structuredClone(sample.value);
    extra.unexpected = true;
    assert.equal(sample.runtime.safeParse(extra).success, false, "runtime rejects undeclared fields");
    assert.equal(schemaAccepts(schema, extra), false, "packaged schema rejects undeclared fields");
  });
}
