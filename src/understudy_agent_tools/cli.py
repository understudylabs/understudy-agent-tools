from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

from understudy_agent_tools.artifact_contract import (
    REQUIRED_BASELINE_ARTIFACTS,
    build_artifact_contract,
    default_understand_artifact_paths,
    stale_hash_blockers,
    validate_metric_contract,
)
from understudy_agent_tools.route_decision import build_route_decision
from understudy_agent_tools.value_calculator import build_value_report


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
CAPTURE_PREVIEW_DEFAULT_LIMIT = 25
CAPTURE_PREVIEW_MAX_LIMIT = 200
CAPTURE_PREVIEW_DEFAULT_MAX_CHARS = 500
VALIDATE_AND_OPTIMIZE_REQUIRED_ARTIFACTS = REQUIRED_BASELINE_ARTIFACTS
PREVIEWABLE_SOURCE_EXTENSIONS = {".jsonl", ".json", ".csv", ".yaml", ".yml", ".md", ".txt"}
REDACTION_DROP_FIELDS = {
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "credential",
    "password",
    "secret",
    "token",
}
REDACTION_HASH_FIELDS = {
    "account",
    "account_id",
    "customer_id",
    "domain",
    "email",
    "phone",
    "session_id",
    "tenant_id",
    "user",
    "user_id",
}
REDACTION_REVIEW_FIELDS = {
    "completion",
    "content",
    "input",
    "message",
    "messages",
    "output",
    "prompt",
    "question",
    "response",
    "system",
    "text",
}
REDACTION_KEEP_FIELDS = {
    "category",
    "expected_label",
    "label",
    "latency",
    "latency_ms",
    "score",
    "split",
    "status",
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
    "provider-integrations": {
        "skill": "skills/understudy-provider-integrations/SKILL.md",
        "why": "Provider cookbook mapping and route-decision planning before live calls.",
        "next": "Port redacted key readiness, model lookup, supplier profile refresh, and route-decision packet generation.",
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
    "value": {
        "skill": "skills/understudy-value-reporting/SKILL.md",
        "why": "Conservative value reporting from measured evidence.",
        "next": "Expand beyond baseline-only scenario math after eval evidence lands.",
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
                "preview_supported": path.suffix.lower() in PREVIEWABLE_SOURCE_EXTENSIONS,
                "import_status": "candidate",
                "approval_required_before_payload_read": True,
            }
        )
    ranked = sorted(
        sources,
        key=lambda item: (not bool(item["preview_supported"]), -len(item["source_kinds"]), str(item["path"])),
    )
    for index, source in enumerate(ranked, start=1):
        source["id"] = f"source-{index:03d}"
    return ranked


def _artifact_dir(repo: Path, capability: str) -> Path:
    return repo / ".understudy" / capability


def _resolve_repo_path(repo: Path, path_value: str) -> Path:
    path = Path(path_value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (repo / path).resolve()


def _repo_relative_path(repo: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(repo.resolve()))
    except ValueError:
        return str(path)


def _repo_metadata(repo: Path) -> dict[str, str]:
    return {
        "display_name": repo.name,
        "path": ".",
        "path_kind": "repo-relative",
    }


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _payload_items(payload: dict[str, object], key: str) -> list[object]:
    value = payload.get(key, [])
    return value if isinstance(value, list) else []


def _load_candidates(repo: Path, capability: str) -> list[dict[str, object]]:
    path = _artifact_dir(repo, capability) / "workload-candidates.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload.get("candidates", []))


def _load_capture_sources(repo: Path) -> list[dict[str, object]]:
    path = _artifact_dir(repo, "capture-import") / "capture-sources.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload.get("sources", []))


def _build_workload_scan_payload(repo: Path, capability: str) -> tuple[dict[str, object], Path]:
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
    return payload, output


def _build_capture_scan_payload(repo: Path) -> tuple[dict[str, object], Path]:
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
    return payload, output


def _truncate_value(value: object, max_chars: int) -> object:
    if isinstance(value, dict):
        return {str(key): _truncate_value(item, max_chars) for key, item in value.items()}
    if isinstance(value, list):
        return [_truncate_value(item, max_chars) for item in value]
    if isinstance(value, str) and len(value) > max_chars:
        return value[:max_chars] + "...[truncated]"
    return value


def _preview_jsonl(path: Path, limit: int, max_chars: int) -> tuple[list[object], list[str]]:
    records: list[object] = []
    warnings: list[str] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if len(records) >= limit:
            break
        if not line.strip():
            continue
        try:
            records.append(_truncate_value(json.loads(line), max_chars))
        except json.JSONDecodeError as exc:
            warnings.append(f"line {line_number}: invalid JSONL row: {exc.msg}")
            records.append({"line": line_number, "text": _truncate_value(line, max_chars)})
    return records, warnings


def _preview_json(path: Path, limit: int, max_chars: int) -> tuple[list[object], list[str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        records = payload[:limit]
    elif isinstance(payload, dict):
        records = [payload]
    else:
        records = [payload]
    return [_truncate_value(record, max_chars) for record in records], []


def _preview_csv(path: Path, limit: int, max_chars: int) -> tuple[list[object], list[str]]:
    records: list[object] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if len(records) >= limit:
                break
            records.append(_truncate_value(dict(row), max_chars))
    return records, []


def _preview_text(path: Path, limit: int, max_chars: int) -> tuple[list[object], list[str]]:
    records = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if len(records) >= limit:
            break
        if line.strip():
            records.append({"line": line_number, "text": _truncate_value(line, max_chars)})
    return records, []


def _preview_source_file(path: Path, limit: int, max_chars: int) -> tuple[list[object], list[str]]:
    suffix = path.suffix.lower()
    if suffix == ".jsonl":
        return _preview_jsonl(path, limit, max_chars)
    if suffix == ".json":
        return _preview_json(path, limit, max_chars)
    if suffix == ".csv":
        return _preview_csv(path, limit, max_chars)
    if suffix in {".yaml", ".yml", ".md", ".txt"}:
        return _preview_text(path, limit, max_chars)
    raise ValueError(f"unsupported preview source type: {suffix or '<none>'}")


def _normalize_field_name(path: str) -> str:
    return path.rsplit(".", 1)[-1].replace("-", "_").lower()


def _iter_field_paths(value: object, prefix: str = "$") -> list[tuple[str, object]]:
    if isinstance(value, dict):
        fields: list[tuple[str, object]] = []
        for key, item in value.items():
            child = f"{prefix}.{key}" if prefix != "$" else str(key)
            fields.extend(_iter_field_paths(item, child))
        return fields
    if isinstance(value, list):
        fields = []
        for item in value[:3]:
            child = f"{prefix}[]"
            fields.extend(_iter_field_paths(item, child))
        return fields
    return [(prefix, value)]


def _classify_redaction_action(field_path: str) -> tuple[str, str]:
    field = _normalize_field_name(field_path)
    if field in REDACTION_DROP_FIELDS or any(token in field for token in ["secret", "token", "password"]):
        return "drop", "secret-like field name"
    if field in REDACTION_HASH_FIELDS or field.endswith("_id") or "email" in field:
        return "hash", "identifier-like field name"
    if field in REDACTION_REVIEW_FIELDS or any(token in field for token in ["prompt", "completion", "message"]):
        return "review", "content-like field name"
    if field in REDACTION_KEEP_FIELDS or field.endswith("_ms") or field in {"id", "index"}:
        return "keep", "operational metric or label field"
    return "review", "unclassified field"


def _build_redaction_manifest(source: dict[str, object], records: list[object]) -> dict[str, object]:
    field_stats: dict[str, dict[str, object]] = {}
    for record in records:
        for field_path, value in _iter_field_paths(record):
            stats = field_stats.setdefault(
                field_path,
                {
                    "field_path": field_path,
                    "sample_count": 0,
                    "value_types": set(),
                },
            )
            stats["sample_count"] = int(stats["sample_count"]) + 1
            stats["value_types"].add(type(value).__name__)

    fields = []
    for field_path, stats in sorted(field_stats.items()):
        action, reason = _classify_redaction_action(field_path)
        fields.append(
            {
                "field_path": field_path,
                "recommended_action": action,
                "reason": reason,
                "sample_count": stats["sample_count"],
                "value_types": sorted(stats["value_types"]),
            }
        )

    action_counts = {
        action: sum(1 for field in fields if field["recommended_action"] == action)
        for action in ["keep", "review", "hash", "drop"]
    }
    return {
        "schema_version": "understudy.redaction_manifest.v1",
        "capability": "capture-import",
        "source_id": source["id"],
        "source_path": source["path"],
        "status": "recommended",
        "data_class": "local-preview",
        "review_required": True,
        "record_count": len(records),
        "action_counts": action_counts,
        "fields": fields,
        "approval_required_before": [
            "upload",
            "provider call",
            "hosted job",
            "training handoff",
            "public commit",
        ],
        "notes": [
            "Recommendations are based on field names and preview shape only.",
            "No records were mutated; review before exporting fixtures or provider-bound inputs.",
        ],
    }


def _load_capture_preview(repo: Path, source_id: str) -> dict[str, object]:
    path = _artifact_dir(repo, "capture-import") / f"preview-{source_id}.json"
    if not path.exists():
        raise SystemExit(
            f"preview artifact not found for {source_id}; run `understudy-tools capture-import preview --repo . --source-id {source_id}` first"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _load_redaction_manifest(repo: Path) -> dict[str, object]:
    path = _artifact_dir(repo, "capture-import") / "redaction-manifest.json"
    if not path.exists():
        raise SystemExit("redaction manifest not found; run `understudy-tools capture-import preview --repo .` first")
    return json.loads(path.read_text(encoding="utf-8"))


def _infer_workload_shape_from_capture(
    source: dict[str, object],
    preview: dict[str, object],
    manifest: dict[str, object],
) -> list[str]:
    kinds = set(str(kind) for kind in source.get("source_kinds", []))
    fields = {
        str(field.get("field_path", "")).lower()
        for field in manifest.get("fields", [])
        if isinstance(field, dict)
    }
    shapes: list[str] = []
    if {"jsonl-data", "tabular-data", "eval-fixture"} & kinds:
        shapes.append("evaluation-dataset")
    if {"prompt-template", "trace-or-log"} & kinds:
        shapes.append("llm-replay")
    if "ai-call-site" in kinds:
        shapes.append("app-route")
    field_blob = " ".join(fields)
    if any(token in field_blob for token in ["label", "category", "class"]):
        shapes.append("classification")
    if any(token in field_blob for token in ["input", "expected", "output", "prompt", "completion"]):
        shapes.append("structured-output")
    return sorted(set(shapes)) or ["general-llm"]


def _approval_gates_from_manifest(manifest: dict[str, object]) -> list[str]:
    action_counts = manifest.get("action_counts") if isinstance(manifest.get("action_counts"), dict) else {}
    gates = [
        "sending preview records, source payloads, prompts, traces, or eval rows to any provider",
        "running live model calls",
        "downloading local models",
        "submitting hosted benchmarks or training jobs",
    ]
    if int(action_counts.get("drop", 0) or 0) > 0:
        gates.insert(0, "removing secret-like fields before any export")
    if int(action_counts.get("hash", 0) or 0) > 0:
        gates.insert(0, "hashing identifier-like fields before any export")
    if int(action_counts.get("review", 0) or 0) > 0:
        gates.insert(0, "reviewing content-like fields before any export")
    return gates


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

    payload, output = _build_workload_scan_payload(repo, capability)
    _write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        candidates = _payload_items(payload, "candidates")
        print(f"found {len(candidates)} workload candidate(s)")
        for candidate in candidates[:5]:
            if not isinstance(candidate, dict):
                continue
            providers = ", ".join(candidate["providers"]) or "unknown-provider"
            signals = ", ".join(candidate["signals"])
            print(f"- {candidate['id']}: {candidate['path']} ({providers}; {signals})")
    return 0


def _run_capture_scan(args: argparse.Namespace) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    payload, output = _build_capture_scan_payload(repo)
    _write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        sources = _payload_items(payload, "sources")
        print(f"found {len(sources)} capture/import source candidate(s)")
        for source in sources[:5]:
            if not isinstance(source, dict):
                continue
            kinds = ", ".join(source["source_kinds"])
            print(f"- {source['id']}: {source['path']} ({kinds})")
    return 0


def cmd_capture_import(args: argparse.Namespace) -> int:
    if args.capture_action == "preview":
        return _run_capture_preview(args)
    if args.capture_action == "workload-card":
        return _run_capture_workload_card(args)
    if args.capture_action != "scan":
        args.surface = "capture-import"
        args.action = "status"
        return cmd_roadmap_surface(args)

    return _run_capture_scan(args)


def _run_capture_preview(args: argparse.Namespace) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")
    limit = max(1, min(args.limit, CAPTURE_PREVIEW_MAX_LIMIT))
    max_chars = max(80, args.max_chars)

    sources = _load_capture_sources(repo)
    if not sources:
        raise SystemExit("no capture sources found; run `understudy-tools capture-import scan --repo .` first")
    selected = next((source for source in sources if source.get("id") == args.source_id), None)
    if selected is None:
        available = ", ".join(str(source.get("id")) for source in sources[:10])
        raise SystemExit(f"source id not found: {args.source_id}. Available: {available}")

    source_path = repo / str(selected["path"])
    if not source_path.exists():
        raise SystemExit(f"source file does not exist: {selected['path']}")
    records, warnings = _preview_source_file(source_path, limit, max_chars)
    preview = {
        "schema_version": "understudy.capture_preview.v1",
        "capability": "capture-import",
        "mode": "local-only",
        "source_id": selected["id"],
        "source_path": selected["path"],
        "source_kinds": selected.get("source_kinds", []),
        "data_class": "local-preview",
        "limit_requested": args.limit,
        "limit_applied": limit,
        "max_chars_per_field": max_chars,
        "record_count": len(records),
        "records": records,
        "warnings": warnings,
        "approval_gates": [
            "uploading preview records",
            "sending preview records to a provider",
            "committing preview records",
            "using preview records for hosted jobs or training",
        ],
        "notes": [
            "Preview records are local artifacts and may contain private payloads.",
            "Review and redact before converting records into public fixtures or provider-bound eval inputs.",
        ],
    }
    output = _artifact_dir(repo, "capture-import") / f"preview-{selected['id']}.json"
    _write_json(output, preview)

    manifest = _build_redaction_manifest(selected, records)
    manifest_path = _artifact_dir(repo, "capture-import") / "redaction-manifest.json"
    _write_json(manifest_path, manifest)

    if args.json:
        print(json.dumps(preview, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"wrote {manifest_path}")
        print(f"previewed {len(records)} record(s) from {selected['id']} with local-only boundaries")
        print("records were written to the preview artifact, not printed to the terminal")
    return 0


def _run_capture_workload_card(args: argparse.Namespace) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")
    sources = _load_capture_sources(repo)
    if not sources:
        raise SystemExit("no capture sources found; run `understudy-tools capture-import scan --repo .` first")
    selected = next((source for source in sources if source.get("id") == args.source_id), None)
    if selected is None:
        available = ", ".join(str(source.get("id")) for source in sources[:10])
        raise SystemExit(f"source id not found: {args.source_id}. Available: {available}")

    preview = _load_capture_preview(repo, args.source_id)
    manifest = _load_redaction_manifest(repo)
    if manifest.get("source_id") != args.source_id:
        raise SystemExit(
            f"redaction manifest is for {manifest.get('source_id')}, not {args.source_id}; rerun capture-import preview"
        )

    source_path = str(selected["path"])
    preview_path = f".understudy/capture-import/preview-{args.source_id}.json"
    manifest_path = ".understudy/capture-import/redaction-manifest.json"
    card = {
        "schema_version": "understudy.workload_card.v1",
        "workload_id": args.workload_id,
        "workload_name": args.workload_name,
        "owner": None,
        "candidate_id": None,
        "source_id": args.source_id,
        "source_path": source_path,
        "mode": "local-only",
        "workload_shape": _infer_workload_shape_from_capture(selected, preview, manifest),
        "value_lens": ["quality", "latency", "cost"],
        "success_metric": None,
        "baseline": {
            "provider": None,
            "model": None,
            "latency_ms": None,
            "input_tokens": None,
            "output_tokens": None,
            "cost_usd": None,
        },
        "data_class": "local-preview-metadata",
        "split_boundary": {
            "train": None,
            "dev": None,
            "holdout": None,
        },
        "evaluation_inputs": [source_path],
        "capture_import": {
            "source_id": args.source_id,
            "source_kinds": selected.get("source_kinds", []),
            "capture_sources": ".understudy/capture-import/capture-sources.json",
            "preview_artifact": preview_path,
            "redaction_manifest": manifest_path,
            "preview_record_count": preview.get("record_count"),
            "redaction_action_counts": manifest.get("action_counts", {}),
        },
        "promotion_gate": None,
        "fallback_route": None,
        "route_requirements": {
            "privacy_boundary": "local-only until explicit approval",
            "latency_target_ms": None,
            "structured_output_required": "structured-output"
            in _infer_workload_shape_from_capture(selected, preview, manifest),
            "tool_calling_required": False,
            "pricing_source_required_before_hosted_recommendation": True,
            "supplier_profile_required_before_hosted_recommendation": True,
        },
        "approval_gates": _approval_gates_from_manifest(manifest),
        "recommended_next_steps": [
            "review redaction manifest actions",
            "confirm success metric and split boundary",
            "run route-decision plan before provider calls",
        ],
    }
    output = _artifact_dir(repo, "workload-discovery") / "workload-card.json"
    _write_json(output, card)
    if args.json:
        print(json.dumps(card, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"planned {args.source_id}: {source_path}")
        print("next: understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json")
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


def cmd_route_decision(args: argparse.Namespace) -> int:
    if args.route_action != "plan":
        payload = {
            "surface": "route-decision",
            "status": "implemented",
            "default_mode": "local-only",
            "skill": "docs/route-decision-packet-template.md",
            "why": "Turn a Workload Card into a conservative route shortlist before live calls.",
            "next_migration": "Add supplier profile refresh and pricing source lookup.",
            "migration_plan": "docs/tool-migration-map.md",
        }
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"{payload['surface']}: {payload['status']}")
            print(f"Skill: {payload['skill']}")
            print(f"Why: {payload['why']}")
            print(f"Next migration: {payload['next_migration']}")
            print(f"Plan: {payload['migration_plan']}")
        return 0

    packet, output = build_route_decision(Path(args.workload_card).expanduser().resolve())
    if args.json:
        print(json.dumps(packet, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"decision: {packet['decision']}")
        print(f"candidate routes: {len(packet['candidate_routes'])}")
        print(f"next: {packet['recommended_next_command']}")
    return 0


def cmd_value(args: argparse.Namespace) -> int:
    if args.value_action != "report":
        args.surface = "value"
        args.action = "status"
        return cmd_roadmap_surface(args)

    report, output = build_value_report(
        Path(args.workload_card).expanduser().resolve(),
        Path(args.route_decision).expanduser().resolve(),
        args.requests_per_month,
        overrides={
            "baseline_cost_usd": args.baseline_cost_usd,
            "baseline_latency_ms": args.baseline_latency_ms,
            "candidate_cost_usd": args.candidate_cost_usd,
            "candidate_latency_ms": args.candidate_latency_ms,
        },
        output_path=Path(args.output).expanduser().resolve() if args.output else None,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"decision: {report['decision']}")
        print("savings: not claimed without measured candidate evidence")
        print(f"next: {report['recommended_next_command']}")
    return 0


def cmd_understand(args: argparse.Namespace) -> int:
    if args.understand_action == "scan":
        repo = Path(args.repo).expanduser().resolve()
        if not repo.exists() or not repo.is_dir():
            raise SystemExit(f"repo does not exist or is not a directory: {repo}")
        workload_payload, workload_output = _build_workload_scan_payload(repo, "workload-discovery")
        capture_payload, capture_output = _build_capture_scan_payload(repo)
        _write_json(workload_output, workload_payload)
        _write_json(capture_output, capture_payload)
        combined = {
            "schema_version": "understudy.understand_scan.v1",
            "capability": "understand",
            "mode": "local-only",
            "outputs": {
                "workload_candidates": _repo_relative_path(repo, workload_output),
                "capture_sources": _repo_relative_path(repo, capture_output),
            },
            "workload_candidates_found": len(_payload_items(workload_payload, "candidates")),
            "capture_sources_found": len(_payload_items(capture_payload, "sources")),
            "recommended_next_steps": [
                "review capture/import sources",
                "run `understudy-tools understand preview --repo . --source-id source-001`",
                "run `understudy-tools understand workload-card --repo . --source-id source-001`",
            ],
        }
        if args.json:
            print(json.dumps(combined, indent=2, sort_keys=True))
        else:
            print(f"wrote {workload_output}")
            print(f"wrote {capture_output}")
            print(f"found {combined['workload_candidates_found']} workload candidate(s)")
            print(f"found {combined['capture_sources_found']} capture/import source candidate(s)")
            print("next: understudy-tools understand preview --repo . --source-id source-001")
        return 0
    if args.understand_action == "preview":
        return _run_capture_preview(args)
    if args.understand_action == "workload-card":
        return _run_capture_workload_card(args)
    if args.understand_action == "plan":
        return _run_plan(args, "workload-discovery")
    payload = {
        "surface": "understand",
        "status": "implemented",
        "default_mode": "local-only",
        "aliases": {
            "scan": [
                "understudy-tools workload-discovery scan",
                "understudy-tools capture-import scan",
            ],
            "preview": "understudy-tools capture-import preview",
            "workload-card": "understudy-tools capture-import workload-card",
            "plan": "understudy-tools workload-discovery plan",
        },
        "why": "Build the first local Workload Card from repo signals and capture/import artifacts.",
        "next": "validate-and-optimize dry-run after harness, metric, splits, and baseline artifacts exist.",
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"{payload['surface']}: {payload['status']}")
        print("Default mode: local-only")
        print("Commands: scan, preview, workload-card, plan")
        print(f"Next: {payload['next']}")
    return 0


def _read_required_json_artifacts(
    repo: Path,
    artifact_paths: dict[str, str],
) -> tuple[list[dict[str, object]], dict[str, dict[str, object]], list[dict[str, object]]]:
    checks: list[dict[str, object]] = []
    loaded: dict[str, dict[str, object]] = {}
    blockers: list[dict[str, object]] = []
    for name, path_value in artifact_paths.items():
        path = _resolve_repo_path(repo, path_value)
        check = {
            "name": name,
            "path": _repo_relative_path(repo, path),
            "required": True,
        }
        if not path.exists():
            blocker = {
                "name": name,
                "path": _repo_relative_path(repo, path),
                "reason": "missing required artifact",
            }
            check["status"] = "missing"
            checks.append(check)
            blockers.append(blocker)
            continue
        if not path.is_file():
            blocker = {
                "name": name,
                "path": _repo_relative_path(repo, path),
                "reason": "required artifact path is not a file",
            }
            check["status"] = "invalid"
            checks.append(check)
            blockers.append(blocker)
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            blocker = {
                "name": name,
                "path": _repo_relative_path(repo, path),
                "reason": f"invalid JSON: {exc.msg}",
            }
            check["status"] = "invalid"
            checks.append(check)
            blockers.append(blocker)
            continue
        if not isinstance(payload, dict):
            blocker = {
                "name": name,
                "path": _repo_relative_path(repo, path),
                "reason": "artifact root must be a JSON object",
            }
            check["status"] = "invalid"
            checks.append(check)
            blockers.append(blocker)
            continue
        check["status"] = "ok"
        check["schema_version"] = payload.get("schema_version")
        checks.append(check)
        loaded[name] = payload
    return checks, loaded, blockers


def _write_validate_and_optimize_blockers(
    repo: Path,
    checks: list[dict[str, object]],
    blockers: list[dict[str, object]],
    contract: dict[str, object] | None = None,
) -> tuple[dict[str, object], Path]:
    payload = {
        "schema_version": "understudy.validate_and_optimize_blockers.v1",
        "capability": "validate-and-optimize",
        "status": "blocked",
        "mode": "fail-closed",
        "blocked_before": [
            "route decision refresh",
            "value report refresh",
            "optimizer dry-run proof packet",
            "live GEPA execution",
        ],
        "required_artifacts": list(VALIDATE_AND_OPTIMIZE_REQUIRED_ARTIFACTS),
        "artifact_contract": contract,
        "checks": checks,
        "blockers": blockers,
        "recommended_next_steps": [
            "write local harness.json, metric.json, splits.json, and baseline.json artifacts under .understudy/understand-workload/",
            "rerun the incumbent baseline after harness, metric, or splits changes so baseline hashes match",
            "rerun `understudy-tools validate-and-optimize dry-run --repo .`",
            "do not run hosted optimization or provider calls until these artifacts pass local review",
        ],
    }
    output = _artifact_dir(repo, "validate-and-optimize") / "blockers.json"
    _write_json(output, payload)
    return payload, output


def cmd_validate_and_optimize(args: argparse.Namespace) -> int:
    if args.validate_optimize_action == "status":
        payload = {
            "surface": "validate-and-optimize",
            "status": "dry-run-only",
            "default_mode": "local-only",
            "required_artifacts": list(VALIDATE_AND_OPTIMIZE_REQUIRED_ARTIFACTS),
            "why": "Validate local eval proof before any optimizer or provider spend.",
            "optimizer_status": "GEPA is not externalized in this public CLI.",
        }
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"{payload['surface']}: {payload['status']}")
            print("Required artifacts: harness.json, metric.json, splits.json, baseline.json")
            print(f"Optimizer: {payload['optimizer_status']}")
        return 0

    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists() or not repo.is_dir():
        raise SystemExit(f"repo does not exist or is not a directory: {repo}")

    artifact_paths = {
        "harness": args.harness,
        "metric": args.metric,
        "splits": args.splits,
        "baseline": args.baseline,
    }
    checks, loaded, blockers = _read_required_json_artifacts(repo, artifact_paths)
    relative_paths = {
        name: _repo_relative_path(repo, _resolve_repo_path(repo, path_value))
        for name, path_value in artifact_paths.items()
    }
    contract = build_artifact_contract(paths=relative_paths, loaded=loaded, checks=checks)
    if not blockers and set(loaded) == set(VALIDATE_AND_OPTIMIZE_REQUIRED_ARTIFACTS):
        stale_blockers = stale_hash_blockers(loaded=loaded)
        for blocker in stale_blockers:
            name = str(blocker["name"])
            path_value = relative_paths.get(name)
            if path_value:
                blocker["path"] = path_value
            blockers.append(blocker)
        for check in checks:
            if any(blocker["name"] == check["name"] for blocker in stale_blockers):
                check["status"] = "stale"
        if not stale_blockers:
            metric_blockers = validate_metric_contract(loaded["metric"])
            for blocker in metric_blockers:
                blocker["path"] = relative_paths["metric"]
                blockers.append(blocker)
            for check in checks:
                if check["name"] == "metric" and metric_blockers:
                    check["status"] = "diagnostic" if any(
                        blocker.get("mode") == "diagnostic" for blocker in metric_blockers
                    ) else "unapproved"
    if blockers:
        payload, output = _write_validate_and_optimize_blockers(repo, checks, blockers, contract)
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"wrote {output}")
            print("blocked: missing or invalid required artifact(s)")
            for blocker in blockers:
                print(f"- {blocker['name']}: {blocker['path']} ({blocker['reason']})")
        return 2

    workload_card = _resolve_repo_path(repo, args.workload_card)
    if not workload_card.exists():
        wc_blockers = [
            {
                "name": "workload_card",
                "path": str(workload_card),
                "reason": "missing workload card; run understand-workload first",
            }
        ]
        payload, output = _write_validate_and_optimize_blockers(repo, checks, wc_blockers, contract)
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(f"wrote {output}")
            print("blocked: missing or invalid required artifact(s)")
            for blocker in wc_blockers:
                print(f"- {blocker['name']}: {blocker['path']} ({blocker['reason']})")
        return 2
    route_packet, route_output = build_route_decision(workload_card)
    value_report, value_output = build_value_report(
        workload_card,
        route_output,
        args.requests_per_month,
        overrides={
            "baseline_cost_usd": args.baseline_cost_usd,
            "baseline_latency_ms": args.baseline_latency_ms,
            "candidate_cost_usd": args.candidate_cost_usd,
            "candidate_latency_ms": args.candidate_latency_ms,
        },
    )
    proof = {
        "schema_version": "understudy.validate_and_optimize_proof.v1",
        "capability": "validate-and-optimize",
        "status": "refused_optimizer_execution",
        "mode": "local-only",
        "action_requested": args.validate_optimize_action,
        "workload_card": _repo_relative_path(repo, workload_card),
        "checked_artifacts": checks,
        "artifact_contract": contract,
        "input_schemas": {
            name: loaded[name].get("schema_version")
            for name in sorted(loaded)
        },
        "outputs": {
            "route_decision_packet": _repo_relative_path(repo, route_output),
            "value_report": _repo_relative_path(repo, value_output),
        },
        "route_decision": route_packet.get("decision"),
        "value_decision": value_report.get("decision"),
        "optimizer": {
            "name": "GEPA",
            "externalized": False,
            "executed": False,
            "refusal_reason": "Full GEPA optimization is not available in this public CLI yet.",
        },
        "blocked_actions": [
            "generating optimizer candidates",
            "mutating prompts, parsers, routes, or model configs",
            "running live model calls",
            "submitting hosted optimization jobs",
            "claiming quality, latency, or cost improvements",
        ],
        "recommended_next_steps": [
            "review route decision and value report artifacts",
            "externalize a local GEPA runner with deterministic inputs before enabling optimizer execution",
            "wire optimizer output into a candidate artifact with measured holdout evidence before making claims",
        ],
    }
    output = _artifact_dir(repo, "validate-and-optimize") / "proof-packet.json"
    _write_json(output, proof)
    if args.json:
        print(json.dumps(proof, indent=2, sort_keys=True))
    else:
        print(f"wrote {route_output}")
        print(f"wrote {value_output}")
        print(f"wrote {output}")
        print("GEPA optimizer execution refused: public CLI has dry-run proof only")
        print("savings/quality improvements: not claimed without measured candidate evidence")
    return 1 if args.validate_optimize_action == "run" else 0


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

    understand_parser = subparsers.add_parser(
        "understand",
        help="User-facing MVP spine for repo understanding and Workload Card creation.",
    )
    understand_parser.add_argument(
        "understand_action",
        nargs="?",
        default="status",
        choices=["status", "scan", "preview", "workload-card", "plan"],
        help="Scan repo signals, preview capture sources, or create a Workload Card.",
    )
    understand_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    understand_parser.add_argument("--candidate", default="", help="Candidate id from workload-candidates.json.")
    understand_parser.add_argument("--source-id", default="source-001", help="Source id from capture-sources.json.")
    understand_parser.add_argument("--workload-id", default="workload-001")
    understand_parser.add_argument("--workload-name", default=None)
    understand_parser.add_argument(
        "--limit",
        type=int,
        default=CAPTURE_PREVIEW_DEFAULT_LIMIT,
        help=f"Preview record limit, capped at {CAPTURE_PREVIEW_MAX_LIMIT}.",
    )
    understand_parser.add_argument(
        "--max-chars",
        type=int,
        default=CAPTURE_PREVIEW_DEFAULT_MAX_CHARS,
        help="Maximum characters per string field in preview artifacts.",
    )
    understand_parser.add_argument("--json", action="store_true")
    understand_parser.set_defaults(func=cmd_understand, surface="understand", action="status")

    capture_parser = subparsers.add_parser(
        "capture-import",
        help="Find local traces, eval fixtures, prompt files, logs, and datasets.",
    )
    capture_parser.add_argument(
        "capture_action",
        nargs="?",
        default="status",
        choices=["status", "scan", "preview", "workload-card"],
        help="Scan a local repo for importable workload evidence sources.",
    )
    capture_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    capture_parser.add_argument("--source-id", default="source-001", help="Source id from capture-sources.json.")
    capture_parser.add_argument("--workload-id", default="workload-001")
    capture_parser.add_argument("--workload-name", default=None)
    capture_parser.add_argument(
        "--limit",
        type=int,
        default=CAPTURE_PREVIEW_DEFAULT_LIMIT,
        help=f"Preview record limit, capped at {CAPTURE_PREVIEW_MAX_LIMIT}.",
    )
    capture_parser.add_argument(
        "--max-chars",
        type=int,
        default=CAPTURE_PREVIEW_DEFAULT_MAX_CHARS,
        help="Maximum characters per string field in preview artifacts.",
    )
    capture_parser.add_argument("--json", action="store_true")
    capture_parser.set_defaults(func=cmd_capture_import, surface="capture-import", action="status")

    route_parser = subparsers.add_parser(
        "route-decision",
        help="Create a conservative route decision packet from a Workload Card.",
    )
    route_parser.add_argument(
        "route_action",
        nargs="?",
        default="status",
        choices=["status", "plan"],
        help="Plan route candidates from an existing Workload Card.",
    )
    route_parser.add_argument(
        "--workload-card",
        default=".understudy/workload-discovery/workload-card.json",
        help="Path to a Workload Card JSON artifact.",
    )
    route_parser.add_argument("--json", action="store_true")
    route_parser.set_defaults(func=cmd_route_decision, surface="route-decision", action="status")

    value_parser = subparsers.add_parser(
        "value",
        help="Create a conservative value report from measured artifacts.",
    )
    value_parser.add_argument(
        "value_action",
        nargs="?",
        default="status",
        choices=["status", "report"],
        help="Create a value report from a Workload Card and Route Decision Packet.",
    )
    value_parser.add_argument(
        "--workload-card",
        default=".understudy/workload-discovery/workload-card.json",
        help="Path to a Workload Card JSON artifact.",
    )
    value_parser.add_argument(
        "--route-decision",
        default=".understudy/route-decision/route-decision-packet.json",
        help="Path to a Route Decision Packet JSON artifact.",
    )
    value_parser.add_argument("--requests-per-month", type=int, default=None)
    value_parser.add_argument("--baseline-cost-usd", type=float, default=None)
    value_parser.add_argument("--baseline-latency-ms", type=float, default=None)
    value_parser.add_argument("--candidate-cost-usd", type=float, default=None)
    value_parser.add_argument("--candidate-latency-ms", type=float, default=None)
    value_parser.add_argument("--output", default=None, help="Optional output path for the value report.")
    value_parser.add_argument("--json", action="store_true")
    value_parser.set_defaults(func=cmd_value, surface="value", action="status")

    validate_optimize_parser = subparsers.add_parser(
        "validate-and-optimize",
        help="Validate eval artifacts and write a dry-run optimizer proof packet.",
    )
    validate_optimize_parser.add_argument(
        "validate_optimize_action",
        nargs="?",
        default="dry-run",
        choices=["status", "dry-run", "proof-packet", "run"],
        help="Dry-run validation, write a proof packet, or refuse live optimizer execution.",
    )
    validate_optimize_parser.add_argument("--repo", default=".", help="Local repository to inspect.")
    validate_optimize_parser.add_argument(
        "--workload-card",
        default=".understudy/workload-discovery/workload-card.json",
        help="Path to a Workload Card JSON artifact.",
    )
    validate_optimize_parser.add_argument(
        "--harness",
        default=default_understand_artifact_paths()["harness"],
        help="Path to required harness.json.",
    )
    validate_optimize_parser.add_argument(
        "--metric",
        default=default_understand_artifact_paths()["metric"],
        help="Path to required metric.json.",
    )
    validate_optimize_parser.add_argument(
        "--splits",
        default=default_understand_artifact_paths()["splits"],
        help="Path to required splits.json.",
    )
    validate_optimize_parser.add_argument(
        "--baseline",
        default=default_understand_artifact_paths()["baseline"],
        help="Path to required baseline.json.",
    )
    validate_optimize_parser.add_argument("--requests-per-month", type=int, default=None)
    validate_optimize_parser.add_argument("--baseline-cost-usd", type=float, default=None)
    validate_optimize_parser.add_argument("--baseline-latency-ms", type=float, default=None)
    validate_optimize_parser.add_argument("--candidate-cost-usd", type=float, default=None)
    validate_optimize_parser.add_argument("--candidate-latency-ms", type=float, default=None)
    validate_optimize_parser.add_argument("--json", action="store_true")
    validate_optimize_parser.set_defaults(
        func=cmd_validate_and_optimize,
        surface="validate-and-optimize",
        action="dry-run",
    )

    for surface, spec in ROADMAP_SURFACES.items():
        if surface in {"demo", "workload-discovery", "capture-import", "value"}:
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
