import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  TIEBREAKER_MODEL,
  TIEBREAKER_PROMPT_PATH,
  analyzeTiebreaker,
  buildRemoteReviewEvidence,
  parseTiebreakerDecision,
  recordTiebreakerFeedback,
  validateTiebreakerRoute,
} from "../dist/supervision/tiebreaker.js";
import {
  CONSERVATIVE_CASE_FUSE_USD,
  TIEBREAKER_EVAL_SUITE_PATH,
  runTiebreakerEval,
} from "../dist/supervision/tiebreaker-eval.js";

const root = mkdtempSync(join(tmpdir(), "understudy-supervision-tiebreaker-"));
const originalApiKey = process.env.UNDERSTUDY_API_KEY;
const originalGateway = process.env.UNDERSTUDY_GATEWAY_URL;
const originalHome = process.env.HOME;

const input = {
  marker_id: "run-1:intervention:0",
  stage: "take_over",
  user_request: "Return exactly two words.",
  small_model: "understudy-small",
  small_output: "three incorrect words",
  decision_phase: "streaming",
  reason: "The answer contains three words instead of two.",
  reason_source: "supervisor",
  tool_rounds_before_decision: 0,
  max_tool_rounds: 4,
  tool_results: [{ name: "lookup", result_ok: true, result: "two words required" }],
  system_prompt: "must stay local",
  after_output: "teacher output must stay local",
};

