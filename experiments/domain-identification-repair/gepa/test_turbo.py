#!/usr/bin/env python3
"""Provider-free regression gate for the turbo two-stage race + combined manifest.

No providers, no network. Budget/subset/selection logic and the combined
experiment manifest schema are exercised with synthetic, non-production data.
No holdout identifiers or production task ids appear in this file.
"""
import re
import sys
import tempfile
import threading
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import turbo_race  # noqa: E402
import experiment_manifest as em  # noqa: E402
from turbo_race import (  # noqa: E402
    GlobalBudget,
    STAGE_B_EPISODES_PER_WINNER,
    build_final_manifest,
    failure_family_curriculum,
    screening_family_scores,
    screening_valset_hash,
    select_winner,
    stratified_screening_subsets,
    subset_hash,
    train_screening_subsets,
)
from optimize import FuseTripped, assert_split_allowed  # noqa: E402

# Generic leak patterns — no production identifier is embedded in this file.
FORBIDDEN_PATTERNS = [r"domain" + r"-id-", r"\b[0-9a-f]{64}\b", r"split\s*=\s*holdout",
                      r"holdout_hash", r"holdout_sha"]


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


def test_stdout_logger_survives_late_background_write():
    """Eight island loggers must survive late background-thread writes."""
    from gepa.logging.logger import StdOutLogger

    loggers = [StdOutLogger() for _ in range(8)]
    release = threading.Event()
    errors = []

    def late_write(index):
        release.wait(timeout=1)
        try:
            loggers[index].log(f"late reflection log {index}")
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    workers = [threading.Thread(target=late_write, args=(index,)) for index in range(8)]
    for worker in workers:
        worker.start()
    for index, logger in enumerate(loggers):
        logger.log(f"optimizer returned {index}")
    release.set()
    for worker in workers:
        worker.join(timeout=1)
    check("all eight late logger threads finished", not any(worker.is_alive() for worker in workers))
    check("all eight late logger writes avoided closed streams", errors == [])


def test_reflection_route_is_scoped_and_headered():
    import litellm

    class FakeFuse:
        def __init__(self):
            self.events = []

        def note_reflection(self):
            self.events.append("reflection")

    class Chunk:
        def __init__(self, content):
            self.choices = [types.SimpleNamespace(
                delta=types.SimpleNamespace(content=content),
            )]

    calls = []
    original_completion = litellm.completion

    def fake_completion(**kwargs):
        calls.append(kwargs)
        if "reflection" not in fuse.events:
            raise AssertionError("reflection fuse was not noted before completion")
        fuse.events.append("completion")
        return [Chunk("ok")]

    litellm.completion = fake_completion
    try:
        fuse = FakeFuse()
        reflection = turbo_race.make_reflection(
            fuse, "SENTINEL-KEY", "exploit",
            model="openai/gpt-5.6-sol",
            api_base="https://api.understudylabs.com/v1",
            extra_headers={
                "x-understudy-project": "rehearsal",
                "x-understudy-workload": "main",
            },
            provider_label="understudy-gateway",
        )
        check("scoped reflection returns streamed content", reflection("hello") == "ok")
        call = calls[-1]
        check("reflection model is parameterized", call["model"] == "openai/gpt-5.6-sol")
        check("reflection base URL is parameterized",
              call["api_base"] == "https://api.understudylabs.com/v1")
        check("reflection headers are forwarded", call["extra_headers"] == {
            "x-understudy-project": "rehearsal",
            "x-understudy-workload": "main",
        })
        check("reflection key is forwarded", call["api_key"] == "SENTINEL-KEY")
        check("reflection fuse is noted before completion",
              fuse.events[:2] == ["reflection", "completion"])

        calls.clear()
        fuse = FakeFuse()
        reflection = turbo_race.make_reflection(fuse, "SENTINEL-KEY")
        check("default reflection returns streamed content", reflection("hello") == "ok")
        default_call = calls[-1]
        check("default reflection keeps Kimi model",
              default_call["model"] == "openai/kimi-k3")
        check("default reflection omits headers", "extra_headers" not in default_call)
    finally:
        litellm.completion = original_completion
    check("Wave-3 reflection directives are present",
          all(key in turbo_race.REFLECTION_DIRECTIVES for key in (
              "abstention_policy", "termination_discipline", "conservative_exploit")))


