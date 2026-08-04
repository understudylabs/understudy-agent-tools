import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASELINE_FANOUT_SCHEMA,
  GEPA_CONTROLLER_SCHEMA,
  executeBaselineFanout,
  planBaselineFanout,
  runGepaHillclimb,
  sha256,
} from "../dist/outcome-executors/index.js";

const hash = (letter) => letter.repeat(64);
const fuse = {
  max_concurrency: 2,
  max_metric_calls: 12,
  max_spend_usd: 12,
  max_cost_per_call_usd: 1,
  max_wallclock_ms: 10_000,
  max_episodes: 12,
  max_reflections: 12,
};
const binding = {
  source_binding_sha256: hash("a"),
  verifier_calibration_sha256: hash("b"),
  benchmark_sha256: hash("c"),
  split_manifest_sha256: hash("d"),
  train_sha256: hash("e"),
  dev_sha256: hash("f"),
  holdout_sha256: null,
};
const rows = [
  { id: "d1", split: "dev", family: "direct", frozen: false },
  { id: "d2", split: "dev", family: "unmatched", frozen: false },
];
const incumbent = { candidate_id: "incumbent", candidate_sha256: hash("1") };
const candidate = { candidate_id: "student", candidate_sha256: hash("2") };

function baseline(overrides = {}) {
  return {
    schema_version: BASELINE_FANOUT_SCHEMA,
    run_id: "baseline-1",
    workload_id: "synthetic-workload",
    ...binding,
    rows,
    candidates: [candidate],
    incumbent,
    protected_families: [
      { family: "direct", target_score: 0.8, max_regression: 0 },
      { family: "unmatched", target_score: 1, max_regression: 0 },
    ],
    target_score: 0.9,
    fuse,
    ...overrides,
  };
}

