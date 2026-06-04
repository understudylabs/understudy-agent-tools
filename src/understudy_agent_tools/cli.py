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
    ".csv",
    ".md",
    ".mjs",
    ".json",
    ".jsonl",
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
CAPTURE_SOURCE_PATTERNS = {
    "ai-call-site": re.compile(
        r"\b(openai|anthropic|gemini|bedrock|fireworks|openrouter|chat\.completions|responses\.create|generateContent)\b",
        re.IGNORECASE,
    ),
    "eval-fixture": re.compile(r"\b(eval|benchmark|golden|fixture|expected|assert)\b", re.IGNORECASE),
    "prompt-template": re.compile(r"\b(prompt|system_message|system prompt|messages\s*=|jinja|handlebars)\b", re.IGNORECASE),
    "trace-or-log": re.compile(r"\b(trace|span|run_id|request_id|input_tokens|output_tokens|latency_ms)\b", re.IGNORECASE),
}
CAPTURE_EXTENSION_KINDS = {
    ".csv": "tabular-data",
    ".json": "json-data",
    ".jsonl": "jsonl-data",
    ".md": "markdown-notes",
    ".txt": "text-notes",
    ".yaml": "yaml-config",
    ".yml": "yaml-config",
}
EXPLICIT_PROVIDER_PATTERN = re.compile(
    r"\bprovider\s*[:=]\s*[\"']?([a-z0-9_-]+)[\"']?",
    re.IGNORECASE,
)
WORKLOAD_SHAPE_PATTERNS = {
    "agentic": re.compile(r"\b(agent|tool_call|tool calls|function_call|function calls)\b", re.IGNORECASE),
    "classification": re.compile(r"\b(classif|intent|label|category|sentiment)\b", re.IGNORECASE),
    "coding": re.compile(r"\b(code|coder|coding|codex|repository|diff|patch)\b", re.IGNORECASE),
    "extraction": re.compile(r"\b(extract|parse|invoice|receipt|attachment|pdf|email)\b", re.IGNORECASE),
    "multimodal": re.compile(r"\b(image|vision|audio|video|ocr|multimodal)\b", re.IGNORECASE),
    "rag": re.compile(r"\b(rag|retrieval|embedding|vector|search|rank|rerank)\b", re.IGNORECASE),
    "structured-output": re.compile(r"\b(json|schema|structured|pydantic|zod)\b", re.IGNORECASE),
    "summarization": re.compile(r"\b(summary|summarize|summarization)\b", re.IGNORECASE),
}

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
    "capture-import": {
        "skill": "skills/understudy-capture-import/SKILL.md",
        "why": "Find local traces, eval fixtures, prompt files, logs, and datasets before building a Workload Card.",
        "next": "Add format-specific import previews and redaction manifests before payload extraction.",
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
        explicit_provider_match = EXPLICIT_PROVIDER_PATTERN.search(text)
        explicit_provider = explicit_provider_match.group(1).lower() if explicit_provider_match else None
        if explicit_provider and explicit_provider not in provider_hits:
            provider_hits.insert(0, explicit_provider)
        elif explicit_provider in provider_hits:
            provider_hits = [explicit_provider] + [
                provider for provider in provider_hits if provider != explicit_provider
            ]
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
                "explicit_provider": explicit_provider,
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


def _classify_capture_source(path: Path, text: str) -> list[str]:
    kinds = []
    extension_kind = CAPTURE_EXTENSION_KINDS.get(path.suffix.lower())
    if extension_kind:
        kinds.append(extension_kind)
    for kind, pattern in CAPTURE_SOURCE_PATTERNS.items():
        if pattern.search(text) or pattern.search(str(path)):
            kinds.append(kind)
    return sorted(set(kinds))


def _scan_capture_sources(repo: Path) -> list[dict[str, object]]:
    sources: list[dict[str, object]] = []
    for path in _scan_files(repo):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        kinds = _classify_capture_source(path, text)
        if not kinds:
            continue
        line_hits = {
            kind: _line_hits(text, CAPTURE_SOURCE_PATTERNS[kind])[:8]
            for kind in CAPTURE_SOURCE_PATTERNS
            if CAPTURE_SOURCE_PATTERNS[kind].search(text)
        }
        relative = path.relative_to(repo)
        sources.append(
            {
                "id": "",
                "path": str(relative),
                "source_kinds": kinds,
                "data_class": "metadata-only",
                "bytes": path.stat().st_size,
                "evidence_lines": line_hits,
                "import_status": "candidate",
                "approval_required_before_payload_read": True,
            }
        )
    ranked = sorted(
        sources,
        key=lambda item: (-len(item["source_kinds"]), str(item["path"])),
    )
    for index, source in enumerate(ranked, start=1):
        source["id"] = f"source-{index:03d}"
    return ranked


def _artifact_dir(repo: Path, capability: str) -> Path:
    return repo / ".understudy" / capability


def _repo_metadata(repo: Path) -> dict[str, str]:
    return {
        "display_name": repo.name,
        "path": ".",
        "path_kind": "repo-relative",
    }


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_candidates(repo: Path, capability: str) -> list[dict[str, object]]:
    path = _artifact_dir(repo, capability) / "workload-candidates.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload.get("candidates", []))


def _classify_workload_shape(candidate: dict[str, object], repo: Path) -> list[str]:
    path_value = candidate.get("path")
    if not isinstance(path_value, str):
        return []
    path = repo / path_value
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        text = path_value
    shapes = [
        shape for shape, pattern in WORKLOAD_SHAPE_PATTERNS.items() if pattern.search(text)
    ]
    return shapes or ["general-llm"]


def _infer_eval_inputs(candidates: list[dict[str, object]]) -> list[str]:
    eval_inputs: list[str] = []
    for candidate in candidates:
        signals = candidate.get("signals", [])
        path = candidate.get("path")
        if isinstance(path, str) and isinstance(signals, list) and "eval" in signals:
            eval_inputs.append(path)
    return eval_inputs[:10]


def _run_scan(args: argparse.Namespace, capability: str) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    candidates = _scan_repo(repo)
    payload = {
        "schema_version": "understudy.workload_candidates.v1",
        "capability": capability,
        "repo": _repo_metadata(repo),
        "mode": "local-only",
        "notes": [
            "Static scan only; no provider calls, uploads, model downloads, or secret inspection.",
            "Review candidates before turning any source code into an eval artifact.",
        ],
        "candidates": candidates,
    }
    output = _artifact_dir(repo, capability) / "workload-candidates.json"
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


def cmd_capture_import(args: argparse.Namespace) -> int:
    if args.capture_action != "scan":
        args.surface = "capture-import"
        args.action = "status"
        return cmd_roadmap_surface(args)

    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    sources = _scan_capture_sources(repo)
    payload = {
        "schema_version": "understudy.capture_sources.v1",
        "capability": "capture-import",
        "repo": _repo_metadata(repo),
        "mode": "local-only",
        "notes": [
            "Static metadata scan only; no provider calls, uploads, model downloads, or secret inspection.",
            "Payload import requires explicit approval plus a redaction and data-boundary plan.",
        ],
        "sources": sources,
        "recommended_next_steps": [
            "review source candidates and remove private or irrelevant files",
            "choose one source to convert into a Workload Card",
            "define data class, redaction needs, split boundary, and approval gates before reading payload rows",
        ],
    }
    output = _artifact_dir(repo, "capture-import") / "capture-sources.json"
    _write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"found {len(sources)} capture/import source candidate(s)")
        for source in sources[:5]:
            kinds = ", ".join(source["source_kinds"])
            print(f"- {source['id']}: {source['path']} ({kinds})")
    return 0


