import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", "dist/bin.js"];

function run(args) {
  return spawnSync(cli[0], [cli[1], ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function withFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-understand-"));
  try {
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "tests", "fixtures"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node --test tests/*.mjs" } }, null, 2),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    writeFileSync(join(repo, "src", "agent.ts"), "export const ok = true;\n");
    writeFileSync(join(repo, "tests", "agent.test.mjs"), "import 'node:assert/strict';\n");
    writeFileSync(join(repo, "tests", "fixtures", "golden.jsonl"), "{\"id\":\"synthetic-001\"}\n");
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function hashJson(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function withValidateFixtureRepo(overrides, fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-validate-"));
  try {
    const understandDir = join(repo, ".understudy", "understand-workload");
    const optimizeDir = join(repo, ".understudy", "validate-and-optimize");
    mkdirSync(understandDir, { recursive: true });
    mkdirSync(optimizeDir, { recursive: true });

    const harness = overrides.harness ?? { schema_version: "understudy.harness.v1", command: "npm test" };
    const environment = overrides.environment ?? { schema_version: "understudy.environment.v1", runtime: "node" };
    const metric = overrides.metric ?? {
      schema_version: "understudy.metric.v1",
      approved: true,
      primary_metric: "exact_match",
      validator: { kind: "command", command: "npm test" },
      feedback: { required: true, source: "validator_failure" },
    };
    const splits = overrides.splits ?? {
      schema_version: "understudy.splits.v1",
      train: ["train-1"],
      dev: ["dev-1"],
      holdout: ["holdout-1"],
    };
    const baseline = overrides.baseline ?? {
      schema_version: "understudy.baseline.v1",
      harness_sha256: hashJson(harness),
      metric_sha256: hashJson(metric),
      splits_sha256: hashJson(splits),
      score: 0.8,
    };

    for (const [name, value] of [
      ["harness.json", harness],
      ["environment.json", environment],
      ["metric.json", metric],
      ["splits.json", splits],
      ["baseline.json", baseline],
    ]) {
      if (!overrides.missing?.includes(name)) {
        writeFileSync(join(understandDir, name), `${JSON.stringify(value, null, 2)}\n`);
      }
    }
    if (overrides.proofPacket) {
      writeFileSync(join(optimizeDir, "proof-packet.json"), `${JSON.stringify(overrides.proofPacket, null, 2)}\n`);
    }
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withCaptureFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-capture-import-"));
  try {
    mkdirSync(join(repo, "data"), { recursive: true });
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    mkdirSync(join(repo, "prompts"), { recursive: true });
    mkdirSync(join(repo, "app", "api", "chat"), { recursive: true });
    mkdirSync(join(repo, "logs"), { recursive: true });
    writeFileSync(join(repo, "data", "examples.jsonl"), "{\"input\":\"secret prompt\"}\n");
    writeFileSync(join(repo, "data", "metrics.csv"), "customer,value\nacme,1\n");
    writeFileSync(join(repo, "fixtures", "golden.json"), "{\"completion\":\"private\"}\n");
    writeFileSync(join(repo, "prompts", "system.prompt"), "do not leak this\n");
    writeFileSync(join(repo, "app", "api", "chat", "route.ts"), "export const runtime = 'edge';\n");
    writeFileSync(join(repo, "logs", "openai-trace.json"), "{\"messages\":[\"private\"]}\n");
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withValueFixtureRepo({ measured = false } = {}, fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-value-report-"));
  try {
    const workloadDir = join(repo, ".understudy", "workload-discovery");
    const routeDir = join(repo, ".understudy", "route-decision");
    mkdirSync(workloadDir, { recursive: true });
    mkdirSync(routeDir, { recursive: true });

    const card = {
      schema_version: "understudy.workload_card.v1",
      workload_id: "synthetic-workload-001",
      mode: "local-only",
      baseline: {
        provider: "synthetic-provider",
        model: "synthetic-baseline",
        latency_ms: measured ? 900 : null,
        input_tokens: 1200,
        output_tokens: 200,
        cost_usd: measured ? 0.012 : null,
        rerun_artifact: measured ? ".understudy/understand-workload/baseline.json" : null,
        harness_sha256: measured ? "harness-sha" : null,
        metric_sha256: measured ? "metric-sha" : null,
        splits_sha256: measured ? "splits-sha" : null,
      },
      data_class: "source-metadata-only",
      evaluation_inputs: ["evals/synthetic.jsonl"],
    };
    const route = {
      schema_version: "understudy.route_decision_packet.v1",
      workload_card: ".understudy/workload-discovery/workload-card.json",
      decision: "evaluate-first",
      measured_evidence: measured
        ? {
            claim_packet: ".understudy/claims/synthetic-claim.json",
            candidate: {
              provider: "synthetic-candidate-provider",
              model: "synthetic-candidate",
              cost_usd_per_request: 0.006,
              latency_ms: 500,
              quality_delta: 0.01,
              validation_artifact: ".understudy/validate-and-optimize/candidate.json",
              validated_on_holdout: true,
              candidate_sha256: "candidate-sha",
              pricing_basis: "synthetic public fixture",
              sample_size: 25,
            },
          }
        : {},
      candidate_routes: [],
    };
    const cardPath = join(workloadDir, "workload-card.json");
    const routePath = join(routeDir, "route-decision-packet.json");
    writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);
    writeFileSync(routePath, `${JSON.stringify(route, null, 2)}\n`);
    return fn({ repo, cardPath, routePath });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withOptimizerFixtureRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-optimizer-runtime-"));
  try {
    const rubricPath = join(repo, "rubric.json");
    const samplesPath = join(repo, "samples.json");
    writeFileSync(
      rubricPath,
      JSON.stringify(
        {
          criteria: [
            { id: "correctness", description: "Answer must be correct.", weight: 2 },
            { id: "format", description: "Answer must be concise.", weight: 1 },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      samplesPath,
      JSON.stringify([{ question: "q1", answer: "a1" }, { question: "q2", answer: "a2" }], null, 2),
    );
    return fn({ repo, rubricPath, samplesPath });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("understudy-tools CLI", () => {
  it("prints the public spine", () => {
    const result = run(["spine"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy-agent-tools/);
    assert.match(result.stdout, /skills\/understudy\/SKILL\.md/);
  });

  it("lists public MVP skills", () => {
    const result = run(["skills", "--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /understudy/);
    assert.match(result.stdout, /understand-workload/);
    assert.match(result.stdout, /validate-and-optimize/);
  });

  it("inspects one skill", () => {
    const result = run(["skills", "--inspect", "understudy"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /path: skills\/understudy\/SKILL\.md/);
  });

  it("runs doctor against the Node package shape", () => {
    const result = run(["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runtime, "node");
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.missing, []);
  });

  it("writes local-only understand check metadata", () =>
    withFixtureRepo((repo) => {
      const result = run(["understand", "check", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.understand_check.v1");
      assert.equal(payload.mode, "local-only");
      assert.equal(payload.package_manager, "npm");
      assert.deepEqual(payload.signals.package_scripts, ["test"]);
      assert.match(payload.signals.likely_harnesses[0].path, /agent\.test\.mjs/);

      const artifact = JSON.parse(readFileSync(join(repo, ".understudy", "understand-workload", "check.json"), "utf8"));
      assert.equal(artifact.schema_version, "understudy.understand_check.v1");
      assert.equal(artifact.artifacts.workload_card, ".understudy/workload-discovery/workload-card.json");
    }));

  it("writes a metadata-only workload card", () =>
    withFixtureRepo((repo) => {
      const result = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.workload_card.v1");
      assert.equal(payload.mode, "local-only");
      assert.equal(payload.data_class, "source-metadata-only");
      assert.equal(payload.harness.command, "npm run test");
      assert.equal(payload.harness.environment.provider_keys_required, false);
      assert.equal(payload.harness.environment.network_required, false);
      assert.equal(payload.baseline.rerun_required, true);
      assert.equal(payload.discovery.check_artifact, ".understudy/understand-workload/check.json");

      const artifact = JSON.parse(
        readFileSync(join(repo, ".understudy", "workload-discovery", "workload-card.json"), "utf8"),
      );
      assert.equal(artifact.schema_version, "understudy.workload_card.v1");
      assert.equal(artifact.route_requirements.privacy_boundary, "local-only until explicit approval");
    }));

  it("plans a route decision packet from a valid workload card", () =>
    withFixtureRepo((repo) => {
      const cardResult = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(cardResult.status, 0, cardResult.stderr);
      const cardPath = join(repo, ".understudy", "workload-discovery", "workload-card.json");

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.route_decision_packet.v1");
      assert.equal(payload.workload_card, cardPath);
      assert.equal(payload.decision, "evaluate-first");
      assert.equal(payload.constraints.privacy_boundary, "local-only until explicit approval");
      assert.equal(payload.constraints.data_class, "source-metadata-only");
      assert.equal(payload.readiness.local_runner_fit, "likely");
      assert.deepEqual(payload.readiness.pricing_sources_checked, []);
      assert.equal(payload.candidate_routes[0].kind, "local");
      assert.equal(payload.candidate_routes[0].approval_required, false);
      assert.match(payload.recommended_next_command, /understudy-tools validate-and-optimize check/);
      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "route-decision", "route-decision-packet.json"), "utf8"));
      assert.equal(saved.schema_version, "understudy.route_decision_packet.v1");
    }));

  it("fails route decision planning when the workload card is missing", () => {
    const result = run(["route-decision", "plan", "--workload-card", "/tmp/understudy-missing-workload-card.json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unable to read workload card/);
  });

  it("fails route decision planning when the workload card is malformed", () =>
    withFixtureRepo((repo) => {
      const cardPath = join(repo, "bad-workload-card.json");
      writeFileSync(cardPath, "{\"schema_version\": \"wrong\"}\n");

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /expected schema_version understudy\.workload_card\.v1/);
    }));

  it("copies a conservative fallback route from the workload card without live lookups", () =>
    withFixtureRepo((repo) => {
      const cardResult = run(["understand", "workload-card", "--repo", repo]);
      assert.equal(cardResult.status, 0, cardResult.stderr);
      const cardPath = join(repo, ".understudy", "workload-discovery", "workload-card.json");
      const card = JSON.parse(readFileSync(cardPath, "utf8"));
      card.fallback_route = {
        kind: "existing-key",
        provider: "synthetic-provider",
        model: "synthetic-model",
      };
      writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);

      const result = run(["route-decision", "plan", "--workload-card", cardPath, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.candidate_routes.length, 1);
      assert.equal(payload.candidate_routes[0].kind, "existing-key");
      assert.equal(payload.candidate_routes[0].provider, "synthetic-provider");
      assert.equal(payload.candidate_routes[0].model, "synthetic-model");
      assert.equal(payload.candidate_routes[0].approval_required, true);
      assert.equal(payload.candidate_routes[0].pricing_source, null);
      assert.equal(payload.candidate_routes[0].supplier_profile, null);
      assert.deepEqual(payload.readiness.supplier_profiles_checked, []);
    }));

  it("prints the uv optimizer guide", () => {
    const result = run(["validate-and-optimize", "--uv"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /uv venv \.understudy\/venvs\/optimize/);
    assert.match(result.stdout, /gepa/);
    assert.match(result.stdout, /dspy/);
    assert.match(result.stdout, /skills\/validate-and-optimize\/SKILL\.md/);
  });

  it("passes validate-and-optimize check for fresh approved artifacts", () =>
    withValidateFixtureRepo({}, (repo) => {
      const result = run(["validate-and-optimize", "check", "--repo", repo]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /validate-and-optimize passed/);
      assert.match(result.stdout, /PASS fresh-baseline/);
    }));

  it("blocks stale baseline hashes", () =>
    withValidateFixtureRepo(
      {
        baseline: {
          schema_version: "understudy.baseline.v1",
          harness_sha256: "stale",
          metric_sha256: "stale",
          splits_sha256: "stale",
        },
      },
      (repo) => {
        const result = run(["validate-and-optimize", "check", "--repo", repo]);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /FAIL fresh-baseline/);
        assert.match(result.stdout, /route back to understand-workload/);
      },
    ));

  it("blocks missing artifacts with the missing path", () =>
    withValidateFixtureRepo({ missing: ["baseline.json"] }, (repo) => {
      const result = run(["validate-and-optimize", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Missing \.understudy\/understand-workload\/baseline\.json/);
    }));

  it("blocks unapproved metrics", () => {
    const metric = {
      schema_version: "understudy.metric.v1",
      approved: false,
      primary_metric: "exact_match",
      validator: { kind: "command", command: "npm test" },
      feedback: { required: true, source: "validator_failure" },
    };
    return withValidateFixtureRepo({ metric }, (repo) => {
      const result = run(["validate-and-optimize", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL approved-metric/);
    });
  });

  it("blocks proxy-only metrics", () => {
    const metric = {
      schema_version: "understudy.metric.v1",
      approved: true,
      primary_metric: "proxy",
      validator: { kind: "proxy" },
      feedback: { required: true, source: "validator_failure" },
    };
    return withValidateFixtureRepo({ metric }, (repo) => {
      const result = run(["validate-and-optimize", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL proxy-only/);
    });
  });

  it("blocks contaminated proof packets", () =>
    withValidateFixtureRepo({ proofPacket: { status: "contaminated", contaminated: true } }, (repo) => {
      const result = run(["validate-and-optimize", "check", "--repo", repo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /FAIL proof-packet/);
      assert.match(result.stdout, /new split contract/);
    }));

  it("writes a dry-run proof packet without live optimizer execution", () =>
    withValidateFixtureRepo({}, (repo) => {
      const result = run(["validate-and-optimize", "dry-run", "--repo", repo, "--backend", "uv-gepa", "--budget-usd", "10"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /proof-packet: \.understudy\/validate-and-optimize\/proof-packet\.json/);
      const packet = JSON.parse(
        readFileSync(join(repo, ".understudy", "validate-and-optimize", "proof-packet.json"), "utf8"),
      );
      assert.equal(packet.mode, "dry-run");
      assert.equal(packet.backend, "uv-gepa");
      assert.equal(packet.budget_usd, 10);
      assert.equal(packet.provider_calls, false);
      assert.equal(packet.package_installs, false);
      assert.equal(packet.live_optimizer_execution, false);
      assert.equal(packet.status, "ready");
    }));

  it("refuses validate-and-optimize run when deterministic gates are missing", () =>
    withFixtureRepo((repo) => {
      const result = run(["validate-and-optimize", "run", "--repo", repo, "--backend", "uv-gepa", "--budget-usd", "10"]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL required-artifacts: Missing \.understudy\/understand-workload\/harness\.json/);
      assert.match(result.stdout, /run: blocked/);
      assert.match(result.stdout, /Pass --execute only after explicit approval/);
    }));

  it("scaffolds uv-gepa run metadata but refuses live optimizer execution", () =>
    withValidateFixtureRepo({}, (repo) => {
      const result = run(["validate-and-optimize", "run", "--repo", repo, "--backend", "uv-gepa", "--budget-usd", "10"]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /validate-and-optimize passed/);
      assert.match(result.stdout, /run: blocked/);
      assert.match(result.stdout, /Pass --execute only after explicit approval/);

      const packet = JSON.parse(
        readFileSync(join(repo, ".understudy", "validate-and-optimize", "proof-packet.json"), "utf8"),
      );
      assert.equal(packet.mode, "run");
      assert.equal(packet.status, "blocked");
      assert.equal(packet.backend, "uv-gepa");
      assert.equal(packet.budget_usd, 10);
      assert.equal(packet.provider_calls, false);
      assert.equal(packet.package_installs, false);
      assert.equal(packet.live_optimizer_execution, false);
      assert.equal(packet.uv_env_created, false);
      assert.equal(packet.claim_json_created, false);
    }));

  it("scores a rubric through the local uv runtime without provider calls", () =>
    withOptimizerFixtureRepo(({ repo, rubricPath }) => {
      const result = run([
        "validate-and-optimize",
        "rubric",
        "score",
        "--repo",
        repo,
        "--rubric",
        rubricPath,
        "--output-text",
        "synthetic answer",
        "--judge-verdict",
        "SCORE: 0.5\nNeeds more detail.",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.rubric_score.v1");
      assert.equal(payload.score, 0.5);
      assert.equal(payload.provider_calls, false);
      assert.match(payload.feedback, /Rubric gaps/);
    }));

  it("scaffolds a DSPy signature through the local uv runtime without installing packages", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "validate-and-optimize",
        "dspy",
        "scaffold",
        "--repo",
        repo,
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.dspy_scaffold.v1");
      assert.equal(payload.signature, "question -> answer");
      assert.equal(payload.sample_count, 2);
      assert.equal(payload.parity_required_before_gepa, true);
    }));

  it("passes DSPy ChainOfThought parity through the local uv runtime", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "validate-and-optimize",
        "dspy",
        "parity",
        "--repo",
        repo,
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--baseline-score",
        "1.0",
        "--module",
        "cot",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.dspy_parity.v1");
      assert.equal(payload.parity, true);
      assert.equal(payload.provider_calls, false);
    }));

  it("fails DSPy parity when the scaffold diverges from baseline", () =>
    withOptimizerFixtureRepo(({ repo, samplesPath }) => {
      const result = run([
        "validate-and-optimize",
        "dspy",
        "parity",
        "--repo",
        repo,
        "--samples",
        samplesPath,
        "--input-keys",
        "question",
        "--output-keys",
        "answer",
        "--baseline-score",
        "1.0",
        "--dummy-answers",
        '[{"answer":"wrong"},{"answer":"wrong"}]',
        "--tolerance",
        "0",
      ]);
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.schema_version, "understudy.dspy_parity.v1");
      assert.equal(payload.parity, false);
      assert.equal(payload.program_score, 0);
    }));

  it("writes a measured-evidence value report without making provider calls", () =>
    withValueFixtureRepo({ measured: true }, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "10000",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /claim_status: claim-supported/);
      assert.match(result.stdout, /No provider calls/);

      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.schema_version, "understudy.value_report.v1");
      assert.equal(report.evidence_level, 2);
      assert.equal(report.claim_status, "claim-supported");
      assert.equal(report.baseline.monthly_cost_usd, 120);
      assert.equal(report.candidate.monthly_cost_usd, 60);
      assert.equal(report.scenario.monthly_savings_usd, 60);
      assert.equal(report.scenario.latency_delta_ms, 400);
      assert.equal(report.claim_packet, ".understudy/claims/synthetic-claim.json");
    }));

  it("writes an override-only value scenario without claim support", () =>
    withValueFixtureRepo({}, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "1000",
        "--baseline-cost-usd",
        "0.02",
        "--candidate-cost-usd",
        "0.01",
        "--baseline-latency-ms",
        "800",
        "--candidate-latency-ms",
        "600",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /claim_status: claim-packet-required/);

      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.scenario_basis, "override");
      assert.equal(report.scenario.monthly_savings_usd, 10);
      assert.equal(report.scenario.latency_delta_ms, 200);
      assert.equal(report.claim_status, "claim-packet-required");
      assert.match(report.caveats.join("\n"), /not measured evidence/);
      assert.match(report.caveats.join("\n"), /scenario math only/);
    }));

  it("fails value report when required input artifacts are missing", () =>
    withValueFixtureRepo({}, ({ cardPath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        "/tmp/understudy-missing-route-decision.json",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing Route Decision Packet/);
      assert.match(result.stderr, /route-decision plan/);
    }));

  it("keeps value report non-claimable when candidate evidence is absent", () =>
    withValueFixtureRepo({}, ({ repo, cardPath, routePath }) => {
      const result = run([
        "value",
        "report",
        "--workload-card",
        cardPath,
        "--route-decision",
        routePath,
        "--requests-per-month",
        "10000",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(join(repo, ".understudy", "value", "value-report.json"), "utf8"));
      assert.equal(report.evidence_level, 1);
      assert.equal(report.claim_status, "claim-packet-required");
      assert.equal(report.scenario.monthly_savings_usd, null);
      assert.equal(report.candidate.quality_delta, null);
      assert.match(report.caveats.join("\n"), /Do not publish savings/);
    }));

  it("marks full runtime commands as deferred", () => {
    const result = run(["gateway", "--port", "23333"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deferred to the full Understudy runtime/);
  });

  it("scans capture/import sources with metadata only and writes a redaction manifest", () =>
    withCaptureFixtureRepo((repo) => {
      const result = run(["capture-import", "scan", "--repo", repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(result.stdout);
      assert.equal(manifest.source_count, 6);
      assert.deepEqual(
        manifest.sources.map((source) => source.kind).sort(),
        ["app-route", "csv-data", "golden-fixture", "jsonl-data", "prompt-file", "provider-trace"],
      );
      assert.equal(manifest.sources[0].id, "source-001");
      assert.ok(!result.stdout.includes("secret prompt"));
      assert.ok(!result.stdout.includes("private"));

      const redaction = JSON.parse(
        readFileSync(join(repo, ".understudy", "capture-import", "redaction-manifest.json"), "utf8"),
      );
      assert.equal(redaction.policy, "metadata-only");
      assert.ok(redaction.payload_fields_omitted.includes("messages"));
    }));

  it("prints a bounded capture/import preview without payload contents", () =>
    withCaptureFixtureRepo((repo) => {
      assert.equal(run(["capture-import", "scan", "--repo", repo]).status, 0);
      const result = run(["capture-import", "preview", "--repo", repo, "--source-id", "source-001", "--limit", "2", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const preview = JSON.parse(result.stdout);
      assert.equal(preview.limit, 2);
      assert.equal(preview.source_id, "source-001");
      assert.equal(preview.payload_read, false);
      assert.ok(!result.stdout.includes("secret prompt"));
      assert.ok(!result.stdout.includes("private"));
      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "capture-import", "preview-source-001.json"), "utf8"));
      assert.equal(saved.data_class, "metadata-only");
    }));

  it("builds a capture/import workload card from the scan manifest", () =>
    withCaptureFixtureRepo((repo) => {
      assert.equal(run(["capture-import", "scan", "--repo", repo]).status, 0);
      const result = run(["capture-import", "workload-card", "--repo", repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const card = JSON.parse(result.stdout);
      assert.equal(card.source_count, 6);
      assert.equal(card.source_kinds["jsonl-data"], 1);
      assert.equal(card.source_kinds["csv-data"], 1);
      assert.ok(card.evidence_paths.includes(".understudy/capture-import/redaction-manifest.json"));

      const saved = JSON.parse(readFileSync(join(repo, ".understudy", "capture-import", "workload-card.json"), "utf8"));
      assert.equal(saved.source_count, 6);
    }));
});
