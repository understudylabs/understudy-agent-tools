#!/usr/bin/env python3
"""Build and train-screen the private Wave-6 seed population.

This command performs student inference on the hash-bound train curriculum only.
It never reads dev or holdout. Prompt text remains in private files; the
admission manifest carries hashes and bounded screening scalars only.
"""
import argparse
import json
import os
from pathlib import Path

from island_race import (
    WAVE6_SEEDED_POPULATION_ISLAND_SPECS,
    prompt_sha,
)
from optimize import ContractAdapter, call_json
from turbo_race import (
    _family_of,
    failure_family_curriculum,
    failure_family_screening_subsets,
    screening_valset_hash,
)

FAILURE_FAMILY = "domain-id-unmatched-abstain"
PERFECT_FAMILIES = (
    "domain-id-direct-route",
    "domain-id-lookalike-route",
    "domain-id-parent-route",
)

POLICY_DELTAS = {
    "table-1": """
Policy delta — explicit decision table:
1. GET tickets and identify only the addressed unowned ticket and its requester.
2. GET accounts or contacts and compare the complete requester domain character-for-character.
3. Exact registered match: preserve the incumbent direct, lookalike, and parent routing behavior.
4. No exact registered match: PATCH only the addressed ticket with exactly
   {"assignee":"none","status":"unmatched"}, then finish.
Never write any other record.
""",
    "table-2": """
Policy delta — closed-world routing:
Treat an account as matching only when its complete normalized domain equals the requester's
complete domain. A suffix, substring, shared parent, or visual resemblance is not an exact match.
After GET tickets and GET accounts/contacts prove no exact match, PATCH only the addressed ticket
to assignee "none" and status "unmatched", then finish. Preserve all incumbent matched routes.
""",
    "grammar-1": """
Policy delta — tool grammar:
Use one JSON tool action at a time. Read with api_fetch GET. For a proven unmatched requester,
send one api_fetch PATCH to the addressed ticket only, with body
{"assignee":"none","status":"unmatched"}; after the successful observation, emit finish.
Do not narrate, batch actions, or mutate any other object. Preserve working matched routing.
""",
    "grammar-2": """
Policy delta — bounded procedure:
GET tickets -> bind addressed_ticket and requester_domain -> GET accounts/contacts -> compare every
complete domain exactly. If one exact account exists, follow incumbent routing. Otherwise PATCH
addressed_ticket only with assignee=none,status=unmatched -> finish. Never passively finish before
the required unmatched PATCH and never write an unrelated ticket.
""",
    "proof-1": """
Policy delta — explicit proof obligation:
Before choosing unmatched, establish that every registered account/contact domain differs from the
addressed requester's full domain. Record no state while checking. When that proof succeeds, the
only allowed state transition is PATCH of the addressed ticket to
{"assignee":"none","status":"unmatched"}, followed immediately by finish. Keep matched routes intact.
""",
    "termination-1": """
Policy delta — termination discipline:
For unmatched cases, do not stop after discovery. Complete the exact-domain search, PATCH the
addressed ticket only to assignee none/status unmatched, wait for the successful tool observation,
then finish exactly once. Avoid prose, malformed tool objects, retries after success, and unrelated writes.
""",
    "lookalike-guard": """
Policy delta — lookalike safety:
Preserve the incumbent lookalike-route behavior. Similar spelling, suffix overlap, or containment
must never be promoted to an exact-domain match. Only after checking all complete domains and finding
no exact registered account, PATCH the addressed ticket only with assignee none/status unmatched,
then finish. Preserve direct and parent routes unchanged.
""",
    "parent-guard": """
Policy delta — parent-route safety:
Preserve the incumbent parent-route behavior exactly when its registered relationship applies.
Otherwise require character-for-character equality for an account match. If exhaustive GET results
prove no exact or valid parent route, PATCH only the addressed ticket to assignee none/status unmatched,
then finish. Never alter another record.
""",
}


