#!/usr/bin/env python3
"""Eight-island GEPA successive-halving race for domain identification.

The runner is deliberately train/dev only. Eight independent Stage-1 islands
screen in parallel, global prompt hashes remove duplicate work, and only the
best two distinct prompts receive a larger Stage-2 budget. Those survivors are
then evaluated by the authoritative canonical rollout contract at k=3. No
holdout identifier or flag is accepted by this command.

The authoritative experiment manifest is rewritten atomically throughout the
run. It records lifecycle state, episode/reflection budgets, latency, cost
coverage, failure category/detail, deduplication, and promotion evidence. The
same snapshot is projected into gepa-viz on every heartbeat.
"""
import argparse
import hashlib
import json
import os
import threading
import time
from pathlib import Path

import experiment_manifest as em
from optimize import FuseTripped, assert_split_allowed, call_json
from turbo_race import GlobalBudget, confirm_canonical, run_branch, select_winner, stratified_screening_subsets

K = 3
ISLAND_SPECS = (
    ("explore-1", "explore", 178561, 0),
    ("explore-2", "explore", 278561, 1),
    ("explore-3", "explore", 378561, 0),
    ("explore-4", "explore", 478561, 1),
    ("failure-1", "failure_targeted", 578561, 0),
    ("failure-2", "failure_targeted", 678561, 1),
    ("exploit-1", "exploit", 778561, 0),
    ("exploit-2", "exploit", 878561, 1),
)


def prompt_sha(text):
    return hashlib.sha256((text.rstrip() + "\n").encode()).hexdigest()


def unique_ranked(records):
    """Best completed record per prompt hash, ordered by screening evidence.

    Screening scores are only a halving heuristic and never rank-eligible in
    the final manifest. Ties prefer more candidate diversity and lower latency.
    """
    by_hash = {}
    for rec in records:
        if rec.get("status") != "completed" or not rec.get("winner_prompt_sha256"):
            continue
        key = rec["winner_prompt_sha256"]
        prior = by_hash.get(key)
        rank = (-float(rec.get("screening_best_score", -1)),
                -int(rec.get("candidates_tried", 0)), float(rec.get("wall_clock_s", 1e9)))
        if prior is None or rank < prior[0]:
            by_hash[key] = (rank, rec)
    return [item[1] for item in sorted(by_hash.values(), key=lambda item: item[0])]


def classify_failure(rec):
    detail = str(rec.get("detail") or rec.get("abort_reason") or "unknown failure")[:240]
    lowered = detail.lower()
    if "429" in lowered or "rate" in lowered:
        category = "rate_limit"
    elif "timeout" in lowered or "timed out" in lowered:
        category = "timeout"
    elif "fuse" in lowered or "cap" in lowered:
        category = "budget_fuse"
    elif "service" in lowered or "5xx" in lowered:
        category = "service_pressure"
    else:
        category = "runtime_error"
    return category, detail


