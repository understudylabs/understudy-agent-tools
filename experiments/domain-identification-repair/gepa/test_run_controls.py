#!/usr/bin/env python3
"""Provider-free regression gate for the GEPA run-controls (repeated evaluation
+ hard fuses + immutable artifacts).

Runtime glue test (isolated, not an importable package). Run with the optimize
venv:  .understudy/venvs/optimize/bin/python .../gepa/test_run_controls.py

No providers, no network: the student endpoint and env sidecar are faked with
scripted turns. No holdout identifiers appear here.
"""
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import optimize  # noqa: E402
from optimize import (  # noqa: E402
    ConcurrencyController,
    ContractAdapter,
    CostTelemetryUnavailable,
    FuseTripped,
    InvalidServicePressure,
    ProgressLedger,
    RunFuse,
    assert_split_allowed,
    classify_error,
    prepare_run_dir,
    summarize_samples,
)

# Generic leak patterns — NO production identifier is embedded in this file.
FORBIDDEN_PATTERNS = [r"domain-id-", r"\b[0-9a-f]{64}\b", r"split\s*=\s*holdout",
                      r"holdout_hash", r"holdout_sha"]

FINISH = '{"tool": "finish", "arguments": {}}'


class _Msg:
    def __init__(self, content):
        self.content = content


class _Resp:
    def __init__(self, content):
        self.choices = [type("C", (), {"message": _Msg(content)})()]


class FinishLLM:
    """Always returns finish so each episode is one student call, no steps.

    Optional `errors` is a list of exceptions raised on successive completion()
    calls (to simulate provider service pressure), consumed before finishing.
    """
    def __init__(self, errors=None):
        self.calls = 0
        self._errors = list(errors or [])
        self._lock = threading.Lock()

    def completion(self, **kwargs):
        with self._lock:
            self.calls += 1
            if self._errors:
                raise self._errors.pop(0)
        return _Resp(FINISH)


class _HTTPErr(Exception):
    def __init__(self, status_code, msg=""):
        super().__init__(msg or f"http {status_code}")
        self.status_code = status_code


def err_429():
    return _HTTPErr(429, "rate limited")


def err_5xx():
    return _HTTPErr(503, "service unavailable")


def err_timeout():
    return TimeoutError("request timed out")


def make_fake_sidecar(rewards):
    """Fake /reset|/step|/score. Assigns rewards to sessions in reset order."""
    state = {"resets": 0, "by_session": {}}
    it = iter(rewards)

    def fake_call_json(base, path, payload=None):
        if path == "/reset":
            state["resets"] += 1
            sess = f"s{state['resets']}"
            state["by_session"][sess] = next(it)
            return {"session": sess}
        if path == "/step":
            return {"observation": "ok", "done": False, "step": 1}
        if path == "/score":
            sess = payload["session"]
            return {"reward": state["by_session"][sess], "steps": 1, "forbidden_effects": 0}
        raise AssertionError(f"unexpected path {path}")

    return fake_call_json, state


def build_adapter(rewards, k, concurrency=1, fuse=None, ledger=None, errors=None):
    adapter = ContractAdapter("http://fake", samples_per_eval=k,
                              concurrency=concurrency, fuse=fuse, ledger=ledger)
    adapter.litellm = FinishLLM(errors=errors)
    return adapter


def evaluate_with(adapter, batch, rewards):
    fake, state = make_fake_sidecar(rewards)
    orig = optimize.call_json
    optimize.call_json = fake
    try:
        eb = adapter.evaluate(batch, {"system_prompt": "SYS"}, capture_traces=True)
    finally:
        optimize.call_json = orig
    return eb, state


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


def expect_trip(name, fn):
    try:
        fn()
    except FuseTripped:
        print(f"  ok: {name}")
        return
    raise AssertionError(f"FAIL: {name} (expected FuseTripped)")


TASKS = [{"task_id": "test-synthetic-a", "prompt": "pa"},
         {"task_id": "test-synthetic-b", "prompt": "pb"}]


