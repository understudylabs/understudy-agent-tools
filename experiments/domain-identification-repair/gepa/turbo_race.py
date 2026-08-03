#!/usr/bin/env python3
"""Turbo two-stage train/dev-only GEPA race for the domain-identification slice.

Stage A: TWO independent GEPA branches run concurrently, each seeded from the
completed wave-1 winner prompt, each screening on a deterministic, hash-bound,
complementary 4-task stratified dev subset (one task per family). Distinct seeds,
distinct immutable run dirs, samples_per_eval=1.

Stage B: each branch winner is confirmed canonically on the full 8-task dev set
at k=3 via rollout.mjs (the exact serving contract, OFF the adapter path). The
incumbent's existing canonical dev receipt is reused rather than rerun. Selection
is strictly by full-dev canonical score, tie-break malformed rate then latency.
No partial promotion: only a fully-confirmed candidate can be promoted.

Global budget accounting is ATOMIC and all-or-nothing under a single lock:
  * Stage-A per-branch episodes <= 36
  * Stage-A global episodes <= 72 (rejected before they can invade the escrow)
  * Stage-B confirmation escrow = 48 (2 distinct winners x 24), reserved up front
  * total hard cap = 120 new student episodes; global reflections <= 8

This run NEVER touches a holdout. It is train/dev only. There is NO new
orchestration/control layer beyond this file; visualization is a separate,
read-only manifest.
"""
import argparse
import hashlib
import importlib.metadata
import inspect
import json
import os
import re
import subprocess
import threading
import time
import traceback
from pathlib import Path

# Isolated runtime glue: reuse the audited wave-1 primitives verbatim.
import optimize
from optimize import (
    ConcurrencyController,
    ContractAdapter,
    FuseTripped,
    InvalidServicePressure,
    ProgressLedger,
    assert_split_allowed,
    call_json,
    candidate_hash,
    prepare_run_dir,
)

STAGE_B_K = 3
STAGE_B_EPISODES_PER_WINNER = 8 * STAGE_B_K  # full dev (8 tasks) x k=3 = 24


# ---------------------------------------------------------------------------
# Global budget: single-lock, all-or-nothing admission with a reserved Stage-B
# confirmation escrow that Stage-A can never invade.
# ---------------------------------------------------------------------------
class GlobalBudget:
    """One lock guards BOTH global totals and per-branch counters, so every
    admission is atomic and all-or-nothing: a global-cap rejection never touches
    a branch counter and a branch-cap rejection never touches the global counter.

    Episode capacity is partitioned so confirmation is always affordable:
        stage_a_global_cap + stage_b_escrow == max_total_episodes
    Stage-A reservations are refused once Stage-A usage would exceed
    stage_a_global_cap, which structurally protects the escrow.
    """

    def __init__(self, max_total_episodes=120, stage_a_global_cap=72,
                 stage_b_escrow=48, max_total_reflections=8):
        if stage_a_global_cap + stage_b_escrow != max_total_episodes:
            raise ValueError("stage_a_global_cap + stage_b_escrow must equal max_total_episodes")
        self.max_total_episodes = max_total_episodes
        self.stage_a_global_cap = stage_a_global_cap
        self.stage_b_escrow = stage_b_escrow
        self.max_total_reflections = max_total_reflections
        self._lock = threading.Lock()
        self.stage_a_reserved = 0
        self.stage_a_completed = 0
        self.stage_b_reserved = 0
        self.total_reflections = 0
        self._branches = {}  # bid -> counters/caps

    def register_branch(self, bid, max_episodes, max_reflections, wall_deadline=None):
        with self._lock:
            if bid in self._branches:
                raise FuseTripped(f"branch already registered: {bid}")
            self._branches[bid] = {
                "max_episodes": max_episodes,
                "max_reflections": max_reflections,
                "episodes_reserved": 0,
                "episodes_completed": 0,
                "reflections": 0,
                "wall_deadline": wall_deadline,
                "confirm_reserved": 0,
                "confirm_released": 0,
                "confirm_consumed": 0,
            }

    # -- Stage A: one physical student episode -----------------------------
    def reserve_episode(self, bid):
        """Atomic Stage-A admission. Raises FuseTripped (nothing mutated) if the
        branch wall deadline passed, the branch cap is hit, or the reservation
        would push Stage-A usage past its global cap (i.e. invade the escrow)."""
        with self._lock:
            b = self._branches[bid]
            if b["wall_deadline"] is not None and time.time() >= b["wall_deadline"]:
                raise FuseTripped(f"branch {bid} wall fuse")
            if b["episodes_reserved"] >= b["max_episodes"]:
                raise FuseTripped(
                    f"branch {bid} episode cap {b['max_episodes']}")
            if self.stage_a_reserved >= self.stage_a_global_cap:
                raise FuseTripped(
                    f"stage-A global cap {self.stage_a_global_cap} (escrow protected)")
            # Both checks passed: increment both counters together.
            self.stage_a_reserved += 1
            b["episodes_reserved"] += 1
            return self.stage_a_reserved, b["episodes_reserved"]

    def complete_episode(self, bid):
        with self._lock:
            self.stage_a_completed += 1
            self._branches[bid]["episodes_completed"] += 1

    def note_reflection(self, bid):
        with self._lock:
            b = self._branches[bid]
            if b["reflections"] >= b["max_reflections"]:
                raise FuseTripped(f"branch {bid} reflection cap {b['max_reflections']}")
            if self.total_reflections >= self.max_total_reflections:
                raise FuseTripped(f"global reflection cap {self.max_total_reflections}")
            self.total_reflections += 1
            b["reflections"] += 1
            return self.total_reflections

    # -- Stage B: per-branch confirmation reservation from the escrow --------
    def reserve_confirmation(self, bid, n=STAGE_B_EPISODES_PER_WINNER):
        """All-or-nothing reserve of n episodes for ONE branch's confirmation.

        Guards (validated BEFORE any mutation, so no partial reservation):
          * n must be within a single winner's allocation (<= per-winner cap);
          * the branch must not already hold an outstanding reservation
            (duplicate reservation refused — one branch cannot grab 48 and
            starve the other winner);
          * the global escrow must have room.
        Returns True on success, False otherwise (counts unchanged on False)."""
        with self._lock:
            b = self._branches[bid]
            outstanding = b["confirm_reserved"] - b["confirm_released"] - b["confirm_consumed"]
            if n <= 0 or n > STAGE_B_EPISODES_PER_WINNER:
                return False
            if outstanding > 0:
                return False  # duplicate reservation for the same branch
            if self.stage_b_reserved + n > self.stage_b_escrow:
                return False
            self.stage_b_reserved += n
            b["confirm_reserved"] += n
            return True

    def mark_confirmation_dispatched(self, bid):
        """Mark a branch's reserved confirmation as CONSUMED (Stage-B dispatched).
        After this, the allocation can no longer be released."""
        with self._lock:
            b = self._branches[bid]
            outstanding = b["confirm_reserved"] - b["confirm_released"] - b["confirm_consumed"]
            if outstanding <= 0:
                raise FuseTripped(f"branch {bid} has no outstanding confirmation to dispatch")
            b["confirm_consumed"] += outstanding
            return b["confirm_consumed"]

    def release_confirmation(self, bid, n=STAGE_B_EPISODES_PER_WINNER):
        """Release an UNUSED confirmation allocation (winner deduped to a cached
        score, or branch failed). LEGAL ONLY BEFORE Stage-B dispatch: once the
        allocation is consumed it cannot be released. Returns episodes released."""
        with self._lock:
            b = self._branches[bid]
            outstanding = b["confirm_reserved"] - b["confirm_released"] - b["confirm_consumed"]
            if outstanding <= 0:
                return 0  # nothing releasable (never reserved, or already dispatched)
            give = min(n, outstanding)
            self.stage_b_reserved -= give
            b["confirm_released"] += give
            return give

    def snapshot(self):
        with self._lock:
            return {
                "max_total_episodes": self.max_total_episodes,
                "stage_a_global_cap": self.stage_a_global_cap,
                "stage_b_escrow": self.stage_b_escrow,
                "max_total_reflections": self.max_total_reflections,
                "stage_a_reserved": self.stage_a_reserved,
                "stage_a_completed": self.stage_a_completed,
                "stage_b_reserved": self.stage_b_reserved,
                "total_reflections": self.total_reflections,
                "total_reserved": self.stage_a_reserved + self.stage_b_reserved,
                "branches": {bid: dict(b) for bid, b in self._branches.items()},
            }


