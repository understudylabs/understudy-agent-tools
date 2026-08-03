#!/usr/bin/env python3
"""Combined experiment manifest for the domain-identification meet/beat effort.

This is VISUALIZATION ONLY: a read-only, provider-free snapshot of overall
experiment progress across waves. It never orchestrates or controls a run; it
only describes nodes the runs produce.

A node is a candidate/observation in the experiment graph. Nodes carry a wave,
an optional branch, a lifecycle stage/status, a parent, episode progress,
provenance refs, and a PROTOCOL IDENTITY. IN-PROGRESS nodes appear BEFORE any
final score and are NEVER encoded as score=0 or rejected — a null score means
"not finalized yet".

Methodology guards (critical):
  * A score is only meaningful within one evaluation protocol. The protocol
    identity is (method, scorer_version, rollout_contract, fixture_sha256,
    split_sha256, samples_per_task). Scores from different protocols are NOT
    comparable.
  * The headline high-score and any ranking operate ONLY within a single
    designated rank protocol (canonical rollout, k=3, on the dev split). GEPA
    "observed" scores are labeled metadata and never rank-eligible; a canonical
    k=1 reference (e.g. the incumbent) is a reference line, not rank-comparable
    to canonical k=3.

The manifest is hash-bound to the dev split provenance. Holdout state is
explicit and fail-closed: a run can truthfully declare that it did not execute
holdout without implying that an unobserved promotion holdout exists.
"""
import copy
import hashlib
import json
import time
from pathlib import Path

SCHEMA_VERSION = "understudy.experiment_manifest.v2"

STAGES = (
    "queued", "screening", "reflecting", "evaluating", "confirming",
    "promoted", "rejected", "completed", "failed",
)
TERMINAL_STAGES = frozenset({"promoted", "rejected", "completed", "failed"})
IN_PROGRESS_STAGES = frozenset({"queued", "screening", "reflecting", "evaluating", "confirming"})
SCORED_STAGES = frozenset({"promoted", "completed", "rejected"})
WAVES = ("baseline", "wave1", "wave2")

METHODS = ("gepa_observed", "canonical_rollout")
# Only canonical rollout is ever rank-eligible; gepa_observed is metadata.
RANKABLE_METHODS = frozenset({"canonical_rollout"})


def make_protocol(*, method, split_sha256, samples_per_task, fixture_sha256=None,
                  scorer_version="domain-identification-offline-v1",
                  rollout_contract="rollout.mjs@max_tokens=384;max_turns=10;malformed_tolerance=3;temperature=0"):
    """Build a protocol identity. samples_per_task (k) is part of identity, so
    canonical k=1 and canonical k=3 are DIFFERENT protocols."""
    if method not in METHODS:
        raise ValueError(f"unknown method: {method}")
    protocol = {
        "method": method,
        "scorer_version": scorer_version,
        "rollout_contract": rollout_contract,
        "split_sha256": split_sha256,
        "samples_per_task": int(samples_per_task),
    }
    if fixture_sha256:
        protocol["fixture_sha256"] = fixture_sha256
    return protocol


def protocol_key(protocol):
    """Canonical, hashable identity tuple for a protocol."""
    return (
        protocol["method"],
        protocol["scorer_version"],
        protocol["rollout_contract"],
        protocol.get("fixture_sha256"),
        protocol["split_sha256"],
        int(protocol["samples_per_task"]),
    )


def protocols_comparable(a, b):
    return protocol_key(a) == protocol_key(b)


def make_node(*, node_id, label, wave, stage, protocol, score=None,
              branch_id=None, parent=None, episodes_completed=0,
              episodes_expected=None, provenance=None, kind="candidate",
              rank_eligible=None, extra=None):
    """Build a single validated experiment node with a protocol identity."""
    if wave not in WAVES:
        raise ValueError(f"unknown wave: {wave}")
    if stage not in STAGES:
        raise ValueError(f"unknown stage: {stage}")
    if stage in IN_PROGRESS_STAGES and score is not None:
        raise ValueError(f"in-progress node {node_id} ({stage}) must not carry a final score")
    protocol = dict(protocol)
    protocol_key(protocol)  # validates shape
    # A node is only rank-eligible if its method is canonical (never gepa_observed).
    method_rankable = protocol["method"] in RANKABLE_METHODS
    if rank_eligible is None:
        rank_eligible = method_rankable
    if rank_eligible and not method_rankable:
        raise ValueError(f"node {node_id}: method {protocol['method']} can never be rank-eligible")
    node = {
        "node_id": node_id,
        "label": label,
        "kind": kind,
        "wave": wave,
        "branch_id": branch_id,
        "stage": stage,
        "status": stage,
        "score": score,
        "protocol": protocol,
        "rank_eligible": bool(rank_eligible),
        "parent": parent,
        "episode_progress": {
            "completed": int(episodes_completed),
            "expected": (int(episodes_expected) if episodes_expected is not None else None),
        },
        "provenance": dict(provenance or {}),
    }
    if extra:
        node.update(extra)
    return node


