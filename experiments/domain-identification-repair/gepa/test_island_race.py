#!/usr/bin/env python3
"""Provider-free unit tests for eight-island selection and failure evidence."""
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
from island_race import (  # noqa: E402
    ISLAND_SPECS, LiveManifest, build_invalid_execution_receipt,
    build_no_distinct_receipt, classify_failure, global_dedup_annotations,
    incomplete_branch_ids, prompt_sha, required_physical_episode_cap, unique_ranked,
)
from turbo_race import acceptance_criterion_for_strategy, select_strategy_candidate  # noqa: E402


def check(label, condition):
    if not condition:
        raise AssertionError(label)


def test_graph_silent_publish():
    live = object.__new__(LiveManifest)
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
    live.records = {}
    live.states = {}
    live.terminal = {}

    original_write = island_race.em.write_manifest
    original_publish = island_race.em.publish_run_shaped
    calls = []
    island_race.em.write_manifest = lambda manifest, path: None
    island_race.em.publish_run_shaped = lambda *args: calls.append(args)
    try:
        result = live.publish()
        check("empty ingest is graph-silent", result["ingest"] == "graph-silent")
        check("empty ingest does not publish", calls == [])

        live.ingest_url = "http://synthetic.invalid/ingest"
        island_race.em.publish_run_shaped = lambda *args: calls.append(args) or {"ok": True}
        result = live.publish()
        check("nonempty ingest publishes", result["ingest"] == {"ok": True})
        check("nonempty ingest publishes once", len(calls) == 1)
        check("nonempty ingest URL is preserved", calls[0][2] == "http://synthetic.invalid/ingest")
    finally:
        island_race.em.write_manifest = original_write
        island_race.em.publish_run_shaped = original_publish


def main():
    test_graph_silent_publish()
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
    check("stage1 physical cap includes final full-valset evaluation",
          required_physical_episode_cap(12, 4) == 16)
    check("stage2 physical cap includes final full-valset evaluation",
          required_physical_episode_cap(24, 4) == 28)
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
    )
    explore, explore_score, explore_mode = select_strategy_candidate(fake, "seed", "explore")
    check("explore retains a distinct near-best candidate",
          explore["system_prompt"] == "different near best"
          and explore_score == .70 and explore_mode == "distinct_near_best")
    exploit, exploit_score, exploit_mode = select_strategy_candidate(fake, "seed", "exploit")
    check("exploit preserves GEPA best",
          exploit["system_prompt"] == "seed"
          and exploit_score == .75 and exploit_mode == "gepa_best")
    check("exploit requires strict screening improvement",
          acceptance_criterion_for_strategy("exploit") == "strict_improvement")
    check("explore retains tied screening mutations",
          acceptance_criterion_for_strategy("explore") == "improvement_or_equal")
    check("failure-targeted retains tied screening mutations",
          acceptance_criterion_for_strategy("failure_targeted") == "improvement_or_equal")
    print("ALL 25 ISLAND TESTS PASSED")


if __name__ == "__main__":
    main()