before(() => {
  const home = join(root, "home");
  const config = join(home, ".understudy");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const credentials = join(config, "credentials.json");
  writeFileSync(credentials, JSON.stringify({
    gateway_url: "https://gateway.example.test",
    orgs: {
      org_test: {
        api_key: "sk_test_tiebreaker",
        gateway_url: "https://gateway.example.test",
      },
    },
  }));
  chmodSync(credentials, 0o600);
  process.env.HOME = home;
  process.env.UNDERSTUDY_API_KEY = "sk_test_tiebreaker";
  process.env.UNDERSTUDY_GATEWAY_URL = "https://gateway.example.test";
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalApiKey === undefined) delete process.env.UNDERSTUDY_API_KEY;
  else process.env.UNDERSTUDY_API_KEY = originalApiKey;
  if (originalGateway === undefined) delete process.env.UNDERSTUDY_GATEWAY_URL;
  else process.env.UNDERSTUDY_GATEWAY_URL = originalGateway;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

test("remote evidence is strictly pre-intervention and bounded", () => {
  const evidence = buildRemoteReviewEvidence(input);
  const text = JSON.stringify(evidence);
  assert.match(text, /three incorrect words/);
  assert.match(text, /max_tool_rounds/);
  assert.equal(evidence.decision_phase, "streaming");
  assert.doesNotMatch(text, /teacher output/);
  assert.doesNotMatch(text, /must stay local/);
  assert.equal(evidence.recorded_supervisor_action, "interrupt");
});

test("provider routes and response contract are exact", () => {
  assert.deepEqual(
    validateTiebreakerRoute({
      provider: "fireworks",
      project: "rehearsal",
      workload: "supervision-judge",
      orgId: "org_test",
    }),
    {
      provider: "fireworks",
      project: "rehearsal",
      workload: "supervision-judge",
      orgId: "org_test",
    },
  );
  assert.throws(
    () => validateTiebreakerRoute({ provider: "other", project: "rehearsal", workload: "judge" }),
    /provider must be/,
  );
  assert.throws(
    () => validateTiebreakerRoute({ provider: "lilac", project: "Bad\/Project", workload: "judge" }),
    /project must be/,
  );
  assert.deepEqual(
    parseTiebreakerDecision("```json\n{\"recommended_action\":\"interrupt\",\"confidence\":1.4,\"reason\":\"Wrong word count.\",\"supervisor_reason_quality\":\"grounded\"}\n```"),
    {
      recommended_action: "interrupt",
      confidence: 1,
      reason: "Wrong word count.",
      supervisor_reason_quality: "grounded",
    },
  );
});

test("judge policy distinguishes complete, unfinished, and recoverable output", () => {
  const prompt = readFileSync(TIEBREAKER_PROMPT_PATH, "utf8");
  assert.match(prompt, /already satisfies every requested constraint, choose stop/);
  assert.match(prompt, /use decision_phase/);
  assert.match(prompt, /Do not infer that a streaming prefix is final/);
  assert.match(prompt, /specific recoverable defect already present/);
});

test("analysis requires explicit consent before any remote request", async () => {
  let called = false;
  await assert.rejects(
    analyzeTiebreaker({
      input,
      route: { provider: "lilac", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" },
      confirmRemote: false,
      root,
      fetchImpl: async () => {
        called = true;
        throw new Error("must not run");
      },
    }),
    /requires --confirm-remote/,
  );
  assert.equal(called, false);
});

test("analysis verifies the served model, caches private evidence, and records judge feedback", async () => {
  let calls = 0;
  let requestBody;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "zai-org/glm-5.2",
      choices: [{ message: { content: JSON.stringify({
        recommended_action: "interrupt",
        confidence: 0.93,
        reason: "The output violates the exact word count.",
        supervisor_reason_quality: "grounded",
      }) } }],
      usage: { prompt_tokens: 123, completion_tokens: 32 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-understudy-mode": "gateway",
        "x-understudy-route": "lilac",
        "x-understudy-effective-model": "zai-org/glm-5.2",
      },
    });
  };
  const options = {
    input,
    route: { provider: "lilac", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" },
    confirmRemote: true,
    root,
    fetchImpl,
  };
  const fresh = await analyzeTiebreaker(options);
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.assessment, "agree");
  assert.equal(fresh.cache_hit, false);
  assert.equal(fresh.served_model, "zai-org/glm-5.2");
  assert.equal(fresh.prompt_tokens, 123);
  assert.equal(calls, 1);
  const sent = requestBody.messages.at(-1).content;
  assert.doesNotMatch(sent, /teacher output/);
  assert.doesNotMatch(sent, /must stay local/);

  const cached = await analyzeTiebreaker(options);
  assert.equal(cached.cache_hit, true);
  assert.equal(calls, 1);
  const analysisDirectory = join(root, "analyses", fresh.evidence_sha256);
  const analysisFiles = readdirSync(analysisDirectory);
  assert.equal(analysisFiles.length, 1);
  assert.equal(statSync(analysisDirectory).mode & 0o077, 0);
  assert.equal(statSync(join(analysisDirectory, analysisFiles[0])).mode & 0o077, 0);
  const persisted = readFileSync(join(analysisDirectory, analysisFiles[0]), "utf8");
  assert.match(persisted, /three incorrect words/);
  assert.doesNotMatch(persisted, /teacher output/);

  const judged = recordTiebreakerFeedback({
    evidenceSha256: fresh.evidence_sha256,
    model: TIEBREAKER_MODEL,
    helpful: false,
    root,
  });
  assert.equal(judged.user_helpful, false);
  assert.equal(readdirSync(join(root, "feedback", fresh.evidence_sha256)).length, 1);
});

