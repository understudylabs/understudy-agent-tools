from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from understudy_agent_tools.artifact_contract import (  # noqa: E402
    REQUIRED_BASELINE_ARTIFACTS,
    artifact_sha256,
    build_artifact_contract,
    default_understand_artifact_paths,
    stale_hash_blockers,
    validate_metric_contract,
)


def resolve_repo_path(repo: Path, path_value: str) -> Path:
    path = Path(path_value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (repo / path).resolve()


def repo_relative_path(repo: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(repo.resolve()))
    except ValueError:
        return str(path)


def read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("JSON root must be an object")
    return payload


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def artifact_paths_for(artifact_root: str | None = None) -> dict[str, str]:
    if artifact_root is None:
        return default_understand_artifact_paths()
    root = Path(artifact_root)
    return {
        name: str(root / filename)
        for name, filename in REQUIRED_BASELINE_ARTIFACTS.items()
    }


def load_required_artifacts(
    repo: Path,
    paths: dict[str, str] | None = None,
    artifact_root: str | None = None,
) -> tuple[list[dict[str, object]], dict[str, dict[str, Any]], list[dict[str, object]], dict[str, str]]:
    artifact_paths = paths or artifact_paths_for(artifact_root)
    checks: list[dict[str, object]] = []
    loaded: dict[str, dict[str, Any]] = {}
    blockers: list[dict[str, object]] = []
    relative_paths = {
        name: repo_relative_path(repo, resolve_repo_path(repo, path_value))
        for name, path_value in artifact_paths.items()
    }
    for name, path_value in artifact_paths.items():
        path = resolve_repo_path(repo, path_value)
        check = {"name": name, "path": relative_paths[name], "required": True}
        if not path.exists():
            check["status"] = "missing"
            checks.append(check)
            blockers.append({"name": name, "path": relative_paths[name], "reason": "missing required artifact"})
            continue
        if not path.is_file():
            check["status"] = "invalid"
            checks.append(check)
            blockers.append({"name": name, "path": relative_paths[name], "reason": "required artifact path is not a file"})
            continue
        try:
            payload = read_json_object(path)
        except json.JSONDecodeError as exc:
            check["status"] = "invalid"
            checks.append(check)
            blockers.append({"name": name, "path": relative_paths[name], "reason": f"invalid JSON: {exc.msg}"})
            continue
        except ValueError as exc:
            check["status"] = "invalid"
            checks.append(check)
            blockers.append({"name": name, "path": relative_paths[name], "reason": str(exc)})
            continue
        check["status"] = "ok"
        check["schema_version"] = payload.get("schema_version")
        checks.append(check)
        loaded[name] = payload
    return checks, loaded, blockers, relative_paths


def validate_gate(repo: Path, artifact_root: str | None = None) -> dict[str, object]:
    checks, loaded, blockers, relative_paths = load_required_artifacts(repo, artifact_root=artifact_root)
    contract = build_artifact_contract(paths=relative_paths, loaded=loaded, checks=checks)
    if not blockers and set(loaded) == set(REQUIRED_BASELINE_ARTIFACTS):
        stale_blockers = stale_hash_blockers(loaded=loaded)
        for blocker in stale_blockers:
            name = str(blocker["name"])
            blocker["path"] = relative_paths[name]
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
    return {
        "schema_version": "understudy.validate_and_optimize_gate.v1",
        "status": "blocked" if blockers else "ok",
        "checks": checks,
        "blockers": blockers,
        "artifact_contract": contract,
    }


def claim_hashes(repo: Path, candidate_path: Path, artifact_root: str | None = None) -> dict[str, str | None]:
    paths = artifact_paths_for(artifact_root)
    hashes: dict[str, str | None] = {}
    for name, path_value in paths.items():
        path = resolve_repo_path(repo, path_value)
        hashes[f"{name}_sha256"] = artifact_sha256(path) if path.exists() else None
    hashes["candidate_sha256"] = artifact_sha256(candidate_path) if candidate_path.exists() else None
    return hashes
