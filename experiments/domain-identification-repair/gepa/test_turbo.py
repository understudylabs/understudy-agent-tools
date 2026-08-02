#!/usr/bin/env python3
"""Provider-free regression gate for the turbo two-stage race + combined manifest.

No providers, no network. Budget/subset/selection logic and the combined
experiment manifest schema are exercised with synthetic, non-production data.
No holdout identifiers or production task ids appear in this file.
"""
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import turbo_race  # noqa: E402
import experiment_manifest as em  # noqa: E402
from turbo_race import (  # noqa: E402
    GlobalBudget,
    STAGE_B_EPISODES_PER_WINNER,
    select_winner,
    stratified_screening_subsets,
    subset_hash,
)
from optimize import FuseTripped, assert_split_allowed  # noqa: E402

# Generic leak patterns — no production identifier is embedded in this file.
FORBIDDEN_PATTERNS = [r"domain-id-", r"\b[0-9a-f]{64}\b", r"split\s*=\s*holdout",
                      r"holdout_hash", r"holdout_sha"]


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


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


def main():
    tests = [
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
        test_select_winner_by_score_then_malformed_then_latency,
        test_no_partial_promotion_unconfirmed_excluded,
        test_no_holdout_access,
        test_in_progress_node_cannot_carry_score,
        test_gepa_observed_never_rank_eligible,
        test_headline_uses_only_rank_protocol,
        test_mixed_protocol_ranking_refused,
        test_canonical_k1_cannot_rank_against_k3,
        test_manifest_requires_provenance_and_holdout_untouched,
        test_no_holdout_identifiers_in_fixtures,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} TURBO TESTS PASSED")


if __name__ == "__main__":
    main()
