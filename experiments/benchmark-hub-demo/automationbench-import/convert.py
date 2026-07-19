# Copyright: converter only; upstream tasks are (c) 2026 Zapier, Inc., MIT.
"""Convert zapier/AutomationBench public tasks into understudy.benchmark.v1.

Run with the AutomationBench repo's own environment so the domain modules
import cleanly:

    uv run --project <automationbench-clone> --prerelease=allow \
        python convert.py <automationbench-clone> <pinned-commit>

Emits (next to this script):
  - benchmark.json        understudy.benchmark.v1 manifest (validate with dist/benchmark.js)
  - tasks-subset.jsonl    one line per imported task (task_id, domain, example_id,
                          user prompt, tool list) for run-time matching

Selection: the first N_PER_DOMAIN tasks per public domain, in the dataset's own
order (deterministic; tasks are hand-authored Python, not shuffled).
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

N_PER_DOMAIN = 8

HERE = Path(__file__).resolve().parent


def main() -> None:
    ab_repo = Path(sys.argv[1]).resolve()
    commit = sys.argv[2]
    sys.path.insert(0, str(ab_repo))

    from automationbench.domains import PUBLIC_DOMAINS, get_domain_dataset

    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    taxonomy = []
    tasks = []
    subset_lines = []
    tool_surface = set()

    for domain in PUBLIC_DOMAINS:
        ds = get_domain_dataset(domain)
        taxonomy.append(
            {
                "category_id": domain,
                "name": f"{domain.capitalize()} workflows",
                "difficulty": None,
                "derived_from": None,
            }
        )
        for row in list(ds)[:N_PER_DOMAIN]:
            task_name = row["task"]  # e.g. "sales.multi_hop_lookup", unique per domain
            info = row.get("info") or {}
            if isinstance(info, str):  # HF Dataset stores info as a JSON string
                info = json.loads(info)
            tools = info.get("zapier_tools") or []
            tool_surface.update(t.split("_")[0] for t in tools)
            tasks.append(
                {
                    "task_id": task_name,
                    "category_id": domain,
                    # upstream stable integer id for the task, not an RNG seed
                    "seed": row.get("example_id"),
                    "genesis": "imported",
                    "generator_ref": None,
                    "split": "none",
                    # gold = expected final state, encoded as assertion rubrics
                    # bound to the task definition in the upstream repo
                    "gold": {
                        "kind": "final-state",
                        "ref": f"github.com/zapier/AutomationBench@{commit}:automationbench/domains/{domain}/tasks.py#{task_name}",
                    },
                }
            )
            user_msg = next(
                (m["content"] for m in row.get("prompt", []) if m["role"] == "user"), None
            )
            subset_lines.append(
                {
                    "task_id": task_name,
                    "domain": domain,
                    "example_id": row.get("example_id"),
                    "question": user_msg,
                    "zapier_tools": tools,
                }
            )

    manifest = {
        "schema_version": "understudy.benchmark.v1",
        "benchmark_id": "automationbench-import",
        "name": "AutomationBench (imported subset)",
        "description": (
            f"Representative {len(tasks)}-task subset ({N_PER_DOMAIN} per domain) of the "
            "600-task zapier/AutomationBench public split: seeded simulated-SaaS business "
            "workflows scored by assertion-based final-state checks."
        ),
        "created_at": created_at,
        "provenance": {
            "origin": "imported",
            "source_refs": [],
            "imported_from": {
                "format": "automationbench",
                "ref": "github.com/zapier/AutomationBench",
                "version": commit,
                "license": "MIT",
            },
        },
        "taxonomy": taxonomy,
        "tasks": tasks,
        "environment": {
            # AutomationBench pins verifiers>=0.1.12.dev2 (pre-1.0 API) and builds a
            # vf.StatefulToolEnv in automationbench/runner.py
            "format": "verifiers.v0",
            "package_ref": f"github.com/zapier/AutomationBench@{commit} (also: prime env install zapier/AutomationBench)",
            "package_sha256": None,
            "tool_surface": sorted(tool_surface),
            "runtime": "subprocess",
            "verifiers_version_pin": ">=0.1.12.dev2",
        },
        "verifier": {
            "kind": "final-state",
            "strict_metric": "task_completed_correctly",
            "dense_metric": "partial_credit",
            # deterministic assertion replay over the recorded final state is not
            # exposed as a standalone entrypoint; scoring runs inside the rollout
            "replayable": False,
        },
        "splits": {
            "boundary": None,
            "splits_sha256": None,
            "contamination": "unknown",
        },
        "linked_eval": None,
        "results_contract": {
            "row_schema": "understudy.eval_result.v1",
            "trace_artifact": "traces.jsonl",
            "branch_projection": "one row per root-to-leaf branch",
        },
    }

    (HERE / "benchmark.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (HERE / "tasks-subset.jsonl").write_text(
        "\n".join(json.dumps(l) for l in subset_lines) + "\n"
    )
    print(f"wrote {len(tasks)} tasks across {len(taxonomy)} domains @ {commit}")


if __name__ == "__main__":
    main()
