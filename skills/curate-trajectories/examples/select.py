"""Resolve a provenance filter into a hash-stamped, contamination-checked selection.

Reads the index.jsonl from index_trajectories.py, tags each row's split from the
FROZEN capture-evidence splits.json (never re-derives), applies a safe field-only
filter, runs the contamination check, and emits a decontaminated downstream pool
manifest. Guarded selections (train/RL/distill) HARD-BLOCK on any dev/holdout
leak unless explicitly overridden (and the override is logged).

Exits non-zero on a blocked guarded selection so an agent/CI caller must stop.
Stdlib only.

Usage:
    python select.py --index index.jsonl --splits splits.json \
        --name rl-train-safe --expr "toolset == 'api' and split == 'train'" \
        [--guarded] [--allow-holdout --reason "..." --user you] [--out-dir DIR]
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
from pathlib import Path

ALLOWED_FIELDS = {"model", "toolset", "domain", "seed", "outcome", "split", "score", "name"}


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def load_index(path: str) -> list[dict]:
    return [json.loads(line) for line in open(path) if line.strip()]


def _split_ids(splits: dict, name: str) -> set[str]:
    # capture-evidence's splits.json stores the frozen task ids under `rows`
    # (real schema) or `row_ids`; accept either, or a bare list.
    block = splits.get(name, {})
    if isinstance(block, dict):
        ids = block.get("rows") or block.get("row_ids") or []
    else:
        ids = block
    return {str(x) for x in ids}


def tag_splits(records: list[dict], splits_path: str) -> tuple[dict, str]:
    splits = json.load(open(splits_path))
    splits_sha = splits.get("splits_sha256") or _sha(json.dumps(splits, sort_keys=True))
    members = {s: _split_ids(splits, s) for s in ("train", "dev", "holdout")}
    counts = {"train": 0, "dev": 0, "holdout": 0, "none": 0}
    for r in records:
        tid = str(r["task_id"])
        r["split"] = next((s for s in ("train", "dev", "holdout") if tid in members[s]), "none")
        counts[r["split"]] += 1
    return {"splits_sha256": splits_sha, "counts_by_split": counts, "members": members}, splits_sha


def _safe_eval(expr: str, rec: dict) -> bool:
    """Evaluate a restricted boolean expr over ALLOWED_FIELDS only. No arbitrary eval."""
    tree = ast.parse(expr, mode="eval")

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.BoolOp):
            vals = [ev(v) for v in node.values]
            return all(vals) if isinstance(node.op, ast.And) else any(vals)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not ev(node.operand)
        if isinstance(node, ast.Compare):
            left = ev(node.left)
            for op, comp in zip(node.ops, node.comparators):
                right = ev(comp)
                if isinstance(op, ast.Eq) and not (left == right): return False
                if isinstance(op, ast.NotEq) and not (left != right): return False
                if isinstance(op, ast.Lt) and not (left < right): return False
                if isinstance(op, ast.Gt) and not (left > right): return False
                if isinstance(op, ast.LtE) and not (left <= right): return False
                if isinstance(op, ast.GtE) and not (left >= right): return False
                if isinstance(op, ast.In) and left not in right: return False
            return True
        if isinstance(node, ast.Name):
            if node.id not in ALLOWED_FIELDS:
                raise ValueError(f"field not allowed: {node.id}")
            return rec.get(node.id)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, (ast.List, ast.Tuple)):
            return [ev(e) for e in node.elts]
        raise ValueError(f"unsupported expression node: {type(node).__name__}")

    return bool(ev(tree))


def apply_filter(records: list[dict], expr: str) -> list[dict]:
    return [r for r in records if _safe_eval(expr, r)]


def contamination_report(selection: list[dict], guarded: bool) -> dict:
    holdout = [r["row_uid"] for r in selection if r["split"] == "holdout"]
    dev = [r["row_uid"] for r in selection if r["split"] == "dev"]
    none_rows = [r["row_uid"] for r in selection if r["split"] == "none"]
    seen, dups = {}, []
    for r in selection:
        seen.setdefault(r["content_sha256"], []).append(r["row_uid"])
    dups = [v for v in seen.values() if len(v) > 1]
    conflicts = {}
    for r in selection:
        key = (r["task_id"], r["model"], r["seed"])
        conflicts.setdefault(key, set()).add(r["outcome"])
    outcome_conflicts = [list(k) for k, v in conflicts.items() if len(v) > 1]
    missing = [r["row_uid"] for r in selection if not r.get("provenance_complete", True)]
    leak = bool(holdout or dev or none_rows)
    verdict = "blocked" if (guarded and leak) else "clean"
    return {"holdout_in_selection": holdout, "dev_in_selection": dev,
            "none_in_selection": none_rows, "duplicates": dups,
            "outcome_conflicts": outcome_conflicts, "missing_provenance": missing,
            "verdict": verdict}


def selection_hash(row_uids, expr, corpus_sha, splits_sha) -> str:
    return _sha("|".join(sorted(row_uids)) + "|" + expr + "|" + corpus_sha + "|" + splits_sha)


def emit_selection(name, records, expr, corpus_sha, splits_sha, counts_by_split,
                   guarded=True, allow_holdout=False, override_reason="", user="",
                   out_dir=".understudy/curate-trajectories/selections") -> dict:
    report = contamination_report(records, guarded)
    override = None
    if report["verdict"] == "blocked":
        if not allow_holdout:
            manifest = {"name": name, "verdict": "blocked", "report": report,
                        "filter_expr": expr, "n_rows": len(records)}
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            json.dump(manifest, open(Path(out_dir) / f"{name}.BLOCKED.json", "w"), indent=2)
            return manifest
        override = {"user": user, "reason": override_reason,
                    "admitted_row_uids": report["holdout_in_selection"] + report["dev_in_selection"]}
    uids = [r["row_uid"] for r in records]
    sha = selection_hash(uids, expr, corpus_sha, splits_sha)
    manifest = {
        "name": name, "filter_expr": expr, "guarded": guarded,
        "selection_sha256": sha, "corpus_sha256": corpus_sha, "splits_sha256": splits_sha,
        "n_rows": len(records),
        "counts_by_split": {s: sum(1 for r in records if r["split"] == s)
                            for s in ("train", "dev", "holdout", "none")},
        "verdict": "override" if override else "clean",
        "override": override, "report": report, "row_uids": uids,
    }
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    json.dump(manifest, open(Path(out_dir) / f"{name}.manifest.json", "w"), indent=2)
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True)
    ap.add_argument("--splits", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--expr", required=True)
    ap.add_argument("--guarded", action="store_true")
    ap.add_argument("--allow-holdout", action="store_true")
    ap.add_argument("--reason", default="")
    ap.add_argument("--user", default="")
    ap.add_argument("--out-dir", default=".understudy/curate-trajectories/selections")
    args = ap.parse_args(argv)

    records = load_index(args.index)
    corpus_sha = _sha("|".join(sorted(r["row_uid"] + r["content_sha256"] for r in records)))
    tag_info, splits_sha = tag_splits(records, args.splits)
    selected = apply_filter(records, args.expr)
    manifest = emit_selection(args.name, selected, args.expr, corpus_sha, splits_sha,
                              tag_info["counts_by_split"], guarded=args.guarded,
                              allow_holdout=args.allow_holdout, override_reason=args.reason,
                              user=args.user, out_dir=args.out_dir)
    print(json.dumps({k: v for k, v in manifest.items() if k != "row_uids"}, indent=2))
    return 2 if manifest["verdict"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