# --- repeated evaluation: k independent episodes, mean/variance ------------
def test_k_independent_resets_and_mean_variance():
    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=None,
                   allow_unmetered_student=True).preflight()
    adapter = build_adapter(None, k=3, concurrency=1, fuse=fuse)
    rewards = [1.0, 0.0, 0.5, 1.0, 1.0, 1.0]  # task a: mean .5, task b: mean 1
    eb, state = evaluate_with(adapter, TASKS, rewards)
    check("k=3 => 6 independent /reset sessions", state["resets"] == 6)
    check("one logical score per task", len(eb.scores) == 2)
    check("task-a mean == 0.5", abs(eb.scores[0] - 0.5) < 1e-9)
    check("task-b mean == 1.0", abs(eb.scores[1] - 1.0) < 1e-9)
    from statistics import pvariance
    check("task-a variance == pvariance([1,0,.5])",
          abs(eb.outputs[0]["score_variance"] - pvariance([1.0, 0.0, 0.5])) < 1e-9)
    check("output records sample_scores", eb.outputs[0]["sample_scores"] == [1.0, 0.0, 0.5])
    check("episode_count == k", eb.outputs[0]["episode_count"] == 3)


def test_logical_vs_physical_counts():
    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=None,
                   allow_unmetered_student=True).preflight()
    adapter = build_adapter(None, k=3, concurrency=1, fuse=fuse)
    eb, _ = evaluate_with(adapter, TASKS, [0.0] * 6)
    snap = fuse.snapshot()
    check("logical metric calls == #tasks (2)", len(eb.scores) == 2)
    check("physical episodes reserved == tasks*k (6)", snap["episodes_reserved"] == 6)
    check("physical episodes completed == 6", snap["episodes_completed"] == 6)


# --- representative failure selection, order independent -------------------
def _trace(score, malformed):
    return {"score": score, "malformed_total": malformed, "ended": "finish", "steps": 1}


def test_representative_is_lowest_score_then_most_malformed():
    traces = [_trace(0.5, 0), _trace(0.0, 1), _trace(0.0, 3), _trace(1.0, 0)]
    # lowest score 0.0 tie -> highest malformed (3) -> index 2
    for perm in ([0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]):
        permuted = [traces[i] for i in perm]
        rep_idx, rep, summary = summarize_samples(permuted)
        check(f"perm {perm}: representative is the score=0/malformed=3 sample",
              rep["score"] == 0.0 and rep["malformed_total"] == 3)
        check(f"perm {perm}: summary covers every sample", len(summary) == 4)


def test_representative_tie_breaks_to_lowest_index():
    traces = [_trace(0.0, 2), _trace(0.0, 2)]  # identical -> lowest index 0
    rep_idx, _, _ = summarize_samples(traces)
    check("identical failures -> lowest sample index", rep_idx == 0)


# --- reserve-before-dispatch: no overshoot, partial abort pre-dispatch -----
def test_reserve_before_dispatch_no_overshoot():
    fuse = RunFuse(max_episodes=3, max_reflection_calls=1000, max_wall_seconds=9000,
                   max_reflection_cost_usd=None, allow_unmetered_student=True).preflight()
    adapter = build_adapter(None, k=3, concurrency=4, fuse=fuse)  # 2 tasks * 3 = 6 > 3
    expect_trip("evaluate trips at episode cap before dispatch",
                lambda: evaluate_with(adapter, TASKS, [0.0] * 6))
    snap = fuse.snapshot()
    check("no student episode dispatched (0 completions)", adapter.litellm.calls == 0)
    check("no episode completed", snap["episodes_completed"] == 0)
    check("reserved consumed up to cap, recorded", snap["episodes_reserved"] == 3)


def test_concurrent_reservation_boundary():
    fuse = RunFuse(max_episodes=50, max_reflection_calls=1000, max_wall_seconds=9000,
                   max_reflection_cost_usd=None, allow_unmetered_student=True).preflight()
    ok = []
    lock = threading.Lock()

    def worker():
        try:
            fuse.reserve_episode()
            with lock:
                ok.append(1)
        except FuseTripped:
            pass

    threads = [threading.Thread(target=worker) for _ in range(200)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("concurrent reservations never overshoot the cap", sum(ok) == 50)
    check("reserved count exactly the cap", fuse.snapshot()["episodes_reserved"] == 50)


# --- individual fuses ------------------------------------------------------
def test_reflection_call_fuse():
    fuse = RunFuse(1000, max_reflection_calls=2, max_wall_seconds=9000,
                   max_reflection_cost_usd=None, allow_unmetered_student=True).preflight()
    fuse.note_reflection()
    fuse.note_reflection()
    expect_trip("3rd reflection over cap of 2", fuse.note_reflection)


def test_wall_fuse():
    fuse = RunFuse(1000, 1000, max_wall_seconds=0, max_reflection_cost_usd=None,
                   allow_unmetered_student=True).preflight()
    expect_trip("wall fuse trips at 0s budget", fuse.reserve_episode)


def test_reflection_cost_fuse_metered():
    seq = iter([5.0, 16.0, 16.0])  # baseline 5, then +11 delta over $10 cap

    def reader():
        return next(seq)

    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=10.0,
                   reflection_cost_reader=reader, allow_unmetered_student=True).preflight()
    expect_trip("reflection cost delta >= $10 trips", fuse.note_reflection)


