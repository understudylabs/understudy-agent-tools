#!/usr/bin/env python3
"""Out-of-process gepa-viz publisher for the domain-identification GEPA arm.

Reads a *checkpoint-complete* GEPA state (gepa_state.bin) read-only, converts it
to the gepa-viz run.json schema ({"examples": [...], "candidates": {...}}),
writes it atomically to a local path, and best-effort POSTs it to a running
`gepa-viz live` server's /ingest. It never mutates optimizer state and never
touches the running optimizer process.

Truthfulness contract:
- If the checkpoint cannot be loaded as a complete state, publish a valid EMPTY
  snapshot (examples known up front, candidates = {}) rather than fabricating.
- Candidates and their scores are taken verbatim from the checkpoint; nothing is
  invented before the checkpoint contains it.
- Only train/dev (tunable/transfer) data is serialized. Holdout is never read.

Isolated runtime glue only (run via .understudy venv); not an importable module.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# The sealed-holdout digest is NEVER hardcoded here. Split provenance is injected
# at runtime from a private manifest/env so the committed code carries no
# production digest yet still fails closed:
#   DI_EXPECTED_DEV_SHA256 / DI_EXPECTED_TRAIN_SHA256 -> the digest a publishable
#     snapshot's declared split provenance MUST equal (mismatch => refuse).
#   DI_FORBIDDEN_SPLIT_SHAS (comma-separated) -> sealed/holdout digests that must
#     never appear anywhere in a snapshot (presence => refuse). Never logged.
ENV_EXPECTED = {"train": "DI_EXPECTED_TRAIN_SHA256", "dev": "DI_EXPECTED_DEV_SHA256"}
ENV_FORBIDDEN = "DI_FORBIDDEN_SPLIT_SHAS"


def expected_split_shas() -> dict[str, str]:
    """Configured expected train/dev split digests (empty if unset)."""
    out: dict[str, str] = {}
    for split, var in ENV_EXPECTED.items():
        value = os.environ.get(var, "").strip()
        if value:
            out[split] = value
    return out


def forbidden_split_shas() -> set[str]:
    """Private sealed/holdout digests to refuse; injected at runtime, never logged."""
    return {s.strip() for s in os.environ.get(ENV_FORBIDDEN, "").split(",") if s.strip()}


def fetch_dev_examples(sidecar: str, dev_limit: int) -> tuple[list[dict[str, Any]], str]:
    """Dev valset examples (DataId order) and the dev split_sha256 provenance."""
    req = urllib.request.Request(f"{sidecar}/pool?split=dev")
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.loads(r.read())
    tasks = payload.get("tasks", [])[:dev_limit]
    # task dicts are synthetic (task_id, prompt, band); safe to serialize as-is.
    return [dict(t) for t in tasks], str(payload.get("split_sha256", ""))


def flatten_prompt(candidate_text: dict[str, str]) -> str:
    if not candidate_text:
        return ""
    if len(candidate_text) == 1:
        return next(iter(candidate_text.values()))
    return "\n\n".join(f"# component: {k}\n{v}" for k, v in candidate_text.items())


def load_output_for(logs: Path, val_id: int, prog_idx: int) -> Any:
    """Latest generated rollout output for (val_id, candidate) if present."""
    pat = str(logs / "generated_best_outputs_valset" / f"task_{val_id}" / f"iter_*_prog_{prog_idx}.json")
    files = sorted(glob.glob(pat), key=lambda p: (len(p), p))
    if not files:
        return {}
    try:
        trace = json.loads(Path(files[-1]).read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    msgs = trace.get("messages") or []
    last_assistant = ""
    for m in reversed(msgs):
        if m.get("role") == "assistant":
            last_assistant = m.get("content", "")
            break
    return {
        "assistant_message": last_assistant,
        "malformed": trace.get("malformed"),
        "steps": trace.get("steps"),
    }


def build_candidates(state, logs: Path, n_examples: int) -> dict[str, dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    n = len(state.program_candidates)
    for i in range(n):
        subs = dict(state.prog_candidate_val_subscores[i]) if i < len(state.prog_candidate_val_subscores) else {}
        parent = None
        try:
            parents = state.parent_program_for_candidate[i]
            if parents and parents[0] is not None:
                parent = str(parents[0])
        except (IndexError, TypeError):
            parent = None
        predictions = None
        score = None
        if subs:
            predictions = []
            for k in range(n_examples):
                predictions.append({
                    "prediction": load_output_for(logs, k, i),
                    "score": float(subs.get(k, 0.0)),
                })
            score = sum(p["score"] for p in predictions) / n_examples if n_examples else 0.0
        candidates[str(i)] = {
            "prompt": flatten_prompt(state.program_candidates[i]),
            "parent": parent,
            "score": score,
            "predictions": predictions,
            "minibatch": None,
        }
    return candidates


def build_snapshot(logs: Path, examples: list[dict[str, Any]], dev_sha: str = "") -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "examples": examples,
        "candidates": {},
        "split": "dev",
        "split_provenance": {"dev": dev_sha} if dev_sha else {},
    }
    try:
        from gepa.core.state import GEPAState
        state = GEPAState.load(str(logs))  # asserts validate completeness
    except Exception as e:  # incomplete/mid-write checkpoint -> truthful empty
        print(f"[publish] checkpoint not loadable yet ({type(e).__name__}: {str(e)[:120]}); empty candidates")
        return snapshot
    snapshot["candidates"] = build_candidates(state, logs, len(examples))
    return snapshot


def assert_publishable(snapshot: dict[str, Any], *, require_provenance: bool = True) -> None:
    """Fail closed before publishing. Never logs or serializes any digest value.

    (1) refuse anything labeled holdout;
    (2) refuse if any runtime-injected forbidden (sealed) digest appears anywhere;
    (3) when expected train/dev digests are configured, the snapshot's declared
        split provenance must match them exactly;
    (4) if provenance is required but missing, refuse.
    """
    if str(snapshot.get("split", "")).lower() == "holdout" or snapshot.get("holdout") is True:
        raise SystemExit("refusing to publish: snapshot is labeled holdout")
    blob = json.dumps(snapshot)
    for sha in forbidden_split_shas():
        if sha and sha in blob:
            # Deliberately does not echo the digest.
            raise SystemExit("refusing to publish: a forbidden (sealed) split digest is present in the snapshot")
    declared = snapshot.get("split_provenance") or {}
    expected = expected_split_shas()
    if expected:
        for split, want in expected.items():
            got = declared.get(split)
            if got is None:
                raise SystemExit(f"refusing to publish: missing {split} split provenance")
            if got != want:
                raise SystemExit(f"refusing to publish: {split} split digest does not match expected provenance")
    elif require_provenance and not declared:
        raise SystemExit("refusing to publish: split provenance is required but missing")


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def post_ingest(endpoint: str, snapshot: dict[str, Any], timeout: float) -> str:
    url = endpoint.rstrip("/") + "/ingest"
    data = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return f"POST {url} -> {r.status}"
    except (urllib.error.URLError, OSError) as e:
        return f"POST {url} FAILED: {e}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default=str(Path(__file__).resolve().parent / "logs"))
    ap.add_argument("--sidecar", default="http://127.0.0.1:8787")
    ap.add_argument("--dev-limit", type=int, default=8)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "run.json"))
    ap.add_argument("--endpoint", default="http://127.0.0.1:5151")
    ap.add_argument("--endpoint-timeout", type=float, default=5.0)
    ap.add_argument("--no-post", action="store_true")
    ap.add_argument("--watch", action="store_true", help="poll the checkpoint and republish on change")
    ap.add_argument("--interval", type=float, default=15.0)
    args = ap.parse_args()

    logs = Path(args.logs)
    examples, dev_sha = fetch_dev_examples(args.sidecar, args.dev_limit)

    def once() -> str:
        snapshot = build_snapshot(logs, examples, dev_sha)
        assert_publishable(snapshot)
        atomic_write_json(Path(args.out), snapshot)
        scored = {k: v["score"] for k, v in snapshot["candidates"].items() if v["score"] is not None}
        line = json.dumps({"candidates": len(snapshot["candidates"]), "candidate_scores": scored})
        if not args.no_post:
            line += " | " + post_ingest(args.endpoint, snapshot, args.endpoint_timeout)
        # fingerprint to skip redundant work in watch mode
        return line, json.dumps(snapshot["candidates"], sort_keys=True)

    if not args.watch:
        line, _ = once()
        print(f"wrote {args.out} examples={len(examples)} {line}")
        return

    import time as _t
    last = None
    print(f"[watch] every {args.interval}s -> {args.endpoint}/ingest and {args.out}")
    while True:
        try:
            line, fp = once()
            if fp != last:
                print(_t.strftime("%H:%M:%S"), line, flush=True)
                last = fp
        except SystemExit:
            raise
        except Exception as e:  # never die on a transient read/POST error
            print("[watch] error:", type(e).__name__, str(e)[:120], flush=True)
        _t.sleep(args.interval)


if __name__ == "__main__":
    main()
