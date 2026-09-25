import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildRolloutReview } from "../dist/rollout-review.js";
import { renderRolloutReview } from "../dist/rollout-review-viewer.js";

const privateMarker = "SYNTHETIC_PAYLOAD_MUST_NOT_APPEAR";
function capture(side, id, task, { missingUser = false, error = false } = {}) {
  return {
    capture: {
      request_id: id,
      workload_name: `synthetic-${side}`,
      ts: side === "before" ? "2026-01-01T12:00:00Z" : "2026-02-01T12:00:00Z",
      metadata: { task, user: missingUser ? null : "synthetic-user", environment: "synthetic-production" },
      measured_ms: 120,
      status_code: 200,
      headers: { authorization: privateMarker },
      customer_request_body: { model: `synthetic-${side}-model`, messages: [
        { role: "user", content: privateMarker },
        ...(error ? [{ role: "tool", tool_call_id: "synthetic-call", content: JSON.stringify({ success: false, code: "invalid_arguments" }) }] : []),
      ] },
      response_body: { model: `synthetic-${side}-model`, choices: [{ finish_reason: "stop", message: { role: "assistant", content: privateMarker } }] },
    },
    source: { path: `${side}/synthetic.jsonl`, line: 1, sha256: "a".repeat(64) },
  };
}
function report() {
  return buildRolloutReview({
    before: { workload: "synthetic-before", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", captures: [capture("before", "synthetic-before-request", "synthetic-before-task")] },
    after: { workload: "synthetic-after", from: "2026-02-01T00:00:00Z", to: "2026-02-02T00:00:00Z", captures: [capture("after", "synthetic-after-request", "synthetic-after-task", { error: true }), capture("after", "synthetic-ungrouped-request", "synthetic-unknown-task", { missingUser: true })] },
    selectors: { taskId: "/metadata/task", userId: "/metadata/user", environment: "/metadata/environment", durationMs: "/measured_ms" },
    durationBasis: "synthetic declared request measurement",
  });
}
function outputPath() { return join(mkdtempSync(join(tmpdir(), "understudy-rollout-viewer-")), "private-view"); }
function loadData(output) {
  const context = { window: {} };
  runInNewContext(readFileSync(join(output, "rollout-data.js"), "utf8"), context);
  return JSON.parse(JSON.stringify(context.window.ROLLOUT_REVIEW));
}

test("writes a private offline report, metadata projection, and auditable ID ledger", () => {
  const output = outputPath();
  const input = report();
  const original = JSON.stringify(input);
  const result = renderRolloutReview(input, output);
  assert.equal(JSON.stringify(input), original, "rendering must not mutate frozen accounting");
  assert.deepEqual(result.counts, { tasks: 2, requests: 3, ungrouped: 1, comparable_groups: 1 });
  assert.equal(result.privacy.raw_payloads_included, false);
  assert.equal(result.privacy.must_not_commit, true);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  for (const path of Object.values(result.artifacts)) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(privateMarker));
  }
  const data = loadData(output);
  assert.deepEqual(data.accounting, input.accounting);
  assert.deepEqual(data.comparableGroups, JSON.parse(JSON.stringify(input.comparableGroups)));
  assert.deepEqual(data.pooledMetrics, JSON.parse(JSON.stringify(input.pooledMetrics)));
  assert.deepEqual(data.tasks, input.tasks);
  assert.deepEqual(JSON.parse(readFileSync(result.artifacts.report, "utf8")), data);
  const ids = JSON.parse(readFileSync(result.artifacts.request_ids, "utf8"));
  assert.deepEqual(ids.before, ["synthetic-before-request"]);
  assert.deepEqual(ids.after, ["synthetic-after-request", "synthetic-ungrouped-request"]);
  assert.equal(ids.records.find(row => row.requestId === "synthetic-ungrouped-request").disposition, "ungrouped");
  const html = readFileSync(result.artifacts.viewer, "utf8");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /src="\.\/rollout-data\.js"/);
  assert.match(html, /Export request IDs/);
  assert.match(html, /same users/);
  assert.doesNotMatch(html, /synthetic-before-request|synthetic-user/);
  assert.doesNotMatch(html, /\binnerHTML\b|insertAdjacentHTML|\beval\s*\(|new Function|\bfetch\s*\(|XMLHttpRequest|https?:\/\//);
});

test("escapes script termination and Unicode separators while preserving literal identifiers", () => {
  const input = report();
  const hostile = '</script><script>window.INJECTED = true</script>\u2028\u2029<img src=x onerror=alert(1)>';
  input.tasks[0].taskId = hostile;
  input.requests[0].requestedModel = hostile;
  input.comparableGroups[0].before.observedModels["__proto__"] = 1;
  const output = outputPath();
  renderRolloutReview(input, output);
  const script = readFileSync(join(output, "rollout-data.js"), "utf8");
  assert.doesNotMatch(script, /<|\u2028|\u2029/);
  const context = { window: {} };
  runInNewContext(script, context);
  assert.equal(context.window.INJECTED, undefined);
  assert.equal(context.window.ROLLOUT_REVIEW.tasks[0].taskId, hostile);
  assert.equal(context.window.ROLLOUT_REVIEW.requests[0].requestedModel, hostile);
  assert.equal(Object.hasOwn(context.window.ROLLOUT_REVIEW.comparableGroups[0].before.observedModels, "__proto__"), true);
  assert.equal(context.window.ROLLOUT_REVIEW.comparableGroups[0].before.observedModels["__proto__"], 1);
});

test("allowlists nested metadata and excludes unexpected raw bodies, headers, paths, and text", () => {
  const input = report();
  input.rawCaptures = [{ headers: { authorization: privateMarker } }];
  input.requests[0].headers = { authorization: privateMarker };
  input.requests[0].response_body = privateMarker;
  input.requests[0].finalText = privateMarker;
  input.requests[0].source = { path: `/synthetic-private/${privateMarker}`, authorization: privateMarker, line: 7 };
  input.requests[0].toolEvents = [{ kind: "call", name: "synthetic-tool", callId: "synthetic-call", fingerprint: "b".repeat(64), isError: false, argumentValidation: false, origin: "response", arguments: privateMarker, headers: { authorization: privateMarker } }];
  input.tasks[0].response = { content: privateMarker };
  input.comparableGroups[0].before.raw = privateMarker;
  input.pooledMetrics.before.raw = privateMarker;
  input.pooledMetrics.before.topSlowRequests[0].raw = privateMarker;
  input.caveats.push({ raw: privateMarker });
  const output = outputPath();
  const result = renderRolloutReview(input, output);
  const projected = loadData(output);
  assert.equal(projected.requests[0].finalText, null);
  assert.deepEqual(projected.requests[0].source, { line: 7 });
  assert.equal(projected.requests[0].toolEvents[0].name, "synthetic-tool");
  for (const path of Object.values(result.artifacts)) assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(privateMarker));
});