class LiveManifest:
    def __init__(self, *, path, ingest_url, experiment_id, dev_sha, examples,
                 baseline_nodes, rank_protocol, gepa_protocol, budget, started,
                 expected_total, reference_lines=(), mirror_path=None):
        self.path = Path(path)
        self.ingest_url = ingest_url
        self.experiment_id = experiment_id
        self.dev_sha = dev_sha
        self.examples = examples
        self.baseline_nodes = list(baseline_nodes)
        self.rank_protocol = rank_protocol
        self.gepa_protocol = gepa_protocol
        self.budget = budget
        self.started = started
        self.expected_total = expected_total
        self.reference_lines = list(reference_lines)
        self.mirror_path = Path(mirror_path) if mirror_path else None
        self.records = {}
        self.states = {}
        self.confirmations = {}
        self._lock = threading.Lock()

    def update(self, node_id, **values):
        with self._lock:
            self.states.setdefault(node_id, {}).update(values)
        return self.publish()

    def sync_records(self, records):
        with self._lock:
            self.records.update(records)
        return self.publish()

    def _node(self, node_id, state, rec):
        phase = state.get("phase", "stage1")
        status = state.get("status", "queued")
        expected = state.get("episodes_expected")
        budget_branch = self.budget.snapshot().get("branches", {}).get(node_id, {})
        completed = max(rec.get("fuses", {}).get("episodes_completed", 0),
                        budget_branch.get("episodes_completed", 0))
        score = None
        protocol = self.gepa_protocol
        rank_eligible = False
        predictions = None
        if status == "completed" and state.get("confirmation"):
            conf = state["confirmation"]
            score = conf.get("mean_score")
            protocol = self.rank_protocol
            rank_eligible = bool(conf.get("confirmed") and score is not None)
            predictions = conf.get("predictions")
        provenance = {
            "phase": phase,
            "strategy": state.get("strategy"),
            "screening_score": rec.get("screening_best_score"),
            "prompt_sha256": rec.get("winner_prompt_sha256"),
            "dedup_of": state.get("dedup_of"),
            "outcome": state.get("outcome"),
            "failure_category": state.get("failure_category"),
            "failure_reason": state.get("failure_reason"),
            "evidence_state": "canonical_k3" if rank_eligible else "screening_only",
            "holdout_executed": False,
        }
        extra = {
            "latency_s": rec.get("wall_clock_s"),
            "cost_usd": None,
            "cost_coverage": "out_of_band_clickhouse",
        }
        if predictions:
            extra["predictions"] = predictions
        return em.make_node(
            node_id=node_id,
            label=state.get("label", node_id),
            wave="wave2",
            stage=status,
            protocol=protocol,
            score=score,
            rank_eligible=rank_eligible,
            branch_id=node_id,
            parent=state.get("parent", "wave1-winner"),
            episodes_completed=completed,
            episodes_expected=expected,
            provenance=provenance,
            extra=extra,
        )

    def publish(self):
        with self._lock:
            states = {k: dict(v) for k, v in self.states.items()}
            records = {k: dict(v) for k, v in self.records.items()}
        nodes = list(self.baseline_nodes)
        for node_id in sorted(states):
            nodes.append(self._node(node_id, states[node_id], records.get(node_id, {})))
        snap = self.budget.snapshot()
        failures = []
        for node_id, state in states.items():
            if state.get("failure_reason"):
                failures.append({"node_id": node_id, "category": state.get("failure_category"),
                                 "reason": state.get("failure_reason")})
        latencies = sorted(float(rec["wall_clock_s"]) for rec in records.values()
                           if isinstance(rec.get("wall_clock_s"), (int, float)))
        def percentile(values, q):
            if not values:
                return None
            return values[min(len(values) - 1, round((len(values) - 1) * q))]
        totals = {
            "state": "completed" if states and all(s.get("status") in em.TERMINAL_STAGES for s in states.values()) else "running",
            "wall_clock_s": round(time.time() - self.started),
            "budget": snap,
            "episodes_completed": snap.get("stage_a_completed", 0),
            "episodes_expected": self.expected_total,
            "reflections_completed": snap.get("total_reflections", 0),
            "islands_total": len(ISLAND_SPECS),
            "islands_active": sum(s.get("status") in em.IN_PROGRESS_STAGES for s in states.values()),
            "islands_succeeded": sum(s.get("status") in {"completed", "promoted"} for s in states.values()),
            "islands_failed": sum(s.get("status") == "failed" for s in states.values()),
            "failure_events": failures,
            "latency_s": {"p50": percentile(latencies, .50),
                          "p95": percentile(latencies, .95),
                          "samples": len(latencies)},
            "cost_usd": None,
            "cost_coverage": "out_of_band_clickhouse",
            "holdout_executed": False,
        }
        manifest = em.build_manifest(
            experiment=self.experiment_id, dev_split_sha256=self.dev_sha,
            rank_protocol=self.rank_protocol, nodes=nodes,
            reference_lines=self.reference_lines, totals=totals,
            holdout_untouched=True,
        )
        em.write_manifest(manifest, self.path)
        if self.mirror_path:
            em.write_manifest(manifest, self.mirror_path)
        status = em.publish_run_shaped(manifest, self.examples, self.ingest_url)
        return {"manifest": str(self.path), "ingest": status, "totals": totals}


