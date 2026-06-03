from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

ROADMAP_SURFACES: dict[str, dict[str, str]] = {
    "demo": {
        "skill": "skills/understudy-demo/SKILL.md",
        "why": "Replay-first onboarding with bundled or synthetic examples.",
        "next": "Port a no-provider fixture replay from understudy-agent.",
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

    for surface, spec in ROADMAP_SURFACES.items():
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
