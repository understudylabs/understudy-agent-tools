export const optimizerRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import re
import socket
import threading
from pathlib import Path
from collections.abc import Callable, Mapping
from types import MappingProxyType
from typing import Any


DSPY_PACKAGE_SPEC = "dspy==3.3.0"
DSPY_VERSION = "3.3.0"
GEPA_PACKAGE_SPEC = "gepa[dspy]==0.1.1"
GEPA_VERSION = "0.1.1"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def split_keys(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def load_rows(path: str) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
        return raw["rows"]
    raise ValueError("samples must be a JSON list or object with rows")


def normalize_gateway_url(value: str) -> str:
    base = value.rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def normalize_dspy_model(value: str) -> str:
    if "/" in value:
        return value
    return f"openai/{value}"


class SpendBudgetExceeded(RuntimeError):
    pass


class SpendEvidenceError(RuntimeError):
    pass


class RuntimePackageVersionError(RuntimeError):
    pass


class ResumeBindingError(RuntimeError):
    pass


class WorkloadAdmissionError(RuntimeError):
    pass


class UnsupportedTeacherError(RuntimeError):
    pass


def positive_float(value: Any, label: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or not parsed > 0:
        raise ValueError(f"{label} must be positive")
    return parsed


def non_negative_float(value: Any, label: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise ValueError(f"{label} must be non-negative")
    return parsed


def positive_int_arg(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return parsed


def non_negative_int_arg(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be a non-negative integer")
    return parsed


def non_negative_float_arg(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("value must be a finite non-negative number")
    return parsed


def bool_arg(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise argparse.ArgumentTypeError("value must be true or false")


def input_token_ceiling_from_bytes(message_bytes: int, message_count: int) -> int:
    if message_bytes < 0 or message_count < 0:
        raise ValueError("message bytes and count must be non-negative")
    # Byte-level tokenizers cannot emit more tokens than UTF-8 bytes for the
    # serialized content. The fixed and per-message allowances cover chat
    # framing, provider wrappers, and DSPy signature material not visible in
    # the message text. This is intentionally conservative.
    return message_bytes + 4096 + (64 * message_count)


def serialized_message_shape(prompt: str | None, messages: list[dict[str, Any]] | None) -> tuple[int, int]:
    normalized = messages or [{"role": "user", "content": prompt or ""}]
    serialized = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), default=str)
    return len(serialized.encode("utf-8")), len(normalized)


def token_price(input_tokens: int, output_tokens: int, input_usd_per_million: float, output_usd_per_million: float) -> float:
    return (
        (input_tokens * input_usd_per_million)
        + (output_tokens * output_usd_per_million)
    ) / 1_000_000


def usage_token_count(usage: Any, *names: str) -> int | None:
    for name in names:
        if isinstance(usage, dict):
            value = usage.get(name)
        else:
            value = getattr(usage, name, None)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value >= 0 and int(value) == value:
            return int(value)
    return None


def write_owner_only_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, path)
    path.chmod(0o600)


def canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(payload: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def secure_owner_only_tree(root: Path) -> None:
    if not root.exists():
        return
    if root.is_symlink():
        raise ValueError("owner-only artifact roots cannot be symlinks")
    if root.is_file():
        root.chmod(0o600)
        return
    root.chmod(0o700)
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("owner-only artifacts cannot contain symlinks")
        path.chmod(0o700 if path.is_dir() else 0o600)


def artifact_path(repo: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def logical_path(repo: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(repo.resolve()).as_posix()
    except ValueError:
        return f"external/{resolved.name}"


def json_safe_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must return a mapping")
    normalized = dict(value)
    canonical_json_bytes(normalized)
    return normalized


def require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must return a mapping")
    return dict(value)


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower())
    )


_SECRET_CONFIG_KEY = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|authorization|password|secret|token)(?:$|[_-])",
    re.IGNORECASE,
)
_SECRET_CONFIG_VALUE = re.compile(
    r"^(?:bearer\s+|sk-[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----)",
    re.IGNORECASE,
)
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def reject_bridge_config_secrets(value: Any, path: str = "bridge_config") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            reject_bridge_config_secrets(item, f"{path}[{index}]")
        return
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError("program bridge config keys must be strings")
            child_path = f"{path}.{key}"
            if re.search(r"(?:_env|_env_var)$", key, re.IGNORECASE):
                if not isinstance(child, str) or _ENV_NAME.fullmatch(child) is None:
                    raise ValueError(f"{child_path} must be an environment variable name")
            elif _SECRET_CONFIG_KEY.search(key):
                raise ValueError(f"{child_path} is a secret-bearing field")
            reject_bridge_config_secrets(child, child_path)
        return
    if isinstance(value, str) and _SECRET_CONFIG_VALUE.search(value.strip()):
        raise ValueError(f"{path} appears to contain a credential")


def load_bridge_config(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise ValueError("program bridge config must be a non-symlink regular JSON file")
    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("program bridge config must contain finite valid JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("program bridge config must contain a JSON object")
    if payload.get("schema_version") != "understudy.dspy_gepa_bridge_config.v1":
        raise ValueError("program bridge config schema_version must be understudy.dspy_gepa_bridge_config.v1")
    reject_bridge_config_secrets(payload)
    canonical_json_bytes(payload)
    return payload


def freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: freeze_json(child) for key, child in value.items()})
    if isinstance(value, list):
        return tuple(freeze_json(child) for child in value)
    return value


def validate_budget_allocation(bridge_config: Mapping[str, Any], optimizer_cap_usd: float) -> dict[str, float]:
    raw = bridge_config.get("budget_allocation")
    if not isinstance(raw, Mapping):
        raise ValueError("program bridge config requires budget_allocation")
    required = (
        "campaign_approved_max_usd",
        "campaign_cap_usd",
        "prior_experiment_spend_usd",
        "optimizer_inference_cap_usd",
        "endpoint_cap_usd",
    )
    parsed: dict[str, float] = {}
    for key in required:
        value = raw.get(key)
        if isinstance(value, bool):
            raise ValueError(f"budget_allocation.{key} must be numeric")
        parsed[key] = float(value)
        if not math.isfinite(parsed[key]) or parsed[key] < 0:
            raise ValueError(f"budget_allocation.{key} must be finite and non-negative")
    if parsed["campaign_cap_usd"] <= 0:
        raise ValueError("budget_allocation.campaign_cap_usd must be positive")
    if parsed["campaign_cap_usd"] > parsed["campaign_approved_max_usd"] + 1e-12:
        raise ValueError("campaign cap exceeds the explicitly approved maximum")
    if abs(parsed["optimizer_inference_cap_usd"] - optimizer_cap_usd) > 1e-12:
        raise ValueError("bridge optimizer_inference_cap_usd must equal --budget-usd")
    allocated = (
        parsed["prior_experiment_spend_usd"]
        + parsed["optimizer_inference_cap_usd"]
        + parsed["endpoint_cap_usd"]
    )
    if allocated > parsed["campaign_cap_usd"] + 1e-12:
        raise ValueError("prior spend plus optimizer and endpoint caps exceeds campaign cap")
    parsed["campaign_remaining_after_allocations_usd"] = parsed["campaign_cap_usd"] - allocated
    return parsed


class SpendLedger:
    def __init__(
        self,
        budget_usd: float,
        input_usd_per_million: float,
        output_usd_per_million: float,
    ) -> None:
        self.budget_usd = positive_float(budget_usd, "budget_usd")
        self.input_usd_per_million = non_negative_float(
            input_usd_per_million,
            "input_usd_per_million",
        )
        self.output_usd_per_million = non_negative_float(
            output_usd_per_million,
            "output_usd_per_million",
        )
        if self.input_usd_per_million == 0 and self.output_usd_per_million == 0:
            raise ValueError("at least one token price must be non-zero")
        self.reserved_upper_bound_usd = 0.0
        self.attributed_cost_usd = 0.0
        self.calls_attempted = 0
        self.calls_completed = 0
        self.usage_complete = True
        self.entries: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def __deepcopy__(self, memo: dict[int, Any]) -> SpendLedger:
        # DSPy copies LMs for rollout variants. Every copy must share the same
        # process-wide ledger or a copied optimizer could bypass the cap.
        return self

    def projected_reservation(self, input_token_ceiling: int, output_token_ceiling: int) -> float:
        return token_price(
            input_token_ceiling,
            output_token_ceiling,
            self.input_usd_per_million,
            self.output_usd_per_million,
        )

    def reserve(self, input_token_ceiling: int, output_token_ceiling: int) -> int:
        projected = self.projected_reservation(input_token_ceiling, output_token_ceiling)
        with self._lock:
            next_total = self.reserved_upper_bound_usd + projected
            if next_total > self.budget_usd + 1e-12:
                raise SpendBudgetExceeded("next-call-reservation-exceeds-budget")
            self.calls_attempted += 1
            call_id = self.calls_attempted
            self.reserved_upper_bound_usd = next_total
            self.entries.append({
                "call_id": call_id,
                "status": "reserved",
                "input_token_ceiling": input_token_ceiling,
                "output_token_ceiling": output_token_ceiling,
                "reserved_upper_bound_usd": projected,
            })
            return call_id

    def mark_error(self, call_id: int) -> None:
        with self._lock:
            self.entries[call_id - 1]["status"] = "provider-error-billing-ambiguous"
            self.usage_complete = False

    def complete(self, call_id: int, response: Any) -> None:
        usage = getattr(response, "usage", None)
        input_tokens = usage_token_count(usage, "prompt_tokens", "input_tokens")
        output_tokens = usage_token_count(usage, "completion_tokens", "output_tokens")
        with self._lock:
            entry = self.entries[call_id - 1]
            if input_tokens is None or output_tokens is None:
                entry["status"] = "usage-missing"
                self.usage_complete = False
                raise SpendEvidenceError("provider-usage-missing")
            if (
                input_tokens > int(entry["input_token_ceiling"])
                or output_tokens > int(entry["output_token_ceiling"])
            ):
                entry["status"] = "usage-exceeds-reservation"
                self.usage_complete = False
                raise SpendEvidenceError("provider-usage-exceeds-reservation")
            attributed = token_price(
                input_tokens,
                output_tokens,
                self.input_usd_per_million,
                self.output_usd_per_million,
            )
            entry.update({
                "status": "complete",
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "attributed_cost_usd": attributed,
            })
            self.calls_completed += 1
            self.attributed_cost_usd += attributed

    def evidence(self) -> dict[str, Any]:
        with self._lock:
            return {
                "approved_budget_usd": self.budget_usd,
                "reserved_upper_bound_usd": self.reserved_upper_bound_usd,
                "attributed_cost_usd": self.attributed_cost_usd,
                "calls_attempted": self.calls_attempted,
                "calls_completed": self.calls_completed,
                "usage_complete": self.usage_complete,
                "client_num_retries": 0,
                "provider_invoice_verified": False,
                "budget_scope": "optimizer-student-and-reflection-lm-calls-only",
                "price_basis": {
                    "source": "user-supplied",
                    "input_usd_per_million": self.input_usd_per_million,
                    "output_usd_per_million": self.output_usd_per_million,
                    "scope": "token-price-attribution-not-provider-invoice",
                },
                "reservations_are_cumulative": True,
                "entries": [dict(entry) for entry in self.entries],
            }


def split_train_dev(rows: list[dict[str, Any]], split_key: str, train_split: str, dev_split: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    if any(split_key in row for row in rows):
        train = [row for row in rows if str(row.get(split_key)) == train_split]
        dev = [row for row in rows if str(row.get(split_key)) == dev_split]
        holdout_count = len([row for row in rows if str(row.get(split_key)).lower() == "holdout"])
    else:
        train = rows[:1]
        dev = rows[1:] or rows[:1]
        holdout_count = 0
    if not train:
        raise ValueError(f"no train rows found for {split_key}={train_split}")
    if not dev:
        raise ValueError(f"no dev rows found for {split_key}={dev_split}")
    return train, dev, holdout_count


def exact_match_feedback(output_keys: list[str], gold: Any, pred: Any) -> Any:
    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    matches = []
    gaps = []
    for key in output_keys:
        expected = str(getattr(gold, key, "")).strip()
        actual = str(getattr(pred, key, "")).strip()
        ok = actual == expected
        matches.append(ok)
        if not ok:
            gaps.append(f"{key}: expected {expected!r}, got {actual!r}")
    score = sum(1.0 for item in matches if item) / len(matches) if matches else 0.0
    feedback = "All output fields matched." if not gaps else "Output mismatches: " + "; ".join(gaps)
    return ScoreWithFeedback(score=score, feedback=feedback)


def dspy_run_dir(args: argparse.Namespace) -> Path:
    return Path(args.repo) / ".understudy" / "optimize-workload" / "dspy-gepa"


def dspy_run_state_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "run-state.json"


def dspy_artifacts(args: argparse.Namespace) -> dict[str, str]:
    repo = Path(args.repo)
    run_dir = dspy_run_dir(args)
    paths = {
        "package_state_path": run_dir / "package-state.json",
        "config_path": run_dir / "config.json",
        "program_state_path": run_dir / "program-state.json",
        "bundle_manifest_path": run_dir / "bundle-manifest.json",
        "admission_receipt_path": run_dir / "admission-receipt.json",
        "run_state_path": run_dir / "run-state.json",
    }
    return {
        name: artifact_path(repo, path)
        for name, path in paths.items()
        if path.exists() or name in {"package_state_path", "config_path", "run_state_path"}
    }


def write_dspy_run_state(
    args: argparse.Namespace,
    ledger: SpendLedger,
    status: str,
    reason: str | None,
    extra: Mapping[str, Any] | None = None,
) -> None:
    evidence = ledger.evidence()
    payload = {
        "schema_version": "understudy.dspy_gepa_run_state.v2",
        "status": status,
        "reason": reason,
        "adapter": "dspy-gepa",
        "model": args.model,
        "reflection_model": args.reflection_model,
        "provider_calls": evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "spend_evidence": evidence,
        "artifacts": dspy_artifacts(args),
    }
    if extra:
        payload.update(dict(extra))
    write_owner_only_json(dspy_run_state_path(args), payload)


def emit_dspy_failure(
    args: argparse.Namespace,
    ledger: SpendLedger,
    status: str,
    reason: str,
    exit_code: int,
) -> None:
    write_dspy_run_state(args, ledger, status, reason)
    evidence = ledger.evidence()
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v2",
        "status": status,
        "reason": reason,
        "adapter": "dspy-gepa",
        "model": args.model,
        "reflection_model": args.reflection_model,
        "provider_calls": evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "spend_evidence": evidence,
        "artifacts": dspy_artifacts(args),
        "run_state_path": artifact_path(Path(args.repo), dspy_run_state_path(args)),
    })
    raise SystemExit(exit_code)


def require_exact_optimizer_packages(
    workload_package_pins: Mapping[str, Any] | None = None,
    project_state: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        actual = {
            "dspy": importlib.metadata.version("dspy"),
            "gepa": importlib.metadata.version("gepa"),
        }
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimePackageVersionError("runtime-package-version-mismatch") from error
    if actual != {"dspy": DSPY_VERSION, "gepa": GEPA_VERSION}:
        raise RuntimePackageVersionError("runtime-package-version-mismatch")
    workload_actual: dict[str, str] = {}
    for distribution, expected in (workload_package_pins or {}).items():
        if not isinstance(distribution, str) or not isinstance(expected, str) or not expected:
            raise RuntimePackageVersionError("workload-package-pins-invalid")
        try:
            installed = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimePackageVersionError("workload-package-version-mismatch") from error
        if installed != expected:
            raise RuntimePackageVersionError("workload-package-version-mismatch")
        workload_actual[distribution] = installed
    payload = {
        "schema_version": "understudy.dspy_gepa_package_state.v1",
        "requested": [DSPY_PACKAGE_SPEC, GEPA_PACKAGE_SPEC],
        "actual": actual,
        "workload_actual": workload_actual,
        "program_project": dict(project_state) if project_state else None,
        "python": platform.python_version(),
        "installer": "uv run --no-project",
    }
    payload["package_state_sha256"] = canonical_sha256(payload)
    return payload


def program_project_state(path: Path, repo: Path) -> dict[str, Any]:
    if not path.is_dir() or path.is_symlink():
        raise ValueError("program project must be a non-symlink directory")
    pyproject = path / "pyproject.toml"
    lock = path / "uv.lock"
    for artifact in (pyproject, lock):
        if not artifact.is_file() or artifact.is_symlink():
            raise ValueError("program project requires regular pyproject.toml and uv.lock files")
    return {
        "logical_path": logical_path(repo, path),
        "pyproject_sha256": file_sha256(pyproject),
        "uv_lock_sha256": file_sha256(lock),
        "locked": True,
    }


def load_program_bridge(path: Path) -> Any:
    if not path.is_file() or path.is_symlink():
        raise ValueError("program bridge must be a regular Python file")
    module_name = f"understudy_dspy_gepa_bridge_{file_sha256(path)[:16]}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ValueError("program bridge could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_context_window_gate(
    gate: Any,
    *,
    prompt_hash_field: str,
    prompt_tokens_field: str,
    context_limit_field: str,
    overflow_reason: str,
) -> None:
    if not isinstance(gate, Mapping):
        raise WorkloadAdmissionError("bundle-validation-requires-context-window-gate")
    if gate.get("not_applicable") is True:
        if not is_sha256(gate.get("proof_sha256")):
            raise WorkloadAdmissionError("context-window-not-applicable-requires-proof")
        return
    numeric_fields = (
        prompt_tokens_field,
        "max_tokens",
        "safety_margin",
        context_limit_field,
    )
    for hash_key in (prompt_hash_field, "token_count_receipt_sha256"):
        if not is_sha256(gate.get(hash_key)):
            raise WorkloadAdmissionError("context-window-gate-requires-prompt-token-count-hashes")
    numeric: dict[str, int] = {}
    for field in numeric_fields:
        value = gate.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise WorkloadAdmissionError("context-window-gate-has-invalid-token-counts")
        numeric[field] = value
    if numeric["max_tokens"] <= 0 or numeric[context_limit_field] <= 0:
        raise WorkloadAdmissionError("context-window-gate-has-invalid-limits")
    if (
        numeric[prompt_tokens_field]
        + numeric["max_tokens"]
        + numeric["safety_margin"]
        >= numeric[context_limit_field]
    ):
        raise WorkloadAdmissionError(overflow_reason)
    for identity_name in ("renderer", "tokenizer", "checkpoint", "route"):
        identity = gate.get(identity_name)
        if (
            not isinstance(identity, Mapping)
            or not isinstance(identity.get("id"), str)
            or not identity.get("id")
            or not is_sha256(identity.get("sha256"))
        ):
            raise WorkloadAdmissionError("context-window-gate-requires-renderer-tokenizer-checkpoint-identities")
    coverage = gate.get("coverage")
    if not isinstance(coverage, Mapping):
        raise WorkloadAdmissionError("context-window-gate-requires-coverage")
    for hash_key in ("admitted_task_ids_sha256", "eligible_route_ids_sha256"):
        if not is_sha256(coverage.get(hash_key)):
            raise WorkloadAdmissionError("context-window-coverage-requires-task-route-hashes")
    method = coverage.get("method")
    if method == "all_admitted_tasks_and_eligible_routes":
        count_fields = (
            "admitted_task_count",
            "covered_task_count",
            "eligible_route_count",
            "covered_route_count",
        )
        counts = {field: coverage.get(field) for field in count_fields}
        if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in counts.values()):
            raise WorkloadAdmissionError("context-window-coverage-counts-invalid")
        if (
            counts["admitted_task_count"] != counts["covered_task_count"]
            or counts["eligible_route_count"] != counts["covered_route_count"]
        ):
            raise WorkloadAdmissionError("context-window-coverage-incomplete")
        if not is_sha256(coverage.get("complete_inventory_sha256")):
            raise WorkloadAdmissionError("complete-context-inventory-requires-proof")
    elif method == "conservative_bound":
        if not is_sha256(coverage.get("proof_sha256")):
            raise WorkloadAdmissionError("conservative-context-bound-requires-proof")
    else:
        raise WorkloadAdmissionError("context-window-coverage-method-invalid")
    if not is_sha256(coverage.get("worst_case_row_sha256")):
        raise WorkloadAdmissionError("context-window-coverage-requires-worst-case-row")


def run_bridge_admission(module: Any, context: dict[str, Any]) -> dict[str, Any]:
    hook = getattr(module, "admit_understudy_dspy_gepa", None)
    if not callable(hook):
        raise WorkloadAdmissionError("program-bridge-admission-hook-required")
    network_attempts: list[str] = []

    def blocked_network(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        network_attempts.append("socket")
        raise WorkloadAdmissionError("admission-hook-attempted-network-call")

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_create_connection = socket.create_connection
    try:
        socket.socket.connect = blocked_network
        socket.socket.connect_ex = blocked_network
        socket.create_connection = blocked_network
        receipt = json_safe_mapping(hook(context), "admit_understudy_dspy_gepa(context)")
    finally:
        socket.socket.connect = original_connect
        socket.socket.connect_ex = original_connect_ex
        socket.create_connection = original_create_connection
    if network_attempts:
        raise WorkloadAdmissionError("admission-hook-attempted-network-call")
    if receipt.get("admitted") is not True:
        raise WorkloadAdmissionError("workload-admission-failed")
    if not isinstance(receipt.get("live_admission_required"), bool):
        raise WorkloadAdmissionError("offline-admission-must-declare-live-admission-required")
    validation = receipt.get("bundle_validation")
    if not isinstance(validation, Mapping) or validation.get("network_calls_made") != 0:
        raise WorkloadAdmissionError("bundle-validation-must-attest-zero-network-calls")
    if not is_sha256(validation.get("input_bundle_sha256")):
        raise WorkloadAdmissionError("bundle-validation-requires-input-bundle-sha256")
    if validation.get("executable_bundle_loaded") is not True:
        raise WorkloadAdmissionError("bundle-validation-must-prove-executable-bundle-loaded")
    if validation.get("loaded_bundle_sha256") != validation.get("input_bundle_sha256"):
        raise WorkloadAdmissionError("loaded-bundle-sha256-mismatch")
    if validation.get("required_bundle_fields_present") is not True:
        raise WorkloadAdmissionError("bundle-validation-requires-all-bundle-fields")
    if not is_sha256(validation.get("workload_adapter_sha256")):
        raise WorkloadAdmissionError("bundle-validation-requires-workload-adapter-sha256")
    if not is_sha256(validation.get("package_receipt_sha256")):
        raise WorkloadAdmissionError("bundle-validation-requires-package-receipt-sha256")
    if not is_sha256(validation.get("tool_schema_sha256")):
        raise WorkloadAdmissionError("bundle-validation-requires-tool-schema-sha256")
    if not isinstance(validation.get("package_versions"), Mapping):
        raise WorkloadAdmissionError("bundle-validation-requires-package-versions")
    config = context["config"]
    program_bridge = config["program_bridge"]
    if validation.get("workload_adapter_sha256") != program_bridge.get("sha256"):
        raise WorkloadAdmissionError("workload-adapter-sha256-mismatch")
    expected_package_receipt = (
        program_bridge.get("project", {}).get("uv_lock_sha256")
        if isinstance(program_bridge.get("project"), Mapping)
        else config["packages"].get("package_state_sha256")
    )
    if validation.get("package_receipt_sha256") != expected_package_receipt:
        raise WorkloadAdmissionError("package-receipt-sha256-mismatch")
    bridge_config = context["bridge_config"]
    for field in ("input_bundle_sha256", "tool_schema_sha256"):
        if bridge_config.get(field) != validation.get(field):
            raise WorkloadAdmissionError(f"{field.replace('_', '-')}-mismatch")
    typed_contract = validation.get("typed_request_contract")
    required_typed_checks = {
        "model_typed": True,
        "messages_typed": True,
        "tools_typed": True,
        "sampling_typed": True,
    }
    if not isinstance(typed_contract, Mapping) or any(
        typed_contract.get(key) is not expected
        for key, expected in required_typed_checks.items()
    ):
        raise WorkloadAdmissionError("typed-request-contract-validation-failed")
    oracle = validation.get("oracle_contract")
    if not isinstance(oracle, Mapping):
        raise WorkloadAdmissionError("bundle-validation-requires-oracle-contract")
    if oracle.get("kind") == "exact_assistant_message":
        if any(
            oracle.get(field) is not True
            for field in (
                "expected_is_materialized_object",
                "expectation_hash_recomputed",
                "continuation_parent_present",
                "provenance_present",
            )
        ):
            raise WorkloadAdmissionError("exact-assistant-message-oracle-contract-failed")
    elif oracle.get("kind") == "state_verifier":
        if (
            oracle.get("task_typed") is not True
            or oracle.get("initial_state_typed") is not True
            or any(
                not is_sha256(oracle.get(field))
                for field in (
                    "assertion_identity_sha256",
                    "prime_receipt_sha256",
                    "reward_metric_binding_sha256",
                )
            )
            or (
                oracle.get("is_continuation") is True
                and not is_sha256(oracle.get("continuation_parent_sha256"))
            )
        ):
            raise WorkloadAdmissionError("state-verifier-oracle-contract-failed")
    else:
        raise WorkloadAdmissionError("oracle-contract-kind-invalid")
    tool_probe = validation.get("tool_contract_probe")
    if isinstance(tool_probe, Mapping) and tool_probe.get("not_applicable") is not True:
        required_probe_checks = {
            "wire_arguments_type": "string",
            "arguments_json_valid": True,
            "decoded_arguments_type": "object",
        }
        if any(tool_probe.get(key) != expected for key, expected in required_probe_checks.items()):
            raise WorkloadAdmissionError("tool-contract-probe-validation-failed")
        for hash_key in (
            "wire_arguments_sha256",
            "request_semantic_sha256",
            "executed_semantic_sha256",
        ):
            if not is_sha256(tool_probe.get(hash_key)):
                raise WorkloadAdmissionError("tool-contract-probe-requires-argument-hashes")
        if tool_probe.get("request_semantic_sha256") != tool_probe.get("executed_semantic_sha256"):
            raise WorkloadAdmissionError("tool-contract-request-execution-semantics-changed")
        nested_fields = tool_probe.get("nested_string_arguments", {})
        if not isinstance(nested_fields, Mapping):
            raise WorkloadAdmissionError("nested-string-arguments-must-be-a-mapping")
        for field_receipt in nested_fields.values():
            if not isinstance(field_receipt, Mapping) or field_receipt.get("wire_type") != "string":
                raise WorkloadAdmissionError("nested-tool-argument-did-not-remain-a-string")
            for hash_key in (
                "wire_sha256",
                "decoded_semantic_sha256",
                "executed_semantic_sha256",
            ):
                if not is_sha256(field_receipt.get(hash_key)):
                    raise WorkloadAdmissionError("nested-tool-argument-requires-hashes")
            if field_receipt.get("decoded_semantic_sha256") != field_receipt.get("executed_semantic_sha256"):
                raise WorkloadAdmissionError("nested-tool-argument-semantics-changed")
        if tool_probe.get("required_world_state_change") is True:
            if tool_probe.get("required_write_succeeded") is not True or tool_probe.get("world_state_changed") is not True:
                raise WorkloadAdmissionError("required-world-state-change-probe-failed")
            if tool_probe.get("mutation_scope") != "bounded_trajectory":
                raise WorkloadAdmissionError("world-state-change-must-cover-bounded-trajectory")
    elif not isinstance(tool_probe, Mapping):
        raise WorkloadAdmissionError("bundle-validation-requires-tool-contract-probe")
    validate_context_window_gate(
        validation.get("context_window_gate"),
        prompt_hash_field="source_prompt_sha256",
        prompt_tokens_field="source_prompt_tokens",
        context_limit_field="source_context_limit",
        overflow_reason="source-renderer-context-window-overflow",
    )
    validate_context_window_gate(
        validation.get("reflection_context_window_gate"),
        prompt_hash_field="reflection_prompt_sha256",
        prompt_tokens_field="reflection_prompt_tokens",
        context_limit_field="reflection_context_limit",
        overflow_reason="reflection-renderer-context-window-overflow",
    )
    trajectory_feedback = validation.get("trajectory_feedback_contract")
    required_event_fields = [
        "sequence_index",
        "tool_or_method_category",
        "succeeded",
        "error_type",
        "mutation_observed",
        "stop_observed",
    ]
    required_excluded_fields = ["arguments", "urls", "secrets", "answer_keys"]
    event_count = trajectory_feedback.get("event_count") if isinstance(trajectory_feedback, Mapping) else None
    if (
        not isinstance(trajectory_feedback, Mapping)
        or trajectory_feedback.get("redacted") is not True
        or trajectory_feedback.get("ordered_events") is not True
        or trajectory_feedback.get("event_fields") != required_event_fields
        or trajectory_feedback.get("excluded_fields") != required_excluded_fields
        or isinstance(event_count, bool)
        or not isinstance(event_count, int)
        or event_count <= 0
        or not is_sha256(trajectory_feedback.get("full_native_trace_sha256"))
        or not is_sha256(trajectory_feedback.get("redacted_feedback_sha256"))
        or trajectory_feedback.get("action_sequence_optimization_enabled") is not True
    ):
        raise WorkloadAdmissionError("trajectory-feedback-contract-failed")
    deployment_parity = validation.get("deployment_parity")
    if not isinstance(deployment_parity, Mapping):
        raise WorkloadAdmissionError("bundle-validation-requires-deployment-parity")
    if (
        deployment_parity.get("network_calls_made") != 0
        or deployment_parity.get("duplicate_policy_injection") is not False
        or deployment_parity.get("loaded_bundle_once") is not True
        or deployment_parity.get("official_eval_outer_policy_present") is not False
    ):
        raise WorkloadAdmissionError("provider-free-deployment-parity-failed")
    for surface in ("messages", "tools", "sampling"):
        inline_hash = deployment_parity.get(f"inline_{surface}_sha256")
        loaded_hash = deployment_parity.get(f"loaded_bundle_{surface}_sha256")
        if not is_sha256(inline_hash) or inline_hash != loaded_hash:
            raise WorkloadAdmissionError(f"inline-loaded-{surface}-parity-failed")
    mutation_contract = validation.get("candidate_mutation_contract")
    required_mutation_fields = {
        "candidate_hash",
        "parent_hash",
        "reflection_request_hash",
        "reflection_output_hash",
        "reflection_model",
        "reflection_sampling_hash",
        "checkpoint_hash",
        "config_hash",
        "evaluated_prompt_hash",
        "rendered_request_hash",
        "task_hash",
        "trace_hash",
        "world_progress_hash",
        "score",
    }
    if (
        not isinstance(mutation_contract, Mapping)
        or mutation_contract.get("enforcement_status") != "declared_not_enforced"
        or mutation_contract.get("promotion_guarantee") is not False
        or not is_sha256(mutation_contract.get("contract_sha256"))
        or mutation_contract.get("materialize_before_evaluate") is not True
        or mutation_contract.get("atomic_persistence") is not True
        or mutation_contract.get("require_changed_hash") is not True
        or mutation_contract.get("same_hash_quarantine") != {
            "evaluated": False,
            "provider_calls": 0,
            "pareto_eligible": False,
            "promotion_eligible": False,
        }
        or mutation_contract.get("partial_artifact_quarantine") is not True
        or mutation_contract.get("crash_resume_quarantine") is not True
        or set(mutation_contract.get("receipt_fields", [])) != required_mutation_fields
    ):
        raise WorkloadAdmissionError("candidate-mutation-integrity-contract-failed")
    return receipt


def run_live_bridge_admission(
    module: Any,
    context: dict[str, Any],
    program: Mapping[str, Any],
    offline_admission: Mapping[str, Any],
    budget_allocation: Mapping[str, float],
) -> dict[str, Any] | None:
    required = offline_admission.get("live_admission_required") is True
    endpoint_cap = float(budget_allocation["endpoint_cap_usd"])
    if not required:
        if endpoint_cap != 0:
            raise WorkloadAdmissionError("endpoint-cap-requires-live-admission")
        return None
    if endpoint_cap <= 0:
        raise WorkloadAdmissionError("live-admission-requires-positive-endpoint-cap")
    hook = getattr(module, "live_admit_understudy_dspy_gepa", None)
    if not callable(hook):
        raise WorkloadAdmissionError("live-program-bridge-admission-hook-required")
    try:
        receipt = json_safe_mapping(
            hook(context, program),
            "live_admit_understudy_dspy_gepa(context, program)",
        )
    except WorkloadAdmissionError:
        raise
    except Exception as error:
        raise WorkloadAdmissionError("live-workload-admission-failed") from error
    if (
        receipt.get("admitted") is not True
        or receipt.get("standard_verifiers") is not True
        or receipt.get("optimizer_started") is not False
        or receipt.get("episode_count") != 1
        or not isinstance(receipt.get("fixed_task_id"), str)
        or not receipt.get("fixed_task_id")
        or receipt.get("same_student_metric_path") is not True
    ):
        raise WorkloadAdmissionError("live-admission-contract-failed")
    preflight = receipt.get("preflight")
    if not isinstance(preflight, Mapping) or any(
        preflight.get(field) is not True
        for field in ("health_ok", "models_loaded", "bundle_loaded")
    ):
        raise WorkloadAdmissionError("live-admission-preflight-failed")
    expected_bundle_sha = offline_admission["bundle_validation"]["input_bundle_sha256"]
    if preflight.get("loaded_bundle_sha256") != expected_bundle_sha:
        raise WorkloadAdmissionError("live-admission-loaded-bundle-mismatch")
    integer_counts: dict[str, int] = {}
    for field in ("call_count", "node_count", "read_count", "write_count"):
        value = receipt.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise WorkloadAdmissionError("live-admission-counts-invalid")
        integer_counts[field] = value
    if integer_counts["call_count"] <= 0 or integer_counts["node_count"] <= 0:
        raise WorkloadAdmissionError("live-admission-has-no-observed-work")
    assertion_fraction = receipt.get("assertion_fraction")
    if (
        isinstance(assertion_fraction, bool)
        or not isinstance(assertion_fraction, (int, float))
        or not math.isfinite(float(assertion_fraction))
        or not 0 <= float(assertion_fraction) <= 1
    ):
        raise WorkloadAdmissionError("live-admission-assertion-fraction-invalid")
    if receipt.get("parser_failure") is not False or receipt.get("tool_argument_contract_ok") is not True:
        raise WorkloadAdmissionError("live-admission-parser-or-tool-contract-failed")
    if receipt.get("required_world_state_change") is True:
        if (
            integer_counts["write_count"] <= 0
            or receipt.get("world_state_changed") is not True
            or receipt.get("mutation_scope") != "bounded_trajectory"
        ):
            raise WorkloadAdmissionError("live-admission-required-world-state-change-failed")
    spend = receipt.get("endpoint_spend")
    if not isinstance(spend, Mapping):
        raise WorkloadAdmissionError("live-admission-requires-endpoint-spend")
    attributed = spend.get("attributed_cost_usd")
    if (
        spend.get("cap_usd") != endpoint_cap
        or spend.get("usage_complete") is not True
        or spend.get("actual_call_count") != integer_counts["call_count"]
        or isinstance(attributed, bool)
        or not isinstance(attributed, (int, float))
        or not math.isfinite(float(attributed))
        or not 0 <= float(attributed) <= endpoint_cap
    ):
        raise WorkloadAdmissionError("live-admission-endpoint-spend-invalid")
    receipt["receipt_sha256"] = canonical_sha256(receipt)
    return receipt


def admission_receipt_payload(
    config_base: Mapping[str, Any],
    offline_admission: Mapping[str, Any],
    live_admission: Mapping[str, Any] | None,
    resume_config_sha256: str,
    config_sha256: str,
) -> dict[str, Any]:
    payload = {
        "schema_version": "understudy.dspy_gepa_admission_receipt.v1",
        "status": "admitted",
        "optimizer_started": False,
        "static_config_sha256": canonical_sha256(config_base),
        "offline_admission_sha256": canonical_sha256(offline_admission),
        "live_admission": dict(live_admission) if live_admission is not None else None,
        "live_admission_sha256": (
            canonical_sha256(live_admission) if live_admission is not None else None
        ),
        "resume_config_sha256": resume_config_sha256,
        "config_sha256": config_sha256,
    }
    payload["receipt_sha256"] = canonical_sha256(payload)
    return payload


def load_admission_receipt(
    path: Path,
    config_base: Mapping[str, Any],
    offline_admission: Mapping[str, Any],
    resume_config_sha256: str,
) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise WorkloadAdmissionError("admission-receipt-must-be-a-regular-file")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkloadAdmissionError("admission-receipt-invalid") from error
    if not isinstance(receipt, dict):
        raise WorkloadAdmissionError("admission-receipt-invalid")
    claimed_sha = receipt.pop("receipt_sha256", None)
    computed_sha = canonical_sha256(receipt)
    receipt["receipt_sha256"] = claimed_sha
    if (
        receipt.get("schema_version") != "understudy.dspy_gepa_admission_receipt.v1"
        or receipt.get("status") != "admitted"
        or receipt.get("optimizer_started") is not False
        or not is_sha256(claimed_sha)
        or claimed_sha != computed_sha
        or receipt.get("static_config_sha256") != canonical_sha256(config_base)
        or receipt.get("offline_admission_sha256") != canonical_sha256(offline_admission)
        or receipt.get("resume_config_sha256") != resume_config_sha256
    ):
        raise WorkloadAdmissionError("admission-receipt-binding-mismatch")
    live = receipt.get("live_admission")
    live_sha = receipt.get("live_admission_sha256")
    if live is None:
        if offline_admission.get("live_admission_required") is True or live_sha is not None:
            raise WorkloadAdmissionError("admission-receipt-live-proof-missing")
    else:
        if not isinstance(live, Mapping) or not is_sha256(live_sha) or canonical_sha256(live) != live_sha:
            raise WorkloadAdmissionError("admission-receipt-live-proof-invalid")
        live_without_hash = dict(live)
        live_claimed_sha = live_without_hash.pop("receipt_sha256", None)
        if not is_sha256(live_claimed_sha) or canonical_sha256(live_without_hash) != live_claimed_sha:
            raise WorkloadAdmissionError("admission-receipt-live-proof-invalid")
    if not is_sha256(receipt.get("config_sha256")):
        raise WorkloadAdmissionError("admission-receipt-config-hash-invalid")
    return receipt


def bind_resume_log(log_dir: Path, config_sha256: str) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    secure_owner_only_tree(log_dir)
    binding_path = log_dir / "understudy-resume-binding.json"
    binding = {
        "schema_version": "understudy.dspy_gepa_resume_binding.v1",
        "config_sha256": config_sha256,
        "dspy_version": DSPY_VERSION,
        "gepa_version": GEPA_VERSION,
    }
    if binding_path.exists():
        try:
            existing = json.loads(binding_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ResumeBindingError("resume-log-binding-invalid") from error
        if existing != binding:
            raise ResumeBindingError("resume-log-config-mismatch")
    else:
        write_owner_only_json(binding_path, binding)
    return binding_path


def optimized_program_state(optimized: Any, bridge_state: Any) -> dict[str, Any]:
    dump_state = getattr(optimized, "dump_state", None)
    if not callable(dump_state):
        raise ValueError("optimized DSPy program must implement dump_state")
    try:
        state = dump_state(json_mode=True)
    except TypeError:
        state = dump_state()
    canonical_json_bytes(state)
    if bridge_state is not None:
        canonical_json_bytes(bridge_state)
    return {
        "schema_version": "understudy.dspy_gepa_program_state.v1",
        "program_class": optimized.__class__.__name__,
        "program_module": optimized.__class__.__module__,
        "dspy_state": state,
        "bridge_state": bridge_state,
        "dspy_version": DSPY_VERSION,
        "gepa_version": GEPA_VERSION,
    }


def write_canonical_bundle(
    args: argparse.Namespace,
    optimized: Any,
    exporter: Callable[..., Any],
    export_context: dict[str, Any],
    config_sha256: str,
) -> dict[str, Any]:
    run_dir = dspy_run_dir(args)
    bundles_dir = run_dir / "candidate-bundles"
    bundles_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    index = 0
    while True:
        suffix = "" if index == 0 else f"-{index}"
        export_dir = bundles_dir / f"{config_sha256[:16]}{suffix}"
        try:
            export_dir.mkdir(mode=0o700)
            break
        except FileExistsError:
            index += 1
    export_result = exporter(optimized, export_dir, export_context)
    metadata = {} if export_result is None else json_safe_mapping(export_result, "export_candidate")
    if "provenance" not in metadata or not isinstance(metadata.get("provenance"), Mapping):
        raise ValueError("export_candidate metadata must include provenance")
    if "continuation_parent" not in metadata:
        raise ValueError("export_candidate metadata must include continuation_parent (null for a root bundle)")
    mutation = metadata.get("mutation_receipt")
    if not isinstance(mutation, Mapping):
        raise ValueError("export_candidate metadata must include mutation_receipt")
    mutation_claimed = mutation.get("mutation_claimed")
    if not isinstance(mutation_claimed, bool):
        raise ValueError("mutation_receipt requires boolean mutation_claimed")
    if mutation.get("outcome") not in {"improved", "non_improved"}:
        raise ValueError("mutation_receipt requires improved or non_improved outcome")
    if not isinstance(mutation.get("promotion_eligible"), bool):
        raise ValueError("mutation_receipt requires boolean promotion_eligible")
    mutation_hash_fields = (
        "parent_component_sha256",
        "candidate_component_sha256",
        "candidate_persistence_sha256",
        "optimizer_receipt_sha256",
        "reflection_receipt_sha256",
        "checkpoint_sha256",
        "evaluated_prompt_sha256",
        "checkpoint_evaluated_prompt_binding_sha256",
        "world_progress_sha256",
    )
    if mutation_claimed:
        if mutation.get("outcome") != "improved":
            raise ValueError("claimed mutation must have improved outcome")
        if any(not is_sha256(mutation.get(field)) for field in mutation_hash_fields):
            raise ValueError("mutation_receipt requires complete SHA-256 evidence")
        if mutation["parent_component_sha256"] == mutation["candidate_component_sha256"]:
            raise ValueError("artifact_persistence_failure: candidate component matches parent")
        if any(
            mutation.get(field) is not True
            for field in (
                "candidate_persisted_before_evaluation",
                "atomic_persistence",
                "optimizer_reflection_bound",
                "checkpoint_evaluated_prompt_bound",
                "world_progress_observed",
            )
        ):
            raise ValueError("artifact_persistence_failure: mutation evidence is incomplete")
    else:
        if mutation.get("outcome") != "non_improved" or mutation.get("promotion_eligible") is not False:
            raise ValueError("unchanged export must be non_improved and non-promotable")
        candidate_hash = mutation.get("candidate_component_sha256")
        parent_hash = mutation.get("parent_component_sha256")
        if not is_sha256(candidate_hash) or parent_hash not in (None, candidate_hash):
            raise ValueError("unchanged export requires a root or same-hash parent")
    secure_owner_only_tree(export_dir)
    files = []
    for path in sorted(export_dir.rglob("*"), key=lambda item: item.relative_to(export_dir).as_posix()):
        if path.is_file():
            files.append({
                "path": path.relative_to(export_dir).as_posix(),
                "size_bytes": path.stat().st_size,
                "sha256": file_sha256(path),
            })
    if not files:
        raise ValueError("export_candidate must write at least one file")
    canonical = {
        "schema_version": "understudy.dspy_gepa_bundle_content.v1",
        "files": files,
    }
    bundle_sha256 = canonical_sha256(canonical)
    manifest = {
        "schema_version": "understudy.dspy_gepa_bundle_manifest.v1",
        "bundle_path": artifact_path(Path(args.repo), export_dir),
        "bundle_sha256": bundle_sha256,
        "canonical_bundle_sha256": bundle_sha256,
        "canonicalization": "sha256(canonical-json({schema_version,files[path,size_bytes,sha256]}))",
        "files": files,
        "export_metadata": metadata,
        "config_sha256": config_sha256,
        "budget_allocation": export_context["config"]["budget_allocation"],
        "mutation_claimed": mutation_claimed,
        "outcome": mutation["outcome"],
        "promotion_eligible": mutation["promotion_eligible"],
        "sampling": {
            "student": export_context["config"]["inference"]["student_sampling"],
            "reflection": export_context["config"]["inference"]["reflection_sampling"],
        },
    }
    manifest_path = run_dir / "bundle-manifest.json"
    write_owner_only_json(manifest_path, manifest)
    return manifest


def _dspy_gepa_execute(args: argparse.Namespace, ledger: SpendLedger) -> None:
    repo = Path(args.repo).resolve()
    run_dir = dspy_run_dir(args)
    run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    program_bridge_path = Path(args.program_bridge).resolve() if args.program_bridge else None
    program_bridge_config_path = (
        Path(args.program_bridge_config).resolve() if args.program_bridge_config else None
    )
    if (program_bridge_path is None) != (program_bridge_config_path is None):
        raise ValueError("program bridge and program bridge config must be supplied together")
    if program_bridge_path is not None:
        if args.admission_only == bool(args.admission_receipt):
            raise WorkloadAdmissionError(
                "bridge-run-requires-exactly-one-of-admission-only-or-admission-receipt"
            )
    elif args.admission_only or args.admission_receipt:
        raise ValueError("admission controls require a program bridge")
    bridge_config = (
        load_bridge_config(program_bridge_config_path)
        if program_bridge_config_path is not None
        else {}
    )
    immutable_bridge_config = freeze_json(bridge_config)
    project_path = Path(args.program_project).resolve() if args.program_project else None
    if project_path is not None and program_bridge_path is None:
        raise ValueError("program project requires a program bridge")
    project_state = program_project_state(project_path, repo) if project_path is not None else None
    workload_package_pins = bridge_config.get("workload_package_pins", {})
    if project_path is not None and (
        not isinstance(workload_package_pins, Mapping) or not workload_package_pins
    ):
        raise ValueError("locked program projects require workload_package_pins")
    package_state = require_exact_optimizer_packages(workload_package_pins, project_state)
    write_owner_only_json(run_dir / "package-state.json", package_state)
    budget_allocation = (
        validate_budget_allocation(bridge_config, ledger.budget_usd)
        if program_bridge_path is not None
        else {
            "campaign_cap_usd": ledger.budget_usd,
            "prior_experiment_spend_usd": 0.0,
            "optimizer_inference_cap_usd": ledger.budget_usd,
            "endpoint_cap_usd": 0.0,
            "campaign_remaining_after_allocations_usd": 0.0,
        }
    )

    import dspy

    class BudgetedLM(dspy.LM):
        def __init__(self, *lm_args: Any, spend_ledger: SpendLedger, **lm_kwargs: Any) -> None:
            self._spend_ledger = spend_ledger
            super().__init__(*lm_args, **lm_kwargs)

        def _output_token_ceiling(self, call_kwargs: dict[str, Any]) -> int:
            value = (
                call_kwargs.get("max_tokens")
                or call_kwargs.get("max_completion_tokens")
                or self.kwargs.get("max_tokens")
                or self.kwargs.get("max_completion_tokens")
            )
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("LM call is missing a numeric output-token ceiling")
            parsed = int(value)
            if parsed <= 0 or parsed != value:
                raise ValueError("LM output-token ceiling must be a positive integer")
            return parsed

        def _reserve_call(
            self,
            prompt: str | None,
            messages: list[dict[str, Any]] | None,
            call_kwargs: dict[str, Any],
        ) -> int:
            message_bytes, message_count = serialized_message_shape(prompt, messages)
            return self._spend_ledger.reserve(
                input_token_ceiling_from_bytes(message_bytes, message_count),
                self._output_token_ceiling(call_kwargs),
            )

        def forward(
            self,
            prompt: str | None = None,
            messages: list[dict[str, Any]] | None = None,
            **kwargs: Any,
        ) -> Any:
            call_id = self._reserve_call(prompt, messages, kwargs)
            try:
                response = super().forward(prompt=prompt, messages=messages, **kwargs)
            except BaseException:
                self._spend_ledger.mark_error(call_id)
                raise
            self._spend_ledger.complete(call_id, response)
            return response

        async def aforward(
            self,
            prompt: str | None = None,
            messages: list[dict[str, Any]] | None = None,
            **kwargs: Any,
        ) -> Any:
            call_id = self._reserve_call(prompt, messages, kwargs)
            try:
                response = await super().aforward(prompt=prompt, messages=messages, **kwargs)
            except BaseException:
                self._spend_ledger.mark_error(call_id)
                raise
            self._spend_ledger.complete(call_id, response)
            return response

    api_key = os.environ.get("UNDERSTUDY_API_KEY")
    gateway_url = os.environ.get("UNDERSTUDY_GATEWAY_URL")
    if not api_key:
        raise ValueError("UNDERSTUDY_API_KEY is required for dspy-gepa")
    if not gateway_url:
        raise ValueError("UNDERSTUDY_GATEWAY_URL is required for dspy-gepa")

    rows = load_rows(args.samples) if args.samples else []
    input_keys = split_keys(args.input_keys or "")
    output_keys = split_keys(args.output_keys or "")
    bridge_module = load_program_bridge(program_bridge_path) if program_bridge_path else None

    if bridge_module is None:
        if not rows or not input_keys or not output_keys:
            raise ValueError("samples, input keys, and output keys are required without a program bridge")
        train_rows, dev_rows, holdout_count = split_train_dev(
            rows, args.split_key, args.train_split, args.dev_split,
        )
    else:
        train_rows = []
        dev_rows = []
        holdout_count = len([
            row for row in rows
            if str(row.get(args.split_key, "")).lower() == "holdout"
        ])

    config_base = {
        "schema_version": "understudy.dspy_gepa_config.v2",
        "adapter_runtime_sha256": file_sha256(Path(__file__).resolve()),
        "packages": package_state,
        "student_model": args.model,
        "reflection_model": args.reflection_model,
        "module": args.module,
        "samples": {
            "logical_path": logical_path(repo, Path(args.samples)) if args.samples else None,
            "sha256": file_sha256(Path(args.samples).resolve()) if args.samples else None,
        },
        "program_bridge": {
            "logical_path": logical_path(repo, program_bridge_path) if program_bridge_path else None,
            "sha256": file_sha256(program_bridge_path) if program_bridge_path else None,
            "config_logical_path": logical_path(repo, program_bridge_config_path) if program_bridge_config_path else None,
            "config_sha256": canonical_sha256(bridge_config) if program_bridge_config_path else None,
            "config": bridge_config if program_bridge_config_path else None,
            "project": project_state,
            "builder": "build_understudy_dspy_gepa",
            "admission_hook": "admit_understudy_dspy_gepa",
        },
        "input_keys": input_keys,
        "output_keys": output_keys,
        "split": {
            "key": args.split_key,
            "train": args.train_split,
            "dev": args.dev_split,
            "holdout_excluded": True,
        },
        "gepa": {
            "max_metric_calls": args.max_metric_calls,
            "reflection_minibatch_size": args.reflection_minibatch_size,
            "candidate_selection_strategy": args.candidate_selection_strategy,
            "component_selector": args.component_selector,
            "use_merge": args.use_merge,
            "max_merge_invocations": args.max_merge_invocations,
            "num_threads": args.num_threads,
            "seed": args.seed,
            "track_stats": args.track_stats,
            "track_best_outputs": True,
            "log_dir": logical_path(repo, Path(args.log_dir)),
        },
        "inference": {
            "max_tokens": args.max_tokens,
            "student_sampling": {
                "temperature": args.temperature,
                "reasoning_effort": args.reasoning_effort,
            },
            "reflection_sampling": {
                "temperature": args.reflection_temperature,
                "reasoning_effort": args.reflection_reasoning_effort,
            },
            "cache": False,
            "num_retries": 0,
            "shared_cumulative_spend_ledger": True,
            "optimizer_inference_cap_usd": ledger.budget_usd,
            "input_usd_per_million": ledger.input_usd_per_million,
            "output_usd_per_million": ledger.output_usd_per_million,
            "price_basis_scope": "conservative-user-supplied-basis-for-both-models",
        },
        "budget_allocation": budget_allocation,
    }
    admission_context = {
        "repo": repo,
        "rows": rows,
        "config": config_base,
        "bridge_config": immutable_bridge_config,
    }
    offline_admission = (
        run_bridge_admission(bridge_module, admission_context)
        if bridge_module is not None
        else {
            "admitted": True,
            "live_admission_required": False,
            "kind": "built-in-samples-split-contract",
            "bundle_validation": {"network_calls_made": 0},
            "train_count": len(train_rows),
            "dev_count": len(dev_rows),
        }
    )
    resume_config_payload = {
        **config_base,
        "admission": {"offline": offline_admission, "live": "pending"},
    }
    resume_config_sha256 = canonical_sha256(resume_config_payload)
    resume_config_payload["resume_config_sha256"] = resume_config_sha256
    write_owner_only_json(run_dir / "config.json", resume_config_payload)
    log_dir = Path(args.log_dir).resolve()
    bind_resume_log(log_dir, resume_config_sha256)
    prior_admission_receipt = (
        load_admission_receipt(
            Path(args.admission_receipt).resolve(),
            config_base,
            offline_admission,
            resume_config_sha256,
        )
        if args.admission_receipt
        else None
    )
    admitted_live_receipt = (
        prior_admission_receipt.get("live_admission")
        if prior_admission_receipt is not None
        else None
    )

    student_lm = BudgetedLM(
        normalize_dspy_model(args.model),
        spend_ledger=ledger,
        api_key=api_key,
        api_base=normalize_gateway_url(gateway_url),
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        reasoning_effort=args.reasoning_effort,
        cache=False,
        num_retries=0,
    )
    reflection_lm = BudgetedLM(
        normalize_dspy_model(args.reflection_model),
        spend_ledger=ledger,
        api_key=api_key,
        api_base=normalize_gateway_url(gateway_url),
        max_tokens=args.max_tokens,
        temperature=args.reflection_temperature,
        reasoning_effort=args.reflection_reasoning_effort,
        cache=False,
        num_retries=0,
    )
    if student_lm is reflection_lm:
        raise ValueError("student and reflection LMs must be separate instances")
    dspy.configure(lm=student_lm)

    exporter = None
    bridge_state = None
    baseline_feedback = None
    if bridge_module is None:
        for row in [*train_rows, *dev_rows]:
            missing = [key for key in [*input_keys, *output_keys] if key not in row]
            if missing:
                raise ValueError(f"sample row is missing keys: {', '.join(missing)}")
        signature = dspy.Signature(f"{', '.join(input_keys)} -> {', '.join(output_keys)}")
        student = dspy.ChainOfThought(signature) if args.module == "cot" else dspy.Predict(signature)

        def to_example(row: dict[str, Any]) -> Any:
            return dspy.Example(
                **{key: row[key] for key in [*input_keys, *output_keys]},
            ).with_inputs(*input_keys)

        trainset = [to_example(row) for row in train_rows]
        valset = [to_example(row) for row in dev_rows]
        baseline_prediction = student(**{key: train_rows[0][key] for key in input_keys})
        baseline_feedback = exact_match_feedback(output_keys, trainset[0], baseline_prediction)

        def metric(gold: Any, pred: Any, trace: Any = None, pred_name: str | None = None, pred_trace: Any = None) -> Any:
            return exact_match_feedback(output_keys, gold, pred)
    else:
        builder = getattr(bridge_module, "build_understudy_dspy_gepa", None)
        if not callable(builder):
            raise ValueError("program bridge must define build_understudy_dspy_gepa(context)")
        bridge_context = {
            **admission_context,
            "admission": {"offline": offline_admission, "live": admitted_live_receipt},
            "dspy": dspy,
            "student_lm": student_lm,
            "reflection_lm": reflection_lm,
        }
        program = require_mapping(builder(bridge_context), "build_understudy_dspy_gepa(context)")
        for key in ("student", "trainset", "valset", "metric"):
            if key not in program:
                raise ValueError(f"program bridge result is missing {key}")
        student = program["student"]
        trainset = list(program["trainset"])
        valset = list(program["valset"])
        metric = program["metric"]
        if not trainset or not valset or not callable(metric):
            raise ValueError("program bridge requires non-empty trainset/valset and a callable metric")
        teacher = program.get("teacher")
        if teacher is not None:
            raise UnsupportedTeacherError("dspy-3.3.0-gepa-teacher-not-supported")
        exporter = program.get("export_candidate")
        if exporter is not None and not callable(exporter):
            raise ValueError("export_candidate must be callable")
        bridge_state = program.get("program_state")
        holdout_count = int(program.get("holdout_count_excluded", holdout_count))
        if holdout_count < 0:
            raise ValueError("holdout_count_excluded must be non-negative")

    if bridge_module is None:
        live_admission = None
    elif args.admission_only:
        live_admission = run_live_bridge_admission(
            bridge_module,
            bridge_context,
            program,
            offline_admission,
            budget_allocation,
        )
    else:
        live_admission = admitted_live_receipt
    admission = {"offline": offline_admission, "live": live_admission}
    config_payload = {
        **config_base,
        "admission": admission,
        "resume_config_sha256": resume_config_sha256,
    }
    config_sha256 = canonical_sha256(config_payload)
    config_payload["config_sha256"] = config_sha256
    write_owner_only_json(run_dir / "config.json", config_payload)
    if prior_admission_receipt is not None and prior_admission_receipt.get("config_sha256") != config_sha256:
        raise WorkloadAdmissionError("admission-receipt-config-hash-mismatch")
    if args.admission_only:
        receipt = admission_receipt_payload(
            config_base,
            offline_admission,
            live_admission,
            resume_config_sha256,
            config_sha256,
        )
        receipt_path = run_dir / "admission-receipt.json"
        write_owner_only_json(receipt_path, receipt)
        admission_spend_evidence = ledger.evidence()
        admission_spend_evidence["sampling"] = {
            "student": config_payload["inference"]["student_sampling"],
            "reflection": config_payload["inference"]["reflection_sampling"],
        }
        write_dspy_run_state(
            args,
            ledger,
            "admitted",
            None,
            {
                "config_sha256": config_sha256,
                "admission_receipt_sha256": receipt["receipt_sha256"],
                "budget_allocation": budget_allocation,
                "provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
                "optimizer_provider_calls": False,
                "endpoint_provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
            },
        )
        emit({
            "schema_version": "understudy.dspy_gepa_adapter.v2",
            "status": "admitted",
            "optimizer_started": False,
            "provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
            "optimizer_provider_calls": False,
            "endpoint_provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
            "config_sha256": config_sha256,
            "admission_receipt_sha256": receipt["receipt_sha256"],
            "admission_receipt_path": artifact_path(repo, receipt_path),
            "run_state_path": artifact_path(repo, dspy_run_state_path(args)),
            "spend_evidence": admission_spend_evidence,
        })
        return

    teleprompter = dspy.GEPA(
        metric=metric,
        max_metric_calls=args.max_metric_calls,
        reflection_minibatch_size=args.reflection_minibatch_size,
        candidate_selection_strategy=args.candidate_selection_strategy,
        reflection_lm=reflection_lm,
        component_selector=args.component_selector,
        use_merge=args.use_merge,
        max_merge_invocations=args.max_merge_invocations,
        num_threads=args.num_threads,
        log_dir=str(log_dir),
        track_stats=args.track_stats,
        track_best_outputs=True,
        seed=args.seed,
    )
    optimized = teleprompter.compile(student, trainset=trainset, valset=valset)
    program_state = optimized_program_state(optimized, bridge_state)
    program_state["config_sha256"] = config_sha256
    write_owner_only_json(run_dir / "program-state.json", program_state)

    bundle_manifest = None
    if exporter is not None:
        export_context = {
            "repo": repo,
            "config": config_payload,
            "bridge_config": immutable_bridge_config,
            "admission": admission,
            "program_state_path": run_dir / "program-state.json",
        }
        bundle_manifest = write_canonical_bundle(
            args, optimized, exporter, export_context, config_sha256,
        )

    spend_evidence = ledger.evidence()
    spend_evidence["sampling"] = {
        "student": config_payload["inference"]["student_sampling"],
        "reflection": config_payload["inference"]["reflection_sampling"],
    }
    candidate = {
        "schema_version": "understudy.dspy_gepa_candidate.v2",
        "adapter": "dspy-gepa",
        "model": args.model,
        "reflection_model": args.reflection_model,
        "module": args.module,
        "program_bridge": artifact_path(repo, program_bridge_path) if program_bridge_path else None,
        "input_keys": input_keys,
        "output_keys": output_keys,
        "train_count": len(trainset),
        "dev_count": len(valset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": args.max_metric_calls,
        "baseline_first_score": float(baseline_feedback.score) if baseline_feedback else None,
        "baseline_first_feedback": baseline_feedback.feedback if baseline_feedback else None,
        "optimized_program_class": optimized.__class__.__name__,
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "canonical_bundle_sha256": bundle_manifest["canonical_bundle_sha256"] if bundle_manifest else None,
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    }
    optimize_dir = repo / ".understudy" / "optimize-workload"
    candidate_path = optimize_dir / "candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    write_owner_only_json(candidate_path, candidate)
    proof = {
        "schema_version": "understudy.optimize-workload.proof.v1",
        "mode": "dspy-gepa",
        "status": "candidate-created",
        "backend": "uv-gepa",
        "adapter": "dspy-gepa",
        "provider_calls": spend_evidence["calls_attempted"] > 0,
        "live_optimizer_execution": True,
        "package_installs": True,
        "holdout_accessed_during_optimization": False,
        "train_count": len(trainset),
        "dev_count": len(valset),
        "candidate": artifact_path(repo, candidate_path),
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    }
    write_owner_only_json(proof_path, proof)
    extra = {
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
    }
    write_dspy_run_state(args, ledger, "candidate-created", None, extra)
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v2",
        "status": "candidate-created",
        "adapter": "dspy-gepa",
        "model": args.model,
        "reflection_model": args.reflection_model,
        "provider_calls": spend_evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "auth_source": os.environ.get("UNDERSTUDY_AUTH_SOURCE", "unknown"),
        "gateway_url_configured": True,
        "api_key_configured": True,
        "train_count": len(trainset),
        "dev_count": len(valset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": args.max_metric_calls,
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "canonical_bundle_sha256": bundle_manifest["canonical_bundle_sha256"] if bundle_manifest else None,
        "candidate_path": artifact_path(repo, candidate_path),
        "proof_packet_path": artifact_path(repo, proof_path),
        "run_state_path": artifact_path(repo, dspy_run_state_path(args)),
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    })


def dspy_gepa(args: argparse.Namespace) -> None:
    if args.log_dir is None:
        args.log_dir = str(dspy_run_dir(args) / "gepa-log")
    ledger = SpendLedger(
        args.budget_usd,
        args.input_usd_per_million,
        args.output_usd_per_million,
    )
    try:
        _dspy_gepa_execute(args, ledger)
    except SpendBudgetExceeded:
        emit_dspy_failure(
            args,
            ledger,
            "budget-blocked",
            "next-call-reservation-exceeds-budget",
            4,
        )
    except SpendEvidenceError as error:
        emit_dspy_failure(args, ledger, "spend-evidence-error", str(error), 5)
    except RuntimePackageVersionError:
        emit_dspy_failure(args, ledger, "error", "runtime-package-version-mismatch", 3)
    except ResumeBindingError as error:
        emit_dspy_failure(args, ledger, "resume-blocked", str(error), 6)
    except WorkloadAdmissionError as error:
        emit_dspy_failure(args, ledger, "admission-blocked", str(error), 6)
    except UnsupportedTeacherError as error:
        emit_dspy_failure(args, ledger, "error", str(error), 3)
    except KeyboardInterrupt:
        emit_dspy_failure(args, ledger, "cancelled", "optimizer-cancelled", 130)
    except ImportError:
        emit_dspy_failure(args, ledger, "error", "runtime-dependency-error", 3)
    except ValueError:
        emit_dspy_failure(args, ledger, "error", "invalid-runtime-input", 3)
    except Exception:
        emit_dspy_failure(args, ledger, "error", "optimizer-execution-failed", 3)
    finally:
        for root in (dspy_run_dir(args), Path(args.log_dir)):
            try:
                secure_owner_only_tree(root)
            except (OSError, ValueError):
                pass


def load_json_or_jsonl(path: Path) -> Any:
    if path.suffix == ".jsonl":
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows
    return json.loads(path.read_text(encoding="utf-8"))


def load_eval_input_manifest(path: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest_path = Path(path)
    raw = load_json_or_jsonl(manifest_path)
    if isinstance(raw, list):
        return {"schema_version": "understudy.eval_input_manifest.v1"}, raw
    if not isinstance(raw, dict):
        raise ValueError("manifest must be a JSON object, JSON list, or JSONL rows")
    if isinstance(raw.get("rows"), list):
        return raw, raw["rows"]
    if isinstance(raw.get("inputs"), list):
        return raw, raw["inputs"]
    inputs_path = raw.get("inputs_path")
    if isinstance(inputs_path, str) and inputs_path:
        resolved = Path(inputs_path)
        if not resolved.is_absolute():
            resolved = manifest_path.parent / resolved
        rows = load_json_or_jsonl(resolved)
        if isinstance(rows, dict) and isinstance(rows.get("rows"), list):
            rows = rows["rows"]
        if isinstance(rows, dict) and isinstance(rows.get("inputs"), list):
            rows = rows["inputs"]
        if not isinstance(rows, list):
            raise ValueError("inputs_path must resolve to JSON/JSONL rows")
        return raw, rows
    raise ValueError("manifest must include rows, inputs, or inputs_path")


def eval_query_text(row: dict[str, Any]) -> str:
    request = row.get("request", row)
    if isinstance(request, dict):
        for key in ("query", "question", "input", "prompt", "text"):
            value = request.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return json.dumps(request, sort_keys=True)
    return str(request)


def eval_expected(row: dict[str, Any]) -> dict[str, Any]:
    expected = row.get("expected", {})
    return expected if isinstance(expected, dict) else {"label": expected}


def eval_candidate_labels(row: dict[str, Any], manifest: dict[str, Any]) -> list[str]:
    for source in (row, manifest):
        labels = source.get("labels") if isinstance(source, dict) else None
        if isinstance(labels, list) and labels:
            return [str(item) for item in labels]
        label_set = source.get("label_set") if isinstance(source, dict) else None
        if isinstance(label_set, list) and label_set:
            return [str(item) for item in label_set]
    expected_label = eval_expected(row).get("label")
    if expected_label is not None:
        return [str(expected_label)]
    return ["unknown"]


def predict_eval_label(policy: str, row: dict[str, Any], manifest: dict[str, Any]) -> str:
    labels = eval_candidate_labels(row, manifest)
    haystack = f"{policy}\n{eval_query_text(row)}".lower()
    for label in labels:
        if label.lower() in haystack:
            return label
    return labels[0]


def eval_expected_tool(row: dict[str, Any]) -> str | None:
    expected = eval_expected(row)
    tool_call = expected.get("tool_call")
    if isinstance(tool_call, dict) and tool_call.get("name") is not None:
        return str(tool_call["name"])
    tool_calls = expected.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls and isinstance(tool_calls[0], dict) and tool_calls[0].get("name") is not None:
        return str(tool_calls[0]["name"])
    if expected.get("tool_name") is not None:
        return str(expected["tool_name"])
    return None


def eval_candidate_tools(row: dict[str, Any], manifest: dict[str, Any]) -> list[str]:
    tools = row.get("tools") if isinstance(row.get("tools"), list) else manifest.get("tools")
    names = []
    if isinstance(tools, list):
        for item in tools:
            if isinstance(item, dict) and item.get("name") is not None:
                names.append(str(item["name"]))
            elif isinstance(item, str):
                names.append(item)
    expected_tool = eval_expected_tool(row)
    if expected_tool and expected_tool not in names:
        names.append(expected_tool)
    return names


def predict_eval_tool(policy: str, row: dict[str, Any], manifest: dict[str, Any]) -> str | None:
    tools = eval_candidate_tools(row, manifest)
    if not tools:
        return None
    haystack = f"{policy}\n{eval_query_text(row)}".lower()
    for tool in tools:
        if tool.lower() in haystack:
            return tool
    return tools[0]


def eval_input_score(policy: str, row: dict[str, Any], manifest: dict[str, Any], score_objective: str) -> tuple[dict[str, Any], float, str]:
    expected = eval_expected(row)
    output: dict[str, Any] = {}
    checks: list[bool] = []
    gaps: list[str] = []

    expected_label = expected.get("label")
    if expected_label is not None and score_objective in ("exact_match", "label", "mixed"):
        predicted_label = predict_eval_label(policy, row, manifest)
        output["label"] = predicted_label
        ok = str(predicted_label) == str(expected_label)
        checks.append(ok)
        if not ok:
            gaps.append(f"label expected {expected_label!r}, got {predicted_label!r}")

    expected_tool = eval_expected_tool(row)
    if expected_tool is not None and score_objective in ("tool_call", "mixed"):
        predicted_tool = predict_eval_tool(policy, row, manifest)
        output["tool_call"] = {"name": predicted_tool}
        ok = str(predicted_tool) == str(expected_tool)
        checks.append(ok)
        if not ok:
            gaps.append(f"tool expected {expected_tool!r}, got {predicted_tool!r}")

    if not checks:
        predicted_label = predict_eval_label(policy, row, manifest)
        output["label"] = predicted_label
        expected_label = expected.get("label", predicted_label)
        ok = str(predicted_label) == str(expected_label)
        checks.append(ok)
        if not ok:
            gaps.append(f"label expected {expected_label!r}, got {predicted_label!r}")

    score = sum(1.0 for item in checks if item) / len(checks)
    feedback = "All objectives matched." if not gaps else "Objective gaps: " + "; ".join(gaps)
    return output, score, feedback


class EvalInputGepaAdapter:
    def __init__(self, manifest: dict[str, Any], score_objective: str):
        self.manifest = manifest
        self.score_objective = score_objective

    def evaluate(self, batch: list[dict[str, Any]], candidate: dict[str, str], capture_traces: bool = False) -> Any:
        from gepa.core.adapter import EvaluationBatch

        policy = candidate.get("eval_input_policy", "")
        outputs = []
        scores = []
        trajectories = [] if capture_traces else None
        for row in batch:
            output, score, feedback = eval_input_score(policy, row, self.manifest, self.score_objective)
            outputs.append(output)
            scores.append(score)
            if capture_traces:
                trajectories.append({
                    "input_id": row.get("input_id") or row.get("id"),
                    "request": row.get("request", row),
                    "expected": eval_expected(row),
                    "output": output,
                    "feedback": feedback,
                    "score": score,
                })
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate: dict[str, str], eval_batch: Any, components_to_update: list[str]) -> dict[str, list[dict[str, Any]]]:
        traces = eval_batch.trajectories or []
        rows = []
        for trace in traces:
            rows.append({
                "Inputs": trace.get("request"),
                "Generated Outputs": trace.get("output"),
                "Feedback": trace.get("feedback"),
                "score": trace.get("score"),
                "input_id": trace.get("input_id"),
            })
        return {component: rows for component in components_to_update}

    def propose_new_texts(self, candidate: dict[str, str], reflective_dataset: dict[str, Any], components_to_update: list[str]) -> dict[str, str]:
        additions = []
        for component in components_to_update:
            for item in reflective_dataset.get(component, []):
                expected = item.get("Feedback", "")
                inputs = item.get("Inputs", {})
                additions.append(f"When input resembles {json.dumps(inputs, sort_keys=True)}, address feedback: {expected}")
        current = candidate.get("eval_input_policy", "")
        suffix = "\n".join(additions[:5])
        return {"eval_input_policy": f"{current}\n{suffix}".strip()}


def eval_input_gepa(args: argparse.Namespace) -> None:
    import gepa

    manifest, rows = load_eval_input_manifest(args.manifest)
    train_rows, dev_rows, holdout_count = split_train_dev(rows, args.split_key, args.train_split, args.dev_split)
    adapter = EvalInputGepaAdapter(manifest=manifest, score_objective=args.score_objective)
    seed_policy = str(manifest.get("seed_policy") or "Classify the request and choose the expected label or tool using explicit request text.")
    result = gepa.optimize(
        seed_candidate={"eval_input_policy": seed_policy},
        trainset=train_rows,
        valset=dev_rows,
        adapter=adapter,
        max_metric_calls=int(args.max_metric_calls),
        reflection_minibatch_size=int(args.reflection_minibatch_size),
        skip_perfect_score=False,
        display_progress_bar=False,
        cache_evaluation=True,
        seed=0,
    )
    best_candidate = getattr(result, "best_candidate", None) or {"eval_input_policy": seed_policy}
    optimize_dir = Path(args.repo) / ".understudy" / "optimize-workload"
    run_dir = optimize_dir / "eval-input-gepa"
    run_dir.mkdir(parents=True, exist_ok=True)
    candidate = {
        "schema_version": "understudy.eval_input_gepa_candidate.v1",
        "adapter": "eval-input-gepa",
        "score_objective": args.score_objective,
        "component": "eval_input_policy",
        "candidate": best_candidate,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "provider_calls": bool(args.model),
        "model": args.model,
    }
    candidate_path = optimize_dir / "eval-input-candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    result_path = run_dir / "result.json"
    candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    proof = {
        "schema_version": "understudy.optimize-workload.proof.v1",
        "mode": "eval-input-gepa",
        "status": "candidate-created",
        "backend": "uv-gepa",
        "adapter": "eval-input-gepa",
        "provider_calls": bool(args.model),
        "live_optimizer_execution": True,
        "package_installs": True,
        "holdout_accessed_during_optimization": False,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "candidate": ".understudy/optimize-workload/eval-input-candidate.json",
    }
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    result_path.write_text(json.dumps({
        "schema_version": "understudy.eval_input_gepa_result.v1",
        "best_candidate": best_candidate,
        "gepa_result_class": result.__class__.__name__,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    emit({
        "schema_version": "understudy.eval_input_gepa_adapter.v1",
        "status": "candidate-created",
        "adapter": "eval-input-gepa",
        "provider_calls": bool(args.model),
        "optimizer_execution": True,
        "train_count": len(train_rows),
        "dev_count": len(dev_rows),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "candidate_path": ".understudy/optimize-workload/eval-input-candidate.json",
        "proof_packet_path": ".understudy/optimize-workload/proof-packet.json",
        "result_path": ".understudy/optimize-workload/eval-input-gepa/result.json",
    })


def budget_preflight(args: argparse.Namespace) -> None:
    ledger = SpendLedger(
        args.budget_usd,
        args.input_usd_per_million,
        args.output_usd_per_million,
    )
    message_bytes = int(args.message_bytes)
    message_count = int(args.message_count)
    output_token_ceiling = int(args.max_tokens)
    call_count = int(args.call_count)
    if output_token_ceiling <= 0 or call_count <= 0:
        raise ValueError("max_tokens and call_count must be positive")
    input_token_ceiling = input_token_ceiling_from_bytes(message_bytes, message_count)
    projected = ledger.projected_reservation(input_token_ceiling, output_token_ceiling)
    allowed = True
    try:
        for _ in range(call_count):
            ledger.reserve(input_token_ceiling, output_token_ceiling)
    except SpendBudgetExceeded:
        allowed = False
    evidence = ledger.evidence()
    emit({
        "schema_version": "understudy.dspy_gepa_budget_preflight.v1",
        "status": "allowed" if allowed else "budget-blocked",
        "allowed": allowed,
        "provider_calls": False,
        "approved_budget_usd": ledger.budget_usd,
        "input_token_ceiling": input_token_ceiling,
        "output_token_ceiling": output_token_ceiling,
        "projected_per_call_reservation_usd": projected,
        "projected_requested_reservations_usd": projected * call_count,
        "requested_call_count": call_count,
        "simulated_reservation_count": evidence["calls_attempted"],
        "reserved_upper_bound_usd": evidence["reserved_upper_bound_usd"],
        "price_basis": evidence["price_basis"],
    })
    if not allowed:
        raise SystemExit(4)


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    dspy_gepa_parser = sub.add_parser("dspy-gepa")
    dspy_gepa_parser.add_argument("--repo", required=True)
    dspy_gepa_parser.add_argument("--samples", default=None)
    dspy_gepa_parser.add_argument("--input-keys", default="")
    dspy_gepa_parser.add_argument("--output-keys", default="")
    dspy_gepa_parser.add_argument("--module", choices=("predict", "cot"), default="predict")
    dspy_gepa_parser.add_argument("--model", required=True)
    dspy_gepa_parser.add_argument("--reflection-model", required=True)
    dspy_gepa_parser.add_argument("--max-metric-calls", type=positive_int_arg, default=3)
    dspy_gepa_parser.add_argument("--split-key", default="split")
    dspy_gepa_parser.add_argument("--train-split", default="train")
    dspy_gepa_parser.add_argument("--dev-split", default="dev")
    dspy_gepa_parser.add_argument("--max-tokens", type=positive_int_arg, default=256)
    dspy_gepa_parser.add_argument("--temperature", type=non_negative_float_arg, default=0.1)
    dspy_gepa_parser.add_argument(
        "--reasoning-effort", choices=("none", "minimal", "low", "medium", "high"), default="none",
    )
    dspy_gepa_parser.add_argument("--reflection-temperature", type=non_negative_float_arg, default=0.1)
    dspy_gepa_parser.add_argument(
        "--reflection-reasoning-effort",
        choices=("none", "minimal", "low", "medium", "high"),
        default="none",
    )
    dspy_gepa_parser.add_argument("--budget-usd", required=True)
    dspy_gepa_parser.add_argument("--input-usd-per-million", required=True)
    dspy_gepa_parser.add_argument("--output-usd-per-million", required=True)
    dspy_gepa_parser.add_argument("--reflection-minibatch-size", type=positive_int_arg, default=1)
    dspy_gepa_parser.add_argument(
        "--candidate-selection-strategy", choices=("pareto", "current_best"), default="pareto",
    )
    dspy_gepa_parser.add_argument(
        "--component-selector", choices=("round_robin", "all"), default="round_robin",
    )
    dspy_gepa_parser.add_argument("--use-merge", type=bool_arg, default=False)
    dspy_gepa_parser.add_argument("--max-merge-invocations", type=non_negative_int_arg, default=5)
    dspy_gepa_parser.add_argument("--num-threads", type=positive_int_arg, default=1)
    dspy_gepa_parser.add_argument("--seed", type=int, default=0)
    dspy_gepa_parser.add_argument("--log-dir", default=None)
    dspy_gepa_parser.add_argument("--track-stats", type=bool_arg, default=False)
    dspy_gepa_parser.add_argument("--program-bridge", default=None)
    dspy_gepa_parser.add_argument("--program-bridge-config", default=None)
    dspy_gepa_parser.add_argument("--program-project", default=None)
    dspy_gepa_parser.add_argument("--admission-only", action="store_true")
    dspy_gepa_parser.add_argument("--admission-receipt", default=None)
    dspy_gepa_parser.set_defaults(func=dspy_gepa)

    eval_input_gepa_parser = sub.add_parser("eval-input-gepa")
    eval_input_gepa_parser.add_argument("--repo", required=True)
    eval_input_gepa_parser.add_argument("--manifest", required=True)
    eval_input_gepa_parser.add_argument("--max-metric-calls", default="6")
    eval_input_gepa_parser.add_argument("--split-key", default="split")
    eval_input_gepa_parser.add_argument("--train-split", default="train")
    eval_input_gepa_parser.add_argument("--dev-split", default="dev")
    eval_input_gepa_parser.add_argument("--score-objective", default="exact_match")
    eval_input_gepa_parser.add_argument("--reflection-minibatch-size", default="1")
    eval_input_gepa_parser.add_argument("--model", default=None)
    eval_input_gepa_parser.set_defaults(func=eval_input_gepa)

    budget_preflight_parser = sub.add_parser("budget-preflight")
    budget_preflight_parser.add_argument("--message-bytes", required=True)
    budget_preflight_parser.add_argument("--message-count", required=True)
    budget_preflight_parser.add_argument("--max-tokens", required=True)
    budget_preflight_parser.add_argument("--call-count", default="1")
    budget_preflight_parser.add_argument("--budget-usd", required=True)
    budget_preflight_parser.add_argument("--input-usd-per-million", required=True)
    budget_preflight_parser.add_argument("--output-usd-per-million", required=True)
    budget_preflight_parser.set_defaults(func=budget_preflight)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