class BranchFuse:
    """RunFuse-compatible shim the ContractAdapter can drive. Episode/reflection
    admission is delegated to the shared GlobalBudget (single atomic lock); the
    wall deadline is enforced there too. Student compute is unmetered; that is
    accepted explicitly, matching the audited wave-1 fuse semantics."""

    def __init__(self, budget, bid, allow_unmetered_student=True,
                 spend_authorization_usd=None):
        self.budget = budget
        self.bid = bid
        self.allow_unmetered_student = allow_unmetered_student
        self.spend_authorization_usd = spend_authorization_usd
        self.cost_coverage = "out_of_band_clickhouse"
        self.in_process_dollar_fuse = False

    def preflight(self):
        if not self.allow_unmetered_student:
            raise FuseTripped(
                "student compute is unmetered; pass allow_unmetered_student to accept "
                "the episode/reflection/wall bounds as the only in-process controls")
        return self

    def reserve_episode(self):
        return self.budget.reserve_episode(self.bid)

    def complete_episode(self):
        return self.budget.complete_episode(self.bid)

    def note_reflection(self):
        return self.budget.note_reflection(self.bid)

    def snapshot(self):
        snap = self.budget.snapshot()
        b = snap["branches"][self.bid]
        return {
            "branch_id": self.bid,
            "episodes_reserved": b["episodes_reserved"],
            "episodes_completed": b["episodes_completed"],
            "reflection_calls": b["reflections"],
            "cost_coverage": self.cost_coverage,
            "in_process_dollar_fuse": self.in_process_dollar_fuse,
            "reflection_spent_usd": None,
            "total_cost_usd": None,
            "student_compute_metered": False,
            "spend_authorization_usd": self.spend_authorization_usd,
            "global": {k: snap[k] for k in (
                "stage_a_reserved", "stage_a_global_cap", "stage_b_reserved",
                "stage_b_escrow", "total_reserved", "max_total_episodes",
                "total_reflections", "max_total_reflections")},
        }


# ---------------------------------------------------------------------------
# Deterministic, hash-bound, complementary stratified dev screening subsets.
# ---------------------------------------------------------------------------
def _family_of(task_id):
    return re.sub(r"-\d+$", "", task_id)


def stratified_screening_subsets(dev_tasks):
    """Return two complementary subsets (branch_a, branch_b), each with exactly
    one deterministically-chosen task from EVERY family present in the dev pool.
    Families are inferred from the task ids (no hard-coded identifiers). Branch A
    takes each family's lowest-id task, branch B the next — disjoint,
    family-complete, order-independent. Each subset is returned with a hash bound
    to its sorted task ids."""
    by_family = {}
    for task in dev_tasks:
        by_family.setdefault(_family_of(task["task_id"]), []).append(task)
    families = sorted(by_family)
    branch_a, branch_b = [], []
    for fam in families:
        members = sorted(by_family[fam], key=lambda t: t["task_id"])
        if len(members) < 2:
            raise ValueError(f"family {fam} needs >=2 dev tasks for complementary rotation")
        branch_a.append(members[0])
        branch_b.append(members[1])
    return (
        {"tasks": branch_a, "subset_sha256": subset_hash(branch_a),
         "families": list(families)},
        {"tasks": branch_b, "subset_sha256": subset_hash(branch_b),
         "families": list(families)},
    )


def train_screening_subsets(train_tasks):
    """Build the Wave-3 train-only, complementary four-task screen."""
    subsets = stratified_screening_subsets(train_tasks)
    for subset in subsets:
        subset["valset_sha256"] = subset["subset_sha256"]
    return subsets


def failure_family_screening_subsets(train_tasks, failure_family, sentinels_per_family=2):
    """Hash-bound train-only screen with every target row plus route sentinels."""
    curriculum = failure_family_curriculum(train_tasks, failure_family, sentinels_per_family)
    tasks = curriculum["tasks"]
    families = sorted({_family_of(task["task_id"]) for task in tasks})
    subset = {"tasks": tasks, "subset_sha256": subset_hash(tasks),
              "valset_sha256": subset_hash(tasks), "families": families}
    return dict(subset), dict(subset)


def screening_valset_hash(subsets):
    task_ids = sorted(
        task["task_id"] for subset in subsets for task in subset["tasks"]
    )
    return hashlib.sha256(",".join(task_ids).encode("utf-8")).hexdigest()


def subset_hash(tasks):
    ids = ",".join(sorted(t["task_id"] for t in tasks))
    return hashlib.sha256(ids.encode("utf-8")).hexdigest()


def failure_family_curriculum(train_tasks, failure_family, sentinels_per_family):
    """Build a deterministic train-only curriculum around one failure family."""
    if sentinels_per_family < 0:
        raise ValueError("sentinels_per_family must be non-negative")
    by_family = {}
    for task in train_tasks:
        by_family.setdefault(_family_of(task["task_id"]), []).append(task)
    if failure_family not in by_family:
        raise ValueError(f"failure family not found in train tasks: {failure_family}")
    selected = list(sorted(by_family[failure_family], key=lambda t: t["task_id"]))
    for family in sorted(by_family):
        if family == failure_family:
            continue
        selected.extend(sorted(by_family[family], key=lambda t: t["task_id"])[:sentinels_per_family])
    selected = sorted(selected, key=lambda t: t["task_id"])
    task_ids = [task["task_id"] for task in selected]
    return {
        "tasks": selected,
        "curriculum_sha256": hashlib.sha256(",".join(sorted(task_ids)).encode("utf-8")).hexdigest(),
        "failure_family": failure_family,
        "families": {
            family: sum(_family_of(task_id) == family for task_id in task_ids)
            for family in sorted(set(_family_of(task_id) for task_id in task_ids))
        },
        "sentinels_per_family": sentinels_per_family,
    }