def rank_nodes(nodes, rank_protocol):
    """Rank finalized, rank-eligible nodes whose protocol EXACTLY matches
    rank_protocol. Refuses to mix protocols: any node marked rank_eligible whose
    protocol differs from rank_protocol is a programming error and raises.

    Returns nodes sorted by score desc, tie-break malformed_rate asc then
    latency asc. Non-matching / metadata / reference nodes are simply excluded.
    """
    ranked = []
    for n in nodes:
        if not n.get("rank_eligible"):
            continue
        if n["stage"] not in SCORED_STAGES or n.get("score") is None:
            continue
        if not protocols_comparable(n["protocol"], rank_protocol):
            raise ValueError(
                f"node {n['node_id']} is rank_eligible but its protocol "
                f"{protocol_key(n['protocol'])} != rank protocol "
                f"{protocol_key(rank_protocol)} (mixed-protocol ranking refused)")
        ranked.append(n)
    ranked.sort(key=lambda n: (
        -n["score"],
        n.get("malformed_rate", 1.0),
        n.get("latency_s", n.get("wall_clock_s", 1e9)),
    ))
    return ranked


def build_manifest(*, experiment, dev_split_sha256, rank_protocol, nodes,
                   reference_lines=None, totals=None, holdout_untouched=True,
                   holdout_status=None, generated_ts=None):
    """Assemble the combined manifest. The headline high-score is computed ONLY
    from rank-eligible nodes matching rank_protocol, so an in-progress node, a
    gepa_observed metadata node, or a canonical k=1 reference can never become
    the high-water mark."""
    if not protocols_comparable(rank_protocol, rank_protocol):  # shape check
        raise ValueError("bad rank_protocol")
    ranked = rank_nodes(nodes, rank_protocol)
    high = ranked[0]["score"] if ranked else None
    high_node = ranked[0]["node_id"] if ranked else None
    if holdout_status is None:
        holdout_status = "untouched" if holdout_untouched else "unverified"
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "experiment": experiment,
        "generated_ts": generated_ts if generated_ts is not None else time.time(),
        "dev_split_sha256": dev_split_sha256,
        "holdout_untouched": bool(holdout_untouched),
        "holdout_status": holdout_status,
        "rank_protocol": dict(rank_protocol),
        "headline": {
            "high_score": high,
            "high_score_node": high_node,
            "rank_protocol_key": list(protocol_key(rank_protocol)),
        },
        "reference_lines": [dict(r) for r in (reference_lines or [])],
        "totals": dict(totals or {}),
        "nodes": [copy.deepcopy(n) for n in nodes],
        "waves": list(WAVES),
    }
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest):
    """Fail-closed structural + invariant validation (provider-free)."""
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("bad schema_version")
    if not manifest.get("dev_split_sha256"):
        raise ValueError("manifest must be hash-bound to dev provenance")
    if not isinstance(manifest.get("holdout_untouched"), bool):
        raise ValueError("manifest must explicitly declare holdout_untouched")
    holdout_status = manifest.get("holdout_status")
    if holdout_status not in {
            "untouched", "historical_holdout_observed", "unverified", "executed"}:
        raise ValueError("manifest must declare a recognized holdout_status")
    if manifest["holdout_untouched"] and holdout_status != "untouched":
        raise ValueError("holdout_untouched=true requires holdout_status=untouched")
    if not manifest["holdout_untouched"] and holdout_status == "untouched":
        raise ValueError("holdout_status=untouched contradicts holdout_untouched=false")
    rank_protocol = manifest.get("rank_protocol")
    if not rank_protocol or rank_protocol.get("method") not in RANKABLE_METHODS:
        raise ValueError("rank_protocol must be a canonical (rank-eligible) protocol")
    all_ids = {n["node_id"] for n in manifest["nodes"]}
    seen = set()
    for node in manifest["nodes"]:
        nid = node["node_id"]
        if nid in seen:
            raise ValueError(f"duplicate node_id: {nid}")
        seen.add(nid)
        if node["wave"] not in WAVES:
            raise ValueError(f"node {nid}: unknown wave")
        if node["stage"] not in STAGES:
            raise ValueError(f"node {nid}: unknown stage")
        protocol_key(node["protocol"])  # shape
        if node["stage"] in IN_PROGRESS_STAGES and node.get("score") is not None:
            raise ValueError(f"node {nid}: in-progress node must not carry a score")
        if node.get("rank_eligible"):
            if node["protocol"]["method"] not in RANKABLE_METHODS:
                raise ValueError(f"node {nid}: gepa_observed can never be rank-eligible")
            if not protocols_comparable(node["protocol"], rank_protocol):
                raise ValueError(
                    f"node {nid}: rank-eligible but protocol != manifest rank_protocol "
                    "(mixed-protocol ranking refused)")
        parent = node.get("parent")
        if parent is not None and parent not in all_ids:
            raise ValueError(f"node {nid}: dangling parent {parent}")
    # Headline must equal the rank result and must never be a non-matching score.
    ranked = rank_nodes(manifest["nodes"], rank_protocol)
    expected_high = ranked[0]["score"] if ranked else None
    if manifest["headline"].get("high_score") != expected_high:
        raise ValueError("headline high_score does not match rank protocol result")
    return True


