#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import artifact_sha256, claim_hashes, read_json_object, validate_gate, write_json


REQUIRED_CLAIM_FIELDS = {
    "harness_sha256",
    "metric_sha256",
    "splits_sha256",
    "baseline_sha256",
    "candidate_sha256",
    "holdout_result",
    "sample_size",
    "score_delta",
    "caveats",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate that claim.json is supported by sealed evidence.")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--artifact-root", default=None, help="Artifact root relative to repo; defaults to .understudy/understand-workload.")
    parser.add_argument("--claim", default=".understudy/validate-and-optimize/claim.json")
    parser.add_argument("--candidate", default=".understudy/validate-and-optimize/candidate.json")
    parser.add_argument("--output", default=".understudy/validate-and-optimize/claim-gate.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    claim_path = Path(args.claim).expanduser()
    if not claim_path.is_absolute():
        claim_path = repo / claim_path
    candidate_path = Path(args.candidate).expanduser()
    if not candidate_path.is_absolute():
        candidate_path = repo / candidate_path

    blockers: list[dict[str, object]] = []
    gate = validate_gate(repo, artifact_root=args.artifact_root)
    blockers.extend(gate["blockers"])
    try:
        claim = read_json_object(claim_path)
    except FileNotFoundError:
        claim = {}
        blockers.append({"name": "claim", "path": str(claim_path), "reason": "missing claim.json"})
    except json.JSONDecodeError as exc:
        claim = {}
        blockers.append({"name": "claim", "path": str(claim_path), "reason": f"invalid JSON: {exc.msg}"})
    except ValueError as exc:
        claim = {}
        blockers.append({"name": "claim", "path": str(claim_path), "reason": str(exc)})

    for field in sorted(REQUIRED_CLAIM_FIELDS):
        if claim and field not in claim:
            blockers.append({"name": "claim", "path": str(claim_path), "reason": f"claim.json missing {field}"})

    if claim:
        expected_hashes = claim_hashes(repo, candidate_path, artifact_root=args.artifact_root)
        for field, expected in expected_hashes.items():
            if expected is None:
                blockers.append({"name": "claim", "path": str(candidate_path), "reason": f"missing artifact for {field}"})
                continue
            if claim.get(field) != expected:
                blockers.append(
                    {
                        "name": "claim",
                        "path": str(claim_path),
                        "reason": f"claim.json {field} does not match artifact hash",
                        "expected_sha256": expected,
                        "actual_sha256": claim.get(field),
                    }
                )
        holdout_result = claim.get("holdout_result")
        if not isinstance(holdout_result, dict):
            blockers.append({"name": "claim", "path": str(claim_path), "reason": "claim.json holdout_result must be an object"})
        elif str(holdout_result.get("split") or "").lower() != "holdout":
            blockers.append({"name": "claim", "path": str(claim_path), "reason": "claim.json holdout_result.split must be holdout"})
        if claim.get("proxy_metric") is True:
            blockers.append({"name": "claim", "path": str(claim_path), "reason": "proxy metrics cannot support claim.json"})
        if claim.get("evidence_split") in {"train", "dev"}:
            blockers.append({"name": "claim", "path": str(claim_path), "reason": "train/dev evidence cannot support claim.json"})

    payload = {
        "schema_version": "understudy.claim_gate.v1",
        "status": "blocked" if blockers else "ok",
        "claim_sha256": artifact_sha256(claim_path) if claim_path.exists() else None,
        "blockers": blockers,
    }
    output = Path(args.output).expanduser()
    if not output.is_absolute():
        output = repo / output
    write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"status: {payload['status']}")
        for blocker in blockers:
            print(f"- {blocker['name']}: {blocker['reason']}")
    return 0 if not blockers else 2


if __name__ == "__main__":
    raise SystemExit(main())