# ---------------------------------------------------------------------------
# Stage A: one GEPA branch.
# ---------------------------------------------------------------------------
REFLECTION_DIRECTIVES = {
    "exploit": (
        "Act as a conservative prompt optimizer. Preserve working behavior and make the smallest "
        "evidence-backed change that fixes the supplied failures. Return a complete candidate prompt."
    ),
    "explore": (
        "Act as a divergent prompt optimizer. Produce a materially different complete prompt, not a "
        "paraphrase or the incumbent unchanged. Explore a new decomposition or decision procedure while "
        "still satisfying the supplied contracts."
    ),
    "failure_targeted": (
        "Act as a failure-cluster specialist. Derive explicit rules from the supplied failing traces, "
        "counterexamples, and grader feedback. Produce a complete candidate prompt that directly targets "
        "those failure modes; do not return the incumbent unchanged."
    ),
    "abstention_policy": (
        "Act as an abstention-policy specialist. The student correctly handles direct, "
        "lookalike, and parent routing but fails to ABSTAIN on unmatched cases. From the "
        "supplied failing TRAIN traces and grader feedback, derive explicit, testable rules "
        "for when and how to emit the correct unmatched-abstain terminal response. Return "
        "a COMPLETE candidate prompt that fixes abstention while preserving the working "
        "routing behavior verbatim. Do not return the incumbent unchanged."
    ),
    "termination_discipline": (
        "Act as a tool-use and termination-discipline specialist. Many abstain failures "
        "come from over-acting, forbidden writes, extra turns, or failing to emit a clean "
        "terminal. From the supplied failing TRAIN traces, produce a COMPLETE candidate "
        "prompt that enforces disciplined stopping and the correct terminal emission for "
        "unmatched-abstain cases, without weakening the correct routing paths."
    ),
    "conservative_exploit": (
        "Act as a conservative optimizer. Make the SMALLEST evidence-backed change to fix "
        "the unmatched-abstain failures while preserving direct/lookalike/parent routing "
        "behavior exactly. Return a complete candidate prompt."
    ),
    "exact_state_transition": (
        "Act as an exact state-transition prompt optimizer. Unmatched is NOT passive abstention. "
        "GET tickets, identify the addressed requester's full domain, GET accounts, compare domains "
        "character-for-character, and when no exact account exists PATCH only the addressed ticket "
        "with {assignee: none, status: unmatched}, then finish. Preserve every working route."
    ),
    "explicit_tool_sequence": (
        "Act as a tool-sequence specialist. Produce a complete prompt with this ordered procedure: "
        "GET tickets; identify the addressed requester; GET accounts; exact full-domain comparison; "
        "on no exact match PATCH only that ticket with assignee none and status unmatched; finish. "
        "Never substitute passive finish and preserve direct, lookalike, and parent routing."
    ),
    "state_transition_crossover": (
        "Act as a conservative crossover optimizer. Preserve incumbent routing and splice in one "
        "explicit unmatched transition: after exact full-domain comparison finds no account, PATCH "
        "only the addressed ticket with {assignee: none, status: unmatched}, then finish."
    ),
    "dense_state_transition": (
        "Act as a dense state-transition specialist. Preserve direct, lookalike, and parent "
        "routing exactly. For unmatched requests, GET the tickets list, resolve the addressed "
        "unowned ticket and requester domain, GET accounts or contacts, compare the complete "
        "domain character-for-character, PATCH only that addressed ticket with "
        '{"assignee":"none","status":"unmatched"}, then finish. Every forbidden or unrelated write is zero.'
    ),
    "explicit_dense_sequence": (
        "Act as an explicit tool-sequence specialist. Preserve all perfect routes verbatim. "
        "For unmatched: GET tickets; resolve the addressed unowned ticket and requester domain; "
        "GET accounts or contacts; compare the full domain character-for-character; if there is "
        'no exact match, PATCH only that ticket with {"assignee":"none","status":"unmatched"}; finish. '
        "Never write another record."
    ),
    "dense_transition_crossover": (
        "Act as a conservative crossover optimizer. Keep the incumbent direct, lookalike, and "
        "parent paths unchanged, adding only this unmatched transition: GET tickets, resolve the "
        "addressed requester domain, GET accounts or contacts, compare exact domains, then PATCH "
        'only the addressed ticket with {"assignee":"none","status":"unmatched"} and finish. '
        "Forbidden or unrelated writes score zero."
    ),
}

REQUIRED_GEPA_VERSION = "0.1.4"


def assert_gepa_runtime():
    """Fail closed unless the optimizer supports strategy-aware acceptance."""
    import gepa

    installed = importlib.metadata.version("gepa")
    if installed != REQUIRED_GEPA_VERSION:
        raise RuntimeError(
            f"gepa=={REQUIRED_GEPA_VERSION} required; found {installed}. "
            "Refusing to silently collapse exploratory ties."
        )
    if "acceptance_criterion" not in inspect.signature(gepa.optimize).parameters:
        raise RuntimeError("gepa.optimize lacks acceptance_criterion; runtime is incompatible")
    return installed


def acceptance_criterion_for_strategy(strategy):
    """Keep tied mutations available to exploratory islands.

    GEPA's default strict-improvement gate discards a syntactically valid
    mutation before it appears in ``result.candidates`` when its minibatch
    score ties the parent. That is appropriate for exploit, but collapses all
    exploration islands back to the incumbent on a coarse four-task score.
    This only controls the screening candidate pool; canonical dev k=3 remains
    the sole promotion gate.
    """
    if is_exploit_strategy(strategy):
        return "strict_improvement"
    return "improvement_or_equal"


def is_exploit_strategy(strategy):
    """Treat lineage-qualified Stage-2 exploit labels as exploit behavior."""
    return strategy in {
        "exploit", "conservative_exploit", "state_transition_crossover",
        "dense_transition_crossover",
    } or strategy.startswith("exploit_")


def make_reflection(fuse, reflection_key, strategy="exploit", *,
                    model="openai/kimi-k3",
                    api_base="https://api.understudylabs.com/v1",
                    extra_headers=None,
                    provider_label="understudy-gateway"):
    import litellm

    def reflection(messages):
        fuse.note_reflection()  # counts + caps (global + branch) BEFORE the spend
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        directive = REFLECTION_DIRECTIVES.get(strategy, REFLECTION_DIRECTIVES["exploit"])
        messages = [{"role": "system", "content": directive}, *messages]
        completion_kwargs = {
            "model": model,
            "messages": messages,
            "api_base": api_base,
            "api_key": reflection_key,
            "temperature": 1.0,
            "max_tokens": 8000,
            "stream": True,
        }
        if extra_headers:
            completion_kwargs["extra_headers"] = extra_headers
        response = litellm.completion(**completion_kwargs)
        return "".join(
            chunk.choices[0].delta.content or ""
            for chunk in response
            if chunk.choices and chunk.choices[0].delta
        )

    return reflection