test("tightens existing permissions and does not write through symlinks or hard links", () => {
  const output = outputPath();
  mkdirSync(output, { mode: 0o755 });
  chmodSync(output, 0o755);
  renderRolloutReview(report(), output);
  assert.equal(statSync(output).mode & 0o777, 0o700);

  const root = mkdtempSync(join(tmpdir(), "understudy-rollout-links-"));
  const external = join(root, "synthetic-external.txt");
  writeFileSync(external, "untouched", { mode: 0o644 });
  const linkedOutput = join(root, "linked-output");
  mkdirSync(linkedOutput);
  symlinkSync(external, join(linkedOutput, "report.json"));
  assert.throws(() => renderRolloutReview(report(), linkedOutput), /non-regular output/);
  assert.equal(readFileSync(external, "utf8"), "untouched");
  assert.equal(existsSync(join(linkedOutput, "index.html")), false, "preflight all targets before writing");
  const directoryLink = join(root, "directory-link");
  symlinkSync(linkedOutput, directoryLink);
  assert.throws(() => renderRolloutReview(report(), directoryLink), /not a symlink/);

  const hardOutput = join(root, "hard-output");
  mkdirSync(hardOutput);
  linkSync(external, join(hardOutput, "report.json"));
  renderRolloutReview(report(), hardOutput);
  assert.equal(readFileSync(external, "utf8"), "untouched");
  assert.notEqual(statSync(external).ino, statSync(join(hardOutput, "report.json")).ino);
});

test("rejects unsupported or payload-bearing reports before creating output", () => {
  for (const input of [null, { ...report(), schema_version: "unsupported" }, { ...report(), privacy: { raw_payloads_included: true } }]) {
    const output = outputPath();
    assert.throws(() => renderRolloutReview(input, output), /metadata-only/);
    assert.equal(existsSync(output), false);
  }
});

// Minimal DOM fixture checks actual control behavior without a browser dependency.
class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.style = {}; this.value = ""; this.hidden = false; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.events[type] = callback; }
  scrollIntoView() {}
}
function mountedViewer(hash = "", input = report()) {
  const output = outputPath();
  renderRolloutReview(input, output);
  const html = readFileSync(join(output, "index.html"), "utf8");
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get("app").hidden = true;
  elements.get("failure").hidden = true;
  elements.get("period").value = "all";
  elements.get("signal").value = "all";
  const context = {
    window: { ROLLOUT_REVIEW: loadData(output) }, location: { hash }, history: { replaceState() {} },
    document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag), createTextNode: value => { const node = new Element("#text"); node.textContent = value; return node; } },
  };
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  runInNewContext(inline, context);
  return elements;
}