# The deployed gepa-viz renderer pulses a node WHITE while its candidate.status
# is in this active set; terminal nodes keep the existing green/red (from
# predictions). Kept in sync with the deployed renderer.
BRIDGE_ACTIVE_STATUSES = frozenset(
    {"started", "running", "screening", "reflecting", "evaluating", "confirming"})


def run_shaped_from_manifest(manifest, examples):
    """Project the combined manifest into the gepa-viz run.json shape
    ({"examples": [...], "candidates": {id: {...}}}) so PLAIN gepa-viz renders
    baseline/wave1/wave2 with only the background changing.

    Contract (matches the deployed renderer + Luis's bridge spec):
      * candidate keys are STABLE node ids; parents reference those same ids;
      * `status` is carried for every node — the active subset drives the white
        pulse, terminal stages keep existing green/red;
      * `score` and `predictions` are included ONLY when the node is finalized
        (a scored terminal stage with a real score). In-progress nodes never
        carry a score or fabricated predictions.

    This is a read-only projection; the richer manifest stays the durable
    sidecar artifact. Never raises on shape (validated up front).
    """
    validate_manifest(manifest)
    candidates = {}
    for n in manifest["nodes"]:
        nid = str(n["node_id"])
        stage = n["stage"]
        finalized = stage in SCORED_STAGES and n.get("score") is not None
        parent = n.get("parent")
        candidates[nid] = {
            "prompt": n.get("prompt", ""),
            "parent": (str(parent) if parent is not None else None),
            "score": (n["score"] if finalized else None),
            "predictions": (n.get("predictions") if finalized else None),
            "minibatch": None,
            "status": stage,
            "label": n.get("label", nid),
            "wave": n.get("wave"),
            "branch_id": n.get("branch_id"),
            "rank_eligible": n.get("rank_eligible", False),
            "episode_progress": n.get("episode_progress"),
            "provenance": n.get("provenance", {}),
            "latency_s": n.get("latency_s"),
            "cost_usd": n.get("cost_usd"),
            "cost_coverage": n.get("cost_coverage"),
        }
    return {
        "examples": [dict(e) for e in examples],
        "candidates": candidates,
        "split": "dev",
        "split_provenance": {"dev": manifest["dev_split_sha256"]},
    }


def predictions_from_canonical(canonical, examples):
    """Build gepa-viz `predictions` for a finalized canonical node from its
    authoritative per-task receipt rows, so the viewer draws the real red/green
    ring instead of an unscored gray node.

    Rows are the per-episode canonical results (k samples per dev task). We
    aggregate to ONE cell per dev task, ALIGNED to `examples` order, using the
    real mean of that task's sample scores (no fabricated scores). The result
    has length len(examples) and its mean equals the receipt mean_score.

    Returns None if the receipt carries no rows (caller leaves predictions null).
    """
    rows = (canonical or {}).get("rows") or []
    if not rows:
        return None
    by_task = {}
    for r in rows:
        by_task.setdefault(str(r.get("task_id")), []).append(float(r.get("score", 0.0)))
    predictions = []
    for ex in examples:
        tid = str(ex.get("task_id"))
        scores = by_task.get(tid)
        if not scores:  # task absent from receipt: cannot assert an outcome
            return None
        predictions.append({
            "prediction": {},
            "score": sum(scores) / len(scores),
        })
    return predictions


def publish_run_shaped(manifest, examples, ingest_url, timeout=10):
    """Project the manifest into the gepa-viz run.json shape and POST it to the
    viewer ingest endpoint so PLAIN gepa-viz renders baseline/wave1/wave2. The
    combined manifest stays the durable sidecar; this bridge is what the live
    page consumes. Never raises on a non-2xx (a viewer outage must not kill a
    run)."""
    from urllib.request import Request, urlopen
    run_shaped = run_shaped_from_manifest(manifest, examples)
    data = json.dumps(run_shaped).encode("utf-8")
    req = Request(ingest_url, data=data, headers={"content-type": "application/json"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status
    except Exception as exc:  # noqa: BLE001 - viewer outage must not kill a run
        return f"publish-failed: {str(exc)[:120]}"


def manifest_digest(manifest):
    payload = {k: manifest[k] for k in manifest if k != "generated_ts"}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def write_manifest(manifest, path):
    """Atomically write the manifest so the viewer never reads a half-file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)
    return path


def publish_manifest(manifest, ingest_url, timeout=10):
    """POST the manifest to the viewer ingest endpoint. Read-only w.r.t. the
    experiment; never raises on a non-2xx so a viewer outage cannot kill a run."""
    from urllib.request import Request, urlopen
    validate_manifest(manifest)
    data = json.dumps(manifest).encode("utf-8")
    req = Request(ingest_url, data=data, headers={"content-type": "application/json"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status
    except Exception as exc:  # noqa: BLE001 - viewer outage must not kill a run
        return f"publish-failed: {str(exc)[:120]}"