def test_gepa_014_metric_budget_full_valset_headroom():
    """A tied final proposal can overshoot the logical stopper by one valset."""
    import gepa
    from gepa.core.adapter import EvaluationBatch
    from gepa.logging.logger import StdOutLogger

    class SyntheticAdapter:
        def __init__(self):
            self.physical_calls = 0
            self.proposals = 0

        def evaluate(self, batch, candidate, capture_traces=False):
            self.physical_calls += len(batch)
            outputs = [{"item": item} for item in batch]
            return EvaluationBatch(
                outputs=outputs,
                scores=[0.5] * len(batch),
                trajectories=outputs if capture_traces else None,
            )

        def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
            return {"system_prompt": [{"Feedback": "synthetic tied mutation"}]}

        def propose_new_texts(self, candidate, reflective_dataset, components_to_update):
            self.proposals += 1
            return {"system_prompt": f"synthetic-{self.proposals}"}

    adapter = SyntheticAdapter()
    result = gepa.optimize(
        seed_candidate={"system_prompt": "synthetic-seed"},
        trainset=list(range(8)), valset=list(range(4)), adapter=adapter,
        max_metric_calls=12, reflection_minibatch_size=4,
        candidate_selection_strategy="current_best",
        acceptance_criterion="improvement_or_equal", frontier_type="instance",
        skip_perfect_score=True, logger=StdOutLogger(),
        run_dir=tempfile.mkdtemp(prefix="gepa-budget-boundary-"), seed=1,
    )
    check("GEPA 0.1.4 accepted tied candidate", len(result.candidates) >= 2)
    check("logical budget 12 may consume 16 physical episodes", adapter.physical_calls == 16)
    check("result reports the same 16 metric calls", result.total_metric_calls == 16)


def new_budget():
    b = GlobalBudget(max_total_episodes=120, stage_a_global_cap=72,
                     stage_b_escrow=48, max_total_reflections=8)
    b.register_branch("A", max_episodes=36, max_reflections=4)
    b.register_branch("B", max_episodes=36, max_reflections=4)
    return b


# --------------------------------------------------------------------------
# GlobalBudget: atomic all-or-nothing admission.
# --------------------------------------------------------------------------
def test_global_cap_failure_leaves_branch_unchanged():
    # cap Stage-A global at 4 with two 3-episode branches: after 4 global
    # reservations the 5th must fail WITHOUT touching the branch counter.
    b = GlobalBudget(max_total_episodes=52, stage_a_global_cap=4, stage_b_escrow=48)
    b.register_branch("A", max_episodes=100, max_reflections=4)
    b.register_branch("B", max_episodes=100, max_reflections=4)
    for _ in range(3):
        b.reserve_episode("A")
    b.reserve_episode("B")  # global now 4/4
    snap_before = b.snapshot()
    a_before = snap_before["branches"]["A"]["episodes_reserved"]
    try:
        b.reserve_episode("A")
        raise AssertionError("expected FuseTripped")
    except FuseTripped:
        pass
    snap_after = b.snapshot()
    check("global-cap failure leaves branch A counter unchanged",
          snap_after["branches"]["A"]["episodes_reserved"] == a_before == 3)
    check("global-cap failure leaves global counter unchanged",
          snap_after["stage_a_reserved"] == 4)


def test_branch_cap_failure_leaves_global_unchanged():
    b = GlobalBudget(max_total_episodes=120, stage_a_global_cap=72, stage_b_escrow=48)
    b.register_branch("A", max_episodes=2, max_reflections=4)
    b.register_branch("B", max_episodes=36, max_reflections=4)
    b.reserve_episode("A"); b.reserve_episode("A")  # branch A at cap 2
    global_before = b.snapshot()["stage_a_reserved"]
    try:
        b.reserve_episode("A")
        raise AssertionError("expected FuseTripped")
    except FuseTripped:
        pass
    snap = b.snapshot()
    check("branch-cap failure leaves global counter unchanged",
          snap["stage_a_reserved"] == global_before == 2)
    check("branch-cap failure leaves branch counter unchanged",
          snap["branches"]["A"]["episodes_reserved"] == 2)