test("offline controls link a cohort to its exact task and preserve unknown hash semantics", () => {
  const elements = mountedViewer();
  assert.equal(elements.get("app").hidden, false);
  assert.equal(elements.get("failure").hidden, true);
  assert.match(elements.get("phases").textContent, /Mean requests \/ task/);
  assert.match(elements.get("phases").textContent, /Mixed observed models · included tasks/);
  const first = elements.get("task-list").children[0];
  first.events.click();
  assert.match(elements.get("detail").textContent, /synthetic-after-request/);
  assert.doesNotMatch(elements.get("detail").textContent, /synthetic-before-request/);
  assert.match(elements.get("detail").textContent, /intentionally omitted/);
  assert.match(elements.get("detail").textContent, /resulting state/);

  elements.get("search").value = "no-such-synthetic-task";
  elements.get("search").events.input();
  assert.match(elements.get("task-list").textContent, /No tasks match/);
  assert.doesNotMatch(elements.get("detail").textContent, /synthetic-after-request/);

  for (const hash of ["#unknown-task", "#%malformed"]) {
    const missing = mountedViewer(hash);
    assert.equal(missing.get("app").hidden, false);
    assert.equal(missing.get("failure").hidden, true);
    assert.match(missing.get("detail").textContent, /requested task is unavailable/);
    assert.doesNotMatch(missing.get("detail").textContent, /synthetic-before-request|synthetic-after-request/);
  }
});

test("ungrouped evidence stays outside task counts and latency is hidden without a basis", () => {
  const input = report();
  input.durationBasis = null;
  const elements = mountedViewer("", input);
  assert.match(elements.get("timing").textContent, /Latency is not compared/);
  elements.get("cohort").value = "";
  elements.get("cohort").events.change();
  elements.get("signal").value = "ungrouped";
  elements.get("signal").events.change();
  assert.match(elements.get("task-count").textContent, /1 ungrouped requests shown/);
  elements.get("task-list").children[0].events.click();
  assert.match(elements.get("detail").textContent, /synthetic-ungrouped-request/);
  assert.match(elements.get("detail").textContent, /outside task denominators/);
  assert.match(elements.get("detail").textContent, /basis unspecified/);
});

test("All groups preserves pooled duration coverage and slow-request task links across cohorts", () => {
  const baseline = capture("before", "synthetic-complete-request", "synthetic-complete-task");
  const measured = capture("before", "synthetic-slow-request", "synthetic-partial-task");
  measured.capture.metadata.user = "synthetic-second-user";
  measured.capture.measured_ms = 900;
  const missing = capture("before", "synthetic-missing-request", "synthetic-partial-task");
  missing.capture.metadata.user = "synthetic-second-user";
  missing.capture.ts = "2026-01-01T12:00:01Z";
  delete missing.capture.measured_ms;
  const input = buildRolloutReview({
    before: { workload: "synthetic-before", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", captures: [baseline, measured, missing] },
    after: { workload: "synthetic-after", from: "2026-02-01T00:00:00Z", to: "2026-02-02T00:00:00Z", captures: [] },
    selectors: { taskId: "/metadata/task", userId: "/metadata/user", environment: "/metadata/environment", durationMs: "/measured_ms" },
    durationBasis: "Synthetic request measurement",
  });
  const elements = mountedViewer("", input);
  elements.get("cohort").value = "";
  elements.get("cohort").events.change();
  assert.match(elements.get("cohort-heading").textContent, /All groups/);
  assert.match(elements.get("cohort-note").textContent, /Pooled totals mix users/);
  const before = elements.get("phases").children[0];
  assert.match(before.textContent, /Recorded duration and sensitivity/);
  assert.match(before.textContent, /Complete task sums1 \/ 2/);
  assert.match(before.textContent, /Median recorded sum120\.0 ms/);
  assert.match(before.textContent, /Requests missing measurements1 \/ 3/);
  assert.match(before.textContent, /Mean requests\/task after dropping largest task1\.00/);
  assert.match(elements.get("phases").children[1].textContent, /No eligible captured tasks/);
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const slowLink = descendants(before).find(node => node.tagName === "button" && node.textContent.includes("synthetic-slow-request"));
  assert.ok(slowLink, "the longest measured request stays inspectable even when its task has incomplete duration coverage");
  slowLink.events.click();
  assert.match(elements.get("detail").textContent, /Task synthetic-partial-task/);
  assert.match(elements.get("detail").textContent, /Recorded duration sum— ms · 1 \/ 2 requests measured/);
  assert.match(elements.get("detail").textContent, /synthetic-slow-request/);
  assert.match(elements.get("detail").textContent, /synthetic-missing-request/);
});
