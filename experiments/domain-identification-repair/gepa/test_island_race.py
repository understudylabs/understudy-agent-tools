#!/usr/bin/env python3
"""Provider-free unit tests for eight-island selection and failure evidence."""
import json
import sys
import tempfile
import threading
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
# The selection/failure tests are provider-free; stub optional runtime packages
# so importing the runner cannot install or contact anything.
if "dspy" not in sys.modules:
    dspy = types.ModuleType("dspy")
    dspy.Signature = type("Signature", (), {})
    dspy.InputField = lambda *a, **k: None
    dspy.OutputField = lambda *a, **k: None
    dspy.__version__ = "test-stub"
    sys.modules["dspy"] = dspy
if "gepa" not in sys.modules:
    gepa = types.ModuleType("gepa")
    core = types.ModuleType("gepa.core")
    adapter = types.ModuleType("gepa.core.adapter")
    adapter.EvaluationBatch = type("EvaluationBatch", (), {})
    core.adapter = adapter
    gepa.core = core
    sys.modules.update({"gepa": gepa, "gepa.core": core, "gepa.core.adapter": adapter})
import island_race  # noqa: E402
import experiment_manifest as em  # noqa: E402
from island_race import (  # noqa: E402
    ISLAND_SPECS, LiveManifest, build_invalid_execution_receipt,
    build_no_distinct_receipt, classify_failure, global_dedup_annotations,
    canonical_promotion_eligible, family_aware_ranked, incomplete_branch_ids,
    island_specs_for_plan,
    prompt_sha, required_physical_episode_cap, stamp_wave, unique_ranked,
)
from turbo_race import (  # noqa: E402
    acceptance_criterion_for_strategy, screening_family_scores, select_strategy_candidate,
)


def check(label, condition):
    if not condition:
        raise AssertionError(label)


def test_graph_silent_publish():
    live = object.__new__(LiveManifest)
    live.wave = None
    live._lock = threading.Lock()
    live.path = Path(tempfile.mkdtemp()) / "manifest.json"
    live.ingest_url = ""
    live.experiment_id = "synthetic"
    live.dev_sha = "synthetic-dev"
    live.examples = []
    live.baseline_nodes = []
    live.rank_protocol = {
        "method": "canonical_rollout",
        "scorer_version": "synthetic",
        "rollout_contract": "synthetic",
        "split_sha256": "synthetic-dev",
        "samples_per_task": 3,
    }
    live.gepa_protocol = live.rank_protocol
    live.budget = types.SimpleNamespace(snapshot=lambda: {})
    live.started = 0
    live.expected_total = 0
    live.reference_lines = []
    live.mirror_path = None
    live.provider = "synthetic"
    live.model = "synthetic"
    live.reflection = None
    live.records = {}
    live.states = {}
    live.terminal = {}

    original_write = island_race.em.write_manifest
    original_publish = island_race.em.publish_run_shaped
    calls = []
    writes = []
    island_race.em.write_manifest = lambda manifest, path: writes.append(manifest)
    island_race.em.publish_run_shaped = lambda *args: calls.append(args)
    try:
        result = live.publish()
        check("empty ingest is graph-silent", result["ingest"] == "graph-silent")
        check("empty ingest does not publish", calls == [])

        run_dir = live.path.parent / "active-branch"
        run_dir.mkdir()
        (run_dir / "progress.jsonl").write_text(
            json.dumps({"kind": "episode", "latency_s": 2.0, "status": "success"}) + "\n"
            + json.dumps({"kind": "episode", "latency_s": 6.0, "status": "timeout"}) + "\n"
        )
        live.states = {"branch-a": {
            "status": "screening", "phase": "stage1", "strategy": "synthetic",
            "run_dir": str(run_dir), "episodes_expected": 2, "parent": None,
        }}
        live.publish()
        totals = writes[-1]["totals"]
        check("active branch ledger streams rollout latency",
              totals["rollout_latency_s"] == {"p50": 2.0, "p95": 6.0,
                                               "max": 6.0, "samples": 2})
        check("active branch ledger streams rollout statuses",
              totals["rollout_statuses"] == {"success": 1, "timeout": 1})

        live.ingest_url = "http://synthetic.invalid/ingest"
        island_race.em.publish_run_shaped = lambda *args: calls.append(args) or {"ok": True}
        result = live.publish()
        check("nonempty ingest publishes", result["ingest"] == {"ok": True})
        check("nonempty ingest publishes once", len(calls) == 1)
        check("nonempty ingest URL is preserved", calls[0][2] == "http://synthetic.invalid/ingest")
    finally:
        island_race.em.write_manifest = original_write
        island_race.em.publish_run_shaped = original_publish


