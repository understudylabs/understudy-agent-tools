from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


UNDERSTAND_ARTIFACT_DIR = Path(".understudy/understand-workload")
VALIDATE_ARTIFACT_DIR = Path(".understudy/validate-and-optimize")

REQUIRED_BASELINE_ARTIFACTS = {
    "harness": "harness.json",
    "metric": "metric.json",
    "splits": "splits.json",
    "baseline": "baseline.json",
}

REQUIRED_BASELINE_HASH_KEYS = {
    "harness": "harness_sha256",
    "metric": "metric_sha256",
    "splits": "splits_sha256",
}


def canonical_json_sha256(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def artifact_sha256(path: Path) -> str:
    return canonical_json_sha256(json.loads(path.read_text(encoding="utf-8")))


def default_understand_artifact_paths() -> dict[str, str]:
    return {
        name: str(UNDERSTAND_ARTIFACT_DIR / filename)
        for name, filename in REQUIRED_BASELINE_ARTIFACTS.items()
    }


def baseline_expected_hashes(
    loaded: dict[str, dict[str, Any]],
) -> dict[str, str]:
    baseline = loaded.get("baseline", {})
    return {
        name: str(baseline.get(hash_key) or "")
        for name, hash_key in REQUIRED_BASELINE_HASH_KEYS.items()
    }


def build_artifact_contract(
    *,
    paths: dict[str, str],
    loaded: dict[str, dict[str, Any]],
    checks: list[dict[str, object]],
) -> dict[str, object]:
    hashes = {
        name: canonical_json_sha256(payload)
        for name, payload in sorted(loaded.items())
    }
    return {
        "schema_version": "understudy.artifact_contract.v1",
        "artifacts": {
            name: {
                "path": paths[name],
                "sha256": hashes.get(name),
                "schema_version": loaded.get(name, {}).get("schema_version"),
            }
            for name in sorted(paths)
        },
        "baseline_expected_hashes": baseline_expected_hashes(loaded),
        "checks": checks,
    }


def stale_hash_blockers(
    *,
    loaded: dict[str, dict[str, Any]],
) -> list[dict[str, object]]:
    blockers: list[dict[str, object]] = []
    actual = {
        name: canonical_json_sha256(payload)
        for name, payload in loaded.items()
        if name in REQUIRED_BASELINE_HASH_KEYS
    }
    for name, expected in baseline_expected_hashes(loaded).items():
        if not expected:
            blockers.append(
                {
                    "name": name,
                    "reason": f"baseline missing {REQUIRED_BASELINE_HASH_KEYS[name]}",
                }
            )
            continue
        if actual.get(name) != expected:
            blockers.append(
                {
                    "name": name,
                    "reason": "baseline hash does not match current artifact",
                    "expected_sha256": expected,
                    "actual_sha256": actual.get(name),
                }
            )
    return blockers