def select_strategy_candidate(result, seed_prompt, strategy):
    """Select a branch output without confusing exploration with promotion.

    Exploit keeps GEPA's best candidate. Explore modes may retain a distinct,
    near-best generated candidate so independent islands do not all collapse
    back to the incumbent before global deduplication. These are still
    screening-only; canonical k=3 remains the sole promotion evidence.
    """
    candidates = list(result.candidates)
    scores = [float(score) for score in result.val_aggregate_scores]
    best_idx = result.best_idx
    if not candidates or len(candidates) != len(scores):
        return result.best_candidate, max(scores) if scores else None, "gepa_best", best_idx
    best_score = max(scores)
    if is_exploit_strategy(strategy):
        return result.best_candidate, best_score, "gepa_best", best_idx
    max_drop = 0.10 if strategy == "explore" else 0.25
    seed_hash = hashlib.sha256((seed_prompt.rstrip() + "\n").encode()).hexdigest()
    eligible = []
    for index, (candidate, score) in enumerate(zip(candidates, scores)):
        prompt = candidate.get("system_prompt", "")
        candidate_sha = hashlib.sha256((prompt.rstrip() + "\n").encode()).hexdigest()
        if prompt and candidate_sha != seed_hash and score >= best_score - max_drop:
            eligible.append((score, index, candidate))
    if not eligible:
        return result.best_candidate, best_score, "gepa_best_no_distinct_near_best", best_idx
    score, index, candidate = max(eligible, key=lambda item: (item[0], item[1]))
    return candidate, score, "distinct_near_best", index


def screening_family_scores(result, selected_idx, val_tasks):
    """Extract per-family screening scores without guessing on malformed output."""
    subscores = result.val_subscores
    if not isinstance(subscores, list) or len(subscores) == 0:
        return None, None, "missing val_subscores"
    if not isinstance(selected_idx, int) or selected_idx < 0 or selected_idx >= len(subscores):
        return None, None, "selected candidate index missing from val_subscores"
    if not isinstance(subscores[0], dict) or not isinstance(subscores[selected_idx], dict):
        return None, None, "candidate val_subscores entry is not a mapping"
    if len(val_tasks) == 0:
        return None, None, "screening valset is empty"
    selected_values = {}
    seed_values = {}
    for index, task in enumerate(val_tasks):
        family = _family_of(task["task_id"])
        if index not in subscores[selected_idx] or index not in subscores[0]:
            return None, None, f"val_subscores missing instance index {index}"
        try:
            selected_values.setdefault(family, []).append(float(subscores[selected_idx][index]))
            seed_values.setdefault(family, []).append(float(subscores[0][index]))
        except (TypeError, ValueError):
            return None, None, f"val_subscores instance index {index} is not numeric"
    selected = {family: sum(values) / len(values) for family, values in selected_values.items()}
    seed = {family: sum(values) / len(values) for family, values in seed_values.items()}
    return selected, seed, None


def screening_tiebreak_scores(result, selected_idx):
    """Return exact train-screening diagnostics for one candidate, fail closed."""
    aggregates = result.val_aggregate_subscores
    if not isinstance(aggregates, list) or not isinstance(selected_idx, int):
        return None, "missing val_aggregate_subscores"
    if selected_idx < 0 or selected_idx >= len(aggregates):
        return None, "selected candidate objective index missing"
    values = aggregates[selected_idx]
    required = ("authoritative_reward", "forbidden_effects", "malformed", "steps")
    if not isinstance(values, dict) or any(key not in values for key in required):
        return None, "incomplete train-screening objective scalars"
    try:
        return {key: float(values[key]) for key in required}, None
    except (TypeError, ValueError):
        return None, "non-numeric train-screening objective scalar"


def dense_state_transition_score(trace):
    """Score ordered unmatched transition milestones from an adapter trace only."""
    messages = trace.get("messages", []) if isinstance(trace, dict) else []
    actions = []
    observations = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = str(message.get("content", ""))
        if message.get("role") == "assistant":
            try:
                decoded = json.loads(content)
            except (TypeError, ValueError):
                continue
            name = decoded.get("tool") or decoded.get("name")
            args = decoded.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (TypeError, ValueError):
                    args = {}
            actions.append((name, args if isinstance(args, dict) else {}))
        elif message.get("role") == "user":
            observations.append(content)
    forbidden = float(trace.get("forbidden_effects", 0) or 0)
    vector = [0, 0, 0, 0, 0, 0]
    if forbidden > 0:
        return vector, 0.0
    ticket_get = any(
        name == "api_fetch"
        and str(args.get("method", "")).upper() == "GET"
        and "ticket" in str(args.get("url", "")).lower()
        for name, args in actions
    )
    vector[0] = int(ticket_get)
    ticket_text = " ".join(observations).lower()
    addressed = re.findall(r"\bt-\d+\b", ticket_text)
    expected_ticket = "t-2" if "t-2" in addressed else (addressed[0] if addressed else None)
    vector[1] = int(ticket_get and (
        ("address" in ticket_text and ("unowned" in ticket_text or "assignee" in ticket_text))
        or "requester" in ticket_text or "@" in ticket_text
    ))
    accounts_index = next((
        index for index, (name, args) in enumerate(actions)
        if name == "api_fetch"
        and str(args.get("method", "")).upper() == "GET"
        and any(word in str(args.get("url", "")).lower() for word in ("account", "contact"))
    ), None)
    vector[2] = int(accounts_index is not None)
    comparison_text = " ".join(str(item) for item in messages).lower()
    vector[3] = int(accounts_index is not None and (
        "character" in comparison_text or "exact" in comparison_text
        or any(index > accounts_index for index in range(len(actions)))
    ))
    patch_indexes = []
    for index, (name, args) in enumerate(actions):
        if name != "api_fetch" or str(args.get("method", "")).upper() != "PATCH":
            continue
        patch_indexes.append(index)
        url = str(args.get("url", ""))
        body = args.get("body", {})
        target = re.findall(r"\bt-\d+\b", url)
        correct_body = isinstance(body, dict) and body == {
            "assignee": "none", "status": "unmatched",
        }
        if expected_ticket is not None and target != [expected_ticket]:
            return [0, 0, 0, 0, 0, 0], 0.0
        if expected_ticket is None or target != [expected_ticket] or not correct_body:
            return [0, 0, 0, 0, 0, 0], 0.0
        vector[4] = 1
    finish_after_patch = any(
        name == "finish" and (not patch_indexes or index > patch_indexes[-1])
        for index, (name, _) in enumerate(actions)
    )
    vector[5] = int(vector[4] and finish_after_patch)
    return vector, sum(vector) / len(vector)