def test_reflection_provenance_contains_name_not_secret():
    reflection_provenance = {
        "provider": "understudy-gateway",
        "model": "openai/kimi-k3",
        "project": "rehearsal",
        "workload": "main",
        "api_key_env": "UNDERSTUDY_API_KEY",
    }
    env = {"UNDERSTUDY_API_KEY": "SENTINEL-SECRET-VALUE"}
    serialized = json.dumps({
        "reflection": reflection_provenance,
        "env_name": reflection_provenance["api_key_env"],
    })
    check("reflection provenance includes API key environment name",
          "UNDERSTUDY_API_KEY" in serialized)
    check("reflection provenance includes provider label",
          "understudy-gateway" in serialized)
    check("reflection secret is not serialized",
          env["UNDERSTUDY_API_KEY"] not in serialized)


def test_completed_manifest_stamps_confirmation_totals():
    live = object.__new__(LiveManifest)
    live.wave = None
    live._lock = threading.Lock()
    live.path = Path(tempfile.mkdtemp()) / "manifest.json"
    live.ingest_url = ""
    live.experiment_id = "synthetic"
    live.dev_sha = "synthetic-dev"
    live.examples = []
    live.rank_protocol = em.make_protocol(
        method="canonical_rollout", split_sha256="synthetic-dev", samples_per_task=3,
    )
    live.gepa_protocol = em.make_protocol(
        method="gepa_observed", split_sha256="synthetic-dev", samples_per_task=1,
    )
    live.baseline_nodes = [
        em.make_node(
            node_id="wave1-winner", label="Wave-1 winner", wave="wave1",
            stage="completed", protocol=live.rank_protocol, score=0.5,
            rank_eligible=True,
        )
    ]
    live.budget = types.SimpleNamespace(snapshot=lambda: {
        "branches": {
            "survivor-1": {"episodes_completed": 24},
            "survivor-2": {"episodes_completed": 28},
        },
        "stage_a_completed": 168,
        "total_reflections": 2,
    })
    live.started = 0
    live.expected_total = 232
    live.reference_lines = []
    live.mirror_path = None
    live.provider = "synthetic"
    live.model = "synthetic"
    live.reflection = None
    live.records = {
        "survivor-1": {"status": "completed", "run_dir": "", "wall_clock_s": 1},
        "survivor-2": {"status": "completed", "run_dir": "", "wall_clock_s": 1},
    }
    predictions = [{"prediction": {}, "score": 1.0}]
    confirmations = [
        {"branch_id": "survivor-1", "confirmed": True, "mean_score": 0.5,
         "predictions": predictions},
        {"branch_id": "survivor-2", "confirmed": True, "mean_score": 0.75,
         "predictions": predictions},
    ]
    live.states = {
        "survivor-1": {"status": "completed", "confirmation": confirmations[0]},
        "survivor-2": {"status": "promoted", "confirmation": confirmations[1]},
    }
    live.terminal = {}
    original_write = island_race.em.write_manifest
    original_publish = island_race.em.publish_run_shaped
    published = []
    island_race.em.write_manifest = lambda manifest, path: published.append(manifest)
    island_race.em.publish_run_shaped = lambda *args: None
    try:
        live.finalize_completed(
            selected_winner=confirmations[1], confirmations=confirmations,
        )
        manifest = published[-1]
        nodes = {node["node_id"]: node for node in manifest["nodes"]}
        check("promoted winner carries confirmation score",
              nodes["survivor-2"]["score"] == 0.75)
        check("promoted winner is rank eligible",
              nodes["survivor-2"]["rank_eligible"] is True)
        check("completed finalist carries confirmation score",
              nodes["survivor-1"]["score"] == 0.5)
        check("completed manifest selects survivor-2",
              manifest["totals"]["selected_winner"]["branch_id"] == "survivor-2")
        check("completed manifest carries confirmations",
              manifest["totals"]["confirmations"] == confirmations)
        check("completed manifest marks stage2 executed",
              manifest["totals"]["stage2_executed"] is True)
    finally:
        island_race.em.write_manifest = original_write
        island_race.em.publish_run_shaped = original_publish