# --- fail-closed cost coverage --------------------------------------------
def test_reflection_cap_requires_reader():
    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=10.0,
                   reflection_cost_reader=None, allow_unmetered_student=True)
    expect_trip("cost cap set + no reader => refuse to start", fuse.preflight)


def test_cost_telemetry_unreadable_fails_closed():
    def reader():
        raise CostTelemetryUnavailable("no endpoint")

    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=10.0,
                   reflection_cost_reader=reader, allow_unmetered_student=True)
    expect_trip("cost cap set + unreadable telemetry => refuse", fuse.preflight)


def test_unmetered_student_requires_explicit_ack():
    fuse = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=10.0,
                   reflection_cost_reader=lambda: 0.0, allow_unmetered_student=False)
    expect_trip("student compute unmetered + no ack => refuse", fuse.preflight)


def test_cost_coverage_labels_and_no_total_claim():
    metered = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=10.0,
                      reflection_cost_reader=lambda: 1.0, allow_unmetered_student=True).preflight()
    s = metered.snapshot()
    check("coverage=reflection_only when in-process metered", s["cost_coverage"] == "reflection_only")
    check("in_process_dollar_fuse True when metered", s["in_process_dollar_fuse"] is True)
    check("total_cost_usd is null (never a number)", s["total_cost_usd"] is None)
    check("student_compute_metered is False", s["student_compute_metered"] is False)

    # Planned mode: no in-process cap -> out-of-band ClickHouse observability.
    planned = RunFuse(1000, 1000, 9000, max_reflection_cost_usd=None,
                      reflection_cost_reader=None, allow_unmetered_student=True,
                      spend_authorization_usd=1000.0).preflight()
    s2 = planned.snapshot()
    check("coverage=out_of_band_clickhouse when no in-process cap",
          s2["cost_coverage"] == "out_of_band_clickhouse")
    check("in_process_dollar_fuse False in planned mode", s2["in_process_dollar_fuse"] is False)
    check("total_cost_usd null in planned mode", s2["total_cost_usd"] is None)
    check("spend_authorization_usd recorded (observability only)",
          s2["spend_authorization_usd"] == 1000.0)
    check("reflection_spent_usd null when unmetered", s2["reflection_spent_usd"] is None)


# --- service pressure: failures NEVER enter scores/reflection --------------
def test_classify_error_mapping():
    check("429 -> 429", classify_error(err_429()) == "429")
    check("503 -> 5xx", classify_error(err_5xx()) == "5xx")
    check("timeout -> timeout", classify_error(err_timeout()) == "timeout")
    check("ValueError -> other", classify_error(ValueError("bad schema")) == "other")


def _fuse(max_episodes):
    return RunFuse(max_episodes, 1000, 9000, max_reflection_cost_usd=None,
                   allow_unmetered_student=True).preflight()


def test_transient_retry_then_success_consumes_capacity(tmp_root):
    fuse = _fuse(max_episodes=2)
    ledger = ProgressLedger(prepare_run_dir(tmp_root, "r"))
    adapter = build_adapter(None, k=1, concurrency=1, fuse=fuse, ledger=ledger,
                            errors=[err_429()])  # first attempt fails, retry ok
    eb, _ = evaluate_with(adapter, [TASKS[0]], [0.7, 0.7, 0.7])
    check("one logical score returned after successful retry", len(eb.scores) == 1)
    check("score comes from the SUCCESSFUL attempt (not 0)", eb.scores[0] == 0.7)
    snap = fuse.snapshot()
    check("retry reserved a fresh physical episode (2 reserved)", snap["episodes_reserved"] == 2)
    check("only the successful episode completed", snap["episodes_completed"] == 1)