test("served-model mismatch is durable evidence, not a trusted advisory", async () => {
  const mismatchRoot = join(root, "mismatch");
  const result = await analyzeTiebreaker({
    input: { ...input, marker_id: "run-2:intervention:0" },
    route: { provider: "fireworks", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" },
    confirmRemote: true,
    root: mismatchRoot,
    fetchImpl: async () => new Response(JSON.stringify({
      model: "wrong/model",
      choices: [{ message: { content: "{}" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.status, "error");
  assert.match(result.error, /served-model mismatch/);
  assert.equal(result.recommended_action, null);
  assert.equal(result.remote_call_performed, true);
});

test("remote provider failures are persisted without provider-shaped secrets", async () => {
  const redactionRoot = join(root, "redaction");
  const providerShapedSecret = ["sk", "ant", "api03", "fixturesecret"].join("-");
  const result = await analyzeTiebreaker({
    input: { ...input, marker_id: "run-3:intervention:0" },
    route: { provider: "lilac", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" },
    confirmRemote: true,
    root: redactionRoot,
    fetchImpl: async () => new Response(
      JSON.stringify({ error: `provider rejected ${providerShapedSecret}` }),
      { status: 401 },
    ),
  });
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.error, /fixturesecret/);
  assert.match(result.error, /\[redacted\]/);
});

test("a stale crashed-process lock cannot permanently block review", async () => {
  const staleRoot = join(root, "stale-lock");
  const route = { provider: "lilac", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" };
  const fetchImpl = async () => new Response(JSON.stringify({
    model: "zai-org/glm-5.2",
    choices: [{ message: { content: JSON.stringify({
      recommended_action: "interrupt",
      confidence: 0.9,
      reason: "The exact output constraint was violated.",
      supervisor_reason_quality: "grounded",
    }) } }],
  }), { status: 200 });
  const first = await analyzeTiebreaker({ input, route, confirmRemote: true, root: staleRoot, fetchImpl });
  const lockDirectory = join(staleRoot, "locks");
  const lockPath = join(lockDirectory, `${first.evidence_sha256}.lock`);
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);
  const retried = await analyzeTiebreaker({
    input,
    route,
    confirmRemote: true,
    force: true,
    root: staleRoot,
    fetchImpl,
  });
  assert.equal(retried.status, "ok");
  assert.equal(retried.cache_hit, false);
});

test("frozen eval defaults to a no-call dry run with immutable suite identity", async () => {
  let called = false;
  const result = await runTiebreakerEval({
    suitePath: TIEBREAKER_EVAL_SUITE_PATH,
    split: "validation",
    maxExamples: 5,
    live: false,
    confirmRemote: false,
    confirmSpend: false,
    budgetUsd: 0,
    fetchImpl: async () => {
      called = true;
      throw new Error("dry run must not call a provider");
    },
  });
  assert.equal(called, false);
  assert.equal(result.rows.length, 0);
  assert.equal(result.manifest.live, false);
  assert.equal(result.manifest.examples.length, 5);
  assert.equal(result.manifest.suite_ref, "supervision-tiebreaker-eval-v2.jsonl");
  assert.equal("suite_path" in result.manifest, false);
  assert.match(result.manifest.suite_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.summary.recommendation, "plumbing_only_collect_more_evidence");
  assert.equal(result.summary.provider_calls_performed, false);
});

test("live judge evaluation is fail-closed on consent, spend, route, and promotion gates", async () => {
  await assert.rejects(
    runTiebreakerEval({
      split: "validation",
      maxExamples: 5,
      live: true,
      confirmRemote: false,
      confirmSpend: false,
      budgetUsd: 1,
    }),
    /requires remote consent/,
  );

  const suite = Array.from({ length: 10 }, (_, index) => JSON.stringify({
    schema: "understudy.supervision.tiebreaker_eval_case.v1",
    case_id: `promotion-${index}`,
    split: "validation",
    user_request: "Return exactly two words and no punctuation.",
    small_output_at_decision: "three incorrect words",
    tool_results_before_decision: [],
    recorded_supervisor_action: "interrupt",
    recorded_supervisor_reason: "The answer contains three words instead of two.",
    expected_recommended_action: "interrupt",
    expected_assessment: "agree",
    expected_reason_quality: "grounded",
    ground_truth: "The exact word-count constraint is violated.",
  })).join("\n") + "\n";
  const suitePath = join(root, "promotion-suite.jsonl");
  writeFileSync(suitePath, suite);
  let calls = 0;
  const result = await runTiebreakerEval({
    suitePath,
    split: "validation",
    maxExamples: 10,
    live: true,
    confirmRemote: true,
    confirmSpend: true,
    budgetUsd: CONSERVATIVE_CASE_FUSE_USD * 10,
    route: { provider: "lilac", project: "rehearsal", workload: "supervision-judge", orgId: "org_test" },
    cacheRoot: join(root, "promotion-cache"),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        model: "zai-org/glm-5.2",
        choices: [{ message: { content: JSON.stringify({
          recommended_action: "interrupt",
          confidence: 0.75,
          reason: "The exact two-word constraint is violated.",
          supervisor_reason_quality: "grounded",
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls, 10);
  assert.equal(result.summary.contract_valid_rate, 1);
  assert.equal(result.summary.route_valid_rate, 1);
  assert.equal(result.summary.action_accuracy, 1);
  assert.equal(result.summary.repeated_evidence_action_consistency, 1);
  assert.equal(result.summary.recommendation, "eligible_for_opt_in_pilot");
});
