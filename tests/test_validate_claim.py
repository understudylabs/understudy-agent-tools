"""Claim-gate field requirements: a hash-valid but underspecified claim must
not pass."""
from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "validate-and-optimize" / "scripts"
sys.path.insert(0, str(_SCRIPTS))

from validate_claim import REQUIRED_CLAIM_FIELDS, missing_claim_fields  # noqa: E402


def _fully_specified_claim() -> dict:
    return {field: "x" for field in REQUIRED_CLAIM_FIELDS}


def test_required_fields_cover_the_claim_contract():
    # The fields a savings/readiness claim cannot omit.
    for field in (
        "workload_card",
        "latency_basis",
        "cost_basis",
        "pricing_basis",
        "request_volume_assumption",
        "confidence",
        "fallback_route",
        "demotion_trigger",
    ):
        assert field in REQUIRED_CLAIM_FIELDS


def test_complete_claim_has_no_missing_fields():
    assert missing_claim_fields(_fully_specified_claim()) == []


def test_hash_valid_but_underspecified_claim_is_flagged():
    # Hashes + holdout present, but no pricing/volume/fallback context.
    claim = {
        "harness_sha256": "a",
        "metric_sha256": "b",
        "splits_sha256": "c",
        "baseline_sha256": "d",
        "candidate_sha256": "e",
        "holdout_result": {"split": "holdout"},
        "sample_size": 50,
        "score_delta": 0.1,
        "caveats": "small sample",
    }
    missing = missing_claim_fields(claim)
    assert "pricing_basis" in missing
    assert "request_volume_assumption" in missing
    assert "fallback_route" in missing
    assert "demotion_trigger" in missing
