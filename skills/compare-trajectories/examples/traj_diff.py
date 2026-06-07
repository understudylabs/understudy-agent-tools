"""Behavioral trajectory diff — the executor behind compare-trajectories Flow 3-6.

Reads two run JSON exports (per-task records with messages/tool_calls/steps/
finish_reasons/end_state/score/passed), aligns by task id, and emits:
  * the outcome-delta matrix (A pass/fail x B pass/fail),
  * per-task behavioral metrics (steps, finish bucket, distinct tools, recovery),
  * a heuristic gap-class label for each reachable-gap (A-fail, B-pass) task,
  * the warm-start yield (clean B-passes of A-failures),
  * an "is this gap RL-shaped?" verdict.

Reads existing trajectories only; never calls a model. Stdlib only. Gap-class
labels are HYPOTHESES — confirm with a spot-check. Run __main__ for a self-test.

Usage:
    python traj_diff.py run_a.json run_b.json [--holdout-ids ids.txt] \
        [--min-n 10] [--json out.json]
"""
from __future__ import annotations
import argparse
import json
import sys
from collections import Counter


# ----- loading & alignment -------------------------------------------------

def load_run(path: str) -> dict:
    """Load a run export -> {task_id: record}. Tolerates a bare list or
    {'tasks': [...]} / {'results': [...]}; keys by record['id']."""
    raw = json.load(open(path))
    rows = raw if isinstance(raw, list) else raw.get("tasks") or raw.get("results") or []
    return {str(r["id"]): r for r in rows}


def align(run_a: dict, run_b: dict) -> tuple[list[str], list[str], list[str]]:
    a, b = set(run_a), set(run_b)
    shared = sorted(a & b)
    return shared, sorted(a - b), sorted(b - a)


# ----- behavioral metrics --------------------------------------------------

def tool_sequence(record: dict) -> list[str]:
    """Ordered (tool_name) signature from messages[].tool_calls."""
    seq = []
    for m in record.get("messages", []):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                seq.append(tc.get("name") or tc.get("function", {}).get("name", "?"))
    return seq


def classify_finish(record: dict) -> str:
    """Map finish_reasons / end_state -> {completed, max_steps, gave_up, error}."""
    fr = record.get("finish_reasons") or []
    fr = [fr] if isinstance(fr, str) else list(fr)
    blob = " ".join(str(x) for x in fr).lower()
    if any(k in blob for k in ("error", "exception", "crash")):
        return "error"
    if any(k in blob for k in ("length", "max_step", "max step", "max_tokens")):
        return "max_steps"
    if record.get("passed"):
        return "completed"
    # ended a turn with no tool_call and didn't pass -> gave up
    return "gave_up"


def detect_malformed(record: dict) -> bool:
    """A's failure is a format/parsing problem, not strategy."""
    for m in record.get("messages", []):
        for tc in (m.get("tool_calls") or []):
            args = tc.get("arguments", tc.get("function", {}).get("arguments"))
            if isinstance(args, str):
                try:
                    json.loads(args)
                except (ValueError, TypeError):
                    return True
    for ar in record.get("assertion_results", []):
        if isinstance(ar, dict) and ar.get("type", "").lower() in {"parse_error", "schema_error"}:
            return True
    return False


def recovery_events(record: dict) -> int:
    """Count error/empty tool results followed by another assistant tool_call."""
    msgs = record.get("messages", [])
    n = 0
    for i, m in enumerate(msgs):
        if m.get("role") == "tool":
            content = str(m.get("content", "")).lower()
            errored = ("404" in content) or ("error" in content) or content.strip() in ("", "[]", "{}")
            if errored:
                nxt = next((x for x in msgs[i + 1:] if x.get("role") == "assistant"), None)
                if nxt and nxt.get("tool_calls"):
                    n += 1
    return n


def behavioral_metrics(record: dict) -> dict:
    seq = tool_sequence(record)
    return {
        "steps_to_done": record.get("steps") or len(seq),
        "finish_bucket": classify_finish(record),
        "distinct_tools": len(set(seq)),
        "recovery_events": recovery_events(record),
        "quit_after_error": classify_finish(record) in {"gave_up", "error"},
    }


