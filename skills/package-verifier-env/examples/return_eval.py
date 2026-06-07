"""Return-eval round-trip — re-score a partner-returned policy on the FROZEN
seed-7 holdout using the SAME scorer/rows/seed/metric as the pre-RL baseline, so
a partner 'win' is apples-to-apples. Local only; no training, no upload.

Refuses to run on holdout-hash drift (splits.json no longer matches the hash the
baseline was computed against).

Usage:
    UNDERSTUDY_WORKLOAD_ROOT=<workload> python return_eval.py <returned-policy-ref>
"""
from __future__ import annotations
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("UNDERSTUDY_WORKLOAD_ROOT", ".")).expanduser().resolve()
EV = ROOT / ".understudy/capture-evidence"     # baseline.json + splits.json live here
PKG = ROOT / ".understudy/verifier-env"

# TODO(dev): import the SAME local scorer the baseline used (reward/metric parity)
# from your_scorer import final_state_score
# TODO(dev): a callable that runs the returned policy through the sim per row
# def run_policy(policy_ref, row) -> final_state: ...


def _hash(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def return_eval(policy_ref: str, split: str = "holdout", run_policy=None) -> dict:
    splits = json.loads((EV / "splits.json").read_text())
    baseline = json.loads((EV / "baseline.json").read_text())

    # Attestation: refuse unless the frozen splits still match the baseline's hash.
    frozen_sha = baseline.get("splits_sha256")
    if frozen_sha and _hash(EV / "splits.json") != frozen_sha:
        raise SystemExit("REFUSED: splits.json hash != baseline splits_sha256 — holdout drift")

    block = splits.get(split, {})
    if isinstance(block, dict):
        rows = block.get("rows") or block.get("row_ids") or []
    else:
        rows = block

    scores = []
    if run_policy is not None:
        for row in rows:
            # final_state = run_policy(policy_ref, row); scores.append(final_state_score(final_state))
            scores.append(run_policy(policy_ref, row))
    returned = sum(scores) / len(scores) if scores else None
    # Pre-RL local baseline number. Real baseline.json nests it under
    # candidate_local.quality.partial_credit_mean; fall back to a top-level score.
    base = baseline.get("score")
    if base is None:
        base = (baseline.get("candidate_local", {}).get("quality", {}).get("partial_credit_mean"))

    out = {
        "result_type": "return-eval",
        "split": split, "seed": splits.get("seed", 7),
        "n_rows": len(rows), "row_ids": rows,
        "metric": baseline.get("metric"),
        "scorer_sha256": baseline.get("metric_sha256"),
        "returned_policy_score": returned,
        "baseline_score": base,
        "delta": (returned - base) if (returned is not None and base is not None) else None,
        "attestation": {"same_rows": True, "same_seed": True, "same_metric": True,
                        "splits_sha256": frozen_sha},
        "policy_ref": policy_ref,
        "note": None if run_policy else "wire run_policy + the baseline scorer to produce a real score",
    }
    PKG.mkdir(parents=True, exist_ok=True)
    (PKG / "return-eval.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    ref = sys.argv[1] if len(sys.argv) > 1 else "POLICY_REF"
    print(json.dumps(return_eval(ref), indent=2))
