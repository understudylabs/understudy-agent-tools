#!/usr/bin/env python3
"""run_eval.py -- CLI for the Larkfield HARD env.

Plain Python 3 (3.9+), standard library only. No network, no model calls.
P0 is replay-only; live model wiring is deferred to P1.

Usage:
  python3 run_eval.py --selftest
      Run oracle + sentinels for every HARD task. Exit != 0 if any gate fails.
      (This is the one-command acceptance gate for the ENV builder.)

  python3 run_eval.py --oracle <task_id>
      Gate #1: assert the scripted oracle scores strict == 1.0 AND dense == 1.0.

  python3 run_eval.py --sentinels <task_id>
      Gate #3: assert every sentinel scores at/below its ceiling (noop -> 0/0).

  python3 run_eval.py --task <task_id> --trajectory <path.jsonl>
      Score a recorded trajectory file (one {"tool","args"} JSON object/line,
      OR a single JSON array). Prints strict & dense + a plain breakdown.

  python3 run_eval.py --validate-all
      Run gates 1+2+3+4 for every task. Exit != 0 on any failure.

  python3 run_eval.py --classify-failure --task <id> --trajectory <path>
      Gate #4: label a failing trajectory parse_failure vs action_failure.

  python3 run_eval.py --list
      List known tasks.
"""

import argparse
import json
import sys

import world as W
import oracle as O
import sentinels as S


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
def _fmt_score(strict, dense):
    return "strict=%.2f  dense=%.2f" % (strict, dense)


def _print_breakdown(breakdown, indent="    "):
    for r in breakdown:
        mark = "PASS" if r["pass"] else "FAIL"
        neg = " (negative)" if r.get("negative") else ""
        print("%s[%s] %s%s" % (indent, mark, r["label"], neg))
        print("%s       expected: %s" % (indent, r["expected"]))
        print("%s       actual:   %s" % (indent, r["actual"]))
        if r.get("plain"):
            print("%s       why:      %s" % (indent, r["plain"]))


# ---------------------------------------------------------------------------
# Trajectory loading (for --task / --classify-failure)
# ---------------------------------------------------------------------------
def load_trajectory(path):
    """Accept either a JSON array file or one JSON object per line."""
    with open(path, "r") as fh:
        text = fh.read().strip()
    if not text:
        return []
    if text[0] == "[":
        return json.loads(text)
    steps = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            steps.append(json.loads(line))
    return steps


# ---------------------------------------------------------------------------
# Gate #1 -- oracle
# ---------------------------------------------------------------------------
def run_oracle(task, verbose=True):
    traj = O.oracle_trajectory(task["task_id"])
    if traj is None:
        return {"ok": False, "reason": "no oracle for %s" % task["task_id"]}
    res = W.evaluate_trajectory(task, traj)
    ok = (res["strict"] == 1.0 and res["dense"] == 1.0)
    if verbose:
        print("ORACLE %s: %s  -> %s" %
              (task["task_id"], _fmt_score(res["strict"], res["dense"]),
               "OK" if ok else "FAIL (want strict=1.0 dense=1.0)"))
        if not ok:
            _print_breakdown(res["breakdown"])
    return {"ok": ok, "strict": res["strict"], "dense": res["dense"],
            "breakdown": res["breakdown"]}


# ---------------------------------------------------------------------------
# Gate #3 -- sentinels
# ---------------------------------------------------------------------------
def run_sentinels(task, verbose=True):
    trajs = S.sentinel_trajectories(task["task_id"])
    if not trajs:
        return {"ok": False, "reason": "no sentinels for %s" % task["task_id"]}
    all_ok = True
    details = {}
    for name, traj in sorted(trajs.items()):
        res = W.evaluate_trajectory(task, traj)
        contract = S.SENTINEL_CONTRACT.get(name, {"max_strict": 0.0, "max_dense": 1.0})
        ok = (res["strict"] <= contract["max_strict"] + 1e-9 and
              res["dense"] <= contract["max_dense"] + 1e-9)
        all_ok = all_ok and ok
        details[name] = {"strict": res["strict"], "dense": res["dense"], "ok": ok}
        if verbose:
            ceil = "strict<=%.2f dense<=%.2f" % (contract["max_strict"], contract["max_dense"])
            print("SENTINEL %s/%s: %s  (ceiling %s) -> %s" %
                  (task["task_id"], name,
                   _fmt_score(res["strict"], res["dense"]), ceil,
                   "OK" if ok else "FAIL"))
    return {"ok": all_ok, "details": details}