def first_divergence(seq_a: list[str], seq_b: list[str]) -> int | None:
    for i in range(min(len(seq_a), len(seq_b))):
        if seq_a[i] != seq_b[i]:
            return i
    if len(seq_a) == len(seq_b):
        return None
    return min(len(seq_a), len(seq_b))


# ----- outcome matrix & gap classification ---------------------------------

def outcome_matrix(run_a: dict, run_b: dict, shared: list[str]) -> dict:
    both_pass, both_fail, reachable_gap, regressions = [], [], [], []
    for tid in shared:
        pa, pb = bool(run_a[tid].get("passed")), bool(run_b[tid].get("passed"))
        (both_pass if (pa and pb) else
         both_fail if (not pa and not pb) else
         reachable_gap if (not pa and pb) else
         regressions).append(tid)
    return {
        "both_pass": both_pass, "both_fail": both_fail,
        "reachable_gap": reachable_gap, "regressions": regressions,
        "agree": len(both_pass) + len(both_fail),
        "disagree": len(reachable_gap) + len(regressions),
    }


def _is_prefix(short: list[str], long: list[str]) -> bool:
    return len(short) < len(long) and long[:len(short)] == short


def classify_gap(rec_a: dict, rec_b: dict) -> tuple[str, str]:
    """For a reachable-gap task (A-fail, B-pass) -> (label, evidence).

    Precedence: format/parsing > persistence/recovery (prefix-extension) >
    knowledge > persistence/recovery (same-tool recovery) > unclassified.

    The prefix check comes before the knowledge rule on purpose: if A's tool
    sequence is a prefix of B's, B reached a NEW tool only because it kept going
    where A quit — that is persistence, not world knowledge, even though the
    later tool is technically one A "never attempted"."""
    if detect_malformed(rec_a):
        return "format/parsing", "A emitted malformed/unparseable tool-calls"
    seq_a, seq_b = tool_sequence(rec_a), tool_sequence(rec_b)
    if seq_a and _is_prefix(seq_a, seq_b):
        return "persistence/recovery", "A's trajectory is a prefix of B's — A stopped early, B persisted"
    tools_a, tools_b = set(seq_a), set(seq_b)
    knew = tools_b - tools_a
    if knew:
        return "knowledge", f"B called tool(s) A never attempted: {sorted(knew)}"
    ma = behavioral_metrics(rec_a)
    if tools_a & tools_b and (ma["steps_to_done"] < (rec_b.get("steps") or len(seq_b))
                              or ma["quit_after_error"]):
        return "persistence/recovery", "A reached the same tools but stopped early / quit after error"
    return "unclassified", "no heuristic fired cleanly — manual review"


def is_clean_warmstart(rec_b: dict, max_thrash: int = 2) -> bool:
    m = behavioral_metrics(rec_b)
    return (bool(rec_b.get("passed")) and m["finish_bucket"] == "completed"
            and not detect_malformed(rec_b) and m["recovery_events"] <= max_thrash)


# ----- top-level -----------------------------------------------------------

