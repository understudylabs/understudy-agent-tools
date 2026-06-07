"""Index loose trajectory JSONs into a queryable provenance index.

Ingests run-JSON files/dirs and/or a Lilac export into a single
`.understudy/curate-trajectories/index.jsonl`, one record per trajectory, with
provenance (model/toolset/domain/seed/source/outcome) + a content hash for dedup
and a corpus hash. Read-only on the source; never prints message bodies or
secrets. Stdlib only. Split is left "unknown" here — select.py tags it from the
frozen splits.json.

Usage:
    python index_trajectories.py <run.json|dir> [more...] --out index.jsonl
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Iterator


# Fields needed to tag splits (by task_id) and dedup. `seed` is recorded when
# present but NOT required — workloads like AutomationBench have no per-row RNG
# seed (the initial_state IS the seed), so requiring it would falsely flag every
# row as incomplete. Contamination safety keys on task_id<->split, not seed.
REQUIRED_PROVENANCE = ("task_id", "model", "toolset", "domain")


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def load_source(path: str) -> Iterator[tuple[dict, str, str]]:
    """Yield (raw_record, source_kind, source_path). Auto-detect run-json vs
    a Lilac export (a list of {item|data|trajectory} wrappers)."""
    p = Path(path)
    files = sorted(p.rglob("*.json")) if p.is_dir() else [p]
    for f in files:
        doc = json.load(open(f))
        if isinstance(doc, dict) and ("tasks" in doc or "results" in doc):
            rows = doc.get("tasks") or doc.get("results") or []
            meta = doc.get("meta", {})
            for r in rows:
                yield {**meta_defaults(meta), **r}, "run-json", str(f)
        elif isinstance(doc, list):
            for r in doc:
                rec = r.get("item") or r.get("data") or r.get("trajectory") or r
                yield rec, "lilac-export", str(f)
        else:
            yield doc, "run-json", str(f)


def meta_defaults(meta: dict) -> dict:
    """Run-level meta (model/toolset/domains) backfills per-row provenance."""
    out = {}
    if "model" in meta:
        out["model"] = os.path.basename(str(meta["model"]).rstrip("/"))
    if "toolset" in meta:
        out["toolset"] = meta["toolset"]
    doms = meta.get("domains") or meta.get("domain")
    if doms:
        out["domain"] = doms[0] if isinstance(doms, list) and len(doms) == 1 else doms
    if "timestamp" in meta:
        out["timestamp"] = meta["timestamp"]
    return out


def _outcome(raw: dict) -> str:
    if raw.get("passed") is True:
        return "pass"
    fr = " ".join(str(x) for x in (raw.get("finish_reasons") or [])).lower()
    if "error" in fr or "exception" in fr:
        return "error"
    if raw.get("passed") is False:
        return "fail"
    return "unknown"


def to_index_record(raw: dict, source_run_id: str, source_kind: str, source_path: str) -> dict:
    # Real AutomationBench exports carry the stable id in `name`; `id` is a
    # 1-based enumeration index. Prefer name so split tagging matches splits.json.
    task_id = str(raw.get("name") or raw.get("task_id") or raw.get("id", ""))
    model = os.path.basename(str(raw.get("model", "")).rstrip("/")) or None
    content = _sha(canonical({
        "messages": raw.get("messages"), "end_state": raw.get("end_state"),
        "assertion_results": raw.get("assertion_results"),
    }))
    rec = {
        "task_id": task_id,
        "name": raw.get("name"),
        "model": model,
        "toolset": raw.get("toolset"),
        "domain": raw.get("domain"),
        "seed": raw.get("seed"),
        "split": "unknown",
        "source_run_id": source_run_id,
        "source_kind": source_kind,
        "source_path": source_path,
        "timestamp": raw.get("timestamp"),
        "outcome": _outcome(raw),
        "score": raw.get("score"),
        "steps": raw.get("steps"),
        "content_sha256": content,
        "input_tokens": raw.get("input_tokens"),
        "output_tokens": raw.get("output_tokens"),
        "cost": raw.get("cost"),
    }
    rec["row_uid"] = _sha("|".join(str(rec[k]) for k in
                          ("task_id", "model", "toolset", "domain", "seed", "source_run_id")))[:16]
    rec["provenance_complete"] = all(
        (rec[k] if k != "task_id" else rec["task_id"]) not in (None, "") for k in REQUIRED_PROVENANCE
    )
    return rec


def build_index(sources: list[str], out_path: str) -> dict:
    records, incomplete = [], []
    for src in sources:
        run_id = _sha(src)[:12]
        for raw, kind, path in load_source(src):
            rec = to_index_record(raw, run_id, kind, path)
            records.append(rec)
            if not rec["provenance_complete"]:
                incomplete.append(rec["row_uid"])
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    corpus = _sha("|".join(sorted(r["row_uid"] + r["content_sha256"] for r in records)))
    by_source = {}
    by_outcome = {}
    for r in records:
        by_source[r["source_kind"]] = by_source.get(r["source_kind"], 0) + 1
        by_outcome[r["outcome"]] = by_outcome.get(r["outcome"], 0) + 1
    return {"corpus_sha256": corpus, "n_rows": len(records), "out": out_path,
            "by_source": by_source, "by_outcome": by_outcome,
            "incomplete_provenance": incomplete}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("--out", default=".understudy/curate-trajectories/index.jsonl")
    args = ap.parse_args(argv)
    summary = build_index(args.sources, args.out)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