describe("baseline fanout", () => {
  it("rejects malformed hashes, unknown fields, train/holdout rows, frozen rows, and duplicates", () => {
    assert.throws(() => planBaselineFanout({ ...baseline(), source_binding_sha256: "bad" }));
    assert.throws(() => planBaselineFanout({ ...baseline(), unknown: true }));
    assert.throws(() => planBaselineFanout({ ...baseline(), rows: [{ ...rows[0], split: "train" }] }));
    assert.throws(() => planBaselineFanout({ ...baseline(), rows: [{ ...rows[0], split: "holdout" }] }));
    assert.throws(() => planBaselineFanout({ ...baseline(), rows: [{ ...rows[0], frozen: true }] }));
    assert.throws(() => planBaselineFanout({ ...baseline(), rows: [rows[0], rows[0]] }));
  });

  it("keeps incumbent separate and measures returned metrics with bounded concurrency", async () => {
    const plan = planBaselineFanout(baseline());
    assert.deepEqual(plan.candidates, [candidate]);
    let active = 0;
    let peak = 0;
    const events = [];
    const result = await executeBaselineFanout(plan, async (model, row) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const metric = model.candidate_id === "student" ? (row.family === "direct" ? 0.9 : 1) : (row.family === "direct" ? 0.8 : 1);
      return { status: "ok", metric, cost_usd: 0.1, latency_ms: 2 };
    }, { checkpoint: () => "artifact://baseline/checkpoint", event: (event) => events.push(event) });
    assert.equal(peak, 2);
    assert.equal(result.state, "target_reached");
    assert.equal(result.results.find((item) => item.candidate_id === "student").quality, 0.95);
    assert.ok(events.every((event) => event.schema_version === "understudy.gepa_viz_manifest.v1"));
    assert.ok(events.every((event) => !JSON.stringify(event).includes("prompt")));
    assert.equal(events.at(-1).state, "completed");
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://baseline/checkpoint"]);
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), { event: () => {} }));
  });

  it("never calls beyond call/episode/spend reservations", async () => {
    const plan = planBaselineFanout(baseline({
      rows: [...rows, { id: "d3", split: "dev", family: "direct", frozen: false }],
      fuse: { ...fuse, max_metric_calls: 2, max_episodes: 2, max_spend_usd: 2, max_cost_per_call_usd: 1 },
    }));
    let invoked = 0;
    const result = await executeBaselineFanout(plan, async () => {
      invoked += 1;
      return { status: "ok", metric: 1, cost_usd: 1, latency_ms: 1 };
    });
    assert.equal(invoked, 2);
    assert.equal(result.usage.metric_calls, 2);
    assert.equal(result.usage.spend_usd, 2);
    assert.equal(result.state, "stopped");
  });

  it("fails a cost-overrun receipt and refuses partial target credit", async () => {
    const plan = planBaselineFanout(baseline());
    const result = await executeBaselineFanout(plan, async (model, row) => {
      if (model.candidate_id === "student" && row.id === "d2") return { status: "ok", metric: 1, cost_usd: 2, latency_ms: 1 };
      return { status: "ok", metric: 1, cost_usd: 0.1, latency_ms: 1 };
    });
    const student = result.results.find((item) => item.candidate_id === "student");
    assert.equal(result.state, "failed");
    assert.equal(student.status, "partial");
    assert.equal(student.quality, null);
    assert.equal(result.target_candidate_id, null);
    assert.deepEqual(result.failure_clusters, [{ cluster: "cost_reservation_exceeded", count: 1 }]);
    assert.equal(result.usage.spend_usd, 2.3);
  });

  it("retains known cost from a structurally invalid adapter receipt", async () => {
    const plan = planBaselineFanout(baseline({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1 } }));
    const result = await executeBaselineFanout(plan, async () => ({ status: "ok", metric: 2, cost_usd: 0.7, latency_ms: 3 }));
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "invalid_adapter_receipt");
    assert.equal(result.usage.spend_usd, 0.7);
    assert.equal(result.usage.spend_complete, true);
  });

  it("persists the exact fatal baseline snapshot before publishing its failed manifest", async () => {
    const plan = planBaselineFanout(baseline({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1 } }));
    const snapshots = [];
    const events = [];
    const result = await executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 2, latency_ms: 1 }), {
      checkpoint: (snapshot) => {
        snapshots.push(structuredClone(snapshot));
        return `artifact://baseline/${snapshot.terminal_reason}`;
      },
      event: (event) => events.push(event),
    });
    assert.equal(result.stop_reason, "cost_reservation_exceeded");
    assert.equal(snapshots.at(-1).terminal_reason, "cost_reservation_exceeded");
    assert.equal(snapshots.at(-1).calls[0].result.cost_usd, 2);
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://baseline/cost_reservation_exceeded"]);
  });

  it("blocks target when a protected family regresses", async () => {
    const plan = planBaselineFanout(baseline());
    const result = await executeBaselineFanout(plan, async (model, row) => ({
      status: "ok",
      metric: model.candidate_id === "student" && row.family === "direct" ? 0.7 : 1,
      cost_usd: 0,
      latency_ms: 1,
    }));
    assert.equal(result.target_candidate_id, null);
  });

  it("resumes idempotently and rejects a checkpoint from another plan", async () => {
    const plan = planBaselineFanout(baseline());
    const key = (await import("../dist/outcome-executors/index.js")).idempotencyKey(plan.plan_sha256, incumbent.candidate_sha256, "d1");
    const checkpoint = { plan_sha256: plan.plan_sha256, spend_complete: true, terminal_reason: null, calls: [{
      idempotency_key: key,
      candidate_id: incumbent.candidate_id,
      row_id: "d1",
      family: "direct",
      result: { status: "ok", metric: 0.8, cost_usd: 0, latency_ms: 1 },
    }] };
    let invoked = 0;
    const result = await executeBaselineFanout(plan, async () => {
      invoked += 1;
      return { status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 };
    }, {}, checkpoint, () => true);
    assert.equal(invoked, 3);
    assert.equal(result.usage.metric_calls, 4);
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {}, { ...checkpoint, plan_sha256: hash("9") }));
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {}, {
      ...checkpoint,
      calls: [{ ...checkpoint.calls[0], candidate_id: "forged" }],
    }, () => true));
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {}, checkpoint));
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {}, {
      ...checkpoint,
      terminal_reason: "wallclock_exhausted",
    }, () => true), /terminal or spend-incomplete/);
    await assert.rejects(() => executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {}, {
      ...checkpoint,
      spend_complete: false,
    }, () => true), /terminal or spend-incomplete/);
  });

  it("serializes concurrent checkpoint writes and exposes only the latest persisted reference", async () => {
    const plan = planBaselineFanout(baseline());
    const persistedSizes = [];
    const events = [];
    const result = await executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {
      checkpoint: async (snapshot) => {
        if (snapshot.calls.length === 1) await new Promise((resolve) => setTimeout(resolve, 8));
        persistedSizes.push(snapshot.calls.length);
        return `artifact://baseline/checkpoint-${snapshot.calls.length}`;
      },
      event: (event) => events.push(event),
    });
    assert.deepEqual(persistedSizes, [1, 2, 3, 4]);
    assert.equal(result.state, "target_reached");
    for (const event of events.slice(0, -1)) {
      assert.deepEqual(event.artifact_refs, [`artifact://baseline/checkpoint-${event.progress.rollouts_completed}`]);
    }
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://baseline/checkpoint-4"]);
  });

  it("bounds a live event sink that ignores its deadline", async () => {
    const plan = planBaselineFanout(baseline({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_wallclock_ms: 5 } }));
    const result = await executeBaselineFanout(plan, async () => ({ status: "ok", metric: 1, cost_usd: 0, latency_ms: 1 }), {
      checkpoint: () => "artifact://baseline/checkpoint",
      event: () => new Promise(() => {}),
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "wallclock_exhausted");
    assert.equal(result.target_candidate_id, null);
  });

  it("returns at the hard wall-clock fuse even when the adapter ignores its signal", async () => {
    const plan = planBaselineFanout(baseline({ fuse: { ...fuse, max_wallclock_ms: 5 } }));
    const snapshots = [];
    const events = [];
    const result = await executeBaselineFanout(plan, async () => new Promise(() => {}), {
      checkpoint: (snapshot) => {
        snapshots.push(structuredClone(snapshot));
        return "artifact://baseline/wallclock-terminal";
      },
      event: (event) => events.push(event),
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "wallclock_exhausted");
    assert.equal(result.usage.spend_complete, false);
    assert.ok(result.failure_clusters.some((cluster) => cluster.cluster === "wallclock_exhausted"));
    assert.equal(snapshots.at(-1).terminal_reason, "wallclock_exhausted");
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://baseline/wallclock-terminal"]);
  });
});