# ---------------------------------------------------------------------------
# Gate #4 -- parse_failure vs action_failure classifier
# ---------------------------------------------------------------------------
def classify_failure(task, trajectory):
    """Decide whether a 0-strict trajectory failed because of a malformed
    tool-call the harness could not parse (parse_failure -- an artifact that
    must be fixed before claiming "the model breaks") vs a well-formed but
    wrong sequence of actions (action_failure -- a genuine capability break).

    Heuristic, mirroring the spirit of the design-simulated-environment gate:
      * If every step named a KNOWN tool AND its args were a dict the tool
        accepted shape-wise (no "must be an object" / "Unknown tool" /
        "Bad arguments" errors), then any miss is an ACTION failure -- the
        model called real tools, just did the wrong thing (e.g. empty-field
        update under strict mode, wrong recipient, stale number).
      * If some step could not be dispatched as a tool call at all
        (unknown tool name, non-dict args, arg-shape TypeError), it is a
        PARSE failure -- a harness/format artifact, NOT yet evidence the
        model lacks the capability.

    Note: the canonical small-model break in this prototype --
    crm_update_subscription({"id": "S-NOVA1"}) with no fields -> the strict-mode
    "No fields to update" error -> never recovers -> emails csm@ -- is an
    ACTION failure: the tool name and arg shape are valid; the model simply
    issued a write the policy refuses and then took a forbidden action. A
    "small model breaks" claim is only allowed to ship on action_failure.
    """
    state, log, _ = W.run_trajectory(task, trajectory)
    parse_signals = []
    for entry in log:
        result = entry.get("result", {})
        err = result.get("error", "") if isinstance(result, dict) else ""
        if not err:
            continue
        if ("Unknown tool" in err or
                "args must be an object" in err or
                "Bad arguments for" in err):
            parse_signals.append({"tool": entry.get("tool"), "error": err})
    label = "parse_failure" if parse_signals else "action_failure"
    return {"label": label, "parse_signals": parse_signals}


# ---------------------------------------------------------------------------
# Gate #2 -- strict-vs-dense sanity (logged every row; warn if strict 0 / dense high)
# ---------------------------------------------------------------------------
def strict_dense_note(strict, dense):
    if strict == 0.0 and dense >= 0.5:
        return "WARN: strict=0 while dense=%.2f -- a near-miss; surface BOTH numbers, never a bare 0-pass." % dense
    return ""