def diff(run_a_path: str, run_b_path: str, holdout_ids: set[str] | None = None) -> dict:
    run_a, run_b = load_run(run_a_path), load_run(run_b_path)
    holdout_ids = holdout_ids or set()
    shared, only_a, only_b = align(run_a, run_b)
    matrix = outcome_matrix(run_a, run_b, shared)

    gap_classes, warm = Counter(), []
    for tid in matrix["reachable_gap"]:
        if tid in holdout_ids:
            continue
        label, _ = classify_gap(run_a[tid], run_b[tid])
        gap_classes[label] += 1
        if is_clean_warmstart(run_b[tid]):
            warm.append(tid)

    divergences = []
    for tid in shared:
        d = first_divergence(tool_sequence(run_a[tid]), tool_sequence(run_b[tid]))
        if d is not None:
            divergences.append(d)
    median_div = sorted(divergences)[len(divergences) // 2] if divergences else None

    plurality = gap_classes.most_common(1)[0][0] if gap_classes else None
    rl_shaped = plurality == "persistence/recovery"
    return {
        "runs": {"a": run_a_path, "b": run_b_path},
        "shared_n": len(shared), "only_a": only_a, "only_b": only_b,
        "matrix": {k: (v if isinstance(v, int) else len(v)) for k, v in matrix.items()},
        "reachable_gap_ids": matrix["reachable_gap"], "regression_ids": matrix["regressions"],
        "gap_classes": dict(gap_classes), "plurality_class": plurality,
        "median_first_divergence": median_div,
        "warm_start_yield": len(warm), "warm_start_ids": warm,
        "rl_shaped_hypothesis": rl_shaped,
        "holdout_excluded": sorted(holdout_ids & set(matrix["reachable_gap"])),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_a"); ap.add_argument("run_b")
    ap.add_argument("--holdout-ids")
    ap.add_argument("--min-n", type=int, default=10)
    ap.add_argument("--json")
    args = ap.parse_args(argv)
    holdout = set(open(args.holdout_ids).read().split()) if args.holdout_ids else set()
    report = diff(args.run_a, args.run_b, holdout)

    print(json.dumps(report["matrix"], indent=2))
    print("gap classes:", report["gap_classes"])
    print("warm-start yield:", report["warm_start_yield"])
    verdict = "RL-shaped (persistence/recovery dominates)" if report["rl_shaped_hypothesis"] \
        else f"NOT clearly RL-shaped (plurality={report['plurality_class']})"
    if report["shared_n"] < args.min_n:
        verdict += f"  [DIRECTIONAL ONLY: shared N={report['shared_n']} < {args.min_n}]"
    print("verdict (hypothesis):", verdict)
    if args.json:
        json.dump(report, open(args.json, "w"), indent=2)
    return 0


def _selftest() -> None:
    import tempfile, os
    def mk(passed, tools, finish, malformed=False):
        tcs = [{"name": t, "arguments": ("{bad" if malformed else "{}")} for t in tools]
        return {"id": None, "passed": passed, "steps": len(tools), "finish_reasons": [finish],
                "messages": [{"role": "assistant", "tool_calls": tcs}], "end_state": {}, "score": 1.0 if passed else 0.0}
    run_a = {"tasks": []}; run_b = {"tasks": []}
    cases = [
        ("persist", mk(False, ["api_search"], "gave_up"), mk(True, ["api_search", "api_fetch"], "stop")),
        ("know",    mk(False, ["email_search"], "gave_up"), mk(True, ["slack_post"], "stop")),
        ("format",  mk(False, ["api_search"], "stop", malformed=True), mk(True, ["api_search"], "stop")),
        ("both",    mk(True, ["api_fetch"], "stop"), mk(True, ["api_fetch"], "stop")),
        ("regress", mk(True, ["api_fetch"], "stop"), mk(False, ["api_fetch"], "gave_up")),
    ]
    for tid, ra, rb in cases:
        ra = {**ra, "id": tid}; rb = {**rb, "id": tid}
        run_a["tasks"].append(ra); run_b["tasks"].append(rb)
    da = tempfile.mktemp(suffix=".json"); db = tempfile.mktemp(suffix=".json")
    json.dump(run_a, open(da, "w")); json.dump(run_b, open(db, "w"))
    rep = diff(da, db)
    assert rep["matrix"]["reachable_gap"] == 3, rep["matrix"]
    assert rep["matrix"]["regressions"] == 1, rep["matrix"]
    assert rep["gap_classes"].get("persistence/recovery") == 1, rep["gap_classes"]
    assert rep["gap_classes"].get("knowledge") == 1, rep["gap_classes"]
    assert rep["gap_classes"].get("format/parsing") == 1, rep["gap_classes"]
    os.remove(da); os.remove(db)
    print("selftest ok:", rep["gap_classes"], "| rl_shaped:", rep["rl_shaped_hypothesis"])


if __name__ == "__main__":
    if len(sys.argv) == 1:
        _selftest()
    else:
        raise SystemExit(main())
