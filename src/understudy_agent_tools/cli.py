from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCAN_EXCLUDE_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".understudy",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
}
SCAN_EXTENSIONS = {
    ".js",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".rs",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
PROVIDER_PATTERNS = {
    "anthropic": re.compile(r"\b(anthropic|claude)\b", re.IGNORECASE),
    "aws-bedrock": re.compile(r"\b(bedrock|aws\s*bedrock)\b", re.IGNORECASE),
    "fireworks": re.compile(r"\bfireworks\b", re.IGNORECASE),
    "gcp-vertex": re.compile(r"\b(vertexai|vertex\s*ai|google\.cloud\.aiplatform)\b", re.IGNORECASE),
    "gemini": re.compile(r"\b(gemini|google\s+genai)\b", re.IGNORECASE),
    "lilac": re.compile(r"\blilac\b", re.IGNORECASE),
    "openai": re.compile(r"\b(openai|gpt-[A-Za-z0-9_.-]+)\b", re.IGNORECASE),
    "openrouter": re.compile(r"\bopenrouter\b", re.IGNORECASE),
    "prime-intellect": re.compile(r"\bprime\s*intellect\b", re.IGNORECASE),
    "tinker": re.compile(r"\btinker\b", re.IGNORECASE),
}
MODEL_PATTERN = re.compile(
    r"\b(?:gpt-[A-Za-z0-9_.-]+|claude-[A-Za-z0-9_.-]+|gemini-[A-Za-z0-9_.-]+|"
    r"gemma-[A-Za-z0-9_.-]+|glm-[A-Za-z0-9_.-]+|kimi-[A-Za-z0-9_.-]+)\b",
    re.IGNORECASE,
)
PROMPT_PATTERN = re.compile(r"\b(prompt|system_message|system prompt|messages\s*=)\b", re.IGNORECASE)
EVAL_PATTERN = re.compile(r"\b(eval|benchmark|golden|fixture|test[_-]?prompt|rubric)\b", re.IGNORECASE)
LATENCY_PATTERN = re.compile(r"\b(latency|timeout|duration|elapsed|p95|p99|slow)\b", re.IGNORECASE)
COST_PATTERN = re.compile(r"\b(cost|price|pricing|token|usage|input_tokens|output_tokens)\b", re.IGNORECASE)

ROADMAP_SURFACES: dict[str, dict[str, str]] = {
    "demo": {
        "skill": "skills/understudy-demo/SKILL.md",
        "why": "Local repo workload discovery before provider spend.",
        "next": "Expand static scan signals and add richer Workload Card validation.",
    },
    "workload-discovery": {
        "skill": "skills/understudy-workload-discovery/SKILL.md",
        "why": "Find and rank local repo AI workload candidates before evaluation.",
        "next": "Add workload type classification and richer candidate-card fields.",
    },
    "evaluate": {
        "skill": "skills/understudy-evaluate/SKILL.md",
        "why": "Local-first workload measurement with explicit split boundaries.",
        "next": "Port artifact validation and dry-run eval planning before live runners.",
    },
    "optimize": {
        "skill": "skills/understudy-optimize/SKILL.md",
        "why": "Post-baseline prompt, route, parser, and candidate improvement.",
        "next": "Port local dry-run planning before any optimizer implementation.",
    },
    "train": {
        "skill": "skills/understudy-train/SKILL.md",
        "why": "Local training handoff: provenance, split validation, and export previews.",
        "next": "Port export-preview and validation stubs before hosted provider flows.",
    },
    "model": {
        "skill": "skills/understudy-model-lookup/SKILL.md",
        "why": "Compatibility checks before benchmark or replacement claims.",
        "next": "Port local metadata inspection and public model-card lookup helpers.",
    },
    "local-models": {
        "skill": "skills/understudy-local-models/SKILL.md",
        "why": "Apple Silicon, MLX, Ollama, and local runner readiness before live comparison.",
        "next": "Port local hardware inventory and dry-run runner checks without private workloads.",
    },
    "proxy": {
        "skill": "skills/understudy-local-proxy/SKILL.md",
        "why": "Local OpenAI-compatible routing and trace-capture setup.",
        "next": "Port local fixture proxy checks without hosted-control-plane details.",
    },
    "keys": {
        "skill": "skills/understudy-provider-keys/SKILL.md",
        "why": "Redacted local provider-key status and safe setup guidance.",
        "next": "Port redacted presence checks only; never print secret values.",
    },
}


def _scan_files(repo: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(repo.rglob("*")):
        if not path.is_file():
            continue
        relative_parts = path.relative_to(repo).parts
        if any(part in SCAN_EXCLUDE_DIRS for part in relative_parts):
            continue
        if path.suffix.lower() not in SCAN_EXTENSIONS:
            continue
        if path.stat().st_size > 250_000:
            continue
        files.append(path)
    return files


def _line_hits(text: str, pattern: re.Pattern[str]) -> list[int]:
    return [index for index, line in enumerate(text.splitlines(), start=1) if pattern.search(line)]


def _scan_repo(repo: Path) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for path in _scan_files(repo):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        provider_hits = sorted(
            provider for provider, pattern in PROVIDER_PATTERNS.items() if pattern.search(text)
        )
        models = sorted({match.group(0) for match in MODEL_PATTERN.finditer(text)})
        prompt_lines = _line_hits(text, PROMPT_PATTERN)
        eval_lines = _line_hits(text, EVAL_PATTERN)
        latency_lines = _line_hits(text, LATENCY_PATTERN)
        cost_lines = _line_hits(text, COST_PATTERN)

        score = (
            len(provider_hits) * 3
            + min(len(models), 5) * 2
            + min(len(prompt_lines), 3)
            + min(len(eval_lines), 3)
            + min(len(latency_lines), 2)
            + min(len(cost_lines), 2)
        )
        if score < 3:
            continue

        relative = path.relative_to(repo)
        signals: list[str] = []
        if provider_hits:
            signals.append("provider")
        if models:
            signals.append("model")
        if prompt_lines:
            signals.append("prompt")
        if eval_lines:
            signals.append("eval")
        if latency_lines:
            signals.append("latency")
        if cost_lines:
            signals.append("cost")

        candidates.append(
            {
                "id": "",
                "path": str(relative),
                "score": score,
                "signals": signals,
                "providers": provider_hits,
                "models": models[:10],
                "evidence_lines": {
                    "prompt": prompt_lines[:8],
                    "eval": eval_lines[:8],
                    "latency": latency_lines[:8],
                    "cost": cost_lines[:8],
                },
            }
        )

    ranked = sorted(candidates, key=lambda item: (-int(item["score"]), str(item["path"])))
    for index, candidate in enumerate(ranked, start=1):
        candidate["id"] = f"candidate-{index:03d}"
    return ranked


def _demo_dir(repo: Path) -> Path:
    return repo / ".understudy" / "demo"


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_candidates(repo: Path) -> list[dict[str, object]]:
    path = _demo_dir(repo) / "workload-candidates.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload.get("candidates", []))


def cmd_demo(args: argparse.Namespace) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    if args.demo_action == "scan":
        candidates = _scan_repo(repo)
        payload = {
            "schema_version": "understudy.demo.workload_candidates.v1",
            "repo": str(repo),
            "mode": "local-only",
            "notes": [
                "Static scan only; no provider calls, uploads, model downloads, or secret inspection.",
                "Review candidates before turning any source code into an eval artifact.",
            ],
            "candidates": candidates,
        }
        output = _demo_dir(repo) / "workload-candidates.json"
        _write_json(output, payload)
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"wrote {output}")
            print(f"found {len(candidates)} workload candidate(s)")
            for candidate in candidates[:5]:
                providers = ", ".join(candidate["providers"]) or "unknown-provider"
                signals = ", ".join(candidate["signals"])
                print(f"- {candidate['id']}: {candidate['path']} ({providers}; {signals})")
        return 0

    if args.demo_action == "plan":
        candidates = _load_candidates(repo)
        if not candidates:
            raise SystemExit("no workload candidates found; run `understudy-tools demo scan --repo .` first")
        selected = next(
            (candidate for candidate in candidates if candidate["id"] == args.candidate),
            candidates[0],
        )
        plan = {
            "schema_version": "understudy.demo.workload_card.v1",
            "candidate_id": selected["id"],
            "source_path": selected["path"],
            "mode": "local-only",
            "inferred_signals": selected["signals"],
            "inferred_providers": selected["providers"],
            "inferred_models": selected["models"],
            "approval_required_before": [
                "sending source, prompts, traces, or eval rows to any provider",
                "running live model calls",
                "downloading local models",
                "submitting hosted benchmarks or training jobs",
            ],
            "recommended_next_steps": [
                "confirm the workload owner and success metric",
                "create 10-30 representative public-safe test cases",
                "record current latency, cost, and quality baseline",
                "choose a local, existing-key, or hosted candidate route",
                "prepare blind pairwise review if quality is qualitative",
            ],
        }
        output = _demo_dir(repo) / "workload-card.json"
        _write_json(output, plan)
        if args.json:
            print(json.dumps(plan, indent=2, sort_keys=True))
        else:
            print(f"wrote {output}")
            print(f"planned {selected['id']}: {selected['path']}")
            print("next: confirm success metric and representative test cases")
        return 0

    return cmd_roadmap_surface(args)


def cmd_workload_discovery(args: argparse.Namespace) -> int:
    demo_args = argparse.Namespace(
        demo_action=args.discovery_action,
        repo=args.repo,
        candidate=args.candidate,
        json=args.json,
        surface="workload-discovery",
        action="status",
    )
    if args.discovery_action in {"scan", "plan"}:
        return cmd_demo(demo_args)
    return cmd_roadmap_surface(demo_args)


def _spine() -> dict[str, object]:
    return {
        "name": "understudy-agent-tools",
        "license": "MIT",
        "spines": [
            {"name": "cli", "path": "src/understudy_agent_tools"},
            {"name": "scripts", "path": "scripts"},
            {"name": "skills", "path": "skills"},
            {"name": "vendor", "path": "vendor"},
            {"name": "docs", "path": "docs"},
        ],
        "entrypoint_skill": "skills/understudy/SKILL.md",
        "default_mode": "local-only",
    }


def cmd_spine(args: argparse.Namespace) -> int:
    spine = _spine()
    if args.json:
        print(json.dumps(spine, indent=2, sort_keys=True))
        return 0

    print(f"{spine['name']} ({spine['license']})")
    print("Public spines:")
    for item in spine["spines"]:
        print(f"- {item['name']}: {item['path']}")
    print(f"Entrypoint skill: {spine['entrypoint_skill']}")
    print("Default mode: local-only")
    return 0


def cmd_skills(args: argparse.Namespace) -> int:
    skills_root = REPO_ROOT / "skills"
    skills = sorted(p for p in skills_root.iterdir() if (p / "SKILL.md").exists())
    if args.json:
        print(json.dumps([{"name": p.name, "path": str(p.relative_to(REPO_ROOT))} for p in skills]))
        return 0
    for path in skills:
        print(path.relative_to(REPO_ROOT))
    return 0


def _roadmap_payload(surface: str) -> dict[str, str]:
    spec = ROADMAP_SURFACES[surface]
    return {
        "surface": surface,
        "status": "planned",
        "implemented": "false",
        "default_mode": "local-only",
        "skill": spec["skill"],
        "why": spec["why"],
        "next_migration": spec["next"],
        "migration_plan": "docs/tool-migration-map.md",
    }


def cmd_roadmap_surface(args: argparse.Namespace) -> int:
    payload = _roadmap_payload(args.surface)
    if args.action in {"status", "doctor", "lookup", "route", "validate", "run", "plan", "start", "export"}:
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"{payload['surface']}: {payload['status']}")
            print(f"Skill: {payload['skill']}")
            print(f"Why: {payload['why']}")
            print(f"Next migration: {payload['next_migration']}")
            print(f"Plan: {payload['migration_plan']}")
        return 0
    raise ValueError(f"unsupported action: {args.action}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="understudy-tools")
    subparsers = parser.add_subparsers(dest="command", required=True)

    spine = subparsers.add_parser("spine", help="Show the public repo spine.")
    spine.add_argument("--json", action="store_true")
    spine.set_defaults(func=cmd_spine)

    skills = subparsers.add_parser("skills", help="List bundled skills.")
    skills.add_argument("--json", action="store_true")
    skills.set_defaults(func=cmd_skills)

    demo_parser = subparsers.add_parser("demo", help="Find and plan a local repo workload demo.")
    demo_parser.add_argument(
        "demo_action",
        nargs="?",
        default="status",
        choices=["status", "scan", "plan"],
        help="Scan a local repo for AI workload candidates or plan the first workload card.",
    )
    demo_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    demo_parser.add_argument("--candidate", default="", help="Candidate id from workload-candidates.json.")
    demo_parser.add_argument("--json", action="store_true")
    demo_parser.set_defaults(func=cmd_demo, surface="demo", action="status")

    discovery_parser = subparsers.add_parser(
        "workload-discovery",
        help="Find and plan local repo AI workload candidates.",
    )
    discovery_parser.add_argument(
        "discovery_action",
        nargs="?",
        default="status",
        choices=["status", "scan", "plan"],
        help="Scan a local repo for AI workload candidates or plan the first Workload Card.",
    )
    discovery_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    discovery_parser.add_argument("--candidate", default="", help="Candidate id from workload-candidates.json.")
    discovery_parser.add_argument("--json", action="store_true")
    discovery_parser.set_defaults(func=cmd_workload_discovery, surface="workload-discovery", action="status")

    for surface, spec in ROADMAP_SURFACES.items():
        if surface in {"demo", "workload-discovery"}:
            continue
        surface_parser = subparsers.add_parser(
            surface,
            help=f"Planned public surface: {spec['why']}",
        )
        surface_parser.add_argument(
            "action",
            nargs="?",
            default="status",
            choices=["status", "doctor", "lookup", "route", "validate", "run", "plan", "start", "export"],
            help="Roadmap action stub. All actions report planned status until runtime code lands.",
        )
        surface_parser.add_argument("--json", action="store_true")
        surface_parser.add_argument("--local", action="store_true", help=argparse.SUPPRESS)
        surface_parser.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)
        surface_parser.add_argument("--redacted", action="store_true", help=argparse.SUPPRESS)
        surface_parser.set_defaults(func=cmd_roadmap_surface, surface=surface)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
