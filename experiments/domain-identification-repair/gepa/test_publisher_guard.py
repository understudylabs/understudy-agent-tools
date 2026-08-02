#!/usr/bin/env python3
"""Provider-free fail-closed tests for the gepa-viz publisher guard.

Runs with plain system python3 (no gepa/dspy/network):
    python3 experiments/domain-identification-repair/gepa/test_publisher_guard.py

Proves assert_publishable stays fail-closed with runtime-injected split identity
and never echoes a digest. Uses a synthetic sentinel digest, never a production
value.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish_snapshot as pub  # noqa: E402

# Synthetic 64-hex sentinels — NOT production digests.
DEV_SHA = "d" * 64
TRAIN_SHA = "a" * 64
SEALED_SHA = "f" * 64  # stands in for a forbidden/holdout digest


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


def clear_env():
    for var in (*pub.ENV_EXPECTED.values(), pub.ENV_FORBIDDEN):
        os.environ.pop(var, None)


def expect_exit(fn):
    try:
        fn()
    except SystemExit as e:
        return str(e)
    raise AssertionError("expected SystemExit, none raised")


def test_allows_matching_dev_snapshot():
    clear_env()
    os.environ[pub.ENV_EXPECTED["dev"]] = DEV_SHA
    snap = {"split": "dev", "split_provenance": {"dev": DEV_SHA}, "examples": [], "candidates": {}}
    pub.assert_publishable(snap)  # must not raise
    check("allowed: dev snapshot with matching expected provenance", True)


def test_rejects_holdout_label():
    clear_env()
    msg = expect_exit(lambda: pub.assert_publishable({"split": "holdout", "split_provenance": {"dev": DEV_SHA}}))
    check("rejected: snapshot labeled holdout", "holdout" in msg)
    msg2 = expect_exit(lambda: pub.assert_publishable({"holdout": True, "split_provenance": {"dev": DEV_SHA}}))
    check("rejected: snapshot flagged holdout=true", "holdout" in msg2)


def test_rejects_missing_required_provenance():
    clear_env()
    msg = expect_exit(lambda: pub.assert_publishable({"split": "dev", "candidates": {}}, require_provenance=True))
    check("rejected: required provenance missing", "provenance" in msg)


def test_rejects_digest_mismatch():
    clear_env()
    os.environ[pub.ENV_EXPECTED["dev"]] = DEV_SHA
    snap = {"split": "dev", "split_provenance": {"dev": "0" * 64}, "candidates": {}}
    msg = expect_exit(lambda: pub.assert_publishable(snap))
    check("rejected: dev digest mismatch", "does not match" in msg)


def test_rejects_forbidden_digest_and_never_echoes_it():
    clear_env()
    os.environ[pub.ENV_FORBIDDEN] = SEALED_SHA
    os.environ[pub.ENV_EXPECTED["dev"]] = DEV_SHA
    # sealed digest smuggled into a candidate prompt
    snap = {"split": "dev", "split_provenance": {"dev": DEV_SHA},
            "candidates": {"0": {"prompt": f"leak {SEALED_SHA}"}}}
    msg = expect_exit(lambda: pub.assert_publishable(snap))
    check("rejected: forbidden (sealed) digest present", "forbidden" in msg or "sealed" in msg)
    check("no-echo: error message does not contain the sealed digest", SEALED_SHA not in msg)


def test_forbidden_and_expected_helpers_read_runtime_env_only():
    clear_env()
    check("helpers empty when env unset (no hardcoded digest)",
          pub.expected_split_shas() == {} and pub.forbidden_split_shas() == set())
    os.environ[pub.ENV_FORBIDDEN] = f"{SEALED_SHA}, {TRAIN_SHA}"
    check("forbidden parses comma list", pub.forbidden_split_shas() == {SEALED_SHA, TRAIN_SHA})


def main():
    tests = [
        test_allows_matching_dev_snapshot,
        test_rejects_holdout_label,
        test_rejects_missing_required_provenance,
        test_rejects_digest_mismatch,
        test_rejects_forbidden_digest_and_never_echoes_it,
        test_forbidden_and_expected_helpers_read_runtime_env_only,
    ]
    for t in tests:
        print(t.__name__)
        t()
    clear_env()
    print(f"\nALL {len(tests)} PUBLISHER-GUARD TESTS PASSED")


if __name__ == "__main__":
    main()
