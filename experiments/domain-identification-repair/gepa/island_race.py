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
import subprocess
import threading
import time
from pathlib import Path

import experiment_manifest as em
from optimize import FuseTripped, assert_split_allowed, call_json
from turbo_race import (
    GlobalBudget, _family_of, confirm_canonical, failure_family_curriculum,
    failure_family_screening_subsets, run_branch, screening_valset_hash,
    select_winner, stratified_screening_subsets,
    train_screening_subsets,
)

K = 3
LEGACY_ISLAND_SPECS = (
    ("explore-1", "explore", 178561, 0),
    ("explore-2", "explore", 278561, 1),
    ("explore-3", "explore", 378561, 0),
    ("explore-4", "explore", 478561, 1),
    ("failure-1", "failure_targeted", 578561, 0),
    ("failure-2", "failure_targeted", 678561, 1),
    ("exploit-1", "exploit", 778561, 0),
    ("exploit-2", "exploit", 878561, 1),
)
WAVE3_ABSTAIN_ISLAND_SPECS = (
    ("abstain-1", "abstention_policy", 178561, 0),
    ("abstain-2", "abstention_policy", 278561, 1),
    ("abstain-3", "abstention_policy", 378561, 0),
    ("abstain-4", "abstention_policy", 478561, 1),
    ("term-1", "termination_discipline", 578561, 0),
    ("term-2", "termination_discipline", 678561, 1),
    ("cons-1", "conservative_exploit", 778561, 0),
    ("cons-2", "conservative_exploit", 878561, 1),
)
WAVE4_STATE_TRANSITION_ISLAND_SPECS = (
    ("state-1", "exact_state_transition", 1187561, 0),
    ("state-2", "exact_state_transition", 1287561, 1),
    ("state-3", "exact_state_transition", 1387561, 0),
    ("state-4", "exact_state_transition", 1487561, 1),
    ("sequence-1", "explicit_tool_sequence", 1587561, 0),
    ("sequence-2", "explicit_tool_sequence", 1687561, 1),
    ("crossover-1", "state_transition_crossover", 1787561, 0),
    ("crossover-2", "state_transition_crossover", 1887561, 1),
)
WAVE5_DENSE_TRANSITION_ISLAND_SPECS = (
    ("dense-1", "dense_state_transition", 2187561, 0),
    ("dense-2", "dense_state_transition", 2287561, 1),
    ("dense-3", "dense_state_transition", 2387561, 0),
    ("dense-4", "dense_state_transition", 2487561, 1),
    ("sequence-1", "explicit_dense_sequence", 2587561, 0),
    ("sequence-2", "explicit_dense_sequence", 2687561, 1),
    ("crossover-1", "dense_transition_crossover", 2787561, 0),
    ("crossover-2", "dense_transition_crossover", 2887561, 1),
)
ISLAND_SPECS = LEGACY_ISLAND_SPECS


def island_specs_for_plan(plan):
    if plan == "legacy":
        return LEGACY_ISLAND_SPECS
    if plan == "wave3-abstain":
        return WAVE3_ABSTAIN_ISLAND_SPECS
    if plan == "wave4-state-transition":
        return WAVE4_STATE_TRANSITION_ISLAND_SPECS
    if plan == "wave5-dense-transition":
        return WAVE5_DENSE_TRANSITION_ISLAND_SPECS
    raise ValueError(f"unknown island plan: {plan}")


def prompt_sha(text):
    return hashlib.sha256((text.rstrip() + "\n").encode()).hexdigest()