def run_parallel(specs, *, seed_prompts, subsets, train, sidecar, budget, runs_root,
                 experiment_id, reflection_key, max_metric_calls, concurrency,
                 spend_authorization_usd, live, phase, episode_cap):
    results = {}
    lock = threading.Lock()
    threads = []
    for bid, strategy, seed, subset_index in specs:
        subset = subsets[subset_index]
        budget.register_branch(bid, episode_cap, 4, time.time() + 3600)
        live.update(bid, label=f"{strategy.replace('_', ' ').title()} · {bid}", phase=phase,
                    strategy=strategy, status="screening", episodes_expected=episode_cap,
                    parent="wave1-winner")
        thread = threading.Thread(target=run_branch, kwargs={
            "bid": bid, "seed": seed, "subset": subset, "trainset": train,
            "seed_prompt": seed_prompts[bid], "sidecar": sidecar, "budget": budget,
            "runs_root": runs_root, "run_id": f"{experiment_id}-{bid}",
            "reflection_key": reflection_key, "max_metric_calls": max_metric_calls,
            "concurrency": concurrency, "spend_authorization_usd": spend_authorization_usd,
            "results": results, "results_lock": lock,
        }, name=bid, daemon=True)
        thread.start()
        threads.append(thread)
    while any(t.is_alive() for t in threads):
        live.sync_records(results)
        time.sleep(2)
    for t in threads:
        t.join()
    live.sync_records(results)
    for bid, *_ in specs:
        rec = results.get(bid, {"status": "failed", "detail": "branch produced no receipt"})
        if rec.get("status") == "completed":
            live.update(bid, status="completed", outcome="screening_complete")
        else:
            category, reason = classify_failure(rec)
            live.update(bid, status="failed", outcome="failed",
                        failure_category=category, failure_reason=reason)
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", default="http://127.0.0.1:8787")
    parser.add_argument("--base-url", default="http://127.0.0.1:8099/v1")
    parser.add_argument("--model", default="nemotron-3-nano-base")
    parser.add_argument("--seed-prompt", required=True)
    parser.add_argument("--runs-root", default=str(Path.home() / ".di-runs"))
    parser.add_argument("--experiment-id", default="")
    parser.add_argument("--stage1-episodes", type=int, default=12)
    parser.add_argument("--stage2-episodes", type=int, default=24)
    parser.add_argument("--stage1-metric-calls", type=int, default=12)
    parser.add_argument("--stage2-metric-calls", type=int, default=24)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-total-reflections", type=int, default=32)
    parser.add_argument("--spend-authorization-usd", type=float, default=1000.0)
    parser.add_argument("--allow-unmetered-cost", action="store_true")
    parser.add_argument("--ingest-url", default="http://127.0.0.1:5151/ingest")
    parser.add_argument("--manifest-mirror", default="",
                        help="optional dashboard manifest path, atomically refreshed on every heartbeat")
    parser.add_argument("--wave1-seed-canonical", required=True)
    parser.add_argument("--wave1-winner-canonical", required=True)
    args = parser.parse_args()
    if not args.allow_unmetered_cost:
        raise FuseTripped("--allow-unmetered-cost required")
    reflection_key = os.environ.get("UNDERSTUDY_API_KEY") or os.environ.get("FIREWORKS_API_KEY")
    if not reflection_key:
        raise RuntimeError("UNDERSTUDY_API_KEY or FIREWORKS_API_KEY is required")
    for split in ("train", "dev"):
        assert_split_allowed(split)

    repo_root = Path(__file__).resolve().parents[3]
    experiment_id = args.experiment_id or time.strftime("islands-%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = Path(args.runs_root) / experiment_id
    out_dir.mkdir(parents=True, exist_ok=False)
    manifest_path = out_dir / "experiment-manifest.json"
    seed_prompt = Path(args.seed_prompt).read_text()
    train = call_json(args.sidecar, "/pool?split=train")["tasks"]
    dev_payload = call_json(args.sidecar, "/pool?split=dev")
    dev, dev_sha = dev_payload["tasks"], dev_payload["split_sha256"]
    subsets = stratified_screening_subsets(dev)
    seed_canonical = json.loads(Path(args.wave1_seed_canonical).read_text())
    winner_canonical = json.loads(Path(args.wave1_winner_canonical).read_text())
    rank_protocol = em.make_protocol(method="canonical_rollout", split_sha256=dev_sha, samples_per_task=K)
    gepa_protocol = em.make_protocol(method="gepa_observed", split_sha256=dev_sha, samples_per_task=1)
    baseline_nodes = [
        em.make_node(node_id="baseline-seed", label="Seed prompt (canonical k=3)", wave="baseline",
                     stage="completed", protocol=rank_protocol, score=seed_canonical["mean_score"],
                     rank_eligible=True, extra={"predictions": em.predictions_from_canonical(seed_canonical, dev)}),
        em.make_node(node_id="wave1-winner", label="Wave-1 winner (canonical k=3)", wave="wave1",
                     stage="completed", protocol=rank_protocol, score=winner_canonical["mean_score"],
                     rank_eligible=True, parent="baseline-seed",
                     extra={"predictions": em.predictions_from_canonical(winner_canonical, dev)}),
    ]
    stage1_total = len(ISLAND_SPECS) * args.stage1_episodes
    stage2_total = 2 * args.stage2_episodes
    confirm_total = 2 * len(dev) * K
    budget = GlobalBudget(max_total_episodes=stage1_total + stage2_total + confirm_total,
                          stage_a_global_cap=stage1_total + stage2_total,
                          stage_b_escrow=confirm_total,
                          max_total_reflections=args.max_total_reflections)
    started = time.time()
    live = LiveManifest(path=manifest_path, ingest_url=args.ingest_url,
                        experiment_id=experiment_id, dev_sha=dev_sha, examples=dev,
                        baseline_nodes=baseline_nodes, rank_protocol=rank_protocol,
                        gepa_protocol=gepa_protocol, budget=budget, started=started,
                        expected_total=stage1_total + stage2_total + confirm_total,
                        mirror_path=args.manifest_mirror or None)
    stage1_prompts = {bid: seed_prompt for bid, *_ in ISLAND_SPECS}
    stage1 = run_parallel(ISLAND_SPECS, seed_prompts=stage1_prompts, subsets=subsets,
                          train=train, sidecar=args.sidecar, budget=budget,
                          runs_root=args.runs_root, experiment_id=experiment_id,
                          reflection_key=reflection_key, max_metric_calls=args.stage1_metric_calls,
                          concurrency=args.concurrency, spend_authorization_usd=args.spend_authorization_usd,
                          live=live, phase="stage1", episode_cap=args.stage1_episodes)
    unique = unique_ranked(stage1.values())
    if len(unique) < 2:
        raise FuseTripped(f"successive halving needs two distinct completed prompts; got {len(unique)}")
    survivors = unique[:2]
    survivor_hashes = {rec["winner_prompt_sha256"] for rec in survivors}
    for bid, rec in stage1.items():
        if rec.get("status") == "completed" and rec.get("winner_prompt_sha256") not in survivor_hashes:
            live.update(bid, status="rejected", outcome="successive_halving", failure_category="not_selected",
                        failure_reason="lower screening rank or globally deduplicated")

    stage2_specs, stage2_prompts = [], {}
    for index, rec in enumerate(survivors, 1):
        bid = f"survivor-{index}"
        strategy = f"exploit_{rec['branch_id']}"
        stage2_specs.append((bid, strategy, 900000 + index, 1 - (index - 1) % 2))
        stage2_prompts[bid] = Path(rec["optimized_prompt_path"]).read_text()
    stage2 = run_parallel(stage2_specs, seed_prompts=stage2_prompts, subsets=subsets,
                          train=train, sidecar=args.sidecar, budget=budget,
                          runs_root=args.runs_root, experiment_id=experiment_id,
                          reflection_key=reflection_key, max_metric_calls=args.stage2_metric_calls,
                          concurrency=args.concurrency, spend_authorization_usd=args.spend_authorization_usd,
                          live=live, phase="stage2", episode_cap=args.stage2_episodes)

    finalists = unique_ranked(stage2.values())[:2]
    confirmations = []
    canonical_cache = {}
    if winner_canonical.get("system_file_sha256"):
        canonical_cache[winner_canonical["system_file_sha256"]] = winner_canonical
    for rec in finalists:
        bid = rec["branch_id"]
        budget.reserve_confirmation(bid)
        sha = rec["winner_prompt_sha256"]
        live.update(bid, status="confirming", outcome="canonical_k3_pending")
        if sha in canonical_cache:
            budget.release_confirmation(bid)
            result = canonical_cache[sha]
            deduped = True
        else:
            budget.mark_confirmation_dispatched(bid)
            receipt_path = out_dir / f"canonical-{bid}-dev-k3.json"
            result = confirm_canonical(prompt_path=rec["optimized_prompt_path"], out_path=receipt_path,
                                       sidecar_base_url=args.base_url, model=args.model,
                                       repo_root=repo_root, k=K)
            canonical_cache[sha] = result
            deduped = False
        conf = {"branch_id": bid, "confirmed": True, "deduped": deduped,
                "mean_score": result["mean_score"], "malformed_rate": result.get("malformed_rate"),
                "wall_clock_s": result.get("wall_clock_s"), "winner_prompt_sha256": sha,
                "predictions": em.predictions_from_canonical(result, dev)}
        confirmations.append(conf)
        live.update(bid, status="completed", outcome="canonical_k3_complete", confirmation=conf)

    winner = select_winner(confirmations)
    if winner:
        live.update(winner["branch_id"], status="promoted", outcome="promoted_canonical_k3",
                    confirmation=winner)
    snapshot = live.publish()
    receipt = {
        "schema_version": "understudy.island_race_receipt.v1",
        "experiment_id": experiment_id,
        "state": "completed",
        "dev_split_sha256": dev_sha,
        "holdout_executed": False,
        "islands": stage1,
        "survivors": stage2,
        "confirmations": confirmations,
        "selected_winner": winner,
        "budget": budget.snapshot(),
        "manifest_path": str(manifest_path),
        "manifest_digest": em.manifest_digest(json.loads(manifest_path.read_text())),
        "publish_status": snapshot["ingest"],
        "total_cost_usd": None,
        "cost_coverage": "out_of_band_clickhouse",
        "wall_clock_s": round(time.time() - started),
    }
    (out_dir / "island-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
