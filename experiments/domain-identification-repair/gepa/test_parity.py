#!/usr/bin/env python3
"""Regression gate for canonical(rollout.mjs) <-> GEPA ContractAdapter parity.

Runtime glue test (isolated, not an importable package). Run with the optimize
venv:  .understudy/venvs/optimize/bin/python .../gepa/test_parity.py

Proves the malformed-counter semantics and cross-path config parity that the
harness-parity calibration required. No network: the student endpoint and the
env sidecar are faked with scripted turns. No holdout identifiers appear here.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROLLOUT_MJS = HERE.parent / "rollout.mjs"

# Generic leak patterns — NO production identifier is embedded in this file.
# Matches real slice task-id prefixes, any 64-hex hash (split hash shape),
# and holdout config keys.
FORBIDDEN_PATTERNS = [
    r"domain-id-",
    r"\b[0-9a-f]{64}\b",
    r"split\s*=\s*holdout",
    r"holdout_hash",
    r"holdout_sha",
]

sys.path.insert(0, str(HERE))
import optimize  # noqa: E402
from optimize import ContractAdapter  # noqa: E402

# ---- synthetic scripted turns (no real tasks, no holdout ids) -------------
MALFORMED = "let me think... but here is no tool object at all"
VALID = '{"tool": "api_search", "arguments": {"query": "contacts"}}'
FINISH = '{"tool": "finish", "arguments": {}}'
TEST_TASK = {"task_id": "test-synthetic-task-01", "prompt": "synthetic parity prompt"}


class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)


class _Resp:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class FakeLLM:
    """Returns scripted assistant texts; records kwargs it was called with."""
    def __init__(self, texts):
        self._texts = list(texts)
        self.calls = []

    def completion(self, **kwargs):
        self.calls.append(kwargs)
        return _Resp(self._texts.pop(0))


def run_rollout(texts):
    """Drive ContractAdapter.rollout with a faked LLM and faked sidecar."""
    adapter = ContractAdapter("http://fake")
    adapter.litellm = FakeLLM(texts)

    step_n = {"n": 0}

    def fake_call_json(base, path, payload=None):
        if path == "/reset":
            return {"session": "s1"}
        if path == "/step":
            step_n["n"] += 1
            return {"observation": "ok", "done": False, "step": step_n["n"]}
        if path == "/score":
            return {"reward": 0.0, "steps": step_n["n"], "forbidden_effects": 0}
        raise AssertionError(f"unexpected path {path}")

    orig = optimize.call_json
    optimize.call_json = fake_call_json
    try:
        _, trace = adapter.rollout(TEST_TASK, "SYSTEM")
    finally:
        optimize.call_json = orig
    return adapter, trace


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


def test_a_malformed_valid_malformed_does_not_terminate():
    # malformed, valid, malformed, finish  -> total=2, streak=1, ended=finish
    _, t = run_rollout([MALFORMED, VALID, MALFORMED, FINISH])
    check("a: malformed_total == 2", t["malformed_total"] == 2)
    check("a: consecutive_malformed == 1", t["consecutive_malformed"] == 1)
    check("a: did NOT terminate on malformed (ended=finish)", t["ended"] == "finish")
    check("a: reported malformed == total", t["malformed"] == t["malformed_total"])


def test_b_three_consecutive_terminates_on_third():
    _, t = run_rollout([MALFORMED, MALFORMED, MALFORMED])
    check("b: malformed_total == 3", t["malformed_total"] == 3)
    check("b: consecutive_malformed == 3", t["consecutive_malformed"] == 3)
    check("b: ended == malformed", t["ended"] == "malformed")


def test_c_valid_never_resets_total():
    # malformed, valid, malformed, valid, finish -> total stays 2, streak reset
    _, t = run_rollout([MALFORMED, VALID, MALFORMED, VALID, FINISH])
    check("c: malformed_total == 2 despite two resets", t["malformed_total"] == 2)
    check("c: consecutive_malformed == 0 after trailing valid", t["consecutive_malformed"] == 0)


def _rollout_mjs_default(flag):
    src = ROLLOUT_MJS.read_text()
    m = re.search(r'argValue\(\s*"' + re.escape(flag) + r'"\s*,\s*"([^"]+)"\s*\)', src)
    if not m:
        raise AssertionError(f"could not find rollout.mjs default for {flag}")
    return m.group(1)


def test_d_config_parity_defaults():
    adapter = ContractAdapter("http://fake")
    check("d: adapter max_tokens default == 384", adapter.max_tokens == 384)
    check("d: adapter max_turns default == 10", adapter.max_turns == 10)
    check("d: adapter malformed_tolerance default == 3", adapter.malformed_tolerance == 3)
    check("d: adapter temperature default == 0", adapter.temperature == 0)
    # cross-path: canonical rollout.mjs CLI defaults must match the adapter's
    check("d: rollout.mjs --max-tokens == adapter", int(_rollout_mjs_default("--max-tokens")) == adapter.max_tokens)
    check("d: rollout.mjs --max-turns == adapter", int(_rollout_mjs_default("--max-turns")) == adapter.max_turns)
    check("d: rollout.mjs --malformed-tolerance == adapter",
          int(_rollout_mjs_default("--malformed-tolerance")) == adapter.malformed_tolerance)
    check("d: rollout.mjs --temperature == adapter", float(_rollout_mjs_default("--temperature")) == adapter.temperature)


def test_d_config_forwarded_to_endpoint():
    adapter, _ = run_rollout([FINISH])
    call = adapter.litellm.calls[0]
    check("d: max_tokens forwarded to completion", call["max_tokens"] == 384)
    check("d: temperature forwarded to completion", call["temperature"] == 0)


def test_reflection_uses_malformed_total():
    adapter = ContractAdapter("http://fake")
    trace = {"prompt": "p", "messages": [{"role": "assistant", "content": MALFORMED}],
             "malformed": 2, "malformed_total": 2, "consecutive_malformed": 1,
             "ended": "finish", "steps": 3, "score": 0.0}

    class _EB:
        trajectories = [trace]

    ds = adapter.make_reflective_dataset({"system_prompt": "x"}, _EB(), ["system_prompt"])
    fb = ds["system_prompt"][0]["Feedback"]
    check("reflection: feedback cites cumulative malformed_total (2)", "2 time(s)" in fb)


def test_no_holdout_identifiers_in_fixtures():
    # Scan only the scripted FIXTURES for generic forbidden patterns; none may
    # match. (Whole-source scanning would self-match on the pattern literals in
    # FORBIDDEN_PATTERNS above — source cleanliness is proven separately with an
    # external rg receipt, see CALIBRATION-NOTE.md.) No production hash/id is
    # embedded in this file.
    fixture_blob = MALFORMED + VALID + FINISH + repr(TEST_TASK)
    for pat in FORBIDDEN_PATTERNS:
        check(f"guard: fixtures free of /{pat}/", re.search(pat, fixture_blob) is None)
    check("guard: task id is an obvious synthetic sentinel",
          TEST_TASK["task_id"].startswith("test-synthetic-"))


def main():
    tests = [
        test_a_malformed_valid_malformed_does_not_terminate,
        test_b_three_consecutive_terminates_on_third,
        test_c_valid_never_resets_total,
        test_d_config_parity_defaults,
        test_d_config_forwarded_to_endpoint,
        test_reflection_uses_malformed_total,
        test_no_holdout_identifiers_in_fixtures,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} PARITY TESTS PASSED")


if __name__ == "__main__":
    main()
