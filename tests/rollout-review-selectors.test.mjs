import assert from "node:assert/strict";
import test from "node:test";
import { buildRolloutReview, validateIdentitySelectors } from "../dist/rollout-review.js";

const selectors = { taskId: "/metadata/execution", userId: "/metadata/user", environment: "/metadata/environment" };
function input(metadata = { execution: "synthetic-task", user: "synthetic-user", environment: "synthetic-production" }) {
  return {
    selectors,
    before: { workload: "synthetic-before", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", captures: [{ capture: {
      request_id: "synthetic-request", workload_name: "synthetic-before", ts: "2026-01-01T12:00:00Z", status_code: 200,
      metadata,
      request: { headers: { Authorization: "SYNTHETIC_COMPACT_CREDENTIAL" }, body: { messages: [{ role: "user", content: "Synthetic private prompt content." }] } },
      response: { model: "synthetic-model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic private completion." } }] },
    } }] },
    after: { workload: "synthetic-after", from: "2026-01-02T00:00:00Z", to: "2026-01-03T00:00:00Z", captures: [] },
  };
}

test("identity selectors reject payload, credential, and arbitrary root paths for every role", () => {
  const unsafe = [
    "", "/", "/anything", "/request/body/messages/0/content", "/customer_request_body/messages/0/content",
    "/request/headers/Authorization", "/headers/authorization", "/metadata/authorization", "/metadata/Authorization",
    "/metadata/api_key", "/metadata/apiKey", "/metadata/API-KEY", "/tags/x-api-key", "/metadata/token",
    "/request/body/metadata/access_token", "/request_body/metadata/clientSecret", "/metadata/nested/credentials/id",
    "/metadata/messages/0/content", "/metadata/nested/prompt", "/metadata/body/user_id", "/metadata/tool_arguments/user",
    "/response_body/metadata/user_id", "/upstream_request_body/metadata/user_id", "/metadata/headers~1Authorization",
    "/metadata/__proto__/value", "/metadata/constructor/value", "/metadata/secret", "/metadata/line\nkey", "/metadata/",
  ];
  for (const field of ["taskId", "userId", "environment"]) {
    for (const pointer of unsafe) {
      const current = { ...selectors, [field]: pointer };
      assert.throws(() => validateIdentitySelectors(current), /Invalid RFC6901|Unsupported/);
      const supplied = input(); supplied.selectors = current;
      assert.throws(() => buildRolloutReview(supplied), /Invalid RFC6901|Unsupported/);
    }
  }
});

test("explicit metadata identities support nesting, request wrappers, and execution tokens", () => {
  for (const prefix of ["/metadata", "/tags", "/customer_request_body/metadata", "/customer_request_body/body/metadata", "/request_body/tags", "/request/metadata", "/request/body/metadata"]) {
    assert.doesNotThrow(() => validateIdentitySelectors({ taskId: `${prefix}/application/execution_token`, userId: `${prefix}/identity/user`, environment: `${prefix}/app_environment` }));
  }
  assert.doesNotThrow(() => validateIdentitySelectors({ taskId: "/execution_id", userId: "/endUserId", environment: "/app_environment" }));
  assert.doesNotThrow(() => validateIdentitySelectors({ taskId: "/taskId", userId: "/user_id", environment: "/environment" }));
  const supplied = input();
  supplied.before.captures[0].capture.request.body = JSON.stringify({ metadata: { application: { execution_token: "synthetic-execution-token" }, identity: { user: "synthetic-user" }, environment: "synthetic-production" } });
  supplied.selectors = { taskId: "/request/body/metadata/application/execution_token", userId: "/request/body/metadata/identity/user", environment: "/request/body/metadata/environment" };
  const report = buildRolloutReview(supplied);
  assert.equal(report.tasks[0].taskId, "synthetic-execution-token");
  assert.equal(report.tasks[0].userId, "synthetic-user");
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_COMPACT_CREDENTIAL|Synthetic private prompt|Synthetic private completion/);
});

test("identity selectors reject malformed pointers without echoing sensitive path contents", () => {
  const sensitivePath = "/metadata/SYNTHETIC_PATH_MUST_NOT_ECHO~2";
  for (const invalid of [null, {}, { ...selectors, userId: sensitivePath }, { ...selectors, taskId: "/metadata/" + "a".repeat(2048) }]) {
    assert.throws(() => validateIdentitySelectors(invalid), error => {
      assert.doesNotMatch(error.message, /SYNTHETIC_PATH_MUST_NOT_ECHO|a{100}/);
      return /selector/.test(error.message);
    });
  }
});

test("prose, oversized values, objects, and control characters never become exported identities", () => {
  const invalid = ["Synthetic private prompt sentence.", "synthetic\nmultiline", "synthetic\tuser", "synthetic\u0000id", "synthetic\u0085id", "synthetic\u2028id", "", " ", "SYNTHETIC_OVERSIZED_" + "a".repeat(512), { nested: "synthetic" }, ["synthetic"]];
  for (const field of ["execution", "user", "environment"]) for (const value of invalid) {
    const metadata = { execution: "synthetic-task", user: "synthetic-user", environment: "synthetic-production", [field]: value };
    const report = buildRolloutReview(input(metadata));
    const identity = field === "execution" ? "taskId" : field === "user" ? "userId" : "environment";
    assert.equal(report.requests[0][identity], null);
    assert.equal(report.tasks.length, 0);
    assert.equal(report.ungrouped.length, 1);
    assert.ok(report.requests[0].flags.includes(`missing_or_invalid_${identity}_selector`));
    assert.doesNotMatch(JSON.stringify(report), /Synthetic private prompt sentence|SYNTHETIC_OVERSIZED_/);
  }
});

test("compact identifiers stay exact and reports disclose that allowed metadata is not secret scrubbed", () => {
  const supplied = input({ execution: 42, user: "synthetic:user@example.invalid", environment: "synthetic-production-eu" });
  const report = buildRolloutReview(supplied);
  assert.equal(report.tasks[0].taskId, "42");
  assert.equal(report.tasks[0].userId, "synthetic:user@example.invalid");
  assert.equal(report.tasks[0].environment, "synthetic-production-eu");
  assert.ok(report.caveats.some(caveat => /not automatically scrubbed of secrets/.test(caveat)));
  const compact = "SYNTHETIC_COMPACT_VALUE_REQUIRES_OWNER_REVIEW";
  const privateReport = buildRolloutReview(input({ execution: "synthetic-task", user: compact, environment: "synthetic-production" }));
  assert.equal(privateReport.tasks[0].userId, compact, "a location guard must not claim arbitrary metadata redaction");
  assert.equal(privateReport.privacy.contains_private_identifiers, true);
});