def write_terminal_artifacts(out_dir, receipt, *record_groups, limit=64):
    """Write the receipt plus a bounded, prompt-free failed-row handoff."""
    out_dir = Path(out_dir)
    (out_dir / "island-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    rows = []
    for group in record_groups:
        for rec in (group or {}).values():
            for dense_row in rec.get("screening_dense_rows") or []:
                if float(dense_row.get("dense_score", 1)) >= 1 and float(
                        dense_row.get("forbidden_effects", 0)) == 0:
                    continue
                rows.append({
                    "task_id": dense_row.get("task_id"),
                    "family": dense_row.get("family"),
                    "score": dense_row.get("dense_score"),
                    "dense_score": dense_row.get("dense_score"),
                    "milestones": dense_row.get("milestones"),
                    "malformed": dense_row.get("malformed"),
                    "forbidden_effects": dense_row.get("forbidden_effects"),
                    "steps": dense_row.get("steps"),
                    "ended": dense_row.get("ended"),
                })
            ledger = Path(rec.get("run_dir", "")) / "progress.jsonl"
            if not ledger.is_file():
                continue
            for line in ledger.read_text().splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("kind") != "candidate_eval" or float(item.get("score", 1)) >= 1:
                    continue
                rows.append({key: item.get(key) for key in (
                    "task_id", "score", "malformed", "forbidden_effects", "ended", "steps",
                )})
    summary = {"schema_version": "understudy.failed_rows_summary.v1",
               "holdout_executed": False, "rows": rows[:limit], "truncated": len(rows) > limit}
    (out_dir / "failed-rows-summary.json").write_text(json.dumps(summary, indent=2) + "\n")


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
        rank = (-float(rec.get("selected_screening_score", rec.get("screening_best_score", -1))),
                -int(rec.get("candidates_tried", 0)), float(rec.get("wall_clock_s", 1e9)))
        if prior is None or rank < prior[0]:
            by_hash[key] = (rank, rec)
    return [item[1] for item in sorted(by_hash.values(), key=lambda item: item[0])]


def global_dedup_annotations(records):
    """Map each completed branch to its prompt-hash representative.

    Representatives use the exact same ordering as successive halving. A
    ``None`` value means the branch is the representative; a branch id means
    the branch is a duplicate of that representative. This keeps live and
    terminal evidence aligned with the work the optimizer will actually
    advance.
    """
    representatives = {
        rec["winner_prompt_sha256"]: rec["branch_id"]
        for rec in unique_ranked(records)
    }
    annotations = {}
    for rec in records:
        if rec.get("status") != "completed" or not rec.get("winner_prompt_sha256"):
            continue
        representative = representatives[rec["winner_prompt_sha256"]]
        annotations[rec["branch_id"]] = (
            None if rec["branch_id"] == representative else representative
        )
    return annotations


def family_aware_ranked(records, *, abstain_family="domain-id-unmatched-abstain",
                        perfect_families=(
                            "domain-id-direct-route",
                            "domain-id-lookalike-route",
                            "domain-id-parent-route",
                        ), primary_reward_first=False, dense_transition=False):
    """Rank wave-3 representatives while rejecting perfect-family regressions."""
    eligible = []
    for rec in records:
        if rec.get("status") != "completed" or not rec.get("winner_prompt_sha256"):
            continue
        selected = rec.get("screening_by_family")
        seed = rec.get("seed_screening_by_family")
        if (not rec.get("screening_subscores_available")
                or not isinstance(selected, dict) or not isinstance(seed, dict)):
            continue
        if any(family not in selected or family not in seed for family in perfect_families):
            continue
        if any(selected[family] < seed[family] for family in perfect_families):
            continue
        if abstain_family not in selected:
            continue
        if (primary_reward_first and not isinstance(rec.get("screening_tiebreaks"), dict)
                or dense_transition and not isinstance(rec.get("screening_dense_metrics"), dict)):
            continue
        eligible.append(rec)
    return sorted(
        eligible,
        key=lambda rec: (
            -float(rec.get("selected_screening_score", rec.get("screening_best_score", -1)))
            if primary_reward_first or dense_transition
            else -float(rec["screening_by_family"][abstain_family]),
            -float(rec["screening_dense_metrics"].get("unmatched_dense_mean", -1))
            if dense_transition else 0,
            float(rec["screening_dense_metrics"].get("forbidden_effects_mean", 1e9))
            if dense_transition else 0,
            -float(rec["screening_dense_metrics"].get("state_transition_partial_mean", -1))
            if dense_transition else 0,
            float(rec["screening_dense_metrics"].get("malformed_mean", 1e9))
            if dense_transition else 0,
            float(rec["screening_dense_metrics"].get("steps_mean", 1e9))
            if dense_transition else 0,
            float(rec["screening_dense_metrics"].get("latency_s_mean", 1e9))
            if dense_transition else 0,
            -float(rec["screening_by_family"][abstain_family])
            if primary_reward_first and not dense_transition
            else -float(rec.get("screening_best_score", -1)),
            float(rec["screening_tiebreaks"].get("forbidden_effects", 1e9))
            if primary_reward_first else 0,
            float(rec["screening_tiebreaks"].get("malformed", 1e9))
            if primary_reward_first else 0,
            float(rec["screening_tiebreaks"].get("steps", 1e9))
            if primary_reward_first else 0,
            -int(rec.get("candidates_tried", 0)),
            float(rec.get("wall_clock_s", 1e9)),
        ),
    )


def canonical_family_score(mean_by_family, family):
    if not isinstance(mean_by_family, dict):
        return None
    suffix = family.removeprefix("domain-id-")
    for key, score in mean_by_family.items():
        if str(key).removeprefix("domain-id-") == suffix:
            try:
                return float(score)
            except (TypeError, ValueError):
                return None
    return None


def canonical_promotion_eligible(confirmation, parent_mean_by_family):
    """Reject dev-k=3 finalists that regress a perfect family."""
    candidate = confirmation.get("mean_by_family")
    if not isinstance(candidate, dict) or not isinstance(parent_mean_by_family, dict):
        return False
    for family in (
        "domain-id-direct-route",
        "domain-id-lookalike-route",
        "domain-id-parent-route",
    ):
        candidate_score = canonical_family_score(candidate, family)
        parent_score = canonical_family_score(parent_mean_by_family, family)
        if candidate_score is None or parent_score is None or candidate_score < parent_score:
            return False
    return True


def incomplete_branch_ids(specs, records):
    """Return branches without a completed, durable screening receipt.

    Global deduplication and no-distinct-candidate conclusions are valid only
    after every scheduled branch completes.  Missing or failed branches are an
    execution failure, not evidence that the optimizer converged.
    """
    return [
        bid for bid, *_ in specs
        if records.get(bid, {}).get("status") != "completed"
    ]


def required_physical_episode_cap(max_metric_calls, valset_size):
    """Conservative GEPA 0.1.4 physical cap for a logical metric budget.

    The max-metric stopper is checked between iterations. GEPA may perform the
    initial full-valset evaluation and one final accepted-candidate full-valset
    evaluation outside the logical minibatch boundary. Reserve both complete
    valsets: Wave 4 empirically attempted call 37 at logical=24,valset=12, so
    the former +1-valset bound was demonstrably insufficient.
    """
    return max_metric_calls + (2 * valset_size)


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


def build_no_distinct_receipt(*, experiment_id, dev_sha, islands, distinct_prompt_count,
                              budget, manifest_path, manifest_digest, publish_status,
                              wall_clock_s, stop_reason=None):
    """Build a fail-closed terminal receipt without touching a provider.

    Full convergence is an experimental outcome, not a runtime failure.  It
    must still produce durable evidence while explicitly refusing Stage 2,
    canonical confirmation, promotion, and holdout access.
    """
    reason = (stop_reason or
              ("successive halving needs two distinct completed prompts; "
               f"got {distinct_prompt_count}"))
    return {
        "schema_version": "understudy.island_race_receipt.v1",
        "experiment_id": experiment_id,
        "state": "stopped_no_distinct_candidates",
        "stop_reason": reason,
        "dev_split_sha256": dev_sha,
        "holdout_executed": False,
        "islands": islands,
        "distinct_prompt_count": distinct_prompt_count,
        "stage2_executed": False,
        "survivors": {},
        "confirmations": [],
        "selected_winner": None,
        "promotion_blocked": True,
        "budget": budget,
        "manifest_path": str(manifest_path),
        "manifest_digest": manifest_digest,
        "publish_status": publish_status,
        "total_cost_usd": None,
        "cost_coverage": "out_of_band_clickhouse",
        "wall_clock_s": wall_clock_s,
    }


def build_invalid_execution_receipt(*, experiment_id, dev_sha, islands,
                                    incomplete_branches, budget, manifest_path,
                                    manifest_digest, publish_status, wall_clock_s,
                                    survivors=None, outcome=None, stop_reason=None):
    """Build terminal evidence for an incomplete island wave.

    This receipt deliberately contains no survivor, confirmation, or promotion
    result.  A later run may retry with a fresh immutable experiment id, but it
    must not reinterpret partial branch output as optimizer-quality evidence.
    """
    receipt = {
        "schema_version": "understudy.island_race_receipt.v1",
        "experiment_id": experiment_id,
        "state": "invalid_execution",
        "stop_reason": (stop_reason or
                        "one or more scheduled branches lacked a completed receipt"),
        "dev_split_sha256": dev_sha,
        "holdout_executed": False,
        "islands": islands,
        "incomplete_branches": list(incomplete_branches),
        "distinct_prompt_count": None,
        "stage2_executed": False,
        "survivors": survivors or {},
        "confirmations": [],
        "selected_winner": None,
        "promotion_blocked": True,
        "budget": budget,
        "manifest_path": str(manifest_path),
        "manifest_digest": manifest_digest,
        "publish_status": publish_status,
        "total_cost_usd": None,
        "cost_coverage": "out_of_band_clickhouse",
        "wall_clock_s": wall_clock_s,
    }
    if outcome is not None:
        receipt["outcome"] = outcome
    return receipt


def stamp_reflection(receipt, reflection_provenance):
    receipt["reflection"] = dict(reflection_provenance)
    return receipt


def stamp_wave(receipt, wave_provenance):
    receipt["wave"] = dict(wave_provenance)
    return receipt


def stamp_terminal_receipt(receipt, reflection_provenance, wave_provenance):
    stamp_reflection(receipt, reflection_provenance)
    return stamp_wave(receipt, wave_provenance)


class LiveManifest:
    def __init__(self, *, path, ingest_url, experiment_id, dev_sha, examples,
                 baseline_nodes, rank_protocol, gepa_protocol, budget, started,
                 expected_total, reference_lines=(), mirror_path=None,
                 provider="unknown", model="unknown", reflection=None, wave=None):
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
        self.provider = provider
        self.model = model
        self.reflection = dict(reflection) if reflection else None
        self.wave = dict(wave) if wave else None
        self.records = {}
        self.states = {}
        self.confirmations = {}
        self.terminal = {}
        self._lock = threading.Lock()

    def stop(self, *, state, outcome, reason, distinct_prompt_count):
        with self._lock:
            self.terminal = {
                "state": state,
                "outcome": outcome,
                "stop_reason": reason,
                "distinct_prompt_count": distinct_prompt_count,
                "promotion_blocked": True,
            }
        return self.publish()

    def finalize_completed(self, *, selected_winner, confirmations):
        with self._lock:
            self.terminal = {
                "state": "completed",
                "selected_winner": selected_winner,
                "confirmations": list(confirmations),
                "stage2_executed": True,
            }
        return self.publish()

    def update(self, node_id, **values):
        with self._lock:
            self.states.setdefault(node_id, {}).update(values)
        return self.publish()

    def sync_records(self, records):
        with self._lock:
            self.records.update(records)
            # Branch receipts become terminal independently. Publish that fact
            # immediately instead of leaving a finished island white until the
            # slowest sibling joins.
            for node_id, rec in records.items():
                state = self.states.setdefault(node_id, {})
                if rec.get("status") == "completed" and state.get("status") in em.IN_PROGRESS_STAGES:
                    state.update(status="completed", outcome="screening_complete")
                elif rec.get("status") == "failed" and state.get("status") in em.IN_PROGRESS_STAGES:
                    category, reason = classify_failure(rec)
                    state.update(status="failed", outcome="failed",
                                 failure_category=category, failure_reason=reason)
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
        if status in {"completed", "promoted"} and state.get("confirmation"):
            conf = state["confirmation"]
            score = conf.get("mean_score")
            protocol = self.rank_protocol
            rank_eligible = bool(conf.get("confirmed") and score is not None)
            predictions = conf.get("predictions")
        provenance = {
            "phase": phase,
            "strategy": state.get("strategy"),
            "screening_score": rec.get("selected_screening_score", rec.get("screening_best_score")),
            "gepa_best_screening_score": rec.get("screening_best_score"),
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
            terminal = dict(self.terminal)
        nodes = list(self.baseline_nodes)
        for node_id in sorted(states):
            nodes.append(self._node(node_id, states[node_id], records.get(node_id, {})))
        snap = self.budget.snapshot()
        failures = []
        for node_id, state in states.items():
            if state.get("failure_reason"):
                failures.append({"node_id": node_id, "category": state.get("failure_category"),
                                 "reason": state.get("failure_reason")})
        island_walls = sorted(float(rec["wall_clock_s"]) for rec in records.values()
                              if isinstance(rec.get("wall_clock_s"), (int, float)))
        rollout_latencies = []
        rollout_statuses = {}
        for rec in records.values():
            ledger = Path(rec.get("run_dir", "")) / "progress.jsonl"
            if not ledger.is_file():
                continue
            for line in ledger.read_text().splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("kind") != "episode":
                    continue
                if isinstance(event.get("latency_s"), (int, float)):
                    rollout_latencies.append(float(event["latency_s"]))
                status = str(event.get("status") or "unknown")
                rollout_statuses[status] = rollout_statuses.get(status, 0) + 1
        rollout_latencies.sort()
        def percentile(values, q):
            if not values:
                return None
            return values[min(len(values) - 1, round((len(values) - 1) * q))]
        totals = {
            "state": terminal.get("state") or ("completed" if states and all(s.get("status") in em.TERMINAL_STAGES for s in states.values()) else "running"),
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
            "rollout_latency_s": {"p50": percentile(rollout_latencies, .50),
                                  "p95": percentile(rollout_latencies, .95),
                                  "max": max(rollout_latencies) if rollout_latencies else None,
                                  "samples": len(rollout_latencies)},
            "island_wall_s": {"p50": percentile(island_walls, .50),
                              "p95": percentile(island_walls, .95),
                              "samples": len(island_walls)},
            "rollout_statuses": rollout_statuses,
            "cost_usd": None,
            "cost_coverage": "out_of_band_clickhouse",
            "holdout_executed": False,
            "serving": {"provider": self.provider, "model": self.model},
            "reflection": self.reflection,
            "wave": self.wave,
        }
        totals.update(terminal)
        manifest = em.build_manifest(
            experiment=self.experiment_id, dev_split_sha256=self.dev_sha,
            rank_protocol=self.rank_protocol, nodes=nodes,
            reference_lines=self.reference_lines, totals=totals,
            holdout_untouched=True,
        )
        manifest["reflection"] = self.reflection
        manifest["wave"] = self.wave
        em.write_manifest(manifest, self.path)
        if self.mirror_path:
            em.write_manifest(manifest, self.mirror_path)
        status = ("graph-silent" if not self.ingest_url
                  else em.publish_run_shaped(manifest, self.examples, self.ingest_url))
        return {"manifest": str(self.path), "ingest": status, "totals": totals}


def run_parallel(specs, *, seed_prompts, subsets, train, sidecar, budget, runs_root,
                 experiment_id, reflection_key, max_metric_calls, concurrency,
                 spend_authorization_usd, live, phase, episode_cap,
                 reflection_cap,
                 student_model, student_api_base, student_api_key, student_headers,
                 reflection_model="openai/kimi-k3",
                 reflection_base_url="https://api.understudylabs.com/v1",
                 reflection_headers=None,
                 reflection_provider_label="understudy-gateway"):
    results = {}
    lock = threading.Lock()
    threads = []
    for bid, strategy, seed, subset_index in specs:
        subset = subsets[subset_index]
        budget.register_branch(bid, episode_cap, reflection_cap, time.time() + 3600)
        live.update(bid, label=f"{strategy.replace('_', ' ').title()} · {bid}", phase=phase,
                    strategy=strategy, status="screening", episodes_expected=episode_cap,
                    parent="wave1-winner")
        thread = threading.Thread(target=run_branch, kwargs={
            "bid": bid, "seed": seed, "subset": subset, "trainset": train,
            "seed_prompt": seed_prompts[bid], "sidecar": sidecar, "budget": budget,
            "runs_root": runs_root, "run_id": f"{experiment_id}-{bid}",
            "reflection_key": reflection_key, "max_metric_calls": max_metric_calls,
            "concurrency": concurrency, "spend_authorization_usd": spend_authorization_usd,
            "results": results, "results_lock": lock, "strategy": strategy,
            "student_model": student_model, "student_api_base": student_api_base,
            "student_api_key": student_api_key, "student_headers": student_headers,
            "reflection_model": reflection_model,
            "reflection_base_url": reflection_base_url,
            "reflection_headers": reflection_headers,
            "reflection_provider_label": reflection_provider_label,
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
    parser.add_argument("--provider-label", default="tinker",
                        help="non-secret provider label persisted in the experiment manifest")
    parser.add_argument("--api-key-env", default="FIREWORKS_API_KEY",
                        help="environment variable used by canonical remote rollout; value is never persisted")
    parser.add_argument("--project", default="",
                        help="Understudy project header for canonical rollout")
    parser.add_argument("--workload", default="",
                        help="Understudy workload header for canonical rollout")
    parser.add_argument("--student-model", default="openai/nemotron-3-nano-base")
    parser.add_argument("--student-base-url", default="http://127.0.0.1:8099/v1")
    parser.add_argument("--student-api-key-env", default="",
                        help="environment variable used by GEPA student calls; local shim needs none")
    parser.add_argument("--student-project", default="",
                        help="Understudy project header for GEPA student calls")
    parser.add_argument("--student-workload", default="",
                        help="Understudy workload header for GEPA student calls")
    parser.add_argument("--reflection-model", default="openai/kimi-k3")
    parser.add_argument("--reflection-base-url", default="https://api.understudylabs.com/v1")
    parser.add_argument("--reflection-provider-label", default="understudy-gateway")
    parser.add_argument("--reflection-api-key-env", default="UNDERSTUDY_API_KEY",
                        help="environment variable used by GEPA reflection calls; value is never persisted")
    parser.add_argument("--reflection-project", default="rehearsal")
    parser.add_argument("--reflection-workload", default="main")
    parser.add_argument("--island-plan", choices=(
        "legacy", "wave3-abstain", "wave4-state-transition", "wave5-dense-transition",
    ), default="legacy")
    parser.add_argument("--wave", type=int, default=1)
    parser.add_argument("--parent-run", default="")
    parser.add_argument("--parent-winner-sha", default="")
    parser.add_argument("--failure-family", default="")
    parser.add_argument("--sentinels-per-family", type=int, default=2)
    parser.add_argument("--target-score", type=float, default=0.0)
    parser.add_argument("--seed-prompt", required=True)
    parser.add_argument("--runs-root", default=str(Path.home() / ".di-runs"))
    parser.add_argument("--experiment-id", default="")
    parser.add_argument("--stage1-episodes", type=int, default=16,
                        help="physical episode cap; >= stage1 metric calls + 2*screening valset size")
    parser.add_argument("--stage2-episodes", type=int, default=28,
                        help="physical episode cap; >= stage2 metric calls + 2*screening valset size")
    parser.add_argument("--stage1-metric-calls", type=int, default=12)
    parser.add_argument("--stage2-metric-calls", type=int, default=24)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-total-reflections", type=int, default=128,
                        help="global ceiling; Stage 1 islands get 8 each and Stage 2 survivors 16 each")
    parser.add_argument("--spend-authorization-usd", type=float, default=1000.0)
    parser.add_argument("--allow-unmetered-cost", action="store_true")
    parser.add_argument("--ingest-url", default="http://127.0.0.1:5151/ingest")
    parser.add_argument("--manifest-mirror", default="",
                        help="optional dashboard manifest path, atomically refreshed on every heartbeat")
    parser.add_argument("--wave1-seed-canonical", required=True)
    parser.add_argument("--wave1-winner-canonical", required=True)
    parser.add_argument("--parent-winner-canonical", default="")
    args = parser.parse_args()
    if not args.allow_unmetered_cost:
        raise FuseTripped("--allow-unmetered-cost required")
    student_is_local = args.student_base_url.startswith(("http://127.0.0.1", "http://localhost"))
    student_api_key = (
        os.environ.get(args.student_api_key_env) if args.student_api_key_env
        else ("local-shim" if student_is_local else None)
    )
    if not student_api_key:
        raise RuntimeError(
            "--student-api-key-env must name a populated environment variable for a remote student endpoint"
        )
    student_headers = {}
    if args.student_project:
        student_headers["x-understudy-project"] = args.student_project
    if args.student_workload:
        student_headers["x-understudy-workload"] = args.student_workload
    if not args.base_url.startswith(("http://127.0.0.1", "http://localhost")):
        if not os.environ.get(args.api_key_env):
            raise RuntimeError(f"{args.api_key_env} is required for canonical remote rollout")
    reflection_key = os.environ.get(args.reflection_api_key_env)
    if not reflection_key and args.reflection_api_key_env == "UNDERSTUDY_API_KEY":
        reflection_key = os.environ.get("FIREWORKS_API_KEY")
    if not reflection_key:
        raise RuntimeError(
            f"{args.reflection_api_key_env} is required for GEPA reflection calls"
        )
    reflection_headers = {}
    if args.reflection_project:
        reflection_headers["x-understudy-project"] = args.reflection_project
    if args.reflection_workload:
        reflection_headers["x-understudy-workload"] = args.reflection_workload
    reflection_provenance = {
        "provider": args.reflection_provider_label,
        "model": args.reflection_model,
        "project": args.reflection_project,
        "workload": args.reflection_workload,
        "api_key_env": args.reflection_api_key_env,
    }
    for split in ("train", "dev"):
        assert_split_allowed(split)

    repo_root = Path(__file__).resolve().parents[3]
    experiment_id = args.experiment_id or time.strftime("islands-%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = Path(args.runs_root) / experiment_id
    out_dir.mkdir(parents=True, exist_ok=False)
    manifest_path = out_dir / "experiment-manifest.json"
    seed_prompt = Path(args.seed_prompt).read_text()
    train = call_json(args.sidecar, "/pool?split=train")["tasks"]
    island_specs = island_specs_for_plan(args.island_plan)
    curriculum = None
    train_for_gepa = train
    if args.failure_family:
        curriculum = failure_family_curriculum(
            train, args.failure_family, args.sentinels_per_family,
        )
        train_for_gepa = curriculum["tasks"]
    wave_provenance = {
        "wave": args.wave,
        "parent_run": args.parent_run,
        "parent_winner_sha256": args.parent_winner_sha,
        "failure_family": args.failure_family,
        "curriculum_sha256": curriculum["curriculum_sha256"] if curriculum else None,
        "valset_sha256": None,
        "sentinels_per_family": args.sentinels_per_family,
        "island_plan": args.island_plan,
        "target_score": args.target_score,
        "seed_prompt_sha256": prompt_sha(seed_prompt),
        "strategies": sorted({strategy for _, strategy, _, _ in island_specs}),
        "strategy_sha256": hashlib.sha256(
            ",".join(sorted({strategy for _, strategy, _, _ in island_specs})).encode()
        ).hexdigest(),
        "source_commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(repo_root), check=True,
            text=True, capture_output=True,
        ).stdout.strip(),
    }
    dev_payload = call_json(args.sidecar, "/pool?split=dev")
    dev, dev_sha = dev_payload["tasks"], dev_payload["split_sha256"]
    targeted_plan = args.island_plan in {
        "wave3-abstain", "wave4-state-transition", "wave5-dense-transition",
    }
    subsets = (
        failure_family_screening_subsets(
            train, args.failure_family, args.sentinels_per_family,
        ) if args.island_plan in {"wave4-state-transition", "wave5-dense-transition"}
        else train_screening_subsets(train) if args.island_plan == "wave3-abstain"
        else stratified_screening_subsets(dev)
    )
    if targeted_plan:
        wave_provenance["valset_sha256"] = screening_valset_hash(subsets)
    if args.island_plan == "wave4-state-transition":
        shaping_contract = {
            "scope": "train_screening_only",
            "primary": "authoritative_reward",
            "tie_breaks": [
                "failure_family_mean", "route_regression_guard", "forbidden_effects",
                "malformed", "steps", "candidate_diversity", "latency",
            ],
            "canonical_scorer_modified": False,
        }
        wave_provenance["shaping_contract"] = shaping_contract
        wave_provenance["shaping_contract_sha256"] = hashlib.sha256(
            json.dumps(shaping_contract, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    if args.island_plan == "wave5-dense-transition":
        shaping_contract = {
            "scope": "train_screening_only",
            "primary": "authoritative_reward",
            "dense_reward": "ordered_state_transition_milestones",
            "milestones": [
                "get_tickets", "resolve_addressed_requester_domain",
                "get_accounts_or_contacts", "exact_character_for_character_comparison",
                "patch_addressed_ticket", "finish_after_transition",
            ],
            "tie_breaks": [
                "unmatched_family_dense_mean", "route_regression_guard",
                "forbidden_effects_asc", "state_transition_partial_desc",
                "malformed_asc", "steps_asc", "latency_asc",
            ],
            "fail_closed": "forbidden_or_wrong_ticket_patch_dense_reward_zero",
            "canonical_scorer_modified": False,
            "source_commit": wave_provenance["source_commit"],
        }
        wave_provenance["shaping_contract"] = shaping_contract
        wave_provenance["shaping_contract_sha256"] = hashlib.sha256(
            json.dumps(shaping_contract, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    screening_size = len(subsets[0]["tasks"])
    required_stage1 = required_physical_episode_cap(args.stage1_metric_calls, screening_size)
    required_stage2 = required_physical_episode_cap(args.stage2_metric_calls, screening_size)
    if args.stage1_episodes < required_stage1 or args.stage2_episodes < required_stage2:
        raise FuseTripped(
            "physical episode caps are below GEPA 0.1.4 worst-case accepted-candidate "
            f"headroom: stage1>={required_stage1}, stage2>={required_stage2}"
        )
    seed_canonical = json.loads(Path(args.wave1_seed_canonical).read_text())
    winner_canonical = json.loads(Path(args.wave1_winner_canonical).read_text())
    parent_canonical = (
        json.loads(Path(args.parent_winner_canonical).read_text())
        if args.parent_winner_canonical else winner_canonical
    )
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
    stage1_total = len(island_specs) * args.stage1_episodes
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
                        mirror_path=args.manifest_mirror or None,
                        provider=args.provider_label, model=args.model,
                        reflection=reflection_provenance, wave=wave_provenance)
    stage1_prompts = {bid: seed_prompt for bid, *_ in island_specs}
    stage1 = run_parallel(island_specs, seed_prompts=stage1_prompts, subsets=subsets,
                          train=train_for_gepa, sidecar=args.sidecar, budget=budget,
                          runs_root=args.runs_root, experiment_id=experiment_id,
                          reflection_key=reflection_key, max_metric_calls=args.stage1_metric_calls,
                          concurrency=args.concurrency, spend_authorization_usd=args.spend_authorization_usd,
                          live=live, phase="stage1", episode_cap=args.stage1_episodes,
                          reflection_cap=8,
                          student_model=args.student_model, student_api_base=args.student_base_url,
                          student_api_key=student_api_key, student_headers=student_headers,
                          reflection_model=args.reflection_model,
                          reflection_base_url=args.reflection_base_url,
                          reflection_headers=reflection_headers,
                          reflection_provider_label=args.reflection_provider_label)
    incomplete = incomplete_branch_ids(island_specs, stage1)
    if incomplete:
        reason = ("scheduled branches lacked completed receipts: "
                  + ", ".join(incomplete))
        snapshot = live.stop(state="invalid_execution", outcome="incomplete_stage1",
                             reason=reason, distinct_prompt_count=None)
        receipt = stamp_terminal_receipt(build_invalid_execution_receipt(
            experiment_id=experiment_id, dev_sha=dev_sha, islands=stage1,
            incomplete_branches=incomplete, budget=budget.snapshot(),
            manifest_path=manifest_path,
            manifest_digest=em.manifest_digest(json.loads(manifest_path.read_text())),
            publish_status=snapshot["ingest"], wall_clock_s=round(time.time() - started),
        ), reflection_provenance, wave_provenance)
        write_terminal_artifacts(out_dir, receipt, stage1)
        print(json.dumps(receipt, indent=2))
        return
    dedup_annotations = global_dedup_annotations(stage1.values())
    for bid, representative in dedup_annotations.items():
        if representative is not None:
            live.update(
                bid, status="rejected", outcome="global_prompt_deduplication",
                dedup_of=representative, failure_category="duplicate_prompt",
                failure_reason=f"identical prompt hash; representative={representative}",
            )
    unique = unique_ranked(stage1.values())
    if targeted_plan:
        representatives = [
            rec for rec in stage1.values()
            if dedup_annotations.get(rec.get("branch_id")) is None
        ]
        unique = family_aware_ranked(
            representatives,
            primary_reward_first=args.island_plan == "wave4-state-transition",
            dense_transition=args.island_plan == "wave5-dense-transition",
        )
    if len(unique) < 2:
        if targeted_plan:
            missing = sorted(
                rec["branch_id"] for rec in stage1.values()
                if rec.get("status") == "completed"
                and not rec.get("screening_subscores_available")
            )
            reason = (
                "wave3 regression guard needs two eligible completed prompts; "
                f"got {len(unique)}"
            )
            if missing:
                reason += "; missing per-instance subscores: " + ", ".join(missing)
        else:
            reason = f"successive halving needs two distinct completed prompts; got {len(unique)}"
        snapshot = live.stop(state="stopped_no_distinct_candidates",
                             outcome="no_distinct_candidates", reason=reason,
                             distinct_prompt_count=len(unique))
        receipt = stamp_terminal_receipt(build_no_distinct_receipt(
            experiment_id=experiment_id, dev_sha=dev_sha, islands=stage1,
            distinct_prompt_count=len(unique), budget=budget.snapshot(),
            manifest_path=manifest_path,
            manifest_digest=em.manifest_digest(json.loads(manifest_path.read_text())),
            publish_status=snapshot["ingest"], wall_clock_s=round(time.time() - started),
            stop_reason=reason,
        ), reflection_provenance, wave_provenance)
        write_terminal_artifacts(out_dir, receipt, stage1)
        print(json.dumps(receipt, indent=2))
        return
    survivors = unique[:2]
    survivor_ids = {rec["branch_id"] for rec in survivors}
    for bid, rec in stage1.items():
        if (rec.get("status") == "completed" and bid not in survivor_ids
                and dedup_annotations.get(bid) is None):
            live.update(bid, status="rejected", outcome="successive_halving", failure_category="not_selected",
                        failure_reason="lower screening rank or globally deduplicated")

    stage2_specs, stage2_prompts = [], {}
    for index, rec in enumerate(survivors, 1):
        bid = f"survivor-{index}"
        strategy = f"exploit_{rec['branch_id']}"
        stage2_specs.append((bid, strategy, 900000 + index, 1 - (index - 1) % 2))
        stage2_prompts[bid] = Path(rec["optimized_prompt_path"]).read_text()
    stage2 = run_parallel(stage2_specs, seed_prompts=stage2_prompts, subsets=subsets,
                          train=train_for_gepa, sidecar=args.sidecar, budget=budget,
                          runs_root=args.runs_root, experiment_id=experiment_id,
                          reflection_key=reflection_key, max_metric_calls=args.stage2_metric_calls,
                          concurrency=args.concurrency, spend_authorization_usd=args.spend_authorization_usd,
                          live=live, phase="stage2", episode_cap=args.stage2_episodes,
                          reflection_cap=16,
                          student_model=args.student_model, student_api_base=args.student_base_url,
                          student_api_key=student_api_key, student_headers=student_headers,
                          reflection_model=args.reflection_model,
                          reflection_base_url=args.reflection_base_url,
                          reflection_headers=reflection_headers,
                          reflection_provider_label=args.reflection_provider_label)

    incomplete2 = incomplete_branch_ids(stage2_specs, stage2)
    if incomplete2:
        reason = ("scheduled Stage-2 survivors lacked completed receipts: "
                  + ", ".join(incomplete2))
        snapshot = live.stop(
            state="invalid_execution", outcome="incomplete_stage2", reason=reason,
            distinct_prompt_count=len(unique),
        )
        receipt = stamp_terminal_receipt(build_invalid_execution_receipt(
            experiment_id=experiment_id, dev_sha=dev_sha, islands=stage1,
            incomplete_branches=incomplete2, budget=budget.snapshot(),
            manifest_path=manifest_path,
            manifest_digest=em.manifest_digest(json.loads(manifest_path.read_text())),
            publish_status=snapshot["ingest"], wall_clock_s=round(time.time() - started),
            survivors=stage2, outcome="incomplete_stage2", stop_reason=reason,
        ), reflection_provenance, wave_provenance)
        write_terminal_artifacts(out_dir, receipt, stage1, stage2)
        print(json.dumps(receipt, indent=2))
        return

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
                                       repo_root=repo_root, k=K, api_key_env=args.api_key_env,
                                       project=args.project or None, workload=args.workload or None)
            canonical_cache[sha] = result
            deduped = False
        conf = {"branch_id": bid, "confirmed": True, "deduped": deduped,
                "mean_score": result["mean_score"], "malformed_rate": result.get("malformed_rate"),
                "wall_clock_s": result.get("wall_clock_s"), "winner_prompt_sha256": sha,
                "predictions": em.predictions_from_canonical(result, dev),
                "mean_by_family": result.get("mean_by_family")}
        if targeted_plan:
            conf["promotion_eligible"] = canonical_promotion_eligible(
                conf, parent_canonical.get("mean_by_family"),
            )
        confirmations.append(conf)
        live.update(bid, status="completed", outcome="canonical_k3_complete", confirmation=conf)

    winner = select_winner(
        confirmations,
        eligible=(
            (lambda conf: conf.get("promotion_eligible", False))
            if targeted_plan else None
        ),
    )
    if winner:
        live.update(winner["branch_id"], status="promoted", outcome="promoted_canonical_k3",
                    confirmation=winner)
    snapshot = live.finalize_completed(
        selected_winner=winner, confirmations=confirmations,
    )
    receipt = stamp_terminal_receipt({
        "schema_version": "understudy.island_race_receipt.v1",
        "experiment_id": experiment_id,
        "state": "completed",
        "outcome": "completed_with_no_promotion" if winner is None else "completed",
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
    }, reflection_provenance, wave_provenance)
    write_terminal_artifacts(out_dir, receipt, stage1, stage2)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