function gepaRows(direct, unmatched, context, overrides = {}) {
  return [
    { controller_sha256: context.controller_sha256, candidate_sha256: context.candidate.candidate_sha256, wave: context.wave, dev_sha256: context.dev_sha256, verifier_calibration_sha256: context.verifier_calibration_sha256, row_id: "d1", family: "direct", status: "ok", metric: direct },
    { controller_sha256: context.controller_sha256, candidate_sha256: context.candidate.candidate_sha256, wave: context.wave, dev_sha256: context.dev_sha256, verifier_calibration_sha256: context.verifier_calibration_sha256, row_id: "d2", family: "unmatched", status: "ok", metric: unmatched },
  ].map((row) => ({ ...row, receipt_sha256: sha256(row), ...overrides }));
}

const verifyEvaluationReceipt = () => true;

function gepaInput(overrides = {}) {
  return {
    schema_version: GEPA_CONTROLLER_SCHEMA,
    run_id: "gepa-1",
    workload_id: "synthetic-workload",
    ...binding,
    train_rows: [{ id: "t1", split: "train", family: "direct", frozen: false }],
    dev_rows: rows,
    seed: incumbent,
    seed_dev_quality: 0.8,
    seed_family_scores: { direct: 0.8, unmatched: 1 },
    protected_families: [
      { family: "direct", target_score: 0.8, max_regression: 0 },
      { family: "unmatched", target_score: 1, max_regression: 0 },
    ],
    target_score: 0.9,
    fuse: { ...fuse, max_concurrency: 2, max_metric_calls: 4, max_episodes: 4, max_reflections: 4, max_spend_usd: 4 },
    ...overrides,
  };
}