# ---------------------------------------------------------------------------
# --validate-all (gates 1+2+3+4 for every task)
# ---------------------------------------------------------------------------
def validate_all(tasks):
    failures = []
    summary_lines = []
    for task_id in sorted(tasks.keys()):
        task = tasks[task_id]

        # gate 1: oracle
        orc = run_oracle(task, verbose=False)
        oracle_ok = orc["ok"]
        if not oracle_ok:
            failures.append("%s: oracle not strict=1.0/dense=1.0 (%s)" %
                            (task_id, _fmt_score(orc.get("strict", -1), orc.get("dense", -1))))

        # gate 2: strict-vs-dense logged (note any near-miss on the oracle row)
        note = strict_dense_note(orc.get("strict", 0.0), orc.get("dense", 0.0))

        # gate 3: sentinels
        sen = run_sentinels(task, verbose=False)
        sentinels_ok = sen["ok"]
        if not sentinels_ok:
            for name, d in sen.get("details", {}).items():
                if not d["ok"]:
                    failures.append("%s: sentinel '%s' not rejected (%s)" %
                                    (task_id, name, _fmt_score(d["strict"], d["dense"])))

        # gate 4: classify the canonical small-model break (the shotgun-ish
        # break we replay in the viewer). We classify the 'shotgun' sentinel,
        # which mirrors the real small-model failure (right intent, forbidden
        # action). It MUST be an action_failure for the "breaks" claim to ship.
        shot = S.sentinel_trajectories(task_id).get("shotgun")
        failure_class = classify_failure(task, shot)["label"] if shot else "n/a"
        if shot and failure_class != "action_failure":
            failures.append("%s: shotgun break classified %s, expected action_failure" %
                            (task_id, failure_class))

        row = {
            "task": task_id,
            "oracle_ok": oracle_ok,
            "strict": orc.get("strict"),
            "dense": orc.get("dense"),
            "sentinels_ok": sentinels_ok,
            "failure_class": failure_class,
        }
        print(json.dumps(row))
        if note:
            print("  %s" % note)
        summary_lines.append("%-32s oracle=%s sentinels=%s failure_class=%s" %
                             (task_id, "OK" if oracle_ok else "FAIL",
                              "OK" if sentinels_ok else "FAIL", failure_class))

    print("\n--- summary ---")
    for line in summary_lines:
        print(line)
    if failures:
        print("\nFAILURES (%d):" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("\nALL GATES PASS (%d tasks): oracle=1.0 strict/dense, sentinels rejected, "
          "breaks classified action_failure, strict+dense logged." % len(tasks))
    return 0


# ---------------------------------------------------------------------------
# --selftest (oracle + sentinels for every task; the env builder's done-gate)
# ---------------------------------------------------------------------------
def selftest(tasks):
    print("=== Larkfield ENV selftest (seed=%d temp=%.1f judge=%s strict_mode=%s) ===" %
          (W.SEED, W.TEMPERATURE, W.JUDGE_MODEL, W.STRICT_MODE))
    return validate_all(tasks)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main(argv=None):
    p = argparse.ArgumentParser(description="Larkfield HARD env evaluator (replay-only, stdlib-only).")
    p.add_argument("--selftest", action="store_true",
                   help="run oracle+sentinels for every task; nonzero exit on gate fail")
    p.add_argument("--validate-all", action="store_true",
                   help="run gates 1+2+3+4 for every task; nonzero exit on fail")
    p.add_argument("--oracle", metavar="TASK_ID", help="gate #1: assert oracle strict=dense=1.0")
    p.add_argument("--sentinels", metavar="TASK_ID", help="gate #3: assert sentinels rejected")
    p.add_argument("--task", metavar="TASK_ID", help="task id for --trajectory / --classify-failure")
    p.add_argument("--trajectory", metavar="PATH", help="score a recorded trajectory file")
    p.add_argument("--classify-failure", action="store_true",
                   help="gate #4: label a failing trajectory parse_failure vs action_failure")
    p.add_argument("--list", action="store_true", help="list known tasks")
    args = p.parse_args(argv)

    tasks = W.load_tasks()

    if args.list:
        for tid in sorted(tasks.keys()):
            print(tid)
        return 0

    if args.selftest:
        return selftest(tasks)

    if args.validate_all:
        return validate_all(tasks)

    if args.oracle:
        task = tasks.get(args.oracle)
        if not task:
            print("Unknown task '%s'." % args.oracle); return 2
        res = run_oracle(task, verbose=True)
        return 0 if res["ok"] else 1

    if args.sentinels:
        task = tasks.get(args.sentinels)
        if not task:
            print("Unknown task '%s'." % args.sentinels); return 2
        res = run_sentinels(task, verbose=True)
        return 0 if res["ok"] else 1

    if args.trajectory:
        if not args.task:
            print("--trajectory requires --task <task_id>."); return 2
        task = tasks.get(args.task)
        if not task:
            print("Unknown task '%s'." % args.task); return 2
        traj = load_trajectory(args.trajectory)
        if args.classify_failure:
            out = classify_failure(task, traj)
            print(json.dumps(out, indent=2))
            return 0
        res = W.evaluate_trajectory(task, traj)
        print("TASK %s: %s  -> %s" %
              (args.task, _fmt_score(res["strict"], res["dense"]),
               "PASS" if res["pass"] else "FAIL"))
        note = strict_dense_note(res["strict"], res["dense"])
        if note:
            print("  %s" % note)
        _print_breakdown(res["breakdown"])
        # also emit the failure class for convenience
        cls = classify_failure(task, traj)["label"]
        print("  failure_class: %s" % cls)
        return 0 if res["pass"] else 1

    if args.classify_failure:
        print("--classify-failure requires --task and --trajectory."); return 2

    p.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