def main():
    test_graph_silent_publish()
    test_reflection_provenance_contains_name_not_secret()
    test_completed_manifest_stamps_confirmation_totals()
    check("exactly eight islands", len(ISLAND_SPECS) == 8)
    check("four explore islands", sum(s[1] == "explore" for s in ISLAND_SPECS) == 4)
    check("two failure-targeted islands", sum(s[1] == "failure_targeted" for s in ISLAND_SPECS) == 2)
    check("two exploit islands", sum(s[1] == "exploit" for s in ISLAND_SPECS) == 2)
    complete_records = {bid: {"status": "completed"} for bid, *_ in ISLAND_SPECS}
    check("complete wave has no incomplete branches",
          incomplete_branch_ids(ISLAND_SPECS, complete_records) == [])
    failed_records = dict(complete_records)
    failed_records["explore-2"] = {"status": "failed"}
    del failed_records["failure-1"]
    check("failed and missing branches invalidate wave",
          incomplete_branch_ids(ISLAND_SPECS, failed_records) == ["explore-2", "failure-1"])
    invalid = build_invalid_execution_receipt(
        experiment_id="invalid-test", dev_sha="dev", islands=failed_records,
        incomplete_branches=["explore-2", "failure-1"], budget={},
        manifest_path="manifest.json", manifest_digest="digest",
        publish_status="graph-silent", wall_clock_s=1,
    )
    check("invalid wave state", invalid["state"] == "invalid_execution")
    check("invalid wave has no distinct count", invalid["distinct_prompt_count"] is None)
    check("invalid wave blocks stage2", invalid["stage2_executed"] is False)
    check("invalid wave blocks promotion", invalid["promotion_blocked"] is True)
    check("invalid wave keeps holdout sealed", invalid["holdout_executed"] is False)
    stage2_specs = [
        ("survivor-1", "exploit_a", 1, 0),
        ("survivor-2", "exploit_b", 2, 1),
    ]
    stage2_records = {
        "survivor-1": {"status": "failed", "abort_reason": "episode cap 28"},
        "survivor-2": {"status": "failed", "abort_reason": "reflection cap 4"},
    }
    incomplete2 = incomplete_branch_ids(stage2_specs, stage2_records)
    stage2_invalid = build_invalid_execution_receipt(
        experiment_id="invalid-stage2-test", dev_sha="dev", islands={},
        incomplete_branches=incomplete2, budget={},
        manifest_path="manifest.json", manifest_digest="digest",
        publish_status="graph-silent", wall_clock_s=1,
        survivors=stage2_records, outcome="incomplete_stage2",
        stop_reason="scheduled Stage-2 survivors lacked completed receipts: survivor-1, survivor-2",
    )
    check("failed Stage-2 survivors invalidate wave",
          incomplete2 == ["survivor-1", "survivor-2"])
    check("Stage-2 invalid execution state",
          stage2_invalid["state"] == "invalid_execution")
    check("Stage-2 blocks promotion and confirmation",
          stage2_invalid["promotion_blocked"] is True
          and stage2_invalid["stage2_executed"] is False
          and stage2_invalid["selected_winner"] is None
          and stage2_invalid["confirmations"] == [])
    check("Stage-2 failure details are retained",
          set(stage2_invalid["survivors"]) == {"survivor-1", "survivor-2"}
          and "reflection cap 4" in stage2_invalid["survivors"]["survivor-2"]["abort_reason"])
    normal_stage2 = {
        "survivor-1": {"status": "completed"},
        "survivor-2": {"status": "completed"},
    }
    check("completed Stage-2 remains eligible",
          incomplete_branch_ids(stage2_specs, normal_stage2) == [])
    check("stage1 physical cap includes final full-valset evaluation",
          required_physical_episode_cap(12, 4) == 20)
    check("stage2 physical cap includes final full-valset evaluation",
          required_physical_episode_cap(24, 4) == 32)
    records = [
        {"status": "completed", "winner_prompt_sha256": "same", "screening_best_score": .7,
         "candidates_tried": 2, "wall_clock_s": 20, "branch_id": "a"},
        {"status": "completed", "winner_prompt_sha256": "same", "screening_best_score": .8,
         "candidates_tried": 2, "wall_clock_s": 30, "branch_id": "b"},
        {"status": "completed", "winner_prompt_sha256": "other", "screening_best_score": .75,
         "candidates_tried": 3, "wall_clock_s": 10, "branch_id": "c"},
        {"status": "failed", "winner_prompt_sha256": "bad", "screening_best_score": 1,
         "branch_id": "d"},
    ]
    ranked = unique_ranked(records)
    check("global prompt dedupe", [r["branch_id"] for r in ranked] == ["b", "c"])
    annotations = global_dedup_annotations(records)
    check("best duplicate is the representative",
          annotations["a"] == "b" and annotations["b"] is None)
    check("distinct prompt remains representative", annotations["c"] is None)
    check("failed branch is absent from dedupe evidence", "d" not in annotations)
    selected_ranked = unique_ranked([
        {"status": "completed", "winner_prompt_sha256": "x", "screening_best_score": .9,
         "selected_screening_score": .6, "candidates_tried": 2, "wall_clock_s": 1, "branch_id": "x"},
        {"status": "completed", "winner_prompt_sha256": "y", "screening_best_score": .8,
         "selected_screening_score": .7, "candidates_tried": 2, "wall_clock_s": 1, "branch_id": "y"},
    ])
    check("halving ranks the selected prompt score, not another candidate's best score",
          [r["branch_id"] for r in selected_ranked] == ["y", "x"])
    check("canonical prompt hash normalizes trailing newline", prompt_sha("x") == prompt_sha("x\n"))
    check("429 classified", classify_failure({"detail": "HTTP 429"})[0] == "rate_limit")
    check("timeout classified", classify_failure({"detail": "request timed out"})[0] == "timeout")
    check("fuse classified", classify_failure({"detail": "episode cap"})[0] == "budget_fuse")
    # The live state transition itself is exercised without constructing a
    # manifest or touching a provider.
    live = object.__new__(LiveManifest)
    live._lock = __import__("threading").Lock()
    live.records = {}
    live.states = {"a": {"status": "screening"}, "b": {"status": "screening"}}
    live.publish = lambda: live.states
    LiveManifest.sync_records(live, {"a": {"status": "completed"},
                                     "b": {"status": "failed", "detail": "HTTP 429"}})
    check("completed receipt finalizes independently", live.states["a"]["status"] == "completed")
    check("failed receipt streams reason independently",
          live.states["b"]["status"] == "failed"
          and live.states["b"]["failure_category"] == "rate_limit")
    live.terminal = {}
    live.publish = lambda: live.terminal
    LiveManifest.stop(live, state="stopped_no_distinct_candidates",
                      outcome="no_distinct_candidates", reason="deduplicated",
                      distinct_prompt_count=1)
    check("terminal no-distinct state is explicit",
          live.terminal["state"] == "stopped_no_distinct_candidates"
          and live.terminal["promotion_blocked"] is True)
    receipt = build_no_distinct_receipt(
        experiment_id="synthetic", dev_sha="d" * 64, islands={},
        distinct_prompt_count=1, budget={"stage_a_completed": 96},
        manifest_path="synthetic-manifest.json", manifest_digest="m" * 64,
        publish_status={"ok": True}, wall_clock_s=505,
    )
    check("convergence receipt refuses every promotion surface",
          receipt["state"] == "stopped_no_distinct_candidates"
          and receipt["stage2_executed"] is False
          and receipt["confirmations"] == []
          and receipt["selected_winner"] is None
          and receipt["promotion_blocked"] is True
          and receipt["holdout_executed"] is False)
    fake = types.SimpleNamespace(
        candidates=[
            {"system_prompt": "seed"},
            {"system_prompt": "different near best"},
            {"system_prompt": "different weak"},
        ],
        val_aggregate_scores=[.75, .70, .25],
        best_candidate={"system_prompt": "seed"},
        best_idx=0,
    )
    explore, explore_score, explore_mode, explore_index = select_strategy_candidate(fake, "seed", "explore")
    check("explore retains a distinct near-best candidate",
          explore["system_prompt"] == "different near best"
          and explore_score == .70 and explore_mode == "distinct_near_best"
          and explore_index == 1)
    exploit, exploit_score, exploit_mode, exploit_index = select_strategy_candidate(fake, "seed", "exploit")
    check("exploit preserves GEPA best",
          exploit["system_prompt"] == "seed"
          and exploit_score == .75 and exploit_mode == "gepa_best"
          and exploit_index == 0)
    check("exploit requires strict screening improvement",
          acceptance_criterion_for_strategy("exploit") == "strict_improvement")
    check("lineage-qualified Stage-2 exploit requires strict screening improvement",
          acceptance_criterion_for_strategy("exploit_abstain-1") == "strict_improvement")
    check("explore retains tied screening mutations",
          acceptance_criterion_for_strategy("explore") == "improvement_or_equal")
    check("failure-targeted retains tied screening mutations",
          acceptance_criterion_for_strategy("failure_targeted") == "improvement_or_equal")
    check("conservative exploit uses strict GEPA best",
          acceptance_criterion_for_strategy("conservative_exploit") == "strict_improvement")
    dense_records = []
    for branch_id, dense_score in (("passive", 0.0), ("clean", 1.0)):
        dense_records.append({
            "branch_id": branch_id, "status": "completed",
            "winner_prompt_sha256": branch_id,
            "screening_subscores_available": True,
            "screening_by_family": {
                "domain-id-direct-route": 1.0,
                "domain-id-lookalike-route": 1.0,
                "domain-id-parent-route": 1.0,
                "domain-id-unmatched-abstain": 0.5,
            },
            "seed_screening_by_family": {
                "domain-id-direct-route": 1.0,
                "domain-id-lookalike-route": 1.0,
                "domain-id-parent-route": 1.0,
                "domain-id-unmatched-abstain": 0.0,
            },
            "selected_screening_score": 0.5,
            "screening_dense_metrics": {
                "unmatched_dense_mean": dense_score,
                "forbidden_effects_mean": 0.0,
                "state_transition_partial_mean": dense_score,
                "malformed_mean": 0.0, "steps_mean": 3.0, "latency_s_mean": 1.0,
            },
        })
    dense_ranked = family_aware_ranked(
        dense_records, dense_transition=True,
    )
    check("Wave-5 dense transition outranks passive finish",
          [row["branch_id"] for row in dense_ranked] == ["clean", "passive"])
    stage2, stage2_score, stage2_mode, stage2_index = select_strategy_candidate(
        fake, "seed", "exploit_abstain-1",
    )
    check("lineage-qualified Stage-2 exploit keeps GEPA best",
          stage2["system_prompt"] == "seed"
          and stage2_score == .75 and stage2_mode == "gepa_best"
          and stage2_index == 0)
    check("abstention strategies use near-best selection",
          acceptance_criterion_for_strategy("abstention_policy") == "improvement_or_equal")
    records = [
        {"branch_id": "regressor", "status": "completed", "winner_prompt_sha256": "r",
         "screening_subscores_available": True,
         "screening_by_family": {"abstain": .9, "direct": .8, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": .2, "direct": .9, "lookalike": 1, "parent": 1}},
        {"branch_id": "winner", "status": "completed", "winner_prompt_sha256": "w",
         "screening_subscores_available": True, "screening_best_score": .8, "candidates_tried": 3,
         "screening_by_family": {"abstain": 1, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": .2, "direct": .9, "lookalike": 1, "parent": 1}},
        {"branch_id": "second", "status": "completed", "winner_prompt_sha256": "s",
         "screening_subscores_available": True, "screening_best_score": .7, "candidates_tried": 2,
         "screening_by_family": {"abstain": .8, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": .2, "direct": 1, "lookalike": 1, "parent": 1}},
    ]
    ranked = family_aware_ranked(
        records, abstain_family="abstain",
        perfect_families=("direct", "lookalike", "parent"),
    )
    check("family guard disqualifies route regression",
          [record["branch_id"] for record in ranked] == ["winner", "second"])
    reward_first = [
        {"branch_id": "higher-total", "status": "completed", "winner_prompt_sha256": "ht",
         "screening_subscores_available": True, "selected_screening_score": .9,
         "screening_tiebreaks": {"forbidden_effects": 0, "malformed": 0, "steps": 3},
         "screening_by_family": {"abstain": .5, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1}},
        {"branch_id": "higher-target", "status": "completed", "winner_prompt_sha256": "hf",
         "screening_subscores_available": True, "selected_screening_score": .8,
         "screening_tiebreaks": {"forbidden_effects": 0, "malformed": 0, "steps": 3},
         "screening_by_family": {"abstain": 1, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1}},
    ]
    check("wave4 keeps authoritative aggregate reward primary before target tie-break",
          family_aware_ranked(
              reward_first, abstain_family="abstain",
              perfect_families=("direct", "lookalike", "parent"),
              primary_reward_first=True,
          )[0]["branch_id"] == "higher-total")
    patch_records = [
        {"branch_id": "passive-finish", "status": "completed", "winner_prompt_sha256": "p0",
         "screening_subscores_available": True, "selected_screening_score": .75,
         "screening_tiebreaks": {"forbidden_effects": 0, "malformed": 0, "steps": 1},
         "screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1}},
        {"branch_id": "required-patch", "status": "completed", "winner_prompt_sha256": "p1",
         "screening_subscores_available": True, "selected_screening_score": 1,
         "screening_tiebreaks": {"forbidden_effects": 0, "malformed": 0, "steps": 4},
         "screening_by_family": {"abstain": 1, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1}},
        {"branch_id": "patch-plus-forbidden", "status": "completed", "winner_prompt_sha256": "pf",
         "screening_subscores_available": True, "selected_screening_score": 1,
         "screening_tiebreaks": {"forbidden_effects": 1, "malformed": 0, "steps": 5},
         "screening_by_family": {"abstain": 1, "direct": 1, "lookalike": 1, "parent": 1},
         "seed_screening_by_family": {"abstain": 0, "direct": 1, "lookalike": 1, "parent": 1}},
    ]
    patch_rank = family_aware_ranked(
        patch_records, abstain_family="abstain",
        perfect_families=("direct", "lookalike", "parent"), primary_reward_first=True,
    )
    check("required PATCH beats passive finish and forbidden-write tie",
          [rec["branch_id"] for rec in patch_rank] == [
              "required-patch", "patch-plus-forbidden", "passive-finish",
          ])
    check("family guard fails closed below two eligible",
          len(family_aware_ranked(
              records[:1], abstain_family="abstain",
              perfect_families=("direct", "lookalike", "parent"),
          )) < 2)
    check("canonical family guard rejects regression",
          not canonical_promotion_eligible(
              {"mean_by_family": {"direct-route": .9, "lookalike-route": 1, "parent-route": 1}},
              {"direct-route": 1, "lookalike-route": 1, "parent-route": 1},
          ))
    check("canonical family guard accepts abstain lift",
          canonical_promotion_eligible(
              {"mean_by_family": {"direct-route": 1, "lookalike-route": 1,
                                  "parent-route": 1, "unmatched-abstain": 1}},
              {"direct-route": 1, "lookalike-route": 1, "parent-route": 1,
               "unmatched-abstain": 0},
          ))
    # Field-level regression gate over GEPA 0.1.4 result.val_subscores.
    # val_subscores is list[dict[DataId, float]] where DataId is the positional
    # index into the (train-only) valset list; val_aggregate_subscores is None
    # because ContractAdapter returns no objective_scores. The gate must still
    # reject a candidate that regresses any sentinel family.
    val_tasks = [
        {"task_id": "aa-route-1"}, {"task_id": "bb-route-1"},
        {"task_id": "cc-route-1"}, {"task_id": "zz-abstain-1"},
    ]
    fake_result = types.SimpleNamespace(
        val_aggregate_subscores=None,
        val_subscores=[
            {0: 1.0, 1: 1.0, 2: 1.0, 3: 0.0},   # index 0 = seed baseline
            {0: 0.5, 1: 1.0, 2: 1.0, 3: 1.0},   # index 1 = sentinel regressor
        ],
    )
    selected, seed_baseline, err = screening_family_scores(fake_result, 1, val_tasks)
    check("val_subscores maps DataId to valset family order with None aggregate",
          err is None
          and selected == {"aa-route": 0.5, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": 1.0}
          and seed_baseline == {"aa-route": 1.0, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": 0.0})
    field_records = [
        {"branch_id": "reg", "status": "completed", "winner_prompt_sha256": "reg",
         "screening_subscores_available": True,
         "screening_by_family": selected, "seed_screening_by_family": seed_baseline},
        {"branch_id": "clean-a", "status": "completed", "winner_prompt_sha256": "ca",
         "screening_subscores_available": True, "screening_best_score": .9, "candidates_tried": 3,
         "screening_by_family": {"aa-route": 1.0, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": 1.0},
         "seed_screening_by_family": {"aa-route": 1.0, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": 0.0}},
        {"branch_id": "clean-b", "status": "completed", "winner_prompt_sha256": "cb",
         "screening_subscores_available": True, "screening_best_score": .8, "candidates_tried": 2,
         "screening_by_family": {"aa-route": 1.0, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": .8},
         "seed_screening_by_family": {"aa-route": 1.0, "bb-route": 1.0, "cc-route": 1.0, "zz-abstain": 0.0}},
    ]
    check("field-level gate disqualifies sentinel regressor from val_subscores",
          [rec["branch_id"] for rec in family_aware_ranked(
              field_records, abstain_family="zz-abstain",
              perfect_families=("aa-route", "bb-route", "cc-route"),
          )] == ["clean-a", "clean-b"])
    wave = {
        "wave": 3, "parent_run": "parent-run", "parent_winner_sha256": "abc",
        "failure_family": "abstain", "curriculum_sha256": "curriculum",
        "valset_sha256": "valset", "sentinels_per_family": 2,
        "island_plan": "wave3-abstain", "target_score": .875,
        "seed_prompt_sha256": "seed",
    }
    serialized = json.dumps(stamp_wave({"state": "completed"}, wave))
    check("wave provenance serializes with curriculum and no secret",
          "curriculum" in serialized and "SENTINEL-SECRET-VALUE" not in serialized)
    wave4 = island_specs_for_plan("wave4-state-transition")
    check("wave4 has four state, two sequence, and two crossover islands",
          len(wave4) == 8
          and sum(strategy == "exact_state_transition" for _, strategy, *_ in wave4) == 4
          and sum(strategy == "explicit_tool_sequence" for _, strategy, *_ in wave4) == 2
          and sum(strategy == "state_transition_crossover" for _, strategy, *_ in wave4) == 2)
    print("ALL 34 ISLAND TESTS PASSED")


if __name__ == "__main__":
    main()