def _run_plan(args: argparse.Namespace, capability: str) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    candidates = _load_candidates(repo, capability)
    if not candidates:
        raise SystemExit(
            f"no workload candidates found; run `understudy-tools {capability} scan --repo .` first"
        )
    selected = next(
        (candidate for candidate in candidates if candidate["id"] == args.candidate),
        candidates[0],
    )
    providers = selected.get("providers", [])
    models = selected.get("models", [])
    baseline = {
        "provider": providers[0] if providers else None,
        "model": models[0] if models else None,
        "latency_ms": None,
        "input_tokens": None,
        "output_tokens": None,
        "cost_usd": None,
    }
    plan = {
        "schema_version": "understudy.workload_card.v1",
        "workload_id": "workload-001",
        "workload_name": None,
        "owner": None,
        "candidate_id": selected["id"],
        "source_path": selected["path"],
        "mode": "local-only",
        "workload_shape": _classify_workload_shape(selected, repo),
        "value_lens": ["quality", "latency", "cost"],
        "success_metric": None,
        "baseline": baseline,
        "data_class": "source-metadata-only",
        "split_boundary": {
            "train": None,
            "dev": None,
            "holdout": None,
        },
        "evaluation_inputs": _infer_eval_inputs(candidates),
        "promotion_gate": None,
        "fallback_route": None,
        "route_requirements": {
            "privacy_boundary": "local-only until explicit approval",
            "latency_target_ms": None,
            "structured_output_required": "structured-output" in _classify_workload_shape(selected, repo),
            "tool_calling_required": "agentic" in _classify_workload_shape(selected, repo),
            "pricing_source_required_before_hosted_recommendation": True,
            "supplier_profile_required_before_hosted_recommendation": True,
        },
        "inferred_signals": selected["signals"],
        "inferred_providers": providers,
        "inferred_models": models,
        "approval_gates": [
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
    output = _artifact_dir(repo, capability) / "workload-card.json"
    _write_json(output, plan)
    if args.json:
        print(json.dumps(plan, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"planned {selected['id']}: {selected['path']}")
        print("next: confirm success metric and representative test cases")
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    if args.demo_action == "scan":
        return _run_scan(args, "workload-discovery")
    if args.demo_action == "plan":
        return _run_plan(args, "workload-discovery")
    return cmd_roadmap_surface(args)


def cmd_workload_discovery(args: argparse.Namespace) -> int:
    if args.discovery_action == "scan":
        return _run_scan(args, "workload-discovery")
    if args.discovery_action == "plan":
        return _run_plan(args, "workload-discovery")
    args.surface = "workload-discovery"
    args.action = "status"
    return cmd_roadmap_surface(args)


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

    capture_parser = subparsers.add_parser(
        "capture-import",
        help="Find local traces, eval fixtures, prompt files, logs, and datasets.",
    )
    capture_parser.add_argument(
        "capture_action",
        nargs="?",
        default="status",
        choices=["status", "scan"],
        help="Scan a local repo for importable workload evidence sources.",
    )
    capture_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    capture_parser.add_argument("--json", action="store_true")
    capture_parser.set_defaults(func=cmd_capture_import, surface="capture-import", action="status")

    for surface, spec in ROADMAP_SURFACES.items():
        if surface in {"demo", "workload-discovery", "capture-import"}:
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
