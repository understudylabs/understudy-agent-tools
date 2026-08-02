#!/usr/bin/env python3
"""Provider-free unit tests for eight-island selection and failure evidence."""
import sys
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
from island_race import ISLAND_SPECS, classify_failure, prompt_sha, unique_ranked  # noqa: E402


def check(label, condition):
    if not condition:
        raise AssertionError(label)


def main():
    check("exactly eight islands", len(ISLAND_SPECS) == 8)
    check("four explore islands", sum(s[1] == "explore" for s in ISLAND_SPECS) == 4)
    check("two failure-targeted islands", sum(s[1] == "failure_targeted" for s in ISLAND_SPECS) == 2)
    check("two exploit islands", sum(s[1] == "exploit" for s in ISLAND_SPECS) == 2)
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
    check("canonical prompt hash normalizes trailing newline", prompt_sha("x") == prompt_sha("x\n"))
    check("429 classified", classify_failure({"detail": "HTTP 429"})[0] == "rate_limit")
    check("timeout classified", classify_failure({"detail": "request timed out"})[0] == "timeout")
    check("fuse classified", classify_failure({"detail": "episode cap"})[0] == "budget_fuse")
    print("ALL 12 ISLAND TESTS PASSED")


if __name__ == "__main__":
    main()