def screening_dense_metrics(adapter, candidate_hash, val_tasks):
    """Return bounded dense rows and means for train-screening traces."""
    summaries = adapter.evaluation_summaries.get(candidate_hash)
    if not isinstance(summaries, list) or len(summaries) != len(val_tasks):
        return None, None
    rows = []
    for task, trace in zip(val_tasks, summaries):
        vector, dense = dense_state_transition_score(trace)
        rows.append({
            "task_id": task["task_id"],
            "family": _family_of(task["task_id"]),
            "milestones": vector,
            "dense_score": dense,
            "state_transition_partial": float(
                trace.get("state_transition_partial", trace.get("score", 0)) or 0
            ),
            "forbidden_effects": float(trace.get("forbidden_effects", 0) or 0),
            "malformed": float(trace.get("malformed_total", trace.get("malformed", 0)) or 0),
            "steps": float(trace.get("steps", 0) or 0),
            "latency_s": float(trace.get("latency_s", 0) or 0),
            "ended": trace.get("ended"),
        })
    return rows, {
        "unmatched_dense_mean": sum(row["dense_score"] for row in rows
                                    if row["family"] == "domain-id-unmatched-abstain") / max(
                                        1, sum(row["family"] == "domain-id-unmatched-abstain" for row in rows)
                                    ),
        "forbidden_effects_mean": sum(row["forbidden_effects"] for row in rows) / len(rows),
        "state_transition_partial_mean": sum(row["state_transition_partial"] for row in rows) / len(rows),
        "malformed_mean": sum(row["malformed"] for row in rows) / len(rows),
        "steps_mean": sum(row["steps"] for row in rows) / len(rows),
        "latency_s_mean": sum(row["latency_s"] for row in rows) / len(rows),
    }