def test_retry_is_capped_by_max_episodes(tmp_root):
    fuse = _fuse(max_episodes=1)  # no room for a retry
    ledger = ProgressLedger(prepare_run_dir(tmp_root, "r"))
    adapter = build_adapter(None, k=1, concurrency=1, fuse=fuse, ledger=ledger,
                            errors=[err_429()])
    expect_trip("retry blocked at episode cap (fuse trips, no score)",
                lambda: evaluate_with(adapter, [TASKS[0]], [0.0, 0.0]))
    check("no score produced", True)


def test_double_transient_failure_aborts_before_ranking(tmp_root):
    fuse = _fuse(max_episodes=10)
    run_dir = prepare_run_dir(tmp_root, "r")
    ledger = ProgressLedger(run_dir)
    adapter = build_adapter(None, k=1, concurrency=1, fuse=fuse, ledger=ledger,
                            errors=[err_5xx(), err_timeout()])  # both attempts fail
    raised = None
    try:
        evaluate_with(adapter, [TASKS[0]], [0.0] * 4)
    except InvalidServicePressure as exc:
        raised = exc
    check("double failure raises InvalidServicePressure (no score/ranking)", raised is not None)
    check("exactly two attempts were made", adapter.litellm.calls == 2)
    blob = (run_dir / "progress.jsonl").read_text()
    check("invalid_service_pressure recorded in ledger", "invalid_service_pressure" in blob)
    check("no candidate_eval snapshot written for the invalid eval",
          len(list((run_dir / "snapshots").glob("candidate-*.json"))) == 0)


def test_non_transient_error_propagates_without_retry(tmp_root):
    fuse = _fuse(max_episodes=10)
    ledger = ProgressLedger(prepare_run_dir(tmp_root, "r"))
    adapter = build_adapter(None, k=1, concurrency=1, fuse=fuse, ledger=ledger,
                            errors=[ValueError("scorer/auth/schema bug")])
    raised = None
    try:
        evaluate_with(adapter, [TASKS[0]], [0.0] * 4)
    except InvalidServicePressure:
        raised = "masked"
    except ValueError as exc:
        raised = exc
    check("non-transient error keeps its identity (ValueError, not masked)",
          isinstance(raised, ValueError))
    check("no retry on non-transient error (exactly one attempt)", adapter.litellm.calls == 1)


# --- adaptive concurrency --------------------------------------------------
def test_concurrency_starts_and_caps_at_24():
    c = ConcurrencyController(start=24)
    check("starts at 24", c.current() == 24)
    for _ in range(5):
        c.observe(24, 0.0, 5.0)  # clean batches
    check("never exceeds the 24 ceiling", c.current() == 24)


def test_stepdown_on_error_pressure_without_baseline():
    c = ConcurrencyController(start=24)
    c.observe(12, 0.05, 1.0)  # pressure >= 2%, jobs<24 so no baseline
    check("error pressure steps 24 -> 16 without any baseline", c.current() == 16)
    check("no latency baseline established on a pressured batch",
          c.snapshot()["baseline_p95_seconds"] is None)


def test_baseline_only_from_first_clean_24_batch():
    c = ConcurrencyController(start=24)
    c.observe(12, 0.0, 3.0)  # clean but only 12 jobs -> NOT a baseline
    check("baseline not set from a <24-job batch", c.snapshot()["baseline_p95_seconds"] is None)
    c.observe(24, 0.0, 5.0)  # first fully-successful 24-job batch
    snap = c.snapshot()
    check("baseline set from first clean 24-job batch", snap["baseline_p95_seconds"] == 5.0)
    check("baseline_source labelled", snap["baseline_source"] == "first_clean_batch")


def test_latency_adaptation_waits_for_clean_baseline():
    c = ConcurrencyController(start=24)
    # High latency but no baseline yet + zero errors + <24 jobs: must NOT adapt.
    for _ in range(3):
        c.observe(12, 0.0, 999.0)
    check("no latency stepdown before a measured baseline", c.current() == 24)
    check("still no baseline", c.snapshot()["baseline_p95_seconds"] is None)
    c.observe(24, 0.0, 4.0)  # establishes baseline = 4.0
    c.observe(24, 0.0, 20.0)  # 5x baseline -> latency stepdown
    check("latency stepdown once baseline exists", c.current() == 16)