def test_32_concurrent_reservations_never_exceed_caps():
    b = new_budget()  # stage_a global cap 72, branch cap 36 each
    errors = []

    def worker(bid):
        for _ in range(40):
            try:
                b.reserve_episode(bid)
            except FuseTripped:
                pass
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

    threads = [threading.Thread(target=worker, args=("A" if i % 2 == 0 else "B",))
               for i in range(32)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    snap = b.snapshot()
    check("no worker errors", not errors)
    check("32-way: global stage-A never exceeds 72", snap["stage_a_reserved"] <= 72)
    check("32-way: branch A never exceeds 36", snap["branches"]["A"]["episodes_reserved"] <= 36)
    check("32-way: branch B never exceeds 36", snap["branches"]["B"]["episodes_reserved"] <= 36)
    check("32-way: total reserved (incl escrow) never exceeds 120",
          snap["total_reserved"] <= 120)


def test_stage_a_cannot_invade_escrow():
    # Even hammering Stage-A, reservations stop at the global cap (72) and can
    # never consume the 48-episode Stage-B escrow.
    b = GlobalBudget(max_total_episodes=120, stage_a_global_cap=72, stage_b_escrow=48)
    b.register_branch("A", max_episodes=1000, max_reflections=4)
    b.register_branch("B", max_episodes=1000, max_reflections=4)
    granted = 0
    for _ in range(500):
        for bid in ("A", "B"):
            try:
                b.reserve_episode(bid)
                granted += 1
            except FuseTripped:
                pass
    snap = b.snapshot()
    check("stage-A grants capped at global cap 72", granted == 72)
    check("escrow untouched by Stage-A", snap["stage_b_reserved"] == 0)
    check("escrow still fully available", snap["stage_b_escrow"] == 48)


def test_stage_b_confirms_two_winners_at_worst_stage_a_usage():
    # Worst case: Stage-A consumed the full 72. Reserve escrow up front (as the
    # orchestrator does) BEFORE Stage-A runs; two distinct winners each get 24.
    b = new_budget()
    check("reserve confirmation A up front", b.reserve_confirmation("A") is True)
    check("reserve confirmation B up front", b.reserve_confirmation("B") is True)
    # Now Stage-A burns its full global allowance.
    granted = 0
    for _ in range(500):
        for bid in ("A", "B"):
            try:
                b.reserve_episode(bid); granted += 1
            except FuseTripped:
                pass
    snap = b.snapshot()
    check("Stage-A still limited to 72 with escrow pre-reserved", granted == 72)
    check("both winners hold 24-episode confirmation each",
          snap["branches"]["A"]["confirm_reserved"] == 24
          and snap["branches"]["B"]["confirm_reserved"] == 24)
    check("escrow exactly filled by the two winners", snap["stage_b_reserved"] == 48)
    check("grand total never exceeds 120", snap["total_reserved"] == 120)


def test_confirmation_per_branch_cap_and_duplicate_refused():
    b = new_budget()
    check("first confirmation reserve for A succeeds", b.reserve_confirmation("A") is True)
    snap_before = b.snapshot()
    # Duplicate reservation for the same outstanding branch is refused, and no
    # branch can grab a second winner's allocation (would starve the other).
    check("duplicate same-branch confirmation reserve refused",
          b.reserve_confirmation("A") is False)
    check("duplicate refusal changed nothing",
          b.snapshot()["stage_b_reserved"] == snap_before["stage_b_reserved"] == 24)
    # n greater than a single winner's allocation is refused all-or-nothing.
    check("oversized confirmation reserve (n=25) refused",
          b.reserve_confirmation("B", n=STAGE_B_EPISODES_PER_WINNER + 1) is False)
    check("oversized refusal changed nothing", b.snapshot()["stage_b_reserved"] == 24)


def test_escrow_exhaustion_refuses_third_branch():
    b = GlobalBudget(max_total_episodes=120, stage_a_global_cap=72, stage_b_escrow=48)
    for bid in ("A", "B", "C"):
        b.register_branch(bid, max_episodes=36, max_reflections=4)
    check("A reserves 24", b.reserve_confirmation("A") is True)
    check("B reserves 24", b.reserve_confirmation("B") is True)
    check("C refused (escrow full at 48)", b.reserve_confirmation("C") is False)
    check("escrow exactly 48", b.snapshot()["stage_b_reserved"] == 48)


def test_release_before_dispatch_then_refused_after_dispatch():
    b = new_budget()
    b.reserve_confirmation("A")
    # Legal release before dispatch (e.g. winner deduped): frees the 24.
    released = b.release_confirmation("A")
    check("release before dispatch frees 24", released == 24)
    check("escrow freed", b.snapshot()["stage_b_reserved"] == 0)
    # Reserve again, dispatch, then release must be refused (returns 0).
    b.reserve_confirmation("A")
    b.mark_confirmation_dispatched("A")
    check("release after dispatch releases nothing", b.release_confirmation("A") == 0)
    check("dispatched escrow still held", b.snapshot()["stage_b_reserved"] == 24)


def test_dedupe_release_frees_only_that_branch_allocation():
    b = new_budget()
    b.reserve_confirmation("A"); b.reserve_confirmation("B")
    b.mark_confirmation_dispatched("A")           # A runs canonically
    freed = b.release_confirmation("B")           # B deduped to cache
    check("dedupe releases exactly B's 24", freed == 24)
    snap = b.snapshot()
    check("A's dispatched allocation retained", snap["branches"]["A"]["confirm_consumed"] == 24)
    check("escrow now holds only A's 24", snap["stage_b_reserved"] == 24)


def test_reflection_caps_global_and_branch():
    b = GlobalBudget(max_total_episodes=120, stage_a_global_cap=72, stage_b_escrow=48,
                     max_total_reflections=3)
    b.register_branch("A", max_episodes=36, max_reflections=2)
    b.register_branch("B", max_episodes=36, max_reflections=2)
    b.note_reflection("A"); b.note_reflection("A")
    try:
        b.note_reflection("A")  # branch cap 2
        raise AssertionError("expected FuseTripped")
    except FuseTripped:
        pass
    check("branch reflection cap holds", b.snapshot()["branches"]["A"]["reflections"] == 2)
    b.note_reflection("B")  # global now 3/3
    try:
        b.note_reflection("B")  # global cap 3
        raise AssertionError("expected FuseTripped")
    except FuseTripped:
        pass
    check("global reflection cap holds", b.snapshot()["total_reflections"] == 3)


# --------------------------------------------------------------------------
# Deterministic stratified screening subsets.
# --------------------------------------------------------------------------
def synthetic_dev():
    # 4 synthetic families x 2 tasks each — no production identifiers.
    tasks = []
    for fam in ("fam-alpha", "fam-beta", "fam-gamma", "fam-delta"):
        for n in ("01", "02"):
            tasks.append({"task_id": f"{fam}-{n}"})
    return tasks


def test_subsets_family_coverage_complementary_and_hashbound():
    dev = synthetic_dev()
    a, b = stratified_screening_subsets(dev)
    fams_a = sorted(re.sub(r"-\d+$", "", t["task_id"]) for t in a["tasks"])
    fams_b = sorted(re.sub(r"-\d+$", "", t["task_id"]) for t in b["tasks"])
    check("branch A covers all 4 families", fams_a == ["fam-alpha", "fam-beta", "fam-delta", "fam-gamma"])
    check("branch B covers all 4 families", fams_b == fams_a)
    ids_a = {t["task_id"] for t in a["tasks"]}
    ids_b = {t["task_id"] for t in b["tasks"]}
    check("subsets are disjoint/complementary", ids_a.isdisjoint(ids_b))
    check("subset A hash bound to its task ids", a["subset_sha256"] == subset_hash(a["tasks"]))
    check("subset A != subset B hash", a["subset_sha256"] != b["subset_sha256"])


def test_subset_hash_order_independent():
    dev = synthetic_dev()
    a1, _ = stratified_screening_subsets(dev)
    a2, _ = stratified_screening_subsets(list(reversed(dev)))
    check("subset selection is order-independent (deterministic hash)",
          a1["subset_sha256"] == a2["subset_sha256"])


def test_train_curriculum_and_screening_valset_are_deterministic():
    tasks = [
        {"task_id": f"fam-{family}-{index:02d}"}
        for family in ("abstain", "direct", "lookalike", "parent")
        for index in range(1, 7)
    ]
    curriculum = failure_family_curriculum(tasks, "fam-abstain", 2)
    ids = [task["task_id"] for task in curriculum["tasks"]]
    expected = sorted(
        [f"fam-abstain-{i:02d}" for i in range(1, 7)]
        + [f"fam-{family}-01" for family in ("direct", "lookalike", "parent")]
        + [f"fam-{family}-02" for family in ("direct", "lookalike", "parent")]
    )
    check("curriculum contains failure family and sentinels", ids == expected)
    check("curriculum family counts are exact",
          curriculum["families"] == {
              "fam-abstain": 6, "fam-direct": 2, "fam-lookalike": 2, "fam-parent": 2})
    check("curriculum hash is deterministic",
          curriculum["curriculum_sha256"] == failure_family_curriculum(
              tasks, "fam-abstain", 2)["curriculum_sha256"])
    subsets = train_screening_subsets(tasks)
    check("train screening subsets are complementary and one per family",
          [len(s["tasks"]) for s in subsets] == [4, 4]
          and all(len({t["task_id"].rsplit("-", 1)[0] for t in s["tasks"]}) == 4 for s in subsets))
    check("train valset hash is deterministic",
          screening_valset_hash(subsets) == screening_valset_hash(
              train_screening_subsets(list(reversed(tasks)))))


def test_screening_family_scores_use_val_subscores_without_objectives():
    tasks = [
        {"task_id": "fam-abstain-01"},
        {"task_id": "fam-direct-01"},
        {"task_id": "fam-lookalike-01"},
        {"task_id": "fam-parent-01"},
    ]
    result = types.SimpleNamespace(
        val_subscores=[
            {0: 0.0, 1: 1.0, 2: 1.0, 3: 1.0},
            {0: 1.0, 1: 0.0, 2: 1.0, 3: 1.0},
        ],
        val_aggregate_subscores=None,
    )
    selected, seed, error = screening_family_scores(result, 1, tasks)
    check("per-family guard uses val_subscores when objective aggregates are absent",
          error is None
          and selected == {"fam-abstain": 1.0, "fam-direct": 0.0,
                           "fam-lookalike": 1.0, "fam-parent": 1.0}
          and seed["fam-direct"] == 1.0)

    missing = types.SimpleNamespace(val_subscores=None, val_aggregate_subscores=None)
    _, _, missing_error = screening_family_scores(missing, 0, tasks)
    check("per-family guard fails closed when val_subscores are absent",
          missing_error == "missing val_subscores")


# --------------------------------------------------------------------------
# Selection: full-dev canonical only, tie-breaks, no partial promotion.
# --------------------------------------------------------------------------
def test_select_winner_by_score_then_malformed_then_latency():
    winner = select_winner([
        {"branch_id": "A", "confirmed": True, "mean_score": 0.72, "malformed_rate": 0.1, "wall_clock_s": 100},
        {"branch_id": "B", "confirmed": True, "mean_score": 0.75, "malformed_rate": 0.3, "wall_clock_s": 90},
    ])
    check("higher score wins", winner["branch_id"] == "B")
    tie = select_winner([
        {"branch_id": "A", "confirmed": True, "mean_score": 0.75, "malformed_rate": 0.3, "wall_clock_s": 50},
        {"branch_id": "B", "confirmed": True, "mean_score": 0.75, "malformed_rate": 0.1, "wall_clock_s": 200},
    ])
    check("score tie broken by lower malformed rate", tie["branch_id"] == "B")
    tie2 = select_winner([
        {"branch_id": "A", "confirmed": True, "mean_score": 0.75, "malformed_rate": 0.1, "wall_clock_s": 200},
        {"branch_id": "B", "confirmed": True, "mean_score": 0.75, "malformed_rate": 0.1, "wall_clock_s": 50},
    ])
    check("score+malformed tie broken by lower latency", tie2["branch_id"] == "B")


def test_no_partial_promotion_unconfirmed_excluded():
    winner = select_winner([
        {"branch_id": "A", "confirmed": False, "reason": "branch_failed"},
        {"branch_id": "B", "confirmed": True, "mean_score": 0.60, "malformed_rate": 0.2, "wall_clock_s": 80},
    ])
    check("unconfirmed branch never promoted", winner["branch_id"] == "B")
    check("all-unconfirmed yields no winner",
          select_winner([{"branch_id": "A", "confirmed": False}]) is None)


# --------------------------------------------------------------------------
# No holdout access.
# --------------------------------------------------------------------------
def test_no_holdout_access():
    assert_split_allowed("dev"); assert_split_allowed("train")
    try:
        assert_split_allowed("holdout")
        raise AssertionError("expected FuseTripped")
    except FuseTripped:
        pass
    check("holdout split is refused", True)


# --------------------------------------------------------------------------
# Combined experiment manifest: protocol identity + methodology guards.
# --------------------------------------------------------------------------
DEV_SHA = "synthetic-dev-split-sentinel"  # obviously non-production, non-hex


def proto(method, k):
    return em.make_protocol(method=method, split_sha256=DEV_SHA, samples_per_task=k)


def test_in_progress_node_cannot_carry_score():
    try:
        em.make_node(node_id="x", label="x", wave="wave2", stage="screening",
                     protocol=proto("canonical_rollout", 3), score=0.5)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("in-progress node with a score is refused", True)
    # In-progress node with null score is fine.
    n = em.make_node(node_id="x", label="x", wave="wave2", stage="screening",
                     protocol=proto("canonical_rollout", 3))
    check("in-progress node with null score allowed", n["score"] is None)


def test_gepa_observed_never_rank_eligible():
    try:
        em.make_node(node_id="g", label="gepa", wave="baseline", stage="completed",
                     protocol=proto("gepa_observed", 1), score=0.5625, rank_eligible=True)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("gepa_observed cannot be forced rank-eligible", True)


def test_headline_uses_only_rank_protocol():
    rankp = proto("canonical_rollout", 3)
    nodes = [
        em.make_node(node_id="seed-gepa", label="seed gepa", wave="baseline",
                     stage="completed", protocol=proto("gepa_observed", 1),
                     score=None, rank_eligible=False,
                     extra={"gepa_observed_score": 0.5625}),
        em.make_node(node_id="seed", label="seed canon", wave="baseline",
                     stage="completed", protocol=rankp, score=0.5),
        em.make_node(node_id="w1", label="wave1 winner", wave="wave1",
                     stage="completed", protocol=rankp, score=0.729, parent="seed"),
        em.make_node(node_id="w2a", label="wave2 A in progress", wave="wave2",
                     stage="screening", protocol=rankp, score=None, parent="w1"),
    ]
    manifest = em.build_manifest(
        experiment="t", dev_split_sha256=DEV_SHA, rank_protocol=rankp, nodes=nodes,
        reference_lines=[{"label": "incumbent", "score": 0.875,
                          "protocol": proto("canonical_rollout", 1),
                          "rank_comparable": False, "note": "k=1; not rank-comparable"}])
    check("headline high-score is the canonical k=3 max (0.729), not gepa 0.5625/0.75",
          manifest["headline"]["high_score"] == 0.729)
    check("headline node is the wave-1 canonical winner",
          manifest["headline"]["high_score_node"] == "w1")
    check("incumbent k=1 kept only as a non-rank-comparable reference line",
          manifest["reference_lines"][0]["rank_comparable"] is False)


def test_mixed_protocol_ranking_refused():
    rankp = proto("canonical_rollout", 3)
    # A canonical node at k=3 but marked with a different (k=1) protocol while
    # rank_eligible must be refused by the ranker.
    bad = em.make_node(node_id="bad", label="bad", wave="wave2", stage="completed",
                       protocol=proto("canonical_rollout", 1), score=0.9)
    try:
        em.rank_nodes([bad], rankp)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("mixed-protocol high-score ranking refused", True)


def test_canonical_k1_cannot_rank_against_k3():
    k3 = proto("canonical_rollout", 3)
    k1 = proto("canonical_rollout", 1)
    check("k1 and k3 are different protocols", not em.protocols_comparable(k1, k3))
    incumbent_k1 = em.make_node(node_id="inc", label="incumbent", wave="baseline",
                                stage="completed", protocol=k1, score=0.875)
    student_k3 = em.make_node(node_id="stu", label="student", wave="wave1",
                              stage="completed", protocol=k3, score=0.729)
    # Building a manifest that ranks on k3 must NOT let the k1 incumbent
    # participate — it raises because incumbent_k1 is rank_eligible under k3.
    try:
        em.build_manifest(experiment="t", dev_split_sha256=DEV_SHA,
                          rank_protocol=k3, nodes=[incumbent_k1, student_k3])
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("canonical k=1 cannot be ranked against canonical k=3", True)


def test_manifest_requires_provenance_and_holdout_untouched():
    rankp = proto("canonical_rollout", 3)
    node = em.make_node(node_id="s", label="s", wave="baseline", stage="completed",
                        protocol=rankp, score=0.5)
    try:
        em.build_manifest(experiment="t", dev_split_sha256="", rank_protocol=rankp, nodes=[node])
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("manifest without dev provenance refused", True)
    m = em.build_manifest(experiment="t", dev_split_sha256=DEV_SHA, rank_protocol=rankp, nodes=[node])
    m["holdout_untouched"] = False
    try:
        em.validate_manifest(m)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    check("manifest not declaring holdout untouched refused", True)


def test_no_holdout_identifiers_in_fixtures():
    # Scan the synthetic DATA this suite constructs (not the source, whose
    # FORBIDDEN_PATTERNS literals would self-match), mirroring the sibling gate.
    rankp = proto("canonical_rollout", 3)
    manifest = em.build_manifest(
        experiment="t", dev_split_sha256=DEV_SHA, rank_protocol=rankp,
        nodes=[em.make_node(node_id="s", label="s", wave="baseline",
                            stage="completed", protocol=rankp, score=0.5)])
    import json as _json
    fixture_blob = _json.dumps(synthetic_dev()) + _json.dumps(manifest)
    for pat in FORBIDDEN_PATTERNS:
        check(f"guard: synthetic fixtures free of /{pat}/",
              re.search(pat, fixture_blob) is None)
    check("synthetic dev task ids use non-production family sentinels",
          all(t["task_id"].split("-")[0] == "fam" for t in synthetic_dev()))


def test_run_shaped_bridge_active_and_terminal_transition():
    # The run-shaped bridge (combined manifest -> gepa-viz run.json) must:
    #  * key candidates by STABLE node id with parents referencing those ids;
    #  * carry status for every node (active subset drives the deployed white
    #    pulse) and expose NO score/predictions while in progress;
    #  * expose score (and forward predictions) ONLY once finalized;
    #  * preserve the examples list and dev provenance.
    rankp = proto("canonical_rollout", 3)
    gepap = proto("gepa_observed", 1)
    examples = [{"task_id": "fam-alpha-01", "prompt": "p", "band": "b"}]

    def manifest_with(branchA_stage, branchA_score, branchA_extra=None):
        nodes = [
            em.make_node(node_id="baseline-seed", label="seed", wave="baseline",
                         stage="completed", protocol=rankp, score=0.5,
                         extra={"predictions": [{"prediction": {}, "score": 1.0}]}),
            em.make_node(node_id="baseline-seed-gepa", label="seed-gepa",
                         wave="baseline", stage="completed", protocol=gepap,
                         score=None, rank_eligible=False,
                         extra={"gepa_observed_score": 0.5625}),
            em.make_node(node_id="wave1-winner", label="w1", wave="wave1",
                         stage="completed", protocol=rankp, score=0.729,
                         parent="baseline-seed"),
            em.make_node(node_id="wave2-A", label="A", wave="wave2",
                         stage=branchA_stage, protocol=rankp, score=branchA_score,
                         branch_id="A", parent="wave1-winner",
                         episodes_completed=12, episodes_expected=36,
                         extra=branchA_extra),
        ]
        return em.build_manifest(experiment="t", dev_split_sha256=DEV_SHA,
                                 rank_protocol=rankp, nodes=nodes)

    # ---- while branch A is ACTIVE (screening): no score / no predictions ----
    run_active = em.run_shaped_from_manifest(manifest_with("screening", None), examples)
    check("bridge preserves examples", run_active["examples"] == examples)
    check("bridge is hash-bound to dev provenance",
          run_active["split_provenance"]["dev"] == DEV_SHA)
    cA = run_active["candidates"]["wave2-A"]
    check("active branch status is in the deployed active set",
          cA["status"] in em.BRIDGE_ACTIVE_STATUSES)
    check("active branch carries NO score", cA["score"] is None)
    check("active branch carries NO fabricated predictions", cA["predictions"] is None)
    check("stable ids: parent references an existing candidate key",
          cA["parent"] == "wave1-winner" and "wave1-winner" in run_active["candidates"])
    check("baseline/wave1/wave2 all present as stable-id candidates",
          {"baseline-seed", "wave1-winner", "wave2-A"} <= set(run_active["candidates"]))
    check("finalized baseline is scored and green-eligible via predictions",
          run_active["candidates"]["baseline-seed"]["score"] == 0.5
          and run_active["candidates"]["baseline-seed"]["predictions"] is not None)
    check("gepa_observed metadata node is not scored in the bridge",
          run_active["candidates"]["baseline-seed-gepa"]["score"] is None)

    # ---- after branch A is PROMOTED (terminal): score + predictions appear ---
    preds = [{"prediction": {}, "score": 1.0}, {"prediction": {}, "score": 0.0}]
    run_done = em.run_shaped_from_manifest(
        manifest_with("promoted", 0.833, {"predictions": preds}), examples)
    dA = run_done["candidates"]["wave2-A"]
    check("terminal branch status leaves the active set (no more pulse)",
          dA["status"] not in em.BRIDGE_ACTIVE_STATUSES)
    check("terminal branch exposes its finalized score", dA["score"] == 0.833)
    check("terminal branch forwards real predictions for green/red arc",
          dA["predictions"] == preds)
    check("node identity is stable across the active->terminal transition",
          set(run_active["candidates"]) == set(run_done["candidates"]))


def test_final_manifest_deduped_stage_b_is_no_improvement():
    rankp = proto("canonical_rollout", 3)
    baseline = [
        em.make_node(node_id="baseline-seed", label="seed", wave="baseline",
                     stage="completed", protocol=rankp, score=0.5),
        em.make_node(node_id="wave1-winner", label="wave1", wave="wave1",
                     stage="completed", protocol=rankp, score=0.729),
    ]
    budget = new_budget()
    budget.reserve_confirmation("A")
    budget.reserve_confirmation("B")
    budget.release_confirmation("A")
    budget.release_confirmation("B")
    branches = [("A", 1, {}, "run-A"), ("B", 2, {}, "run-B")]
    results = {
        bid: {
            "status": "completed",
            "seeded_from_prompt_sha256": "seed-sha",
            "winner_prompt_sha256": "seed-sha",
            "screening_best_score": 0.729,
            "candidates_tried": 3,
            "fuses": {"episodes_completed": 4},
        } for bid, *_ in branches
    }
    confirmations = [{
        "branch_id": bid, "confirmed": True, "deduped": True,
        "confirm_consumed": 0, "confirmation_receipt": None,
        "mean_score": 0.729, "winner_prompt_sha256": "seed-sha",
    } for bid, *_ in branches]
    winner = select_winner(confirmations)
    manifest, selected = build_final_manifest(
        em=em, experiment_id="synthetic-race", dev_sha=DEV_SHA,
        rank_protocol=rankp, baseline_nodes=baseline, branches=branches,
        results=results, confirmations=confirmations, reference_lines=[],
        branch_max_episodes=36, budget=budget, winner=winner, wall_clock_s=1,
    )
    deduped = manifest["nodes"][-1]
    check("deduped wave2 node is completed", deduped["stage"] == "completed")
    check("deduped wave2 node is not rank eligible", deduped["rank_eligible"] is False)
    check("deduped wave2 node has no score", deduped["score"] is None)
    check("deduped wave2 node has no predictions", deduped.get("predictions") is None)
    check("deduped outcome is explicit",
          deduped["provenance"]["outcome"] == "no_improvement_deduplicated")
    check("headline remains the wave1 canonical score", manifest["headline"]["high_score"] == 0.729)
    check("deduped selection reuses wave1 without new lift",
          selected["node_id"] == "wave1-winner"
          and selected["new_model_lift"] is False
          and selected["reuses"] == "wave1-winner")
    check("deduped selection is never a branch id",
          selected["node_id"] not in {"A", "B"} and selected.get("branch_id") is None)
    projected = em.run_shaped_from_manifest(manifest, [{"task_id": "fam-alpha-01"}])
    check("run-shaped projection has examples and candidates",
          "examples" in projected and "candidates" in projected)
    check("run-shaped projection omits combined nodes", "nodes" not in projected)
    candidate = projected["candidates"][deduped["node_id"]]
    check("deduped candidate projects completed with null score/predictions",
          candidate["status"] == "completed"
          and candidate["score"] is None
          and candidate["predictions"] is None)


def test_final_manifest_confirmed_stage_b_is_rankable():
    rankp = proto("canonical_rollout", 3)
    baseline = [em.make_node(node_id="wave1-winner", label="wave1", wave="wave1",
                             stage="completed", protocol=rankp, score=0.729)]
    budget = new_budget()
    budget.reserve_confirmation("A")
    consumed = budget.mark_confirmation_dispatched("A")
    branches = [("A", 1, {}, "run-A")]
    results = {"A": {"status": "completed", "screening_best_score": 0.8,
                     "candidates_tried": 4, "fuses": {"episodes_completed": 4}}}
    confirmations = [{
        "branch_id": "A", "confirmed": True, "deduped": False,
        "confirm_consumed": consumed, "confirmation_receipt": "synthetic-receipt",
        "out_path": "synthetic-receipt", "mean_score": 0.833,
        "winner_prompt_sha256": "new-sha",
        "predictions": [{"prediction": {}, "score": 1.0}],
    }]
    manifest, _selected = build_final_manifest(
        em=em, experiment_id="synthetic-race", dev_sha=DEV_SHA,
        rank_protocol=rankp, baseline_nodes=baseline, branches=branches,
        results=results, confirmations=confirmations, reference_lines=[],
        branch_max_episodes=36, budget=budget, winner=confirmations[0], wall_clock_s=1,
    )
    node = manifest["nodes"][-1]
    check("confirmed wave2 node is rank eligible", node["rank_eligible"] is True)
    check("confirmed wave2 node carries score and predictions",
          node["score"] == 0.833 and node["predictions"] is not None)


def test_predictions_from_canonical_real_and_aligned():
    # 2 dev tasks, k=3 -> 6 rows with REAL 0/1 scores. The helper aggregates to
    # one cell per example, aligned to examples order, using real per-task means
    # (no fabricated scores); its mean equals the receipt mean_score.
    examples = [{"task_id": "fam-alpha-01"}, {"task_id": "fam-beta-02"}]
    rows = (
        [{"task_id": "fam-alpha-01", "score": s} for s in (1, 1, 1)]      # mean 1.0
        + [{"task_id": "fam-beta-02", "score": s} for s in (1, 0, 0)]     # mean 1/3
    )
    canonical = {"mean_score": (1.0 + 1.0 / 3) / 2, "rows": rows}
    preds = em.predictions_from_canonical(canonical, examples)
    check("one prediction cell per example (aligned to examples)", len(preds) == 2)
    check("cell 0 is the real mean of task fam-alpha-01", preds[0]["score"] == 1.0)
    check("cell 1 is the real mean of task fam-beta-02", abs(preds[1]["score"] - 1.0 / 3) < 1e-9)
    mean = sum(p["score"] for p in preds) / len(preds)
    check("aggregated mean equals receipt mean_score", abs(mean - canonical["mean_score"]) < 1e-9)
    check("no rows -> None (caller leaves predictions null / gray)",
          em.predictions_from_canonical({"rows": []}, examples) is None)
    check("missing task in receipt -> None (never asserts a fake outcome)",
          em.predictions_from_canonical({"rows": rows[:3]}, examples) is None)


def main():
    tests = [
        test_stdout_logger_survives_late_background_write,
        test_reflection_route_is_scoped_and_headered,
        test_gepa_014_metric_budget_full_valset_headroom,
        test_global_cap_failure_leaves_branch_unchanged,
        test_branch_cap_failure_leaves_global_unchanged,
        test_32_concurrent_reservations_never_exceed_caps,
        test_stage_a_cannot_invade_escrow,
        test_stage_b_confirms_two_winners_at_worst_stage_a_usage,
        test_confirmation_per_branch_cap_and_duplicate_refused,
        test_escrow_exhaustion_refuses_third_branch,
        test_release_before_dispatch_then_refused_after_dispatch,
        test_dedupe_release_frees_only_that_branch_allocation,
        test_reflection_caps_global_and_branch,
        test_subsets_family_coverage_complementary_and_hashbound,
        test_subset_hash_order_independent,
        test_train_curriculum_and_screening_valset_are_deterministic,
        test_screening_family_scores_use_val_subscores_without_objectives,
        test_select_winner_by_score_then_malformed_then_latency,
        test_no_partial_promotion_unconfirmed_excluded,
        test_no_holdout_access,
        test_in_progress_node_cannot_carry_score,
        test_gepa_observed_never_rank_eligible,
        test_headline_uses_only_rank_protocol,
        test_mixed_protocol_ranking_refused,
        test_canonical_k1_cannot_rank_against_k3,
        test_manifest_requires_provenance_and_holdout_untouched,
        test_run_shaped_bridge_active_and_terminal_transition,
        test_final_manifest_deduped_stage_b_is_no_improvement,
        test_final_manifest_confirmed_stage_b_is_rankable,
        test_predictions_from_canonical_real_and_aligned,
        test_no_holdout_identifiers_in_fixtures,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} TURBO TESTS PASSED")


if __name__ == "__main__":
    main()