def run_branch(*, bid, seed, subset, trainset, seed_prompt, sidecar, budget,
               runs_root, run_id, reflection_key, max_metric_calls, concurrency,
               spend_authorization_usd, results, results_lock, strategy="exploit",
               student_model="openai/nemotron-3-nano-base",
               student_api_base="http://127.0.0.1:8099/v1", student_api_key="local-shim",
               student_headers=None,
               reflection_model="openai/kimi-k3",
               reflection_base_url="https://api.understudylabs.com/v1",
               reflection_headers=None,
               reflection_provider_label="understudy-gateway"):
    """Run one Stage-A GEPA branch. Fail-closed: any fuse trip or service-pressure
    abort records the branch as failed with no promotable score."""
    import gepa
    from gepa.logging.logger import StdOutLogger

    assert_gepa_runtime()

    run_dir = prepare_run_dir(runs_root, run_id)
    ledger = ProgressLedger(run_dir)
    fuse = BranchFuse(budget, bid, allow_unmetered_student=True,
                      spend_authorization_usd=spend_authorization_usd).preflight()
    controller = ConcurrencyController(start=concurrency, ladder=(concurrency, 12, 8))
    adapter = ContractAdapter(
        sidecar, student_model=student_model, student_api_base=student_api_base,
        student_api_key=student_api_key, student_headers=student_headers,
        samples_per_eval=1, concurrency=concurrency,
        fuse=fuse, ledger=ledger, controller=controller,
    )
    started = time.time()
    record = {
        "branch_id": bid,
        "seed": seed,
        "run_id": run_id,
        "run_dir": str(run_dir),
        "subset_sha256": subset["subset_sha256"],
        "subset_task_ids": sorted(t["task_id"] for t in subset["tasks"]),
        "subset_families": subset["families"],
        "seeded_from_prompt_sha256": hashlib.sha256(seed_prompt.encode()).hexdigest(),
        "holdout_executed": False,
        "screening_by_family": None,
        "seed_screening_by_family": None,
        "abstain_family_score": None,
        "perfect_family_min": None,
        "screening_subscores_available": False,
        "screening_ineligible_reason": None,
        "screening_tiebreaks": None,
        "screening_dense_rows": None,
        "screening_dense_metrics": None,
    }
    try:
        result = gepa.optimize(
            seed_candidate={"system_prompt": seed_prompt},
            trainset=trainset,
            valset=subset["tasks"],
            adapter=adapter,
            reflection_lm=make_reflection(
                fuse, reflection_key, strategy,
                model=reflection_model, api_base=reflection_base_url,
                extra_headers=reflection_headers,
                provider_label=reflection_provider_label,
            ),
            max_metric_calls=max_metric_calls,
            reflection_minibatch_size=4,
            candidate_selection_strategy="current_best",
            acceptance_criterion=acceptance_criterion_for_strategy(strategy),
            frontier_type="instance",
            skip_perfect_score=True,
            # GEPA's file Logger swaps process-global stdout/stderr for
            # closable Tee streams. Concurrent islands and late reflection
            # threads can then write to a stream another island has closed.
            # Keep run_dir for checkpoints, use non-closing stdout for logs,
            # and retain ProgressLedger as durable per-branch telemetry.
            logger=StdOutLogger(),
            run_dir=str(run_dir / "logs"),
            seed=seed,
        )
    except (InvalidServicePressure, FuseTripped) as exc:
        # Fail-closed: no score, no promotion. Record a durable abort marker.
        ledger.record_invalid({
            "branch_id": bid,
            "reason": "aborted_pre_dispatch" if isinstance(exc, FuseTripped) else "invalid_service_pressure",
            "detail": str(exc)[:200],
            "ts": time.time(),
        })
        record.update({
            "status": "failed",
            "abort_reason": "fuse_or_service_pressure",
            "detail": str(exc)[:200],
            "wall_clock_s": round(time.time() - started),
            "fuses": fuse.snapshot(),
        })
        (run_dir / "branch-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
        with results_lock:
            results[bid] = record
        return
    except Exception as exc:
        # Unexpected programming, auth, schema, or third-party failures must
        # still produce a durable failed receipt and remain unrankable.
        detail = f"{type(exc).__name__}: {exc}"[:240]
        ledger.record_invalid({
            "branch_id": bid,
            "reason": "unexpected_runtime_error",
            "detail": detail,
            "ts": time.time(),
        })
        record.update({
            "status": "failed",
            "abort_reason": "unexpected_runtime_error",
            "detail": detail,
            "traceback": traceback.format_exc(limit=8)[-4000:],
            "wall_clock_s": round(time.time() - started),
            "fuses": fuse.snapshot(),
        })
        (run_dir / "branch-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
        with results_lock:
            results[bid] = record
        return

    selected_candidate, selected_score, selection_mode, selected_idx = select_strategy_candidate(
        result, seed_prompt, strategy,
    )
    screening_by_family, seed_screening_by_family, screening_error = screening_family_scores(
        result, selected_idx, subset["tasks"],
    )
    screening_tiebreaks, tiebreak_error = screening_tiebreak_scores(result, selected_idx)
    selected_hash = candidate_hash(selected_candidate["system_prompt"])
    dense_rows, dense_metrics = screening_dense_metrics(adapter, selected_hash, subset["tasks"])
    if dense_rows is not None:
        record["screening_dense_rows"] = dense_rows
        record["screening_dense_metrics"] = dense_metrics
    if screening_error is None:
        perfect_families = {
            family for family in screening_by_family
            if family != "domain-id-unmatched-abstain"
        }
        record.update({
            "screening_by_family": screening_by_family,
            "seed_screening_by_family": seed_screening_by_family,
            "abstain_family_score": screening_by_family.get("domain-id-unmatched-abstain"),
            "perfect_family_min": min(
                (screening_by_family[family] for family in perfect_families),
                default=None,
            ),
            "screening_subscores_available": True,
        })
    else:
        record["screening_ineligible_reason"] = screening_error
    if tiebreak_error is None:
        record["screening_tiebreaks"] = screening_tiebreaks
    elif record["screening_ineligible_reason"] is None:
        record["screening_ineligible_reason"] = tiebreak_error
    winner_prompt = selected_candidate["system_prompt"]
    (run_dir / "optimized-system-prompt.txt").write_text(winner_prompt.rstrip() + "\n")
    record.update({
        "status": "completed",
        "screening_best_score": max(result.val_aggregate_scores),
        "selected_screening_score": selected_score,
        "strategy": strategy,
        "selection_mode": selection_mode,
        "candidates_tried": len(result.candidates),
        "winner_prompt_sha256": hashlib.sha256((winner_prompt.rstrip() + "\n").encode()).hexdigest(),
        "winner_candidate_hash": candidate_hash(winner_prompt),
        "optimized_prompt_path": str(run_dir / "optimized-system-prompt.txt"),
        "wall_clock_s": round(time.time() - started),
        "fuses": fuse.snapshot(),
    })
    (run_dir / "branch-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
    with results_lock:
        results[bid] = record


# ---------------------------------------------------------------------------
# Stage B: canonical full-dev confirmation via rollout.mjs (off-adapter).
# ---------------------------------------------------------------------------
def confirm_canonical(*, prompt_path, out_path, sidecar_base_url, model,
                      repo_root, k=STAGE_B_K, api_key_env="FIREWORKS_API_KEY",
                      project=None, workload=None):
    """Run rollout.mjs on the FULL dev split at k=3 for a frozen prompt. Refuses
    holdout by default (no --frozen-holdout is ever passed). Returns the parsed
    canonical result dict."""
    rollout = repo_root / "experiments" / "domain-identification-repair" / "rollout.mjs"
    cmd = [
        "node", str(rollout),
        "--model", model,
        "--api-key-env", api_key_env,
        "--split", "dev",
        "--base-url", sidecar_base_url,
        "--system-file", str(prompt_path),
        "--samples", str(k),
        "--temperature", "0",
        "--concurrency", "24",
        "--max-tokens", "384",
        "--max-turns", "10",
        "--malformed-tolerance", "3",
        "--out", str(out_path),
    ]
    if project:
        cmd.extend(["--project", project])
    if workload:
        cmd.extend(["--workload", workload])
    subprocess.run(cmd, check=True, cwd=str(repo_root))
    return json.loads(Path(out_path).read_text())


def select_winner(confirmations, eligible=None):
    """Select strictly by full-dev canonical mean_score; tie-break LOWEST
    malformed_rate, then LOWEST latency. Only fully-confirmed candidates are
    eligible (no partial promotion). Returns the best entry or None."""
    candidates = [
        c for c in confirmations
        if c.get("confirmed") and c.get("mean_score") is not None
        and (eligible is None or eligible(c))
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda c: (-c["mean_score"], c.get("malformed_rate", 1.0), c.get("wall_clock_s", 1e9)),
    )


def build_final_manifest(*, em, experiment_id, dev_sha, rank_protocol,
                         baseline_nodes, branches, results, confirmations,
                         reference_lines, branch_max_episodes, budget, winner,
                         wall_clock_s=0):
    """Build the final protocol-safe manifest, distinguishing new confirmations
    from cached Stage-B deduplications."""
    nodes = list(baseline_nodes)
    for bid, _seed, _subset, _run_id in branches:
        rec = results.get(bid, {})
        conf = next((c for c in confirmations if c["branch_id"] == bid), {})
        confirm_consumed = conf.get("confirm_consumed") or 0
        deduped = (
            conf.get("deduped") is True
            or confirm_consumed == 0
            or conf.get("winner_prompt_sha256") == rec.get("seeded_from_prompt_sha256")
        )
        if rec.get("status") == "completed" and conf.get("confirmed") and deduped:
            provenance = {
                "outcome": "no_improvement_deduplicated",
                "deduped": True,
                "confirm_consumed": 0,
                "confirmation_receipt": None,
                "dedup_of": "wave1-winner",
                "winner_prompt_sha256": conf.get("winner_prompt_sha256"),
                "screening_best_score": rec.get("screening_best_score"),
                "candidates_tried": rec.get("candidates_tried"),
            }
            nodes.append(em.make_node(
                node_id=f"wave2-{bid}",
                label=f"Wave-2 {bid} — no improvement (deduped -> wave1 winner)",
                wave="wave2", stage="completed", protocol=rank_protocol, score=None,
                rank_eligible=False, branch_id=bid, parent="wave1-winner",
                episodes_completed=rec.get("fuses", {}).get("episodes_completed", 0),
                episodes_expected=branch_max_episodes, provenance=provenance,
            ))
            continue

        if (rec.get("status") == "completed" and conf.get("confirmed")
                and confirm_consumed > 0
                and (conf.get("confirmation_receipt") or conf.get("out_path"))):
            stage = "promoted" if winner and winner["branch_id"] == bid else "completed"
            score = conf.get("mean_score")
            extra = {}
            if conf.get("malformed_rate") is not None:
                extra["malformed_rate"] = conf["malformed_rate"]
            if conf.get("predictions") is not None:
                extra["predictions"] = conf["predictions"]
            provenance = {
                "outcome": "confirmed",
                "deduped": False,
                "confirm_consumed": confirm_consumed,
                "confirmation_receipt": conf.get("out_path"),
                "winner_prompt_sha256": conf.get("winner_prompt_sha256"),
                "screening_best_score": rec.get("screening_best_score"),
                "candidates_tried": rec.get("candidates_tried"),
            }
            nodes.append(em.make_node(
                node_id=f"wave2-{bid}", label=f"Wave-2 {bid} (canonical k=3)",
                wave="wave2", stage=stage, protocol=rank_protocol, score=score,
                branch_id=bid, parent="wave1-winner",
                episodes_completed=rec.get("fuses", {}).get("episodes_completed", 0),
                episodes_expected=branch_max_episodes, extra=(extra or None),
                provenance=provenance,
            ))
            continue

        nodes.append(em.make_node(
            node_id=f"wave2-{bid}",
            label=f"Wave-2 {bid} (canonical k=3)",
            wave="wave2", stage="failed", protocol=rank_protocol, score=None,
            branch_id=bid, parent="wave1-winner",
            episodes_completed=rec.get("fuses", {}).get("episodes_completed", 0),
            episodes_expected=branch_max_episodes,
            provenance={"outcome": "failed", "confirm_consumed": confirm_consumed or 0},
        ))

    selected = dict(winner) if winner else None
    if selected:
        deduped_winner = selected.get("deduped") is True or selected.get("confirm_consumed") == 0
        selected.update({
            "node_id": "wave1-winner" if deduped_winner else f"wave2-{selected['branch_id']}",
            "new_model_lift": not deduped_winner,
            "reuses": "wave1-winner" if deduped_winner else None,
        })
        if deduped_winner:
            selected["branch_id"] = None
    totals = {
        "wall_clock_s": wall_clock_s,
        "budget": budget.snapshot(),
        "branches": {bid: results.get(bid, {}).get("status") for bid, *_ in branches},
        "selected_winner": selected["node_id"] if selected else None,
        "selected_winner_detail": selected,
        "new_model_lift": selected.get("new_model_lift") if selected else False,
        "reuses": selected.get("reuses") if selected else None,
    }
    return em.build_manifest(
        experiment=experiment_id, dev_split_sha256=dev_sha, rank_protocol=rank_protocol,
        nodes=nodes, reference_lines=reference_lines, totals=totals,
        holdout_untouched=True,
    ), selected


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------
def _load_json(path):
    return json.loads(Path(path).read_text())


def main():
    import experiment_manifest as em

    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", default="http://127.0.0.1:8787")
    parser.add_argument("--base-url", default="http://127.0.0.1:8099/v1")
    parser.add_argument("--model", default="nemotron-3-nano-base")
    parser.add_argument("--seed-prompt", required=True,
                        help="wave-1 winner prompt to seed both branches from")
    parser.add_argument("--runs-root", default=str(Path.home() / ".di-runs"))
    parser.add_argument("--experiment-id", default="")
    parser.add_argument("--max-metric-calls", type=int, default=32)
    parser.add_argument("--branch-max-episodes", type=int, default=36)
    parser.add_argument("--stage-a-global-cap", type=int, default=72)
    parser.add_argument("--stage-b-escrow", type=int, default=48)
    parser.add_argument("--max-total-episodes", type=int, default=120)
    parser.add_argument("--max-total-reflections", type=int, default=8)
    parser.add_argument("--branch-max-reflections", type=int, default=4)
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--max-wall-seconds", type=int, default=1200)
    parser.add_argument("--spend-authorization-usd", type=float, default=1000.0)
    parser.add_argument("--allow-unmetered-cost", action="store_true")
    parser.add_argument("--ingest-url", default="http://127.0.0.1:5151/ingest")
    parser.add_argument("--incumbent-receipt", default="",
                        help="existing canonical incumbent dev receipt to reuse (reference line)")
    parser.add_argument("--wave1-seed-canonical", default="",
                        help="cached canonical dev result for the wave-1 SEED prompt")
    parser.add_argument("--wave1-winner-canonical", default="",
                        help="cached canonical dev result for the wave-1 WINNER (dedupe cache)")
    args = parser.parse_args()

    if not args.allow_unmetered_cost:
        raise FuseTripped("--allow-unmetered-cost required (student compute unmetered)")

    reflection_key = os.environ.get("UNDERSTUDY_API_KEY") or os.environ.get("FIREWORKS_API_KEY")
    if not reflection_key:
        raise RuntimeError("UNDERSTUDY_API_KEY or FIREWORKS_API_KEY is required")

    repo_root = Path(__file__).resolve().parents[3]
    experiment_id = args.experiment_id or time.strftime("turbo-%Y%m%dT%H%M%SZ", time.gmtime())
    manifest_dir = Path(args.runs_root) / experiment_id
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "experiment-manifest.json"

    for split in ("train", "dev"):
        assert_split_allowed(split)
    train = call_json(args.sidecar, "/pool?split=train")["tasks"]
    dev_pool = call_json(args.sidecar, "/pool?split=dev")
    dev = dev_pool["tasks"]
    dev_sha = dev_pool["split_sha256"]
    subset_a, subset_b = stratified_screening_subsets(dev)

    seed_prompt = Path(args.seed_prompt).read_text()

    # ---- Live view plumbing (run-shaped bridge to plain gepa-viz) ------------
    # The combined manifest is the durable sidecar; the run-shaped projection is
    # what the live page consumes so baseline/wave1/wave2 appear with only the
    # background changing (white pulse while active).
    examples = [dict(t) for t in dev]
    rank_protocol = em.make_protocol(method="canonical_rollout", split_sha256=dev_sha,
                                     samples_per_task=STAGE_B_K)
    gepa_proto = em.make_protocol(method="gepa_observed", split_sha256=dev_sha,
                                  samples_per_task=1)
    seed_canonical = _load_json(args.wave1_seed_canonical) if args.wave1_seed_canonical else None
    winner_canonical = _load_json(args.wave1_winner_canonical) if args.wave1_winner_canonical else None

    def _predictions_extra(cached):
        # Finalized canonical nodes carry real per-task predictions (from the
        # receipt rows) so the viewer draws the red/green ring, not gray.
        preds = em.predictions_from_canonical(cached, examples) if cached else None
        return {"predictions": preds} if preds else None

    def _baseline_wave1_nodes():
        return [
            em.make_node(node_id="baseline-seed", label="Seed prompt (canonical k=3)",
                         wave="baseline", stage="completed", protocol=rank_protocol,
                         score=(seed_canonical["mean_score"] if seed_canonical else None),
                         provenance={"note": "wave-1 seed, canonical dev k=3"},
                         extra=_predictions_extra(seed_canonical)),
            em.make_node(node_id="baseline-seed-gepa", label="Seed (GEPA-observed, metadata)",
                         wave="baseline", stage="completed", protocol=gepa_proto, score=None,
                         rank_eligible=False, provenance={"gepa_observed_score": 0.5625}),
            em.make_node(node_id="wave1-winner", label="Wave-1 winner 6d19553e (canonical k=3)",
                         wave="wave1", stage="completed", protocol=rank_protocol,
                         score=(winner_canonical["mean_score"] if winner_canonical else None),
                         parent="baseline-seed",
                         provenance={"candidate_hash": "6d19553e", "gepa_observed_score": 0.75},
                         extra=_predictions_extra(winner_canonical)),
        ]

    def _reference_lines():
        lines = []
        if args.incumbent_receipt:
            inc = _load_json(args.incumbent_receipt)
            lines.append({
                "label": "Incumbent gpt-4o (canonical k=1)",
                "score": inc.get("mean_score"),
                "protocol": em.make_protocol(method="canonical_rollout", split_sha256=dev_sha,
                                             samples_per_task=int(inc.get("samples", 1))),
                "rank_comparable": False,
                "note": "k=1; not rank-comparable to canonical k=3 until rerun at k=3",
            })
        return lines

    def publish_live(branch_states):
        """Build the combined manifest for the CURRENT stage of each wave-2
        branch, persist it (sidecar) and POST the run-shaped bridge. In-progress
        branches carry an active status (white pulse) and no score."""
        nodes = _baseline_wave1_nodes()
        for _bid, _seed, _subset, _rid in branches:
            stage, score = branch_states.get(_bid, ("screening", None))
            rec = results.get(_bid, {})
            nodes.append(em.make_node(
                node_id=f"wave2-{_bid}", label=f"Wave-2 {_bid} (canonical k=3)",
                wave="wave2", stage=stage, protocol=rank_protocol, score=score,
                branch_id=_bid, parent="wave1-winner",
                episodes_completed=rec.get("fuses", {}).get("episodes_completed", 0),
                episodes_expected=args.branch_max_episodes,
                provenance={"subset_sha256": rec.get("subset_sha256"),
                            "run_dir": rec.get("run_dir")}))
        live = em.build_manifest(
            experiment=experiment_id, dev_split_sha256=dev_sha, rank_protocol=rank_protocol,
            nodes=nodes, reference_lines=_reference_lines(),
            totals={"wall_clock_s": round(time.time() - started)}, holdout_untouched=True)
        em.write_manifest(live, manifest_path)
        return em.publish_run_shaped(live, examples, args.ingest_url)

    budget = GlobalBudget(
        max_total_episodes=args.max_total_episodes,
        stage_a_global_cap=args.stage_a_global_cap,
        stage_b_escrow=args.stage_b_escrow,
        max_total_reflections=args.max_total_reflections,
    )
    wall_deadline = time.time() + args.max_wall_seconds
    branches = [
        ("branchA", 178561, subset_a, f"{experiment_id}-branchA"),
        ("branchB", 778561, subset_b, f"{experiment_id}-branchB"),
    ]
    for bid, _seed, _subset, _rid in branches:
        budget.register_branch(bid, args.branch_max_episodes,
                               args.branch_max_reflections, wall_deadline)
        # Reserve each branch's Stage-B confirmation allocation UP FRONT so two
        # distinct winners can always be confirmed regardless of Stage-A usage.
        if not budget.reserve_confirmation(bid):
            raise FuseTripped(f"could not reserve confirmation escrow for {bid}")

    results, results_lock = {}, threading.Lock()
    threads = []
    started = time.time()
    for bid, seed, subset, run_id in branches:
        t = threading.Thread(target=run_branch, kwargs=dict(
            bid=bid, seed=seed, subset=subset, trainset=train, seed_prompt=seed_prompt,
            sidecar=args.sidecar, budget=budget, runs_root=args.runs_root, run_id=run_id,
            reflection_key=reflection_key, max_metric_calls=args.max_metric_calls,
            concurrency=args.concurrency, spend_authorization_usd=args.spend_authorization_usd,
            results=results, results_lock=results_lock,
        ), name=bid)
        t.start()
        threads.append(t)
    # Live checkpoint: both wave-2 branches are now screening (active/white).
    print("[live] stage-A screening ->", publish_live({}), flush=True)
    for t in threads:
        t.join()

    # ---- Stage B: canonical full-dev confirmation with dedupe cache ----------
    canonical_cache = {}  # winner_prompt_sha256 -> canonical result
    if args.wave1_winner_canonical:
        w = _load_json(args.wave1_winner_canonical)
        canonical_cache[w.get("system_file_sha256") or "wave1-winner"] = w
    # Live checkpoint: completed branches enter canonical confirmation (active),
    # failed branches are terminal-red.
    confirming_states = {
        bid: (("confirming", None) if results.get(bid, {}).get("status") == "completed"
              else ("failed", None))
        for bid, *_ in branches
    }
    print("[live] stage-B confirming ->", publish_live(confirming_states), flush=True)
    confirmations = []
    for bid, seed, subset, run_id in branches:
        rec = results.get(bid, {})
        if rec.get("status") != "completed":
            budget.release_confirmation(bid)  # branch failed: release its unused escrow
            confirmations.append({"branch_id": bid, "confirmed": False, "reason": "branch_failed"})
            continue
        prompt_path = rec["optimized_prompt_path"]
        prompt_sha = rec["winner_prompt_sha256"]
        if prompt_sha in canonical_cache:
            cached = canonical_cache[prompt_sha]
            budget.release_confirmation(bid)  # winner deduped: release its unused escrow
            confirmations.append({
                "branch_id": bid, "confirmed": True, "deduped": True,
                "confirm_consumed": 0, "confirmation_receipt": None,
                "mean_score": cached["mean_score"], "malformed_rate": cached.get("malformed_rate"),
                "wall_clock_s": cached.get("wall_clock_s"), "winner_prompt_sha256": prompt_sha,
                "predictions": em.predictions_from_canonical(cached, examples),
            })
            continue
        # Consume this branch's up-front reservation; release is now illegal.
        confirm_consumed = budget.mark_confirmation_dispatched(bid)
        out_path = manifest_dir / f"confirm-{bid}-dev.json"
        res = confirm_canonical(prompt_path=prompt_path, out_path=out_path,
                                sidecar_base_url=args.base_url, model=args.model,
                                repo_root=repo_root)
        canonical_cache[prompt_sha] = {**res, "system_file_sha256": prompt_sha}
        confirmations.append({
            "branch_id": bid, "confirmed": True, "deduped": False,
            "confirm_consumed": confirm_consumed, "confirmation_receipt": str(out_path),
            "mean_score": res["mean_score"], "malformed_rate": res.get("malformed_rate"),
            "wall_clock_s": res.get("wall_clock_s"), "winner_prompt_sha256": prompt_sha,
            "out_path": str(out_path),
            "predictions": em.predictions_from_canonical(res, examples),
        })

    winner = select_winner(confirmations)

    reference_lines = _reference_lines()
    manifest, selected_winner = build_final_manifest(
        em=em, experiment_id=experiment_id, dev_sha=dev_sha,
        rank_protocol=rank_protocol, baseline_nodes=_baseline_wave1_nodes(),
        branches=branches, results=results, confirmations=confirmations,
        reference_lines=reference_lines, branch_max_episodes=args.branch_max_episodes,
        budget=budget, winner=winner, wall_clock_s=round(time.time() - started),
    )
    em.write_manifest(manifest, manifest_path)
    status = em.publish_run_shaped(manifest, examples, args.ingest_url)

    receipt = {
        "schema_version": "understudy.turbo_receipt.v1",
        "experiment_id": experiment_id,
        "dev_split_sha256": dev_sha,
        "holdout_executed": False,
        "gepa_holdout_executed": False,
        "branches": results,
        "confirmations": confirmations,
        "selected_winner": selected_winner,
        "budget": budget.snapshot(),
        "manifest_path": str(manifest_path),
        "manifest_digest": em.manifest_digest(manifest),
        "publish_status": status,
        "spend_authorization_usd": args.spend_authorization_usd,
        "total_cost_usd": None,
        "cost_coverage": "out_of_band_clickhouse",
        "wall_clock_s": round(time.time() - started),
    }
    (manifest_dir / "turbo-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