def test_recovery_after_two_clean_batches():
    c = ConcurrencyController(start=24)
    c.observe(12, 0.05, 1.0)  # pressure -> 16
    check("stepped down to 16", c.current() == 16)
    c.observe(12, 0.0, 1.0)
    check("one clean batch does not recover yet", c.current() == 16)
    c.observe(12, 0.0, 1.0)
    check("two clean batches step back up toward 24", c.current() == 24)


def test_concurrency_floor_at_12():
    c = ConcurrencyController(start=24)
    for _ in range(6):
        c.observe(12, 0.5, 1.0)
    check("never drops below the 12 floor", c.current() == 12)


# --- immutable artifacts ---------------------------------------------------
def test_immutable_run_dir_refusal(tmp_root):
    prepare_run_dir(tmp_root, "run-x")
    expect_trip("second prepare of same run id refuses",
                lambda: prepare_run_dir(tmp_root, "run-x"))


def test_ledger_two_records_preserve_snapshots(tmp_root):
    run_dir = prepare_run_dir(tmp_root, "run-ledger")
    ledger = ProgressLedger(run_dir)
    ledger.record({"candidate_hash": "abc123", "task_id": "test-synthetic-a", "mean": 0.5})
    ledger.record({"candidate_hash": "abc123", "task_id": "test-synthetic-b", "mean": 0.6})
    snaps = sorted((run_dir / "snapshots").glob("candidate-abc123-*.json"))
    check("two immutable per-candidate snapshots preserved", len(snaps) == 2)
    lines = (run_dir / "progress.jsonl").read_text().strip().splitlines()
    check("ledger is append-only (2 lines)", len(lines) == 2)
    import json as _json
    latest = _json.loads((run_dir / "snapshots" / "LATEST.json").read_text())
    check("LATEST.json points to newest snapshot only", latest["seq"] == 2)


# --- split guard + fixture leak scan --------------------------------------
def test_split_guard():
    check("train allowed", assert_split_allowed("train") == "train")
    check("dev allowed", assert_split_allowed("dev") == "dev")
    expect_trip("holdout forbidden", lambda: assert_split_allowed("holdout"))


def test_no_holdout_identifiers_in_fixtures():
    fixture_blob = FINISH + repr(TASKS)
    for pat in FORBIDDEN_PATTERNS:
        check(f"guard: fixtures free of /{pat}/", re.search(pat, fixture_blob) is None)
    check("task ids are obvious synthetic sentinels",
          all(t["task_id"].startswith("test-synthetic-") for t in TASKS))


def main():
    import tempfile
    plain = [
        test_k_independent_resets_and_mean_variance,
        test_logical_vs_physical_counts,
        test_representative_is_lowest_score_then_most_malformed,
        test_representative_tie_breaks_to_lowest_index,
        test_reserve_before_dispatch_no_overshoot,
        test_concurrent_reservation_boundary,
        test_reflection_call_fuse,
        test_wall_fuse,
        test_reflection_cost_fuse_metered,
        test_reflection_cap_requires_reader,
        test_cost_telemetry_unreadable_fails_closed,
        test_unmetered_student_requires_explicit_ack,
        test_cost_coverage_labels_and_no_total_claim,
        test_classify_error_mapping,
        test_concurrency_starts_and_caps_at_24,
        test_stepdown_on_error_pressure_without_baseline,
        test_baseline_only_from_first_clean_24_batch,
        test_latency_adaptation_waits_for_clean_baseline,
        test_recovery_after_two_clean_batches,
        test_concurrency_floor_at_12,
        test_split_guard,
        test_no_holdout_identifiers_in_fixtures,
    ]
    needs_tmp = [test_immutable_run_dir_refusal, test_ledger_two_records_preserve_snapshots,
                 test_transient_retry_then_success_consumes_capacity,
                 test_retry_is_capped_by_max_episodes,
                 test_double_transient_failure_aborts_before_ranking,
                 test_non_transient_error_propagates_without_retry]
    for t in plain:
        print(t.__name__)
        t()
    for t in needs_tmp:
        print(t.__name__)
        with tempfile.TemporaryDirectory() as d:
            t(d)
    print(f"\nALL {len(plain) + len(needs_tmp)} RUN-CONTROL TESTS PASSED")


if __name__ == "__main__":
    main()