def build_seed_prompts(parent_prompt):
    prompts = {}
    for branch_id, _strategy, *_ in WAVE6_SEEDED_POPULATION_ISLAND_SPECS:
        prompts[branch_id] = parent_prompt.rstrip() + "\n\n" + POLICY_DELTAS[branch_id].strip() + "\n"
    return prompts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-prompt", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--sidecar", default="http://127.0.0.1:8787")
    parser.add_argument("--student-model", default="openai/nemotron-3-nano-base")
    parser.add_argument("--student-base-url", default="http://127.0.0.1:8099/v1")
    parser.add_argument("--student-api-key-env", default="")
    parser.add_argument("--student-project", default="")
    parser.add_argument("--student-workload", default="")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=False)
    parent = Path(args.parent_prompt).read_text()
    prompts = build_seed_prompts(parent)
    if len({prompt_sha(prompt) for prompt in prompts.values()}) != len(prompts):
        raise RuntimeError("constructed seed population is not distinct")

    train = call_json(args.sidecar, "/pool?split=train")["tasks"]
    curriculum = failure_family_curriculum(train, FAILURE_FAMILY, 2)
    subsets = failure_family_screening_subsets(train, FAILURE_FAMILY, 2)
    tasks = subsets[0]["tasks"]
    valset_sha = screening_valset_hash(subsets)
    local = args.student_base_url.startswith(("http://127.0.0.1", "http://localhost"))
    api_key = os.environ.get(args.student_api_key_env) if args.student_api_key_env else None
    api_key = api_key or ("local-shim" if local else None)
    if not api_key:
        raise RuntimeError("remote student endpoint requires --student-api-key-env")
    headers = {}
    if args.student_project:
        headers["x-understudy-project"] = args.student_project
    if args.student_workload:
        headers["x-understudy-workload"] = args.student_workload
    adapter = ContractAdapter(
        args.sidecar, student_model=args.student_model,
        student_api_base=args.student_base_url, student_api_key=api_key,
        student_headers=headers, concurrency=args.concurrency,
    )

    entries = []
    for branch_id, strategy, *_ in WAVE6_SEEDED_POPULATION_ISLAND_SPECS:
        prompt_path = output_dir / f"{branch_id}.txt"
        prompt_path.write_text(prompts[branch_id])
        evaluated = adapter.evaluate(
            tasks, {"system_prompt": prompts[branch_id]}, capture_traces=True,
        )
        traces = evaluated.trajectories or []
        by_family = {}
        for task, score in zip(tasks, evaluated.scores):
            by_family.setdefault(_family_of(task["task_id"]), []).append(float(score))
        family_means = {
            family: sum(scores) / len(scores) for family, scores in sorted(by_family.items())
        }
        forbidden = sum(float(trace.get("forbidden_effects", 0)) for trace in traces)
        eligible = (
            all(family_means.get(family) == 1.0 for family in PERFECT_FAMILIES)
            and forbidden == 0
        )
        entries.append({
            "branch_id": branch_id, "strategy": strategy,
            "prompt_path": str(prompt_path), "prompt_sha256": prompt_sha(prompts[branch_id]),
            "eligible": eligible, "screening_by_family": family_means,
            "forbidden_effects": forbidden,
        })

    receipt = {
        "schema_version": "understudy.gepa_seed_population.v1",
        "holdout_executed": False,
        "scope": "train_screening_only",
        "curriculum_sha256": curriculum["curriculum_sha256"],
        "valset_sha256": valset_sha,
        "student": {"model": args.student_model, "base_url_kind": "local" if local else "remote"},
        "seeds": entries,
    }
    manifest_path = output_dir / "seed-population-manifest.json"
    manifest_path.write_text(json.dumps(receipt, indent=2) + "\n")
    admitted = sum(entry["eligible"] for entry in entries)
    print(json.dumps({"manifest": str(manifest_path), "admitted": admitted,
                      "total": len(entries), "valset_sha256": valset_sha}, indent=2))
    if admitted != len(entries):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