describe("GEPA controller", () => {
  it("fans out branches, adopts the best safe candidate, and stops on target", async () => {
    let active = 0;
    let peak = 0;
    const events = [];
    const result = await runGepaHillclimb({
      input: gepaInput(),
      verifyEvaluationReceipt,
      propose: async ({ wave, branch }) => ({ status: "ok", candidate: { candidate_id: `w${wave}-b${branch}`, candidate_sha256: hash(branch === 0 ? "3" : "4") }, cost_usd: 0.25, latency_ms: 1 }),
      evaluate: async (context) => {
        const { branch } = context;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { status: "ok", rows: gepaRows(branch === 1 ? 0.9 : 0.7, 1, context), cost_usd: 0.75, latency_ms: 2 };
      },
      hooks: { checkpoint: () => "artifact://gepa/checkpoint", event: (event) => events.push(event) },
    });
    assert.equal(peak, 2);
    assert.equal(result.state, "target_reached");
    assert.equal(result.best_dev_quality, 0.95);
    assert.equal(result.episodes, 2);
    assert.ok(events.every((event) => event.schema_version === "understudy.gepa_viz_manifest.v1"));
    assert.equal(events.at(-1).state, "completed");
  });

  it("quarantines protected-family regressions and clusters failures", async () => {
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 2, max_metric_calls: 2, max_episodes: 2, max_reflections: 2, max_spend_usd: 4 } }),
      verifyEvaluationReceipt,
      propose: async ({ branch }) => ({ status: "ok", candidate: { candidate_id: `bad-${branch}`, candidate_sha256: hash(branch === 0 ? "5" : "6") }, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => context.branch === 0
        ? { status: "ok", rows: gepaRows(1, 0.5, context), cost_usd: 1, latency_ms: 1 }
        : { status: "failed", rows: [], cost_usd: 0, latency_ms: 1, failure_cluster: "malformed" },
    });
    assert.equal(result.best_dev_quality, 0.8);
    assert.equal(result.state, "stopped");
    assert.deepEqual(result.failure_clusters, [{ cluster: "malformed", count: 1 }]);
  });

  it("rejects holdout-shaped input and mismatched resumes", async () => {
    await assert.rejects(() => runGepaHillclimb({ input: { ...gepaInput(), holdout_rows: [] }, verifyEvaluationReceipt, propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }), evaluate: async (context) => ({ status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0, latency_ms: 1 }) }));
    const limitedInput = gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 1 } });
    const first = await runGepaHillclimb({
      input: limitedInput,
      verifyEvaluationReceipt,
      propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(0.81, 1, context), cost_usd: 0, latency_ms: 1 }),
    });
    await assert.rejects(() => runGepaHillclimb({ input: gepaInput(), resume: { ...first.checkpoint, controller_sha256: hash("9") }, verifyResume: () => true, verifyEvaluationReceipt, propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }), evaluate: async () => ({ status: "failed", rows: [], cost_usd: 0, latency_ms: 1 }) }));
    await assert.rejects(() => runGepaHillclimb({ input: limitedInput, resume: first.checkpoint, verifyEvaluationReceipt, propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }), evaluate: async () => ({ status: "failed", rows: [], cost_usd: 0, latency_ms: 1 }) }));
    await assert.rejects(() => runGepaHillclimb({ input: limitedInput, resume: { ...first.checkpoint, terminal_reason: "wallclock_exhausted" }, verifyResume: () => true, verifyEvaluationReceipt, propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }), evaluate: async () => ({ status: "failed", rows: [], cost_usd: 0, latency_ms: 1 }) }), /terminal or spend-incomplete/);
    await assert.rejects(() => runGepaHillclimb({ input: limitedInput, resume: { ...first.checkpoint, spend_complete: false }, verifyResume: () => true, verifyEvaluationReceipt, propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }), evaluate: async () => ({ status: "failed", rows: [], cost_usd: 0, latency_ms: 1 }) }), /terminal or spend-incomplete/);
  });

  it("does not invoke evaluation after a sibling branch trips a fatal fuse", async () => {
    let evaluations = 0;
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 2, max_metric_calls: 2, max_episodes: 2, max_reflections: 2, max_spend_usd: 4 } }),
      verifyEvaluationReceipt,
      propose: async ({ branch }) => {
        if (branch === 1) await new Promise((resolve) => setTimeout(resolve, 5));
        return branch === 0
          ? { status: "ok", candidate: { candidate_id: "overrun", candidate_sha256: hash("7") }, cost_usd: 2, latency_ms: 1 }
          : { status: "ok", candidate: { candidate_id: "must-not-evaluate", candidate_sha256: hash("8") }, cost_usd: 0, latency_ms: 1 };
      },
      evaluate: async (context) => {
        evaluations += 1;
        return { status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0, latency_ms: 1 };
      },
    });
    assert.equal(evaluations, 0);
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "proposal_cost_reservation_exceeded");
  });

  it("persists the exact fatal GEPA snapshot and preserves its original reason", async () => {
    const snapshots = [];
    const events = [];
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 3 } }),
      verifyEvaluationReceipt,
      propose: async () => ({ status: "ok", candidate, cost_usd: 2, latency_ms: 1 }),
      evaluate: async () => { throw new Error("must not evaluate"); },
      hooks: {
        checkpoint: (snapshot) => {
          snapshots.push(structuredClone(snapshot));
          return `artifact://gepa/${snapshot.terminal_reason}`;
        },
        event: (event) => events.push(event),
      },
    });
    assert.equal(result.stop_reason, "proposal_cost_reservation_exceeded");
    assert.equal(snapshots.at(-1).terminal_reason, "proposal_cost_reservation_exceeded");
    assert.equal(snapshots.at(-1).spend_usd, 2);
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://gepa/proposal_cost_reservation_exceeded"]);
  });

  it("accounts for proposal spend and reserves proposal plus evaluation cost", async () => {
    const result = await runGepaHillclimb({
      input: gepaInput({ target_score: 0.95, fuse: { ...fuse, max_concurrency: 4, max_metric_calls: 4, max_episodes: 4, max_reflections: 4, max_spend_usd: 2, max_cost_per_call_usd: 1 } }),
      verifyEvaluationReceipt,
      propose: async ({ branch }) => ({ status: "ok", candidate: { candidate_id: `cost-${branch}`, candidate_sha256: hash(branch === 0 ? "7" : "8") }, cost_usd: 0.4, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(0.81, 1, context), cost_usd: 0.6, latency_ms: 1 }),
    });
    assert.equal(result.episodes, 1);
    assert.equal(result.spend_usd, 1);
    assert.equal(result.stop_reason, "spend_limit");
  });

  it("retains known proposal cost when the candidate receipt is malformed", async () => {
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2 } }),
      verifyEvaluationReceipt,
      propose: async () => ({ status: "ok", candidate: { candidate_id: "bad", candidate_sha256: "bad" }, cost_usd: 0.4, latency_ms: 2 }),
      evaluate: async () => { throw new Error("must not evaluate"); },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "invalid_proposal_receipt");
    assert.equal(result.spend_usd, 0.4);
    assert.equal(result.spend_complete, true);
  });

  it("requires durable checkpoint persistence for live manifests", async () => {
    await assert.rejects(() => runGepaHillclimb({
      input: gepaInput(),
      verifyEvaluationReceipt,
      propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0, latency_ms: 1 }),
      hooks: { event: () => {} },
    }));
  });

  it("bounds a GEPA live event sink and preserves a failed terminal receipt", async () => {
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2, max_wallclock_ms: 5 } }),
      verifyEvaluationReceipt,
      propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0, latency_ms: 1 }),
      hooks: {
        checkpoint: () => "artifact://gepa/checkpoint",
        event: () => new Promise(() => {}),
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "wallclock_exhausted");
  });

  it("hard-stops a hung proposal and marks spend evidence incomplete", async () => {
    const snapshots = [];
    const events = [];
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2, max_wallclock_ms: 5 } }),
      verifyEvaluationReceipt,
      propose: async () => new Promise(() => {}),
      evaluate: async () => ({ status: "failed", rows: [], cost_usd: 0, latency_ms: 1 }),
      hooks: {
        checkpoint: (snapshot) => {
          snapshots.push(structuredClone(snapshot));
          return "artifact://gepa/wallclock-terminal";
        },
        event: (event) => events.push(event),
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "wallclock_exhausted");
    assert.equal(result.spend_complete, false);
    assert.equal(snapshots.at(-1).terminal_reason, "wallclock_exhausted");
    assert.deepEqual(events.at(-1).artifact_refs, ["artifact://gepa/wallclock-terminal"]);
  });

  it("hard-stops a hung receipt authority verifier", async () => {
    const result = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2, max_wallclock_ms: 100 } }),
      verifyEvaluationReceipt: () => new Promise(() => {}),
      propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0.3, latency_ms: 1 }),
    });
    assert.equal(result.state, "failed");
    assert.equal(result.stop_reason, "wallclock_exhausted");
    assert.equal(result.spend_usd, 0.3);
    assert.equal(result.spend_complete, true);
  });

  it("refuses incomplete, foreign, or tampered canonical-dev row receipts", async () => {
    for (const mutate of [
      (receipts) => receipts.slice(0, 1),
      (receipts) => [{ ...receipts[0], row_id: "foreign" }, receipts[1]],
      (receipts) => [{ ...receipts[0], metric: 0 }, receipts[1]],
      (receipts) => {
        const replayed = { ...receipts[0], candidate_sha256: hash("9") };
        return [{ ...replayed, receipt_sha256: sha256(replayed) }, receipts[1]];
      },
    ]) {
      const result = await runGepaHillclimb({
        input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2 } }),
        verifyEvaluationReceipt,
        propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
        evaluate: async (context) => ({ status: "ok", rows: mutate(gepaRows(1, 1, context)), cost_usd: 0, latency_ms: 1 }),
      });
      assert.notEqual(result.state, "target_reached");
    }
    const unauthorized = await runGepaHillclimb({
      input: gepaInput({ fuse: { ...fuse, max_concurrency: 1, max_metric_calls: 1, max_episodes: 1, max_reflections: 1, max_spend_usd: 2 } }),
      verifyEvaluationReceipt: () => false,
      propose: async () => ({ status: "ok", candidate, cost_usd: 0, latency_ms: 1 }),
      evaluate: async (context) => ({ status: "ok", rows: gepaRows(1, 1, context), cost_usd: 0, latency_ms: 1 }),
    });
    assert.equal(unauthorized.state, "failed");
  });
});
