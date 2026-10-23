export const optimizerRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import re
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlsplit
from pathlib import Path
from collections import deque
from collections.abc import Callable, Mapping
from types import MappingProxyType
from typing import Any


# dspy 3.4.1 hard-pins gepa==0.1.4. dspy 3.5 removes the legacy LM interfaces;
# the spend ledger meters at the engine seam that replaces them.
DSPY_PACKAGE_SPEC = "dspy==3.4.1"
DSPY_VERSION = "3.4.1"
GEPA_PACKAGE_SPEC = "gepa[dspy]==0.1.4"
GEPA_VERSION = "0.1.4"
CLOUDPICKLE_PACKAGE_SPEC = "cloudpickle==3.1.2"
CLOUDPICKLE_VERSION = "3.1.2"
# litellm is bounded, not pinned: 1.83 is the security floor in the gepa 0.1.2
# release notes and 2.x is an untested major.
LITELLM_PACKAGE_SPEC = "litellm>=1.83,<2"
LITELLM_MIN_VERSION = (1, 83)
LITELLM_MAX_MAJOR_EXCLUSIVE = 2


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


def normalize_dspy_model(value: str) -> str:
    if "/" in value:
        return value
    return f"openai/{value}"


class SpendBudgetExceeded(RuntimeError):
    pass


class NoScoredCandidateError(SpendBudgetExceeded):
    """Refused calls left the run without any candidate scored on the whole dev split."""


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


def usage_detail_count(usage: Any, container: str, name: str) -> int | None:
    """Read a nested counter such as completion_tokens_details.reasoning_tokens."""
    nested = usage.get(container) if isinstance(usage, dict) else getattr(usage, container, None)
    return usage_token_count(nested, name) if nested is not None else None


def billable_usage_bound(usage: Any, input_tokens: int, output_tokens: int) -> tuple[int, int, int]:
    """Conservative (input, output, exceed-check output) token counts for settling a call.

    lm15 Usage counters are provider-verbatim: output_tokens excludes reasoning on
    Gemini and xAI, total_tokens may add reasoning or cache classes, and Anthropic
    input_tokens excludes cache writes. The settle bound therefore takes the larger
    of output and total - input, adds a separately reported reasoning count when the
    total says nothing more (lm15 fills an unreported total as input + output, so an
    equal total counts as unreported), and adds reported cache writes to the input.
    The exceed check uses output or total - input only: OpenAI already counts
    reasoning inside completion_tokens.
    """
    total = usage_token_count(usage, "total_tokens")
    reasoning = (
        usage_token_count(usage, "reasoning_tokens")
        or usage_detail_count(usage, "completion_tokens_details", "reasoning_tokens")
        or usage_detail_count(usage, "output_tokens_details", "reasoning_tokens")
        or 0
    )
    cache_write = (
        usage_token_count(usage, "cache_write_tokens", "cache_creation_input_tokens")
        or usage_detail_count(usage, "prompt_tokens_details", "cache_write_tokens")
        or 0
    )
    if total is not None and total > input_tokens + output_tokens:
        checked_output = total - input_tokens
        billable_output = checked_output
    else:
        checked_output = output_tokens
        billable_output = output_tokens + reasoning
    return input_tokens + cache_write, billable_output, checked_output


def money(value: Any) -> str:
    # Concatenated, never an f-string with a leading dollar sign: this source is a
    # JavaScript template literal.
    if not isinstance(value, (int, float)):
        return "n/a"
    return "$" + (f"{value:.2f}" if abs(value) >= 0.01 else f"{value:.4f}")


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


class RunEvents:
    """Append-only owner-only JSONL progress stream, flushed as each event happens.

    Events carry counts, scores, token usage and instruction text, never sample
    inputs, route URLs or credentials. Each invocation appends under its own
    run_id so a resumed or admission-then-compile pair keeps one history. A
    failed write disables the stream instead of the run.
    """

    def __init__(self, path: Path | None, echo: bool = False) -> None:
        self.path = path
        self.echo = echo
        self.run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}"
        self._lock = threading.Lock()
        self._seq = 0
        self._started = time.monotonic()
        self._handle: Any = None
        if path is not None:
            try:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.chmod(path, 0o600)
                self._handle = os.fdopen(descriptor, "a", encoding="utf-8")
            except OSError:
                self._handle = None

    def emit(self, event: str, **fields: Any) -> None:
        with self._lock:
            self._seq += 1
            record = {
                "seq": self._seq,
                "run_id": self.run_id,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "elapsed_s": round(time.monotonic() - self._started, 1),
                "event": event,
                **fields,
            }
            if self._handle is not None:
                try:
                    self._handle.write(json.dumps(record, sort_keys=True, default=str) + "\n")
                    self._handle.flush()
                except (OSError, ValueError):
                    self._handle = None
            if self.echo:
                line = self._format(record)
                if line:
                    print(line, file=sys.stderr, flush=True)

    def ledger_event(self, payload: dict[str, Any]) -> None:
        fields = dict(payload)
        self.emit(str(fields.pop("event")), **fields)

    @staticmethod
    def _format(record: dict[str, Any]) -> str | None:
        elapsed = int(record["elapsed_s"])
        stamp = f"[{elapsed // 60:02d}:{elapsed % 60:02d}]"
        name = record["event"]
        hidden = ("seq", "run_id", "at", "elapsed_s", "event")
        if name == "call-completed":
            # Calls are frequent; echo the first few, then every 25th.
            if record["call_id"] > 3 and record["call_id"] % 25:
                return None
            cost = record.get("attributed_cost_usd")
            spend = "$" + f"{cost:.4f}" if isinstance(cost, (int, float)) else "unpriced"
            cap = record.get("approved_budget_usd")
            cap_text = " of $" + f"{cap:g}" if cap else ""
            return (
                f"{stamp} call {record['call_id']} {record['role']} {record.get('model')} "
                f"in={record.get('input_tokens')} out={record.get('output_tokens')} | spend {spend}{cap_text}"
            )
        if name == "phase":
            return f"{stamp} phase: {record['name']}"
        if name.startswith("gepa-candidate") or name in ("gepa-finished", "gepa-error"):
            detail = {key: value for key, value in record.items() if key not in hidden}
            return f"{stamp} {name} {json.dumps(detail, sort_keys=True, default=str)[:200]}"
        if name == "gepa-valset-evaluated":
            best = " (new best)" if record.get("is_best_program") else ""
            score = record.get("average_score")
            score_text = f"{score:.3f}" if isinstance(score, (int, float)) else "n/a"
            return f"{stamp} candidate {record.get('candidate_idx')} val score {score_text}{best}"
        if name == "holdout-progress":
            return f"{stamp} holdout {record['program']}: {record['done']}/{record['total']} rows"
        if name == "spend-rate":
            line = (
                f"{stamp} spend " + money(record.get("committed_usd"))
                + " @ " + money(record.get("recent_rate_usd_per_min")) + "/min"
            )
            projected = record.get("projected_usd")
            if isinstance(projected, (int, float)):
                line += ", projected " + money(projected)
                cap = record.get("approved_budget_usd")
                if isinstance(cap, (int, float)):
                    line += " of " + money(cap)
            reserve = record.get("holdout_reserve_usd")
            if isinstance(reserve, (int, float)) and reserve > 0:
                line += " (optimize limit " + money(record.get("phase_limit_usd")) + ")"
            return line
        if name == "spend-projection-warning":
            return (
                f"{stamp} warning: projected spend " + money(record.get("projected_usd"))
                + " exceeds the optimization limit " + money(record.get("phase_limit_usd"))
                + "; the run will stop before the limit"
            )
        if name == "budget-stop":
            return (
                f"{stamp} budget-stop ({record.get('reason')}): spend " + money(record.get("committed_usd"))
                + " of " + money(record.get("phase_limit_usd")) + " optimization limit; finishing with the best candidate"
            )
        if name == "late-call-refused":
            return f"{stamp} refused a call left over from an earlier phase ({record.get('reason')})"
        if name == "spend-drain-timeout":
            return (
                f"{stamp} spend drain timed out: {record.get('inflight_calls')} call(s) still in flight; "
                "their full reservations stay in the evidence"
            )
        if name == "spend-throttled":
            return (
                f"{stamp} spend throttled: waiting for in-flight calls ("
                + money(record.get("committed_usd")) + " committed + "
                + money(record.get("inflight_reserved_usd")) + " in flight of " + money(record.get("limit_usd")) + ")"
            )
        if name in ("run-started", "data-loaded", "round-finished", "run-finished", "run-failed", "budget-blocked"):
            detail = {key: value for key, value in record.items() if key not in hidden}
            return f"{stamp} {name} {json.dumps(detail, sort_keys=True, default=str)[:240]}"
        return None


class GepaProgress:
    """GEPA 0.1.4 callbacks (every method optional) that stream optimizer progress.

    DSPy 3.4.1 evaluates candidates with Evaluate(max_errors=len(batch)*100),
    which swallows a refused call and scores its row failure_score (0) while
    still reporting the whole dev split as evaluated. So a dev evaluation that
    overlapped a spend refusal is marked partial: its score is not a real score,
    it never becomes best-so-far, and the round's result is checked against it.
    Refusals are counted from the ledger since the current GEPA iteration
    started (the seed's evaluation runs before the first iteration, so since
    this round's callbacks were built). GEPA may evaluate several proposals of
    one iteration together and the optimization phase stays closed after its
    first refusal, so every dev evaluation of an iteration with a refusal is
    treated as having seen one.
    """

    def __init__(
        self,
        events: RunEvents,
        best_path: Path | None,
        round_index: int = 1,
        config_sha256: str | None = None,
        ledger: SpendLedger | None = None,
    ) -> None:
        self._events = events
        self._best_path = best_path
        self._round = round_index
        self._config_sha256 = config_sha256
        self._ledger = ledger
        self._refusals_seen = ledger.refusal_count() if ledger is not None else 0
        self.refusals_at_start = self._refusals_seen
        self._refusals_at_iteration = self._refusals_seen
        # One record per dev evaluation: candidate_idx, average_score,
        # instructions, partial.
        self.evaluations: list[dict[str, Any]] = []
        self._best_full_score: float | None = None

    def on_optimization_start(self, event: dict[str, Any]) -> None:
        self._events.emit(
            "gepa-started",
            round=self._round,
            trainset_size=event.get("trainset_size"),
            valset_size=event.get("valset_size"),
        )

    def on_iteration_start(self, event: dict[str, Any]) -> None:
        if self._ledger is not None:
            self._refusals_at_iteration = self._ledger.refusal_count()

    def on_proposal_end(self, event: dict[str, Any]) -> None:
        self._events.emit(
            "gepa-proposal",
            round=self._round,
            iteration=event.get("iteration"),
            new_instructions=event.get("new_instructions"),
        )

    def refusals_in_round(self) -> int:
        if self._ledger is None:
            return 0
        return self._ledger.refusal_count() - self.refusals_at_start

    def on_valset_evaluated(self, event: dict[str, Any]) -> None:
        evaluated = event.get("num_examples_evaluated")
        total = event.get("total_valset_size")
        is_best = bool(event.get("is_best_program"))
        refusals = self._ledger.refusal_count() if self._ledger is not None else 0
        refused_calls = max(0, refusals - self._refusals_at_iteration)
        self._refusals_seen = refusals
        score = event.get("average_score")
        partial = refused_calls > 0 or evaluated != total or not isinstance(score, (int, float))
        candidate = event.get("candidate")
        self.evaluations.append({
            "iteration": event.get("iteration"),
            "candidate_idx": event.get("candidate_idx"),
            "average_score": score,
            "instructions": dict(candidate) if isinstance(candidate, Mapping) else None,
            "partial": partial,
        })
        self._events.emit(
            "gepa-valset-evaluated",
            round=self._round,
            iteration=event.get("iteration"),
            candidate_idx=event.get("candidate_idx"),
            average_score=score,
            num_examples_evaluated=evaluated,
            total_valset_size=total,
            is_best_program=is_best,
            partial=partial,
            refused_calls=refused_calls,
        )
        if partial:
            return
        # Only a candidate scored on the whole dev split, with no refused call,
        # is worth restarting from: GEPA's best, or one that beats every fully
        # scored candidate when GEPA ranked a deflated partial score above it.
        beats_full = self._best_full_score is not None and float(score) > self._best_full_score
        if self._best_full_score is None or float(score) > self._best_full_score:
            self._best_full_score = float(score)
        if (is_best or beats_full) and self._best_path is not None:
            write_owner_only_json(self._best_path, {
                "schema_version": "understudy.dspy_gepa_best_so_far.v1",
                "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "run_id": self._events.run_id,
                "config_sha256": self._config_sha256,
                "round": self._round,
                "iteration": event.get("iteration"),
                "candidate_idx": event.get("candidate_idx"),
                "average_score": event.get("average_score"),
                "split": "dev",
                "instructions": event.get("candidate"),
            })

    def on_candidate_accepted(self, event: dict[str, Any]) -> None:
        self._events.emit(
            "gepa-candidate-accepted",
            round=self._round,
            iteration=event.get("iteration"),
            new_candidate_idx=event.get("new_candidate_idx"),
            new_score=event.get("new_score"),
            parent_ids=list(event.get("parent_ids") or []),
        )

    def on_candidate_rejected(self, event: dict[str, Any]) -> None:
        self._events.emit(
            "gepa-candidate-rejected",
            round=self._round,
            iteration=event.get("iteration"),
            old_score=event.get("old_score"),
            new_score=event.get("new_score"),
            reason=event.get("reason"),
        )

    def on_optimization_end(self, event: dict[str, Any]) -> None:
        self._events.emit(
            "gepa-finished",
            round=self._round,
            best_candidate_idx=event.get("best_candidate_idx"),
            total_iterations=event.get("total_iterations"),
            total_metric_calls=event.get("total_metric_calls"),
        )

    def on_error(self, event: dict[str, Any]) -> None:
        error = event.get("exception")
        self._events.emit(
            "gepa-error",
            round=self._round,
            iteration=event.get("iteration"),
            error=type(error).__name__ if error is not None else None,
            will_continue=event.get("will_continue"),
        )


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


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def credential_free_api_base(value: Any, *, append_v1: bool) -> tuple[str, str]:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("LM route base_url must be a non-empty string")
    base = value.strip().rstrip("/")
    if append_v1 and not base.endswith("/v1"):
        base = f"{base}/v1"
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("LM route base_url must be credential-free HTTP(S) without query or fragment")
    default_port = 443 if parsed.scheme == "https" else 80
    port = parsed.port or default_port
    host_identity = f"{parsed.scheme.lower()}://{parsed.hostname.lower()}:{port}"
    return base, host_identity


def resolve_lm_route(
    role: str,
    requested_model: str,
    bridge_config: Mapping[str, Any],
    gateway_url: str | None,
) -> tuple[dict[str, Any], str, str]:
    route_map = bridge_config.get("inference_routes", {})
    if not isinstance(route_map, Mapping):
        raise ValueError("bridge_config.inference_routes must be a mapping")
    if any(key not in {"student", "reflection"} for key in route_map.keys()):
        raise ValueError("bridge_config.inference_routes supports only student and reflection")
    configured = route_map.get(role)
    if configured is None:
        if not gateway_url:
            raise ValueError(f"UNDERSTUDY_GATEWAY_URL is required for the default {role} route")
        base_url, host_identity = credential_free_api_base(gateway_url, append_v1=True)
        route_config = {
            "route_id": "understudy-gateway",
            "base_url": base_url,
            "api_key_env": "UNDERSTUDY_API_KEY",
            "requested_model": requested_model,
            "executed_model": normalize_dspy_model(requested_model),
        }
    else:
        if not isinstance(configured, Mapping):
            raise ValueError(f"bridge_config.inference_routes.{role} must be a mapping")
        required_fields = {
            "route_id",
            "base_url",
            "api_key_env",
            "requested_model",
            "executed_model",
        }
        if set(configured.keys()) != required_fields:
            raise ValueError(
                f"bridge_config.inference_routes.{role} must contain exactly {sorted(required_fields)}"
            )
        route_config = dict(configured)
        base_url, host_identity = credential_free_api_base(
            route_config["base_url"], append_v1=False,
        )
    route_id = route_config.get("route_id")
    api_key_env = route_config.get("api_key_env")
    configured_requested_model = route_config.get("requested_model")
    executed_model = route_config.get("executed_model")
    if not isinstance(route_id, str) or not route_id.strip() or route_id != route_id.strip():
        raise ValueError(f"{role} route_id must be a non-empty string")
    if not isinstance(api_key_env, str) or _ENV_NAME.fullmatch(api_key_env) is None:
        raise ValueError(f"{role} api_key_env must be an environment variable name")
    if configured_requested_model != requested_model:
        raise ValueError(f"{role} requested_model does not match the CLI model")
    if (
        not isinstance(executed_model, str)
        or not executed_model.strip()
        or executed_model != executed_model.strip()
    ):
        raise ValueError(f"{role} executed_model must be a non-empty string")
    credential = os.environ.get(api_key_env)
    if not credential:
        raise ValueError(f"{api_key_env} is required for the {role} LM route")
    dspy_model = normalize_dspy_model(executed_model)
    if dspy_model != executed_model:
        raise ValueError(f"{role} executed_model must be the exact DSPy/LiteLLM model identifier")
    binding = {
        "schema_version": "understudy.dspy_lm_route_binding.v1",
        "role": role,
        "route_id": route_id,
        "requested_model": requested_model,
        "executed_model": executed_model,
        "dspy_model": dspy_model,
        "base_url_sha256": text_sha256(base_url),
        "base_host_sha256": text_sha256(host_identity),
        "api_key_env": api_key_env,
    }
    receipt = {
        **binding,
        "route_binding_sha256": canonical_sha256(binding),
        "credential_source": "environment",
        "credential_present": True,
        "provider_response_identity_scope": "per-call-spend-entry-when-exposed",
    }
    return receipt, credential, base_url


def response_identity_receipt(response: Any) -> dict[str, Any]:
    model = response.get("model") if isinstance(response, Mapping) else getattr(response, "model", None)
    model_source = "response.model"
    hidden = (
        response.get("_hidden_params")
        if isinstance(response, Mapping)
        else getattr(response, "_hidden_params", None)
    )
    hidden = hidden if isinstance(hidden, Mapping) else {}
    if not isinstance(model, str) or not model:
        hidden_model = hidden.get("model_id")
        model = hidden_model if isinstance(hidden_model, str) and hidden_model else None
        model_source = "response._hidden_params.model_id"
    headers = hidden.get("additional_headers")
    headers = headers if isinstance(headers, Mapping) else {}
    normalized_headers = {
        str(key).lower(): value
        for key, value in headers.items()
        if isinstance(value, str) and value
    }
    effective_model = None
    effective_header_name = None
    for header_name in (
        "x-understudy-effective-model",
        "x-understudy-upstream-model",
        "x-litellm-model-id",
        "x-model-id",
        "x-fireworks-model",
    ):
        if header_name in normalized_headers:
            effective_header_name = header_name
            effective_model = normalized_headers[header_name]
            break
    return {
        "provider_returned_model": (
            {"status": "observed", "source": model_source, "value": model}
            if model is not None
            else {"status": "unavailable-from-response"}
        ),
        "effective_model_header": (
            {"status": "observed", "header": effective_header_name, "value": effective_model}
            if effective_model is not None
            else {"status": "unavailable-from-response"}
        ),
    }


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


def normalize_price_key(model: str | None) -> str | None:
    if model is None:
        return None
    return model[len("openai/"):] if model.startswith("openai/") else model


# Spend governor tuning. None of these can admit more spend: they only decide
# how long a call that would fit once in-flight calls settle may wait, and how
# far ahead of the limit the run stops.
#
# DSPy 3.4.1's Evaluate runs rows on a ParallelExecutor (timeout=120,
# straggler_limit=3): once at most three rows remain, a row running for 120 s
# is resubmitted and the original thread is abandoned. The throttle wait stays
# well under that, and a call that outlives its phase is refused (see reserve).
SPEND_THROTTLE_MAX_WAIT_S = 90.0
SPEND_THROTTLE_EVENT_INTERVAL_S = 30.0
SPEND_THROTTLE_POLL_S = 5.0
SPEND_DRAIN_MAX_WAIT_S = 60.0
SPEND_DRAIN_POLL_S = 0.05
SPEND_RATE_WINDOW_S = 60.0
HOLDOUT_RESERVE_MARGIN = 1.25
# The holdout reserve prices each call at this percentile of settled student
# call costs (nearest rank), not at the single most expensive one.
HOLDOUT_RESERVE_PERCENTILE = 0.9
# DSPy's ChatAdapter retries a parse failure once through JSONAdapter, so one
# predictor invocation costs one or two student calls.
MAX_STUDENT_CALLS_PER_PREDICTOR_INVOCATION = 2.0
SPEND_STOP_ITERATION_MARGIN = 1.5
SPEND_STOP_RECENT_ITERATIONS = 3
SPEND_PROJECTION_WARNING_AFTER_ITERATIONS = 3
OPTIMIZATION_PHASE = "optimization"
# Between the end of optimization and the holdout: the full cap applies, and
# calls left over from optimization are refused.
FINALIZING_PHASE = "finalizing"
HOLDOUT_PHASE = "holdout"


class SpendLedger:
    """Reserve worst-case spend before each call and record usage after it.

    Prices resolve per call: the reflection flags for reflection calls, then a
    --model-price for the requested model, then a price the Understudy gateway
    publishes (only for roles routed through it), then the global basis. With
    enforce=False the ledger only observes: it never blocks a call and does not
    need a budget or prices; it still records token usage per call.

    Spend governor: reserved_upper_bound_usd is committed spend (settled bounds,
    plus the full reservation of calls whose usage is missing or ambiguous) plus
    inflight_reserved_usd (the full reservation of calls still in flight). A call
    is admitted only if that total plus its own reservation fits the current
    phase limit, which never exceeds the cap. A call that would fit once in-flight
    calls settle waits for them (bounded) instead of failing. During the
    optimization phase the limit is the cap minus a reserve for the holdout
    evaluation, and reaching it marks the phase exhausted without latching the
    run-wide failure, so the holdout can still run under the full cap.

    A call belongs to the phase it entered reserve() in. One that is still
    waiting when the phase changes, or that comes from a thread last admitted in
    an earlier optimization phase (a row DSPy abandoned as a straggler), is
    refused without latching, so leftover optimization work can never spend the
    holdout's reserve or land after the final spend evidence is sampled.
    """

    def __init__(
        self,
        budget_usd: float | None,
        input_usd_per_million: float | None,
        output_usd_per_million: float | None,
        reflection_input_usd_per_million: float | None = None,
        reflection_output_usd_per_million: float | None = None,
        model_prices: Mapping[str, tuple[float, float]] | None = None,
        enforce: bool = True,
        throttle_max_wait_s: float = SPEND_THROTTLE_MAX_WAIT_S,
    ) -> None:
        self.enforce = enforce
        self.throttle_max_wait_s = max(0.0, float(throttle_max_wait_s))
        if enforce:
            if budget_usd is None:
                raise ValueError("budget_usd is required while the spend ledger is enforced")
            self.budget_usd: float | None = positive_float(budget_usd, "budget_usd")
        else:
            if budget_usd is not None:
                raise ValueError("budget_usd cannot be combined with an observe-only spend ledger")
            self.budget_usd = None
        if (input_usd_per_million is None) != (output_usd_per_million is None):
            raise ValueError("input and output prices must be supplied together")
        self.input_usd_per_million: float | None = None
        self.output_usd_per_million: float | None = None
        if input_usd_per_million is not None and output_usd_per_million is not None:
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
        # Reflection often runs on a pricier model than the student. When given,
        # its own price pair applies to calls made with role="reflection".
        if (reflection_input_usd_per_million is None) != (reflection_output_usd_per_million is None):
            raise ValueError("reflection input and output prices must be supplied together")
        self.reflection_prices: tuple[float, float] | None = None
        if reflection_input_usd_per_million is not None and reflection_output_usd_per_million is not None:
            reflection_input = non_negative_float(
                reflection_input_usd_per_million,
                "reflection_input_usd_per_million",
            )
            reflection_output = non_negative_float(
                reflection_output_usd_per_million,
                "reflection_output_usd_per_million",
            )
            if reflection_input == 0 and reflection_output == 0:
                raise ValueError("at least one reflection token price must be non-zero")
            self.reflection_prices = (reflection_input, reflection_output)
        self.model_prices: dict[str, tuple[float, float]] = dict(model_prices or {})
        self.gateway_prices: dict[str, tuple[float, float]] = {}
        self.gateway_roles: frozenset[str] = frozenset()
        self.price_lookup: dict[str, Any] | None = None
        self.reserved_upper_bound_usd = 0.0
        self.attributed_cost_usd = 0.0
        self.calls_attempted = 0
        self.calls_completed = 0
        self.usage_complete = True
        self.entries: list[dict[str, Any]] = []
        # The first budget or usage failure, kept even if DSPy or GEPA swallows
        # the exception it raised inside an engine call.
        self.failure: SpendBudgetExceeded | SpendEvidenceError | None = None
        self.observer: Callable[[dict[str, Any]], None] | None = None
        self._lock = threading.Lock()
        # Waiters for in-flight calls to settle share the ledger lock.
        self._settled = threading.Condition(self._lock)
        self.inflight_reserved_usd = 0.0
        # None until begin_phase: the full cap applies and a refusal latches.
        self.phase: str | None = None
        self.phase_exhausted: str | None = None
        self.phase_refusals = 0
        self.holdout_calls_planned = 0
        self.max_student_settled_usd: float | None = None
        self.max_student_reserved_usd: float | None = None
        # Settled student call costs, for the holdout reserve's percentile.
        self._student_settled: list[float] = []
        self._student_percentile: float | None = None
        self._student_percentile_stale = False
        # Observed ChatAdapter -> JSONAdapter fallback: student calls admitted
        # per predictor invocation whose result reached the metric.
        self.student_calls_admitted = 0
        self.predictor_invocations_scored = 0
        # Bumped by every begin_phase; a call admitted under an older epoch's
        # optimization phase marks its thread (see reserve).
        self._epoch = 0
        self._thread = threading.local()
        # The thread that switches phases runs the run itself (and DSPy's
        # sequential evaluation with --num-threads 1); it is never left over.
        self._owner_ident: int | None = None
        self._inflight_calls = 0
        self.late_refusals = 0
        self.drains: list[dict[str, Any]] = []
        self.max_call_reserved_usd = 0.0
        self.started_monotonic = time.monotonic()
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._settlements: deque[tuple[float, float]] = deque()
        self.throttled_calls = 0
        self.throttle_wait_s = 0.0
        self._waiting = 0
        self._last_throttle_event: float | None = None
        # The SpendStopper's latest projection, carried into every snapshot.
        self.latest_projection: dict[str, Any] | None = None

    def __deepcopy__(self, memo: dict[int, Any]) -> SpendLedger:
        # DSPy copies LMs for rollout variants. Every copy must share the same
        # process-wide ledger or a copied optimizer could bypass the cap.
        return self

    def _notify(self, payload: dict[str, Any]) -> None:
        # Progress logging must never break a run or the spend accounting.
        observer = self.observer
        if observer is None:
            return
        try:
            observer(payload)
        except Exception:
            pass

    def _call_event(self, name: str, entry: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "event": name,
            "call_id": entry["call_id"],
            "role": entry["role"],
            "model": entry["model"],
            "status": entry["status"],
            "input_tokens": entry.get("input_tokens"),
            "output_tokens": entry.get("output_tokens"),
            "call_cost_usd": entry.get("attributed_cost_usd"),
            "price_source": entry["price_source"],
            "calls_attempted": self.calls_attempted,
            "calls_completed": self.calls_completed,
            "attributed_cost_usd": self.attributed_cost_usd,
            "reserved_upper_bound_usd": self.reserved_upper_bound_usd,
            "inflight_reserved_usd": self.inflight_reserved_usd,
            "approved_budget_usd": self.budget_usd,
        }

    def _committed_locked(self) -> float:
        return max(0.0, self.reserved_upper_bound_usd - self.inflight_reserved_usd)

    def _student_cost_percentile_locked(self) -> float | None:
        """HOLDOUT_RESERVE_PERCENTILE of settled student call costs (nearest rank)."""
        if not self._student_settled:
            return None
        if self._student_percentile is None or self._student_percentile_stale:
            ordered = sorted(self._student_settled)
            rank = max(1, math.ceil(HOLDOUT_RESERVE_PERCENTILE * len(ordered)))
            self._student_percentile = ordered[rank - 1]
            self._student_percentile_stale = False
        return self._student_percentile

    def _calls_per_predictor_invocation_locked(self) -> float:
        """Observed student calls per scored predictor invocation, in [1, 2].

        Before anything is observed it is the worst case, 2. Calls whose run
        raised or is still running count without an invocation, which only
        raises the estimate.
        """
        if self.predictor_invocations_scored <= 0:
            return MAX_STUDENT_CALLS_PER_PREDICTOR_INVOCATION
        observed = self.student_calls_admitted / self.predictor_invocations_scored
        return min(MAX_STUDENT_CALLS_PER_PREDICTOR_INVOCATION, max(1.0, observed))

    def record_predictor_invocations(self, count: int) -> None:
        """Count predictor invocations whose program run reached the metric."""
        with self._lock:
            self.predictor_invocations_scored += max(0, int(count))

    def _holdout_reserve_locked(self, projected_student: float | None = None) -> float:
        """Spend kept back for the holdout evaluation while optimizing.

        Expected holdout calls are the planned calls (rows x 2 programs x
        predictors) x the observed student calls per predictor invocation
        (parse fallbacks). Calibrated: expected calls x the 90th percentile of
        settled student call costs x 1.25. Before any student call settles:
        expected calls x the worst-case student reservation. Either way one more
        worst-case student reservation is added, so the holdout's last call can
        still reserve its worst case. The worst case is the larger of the largest
        admitted student reservation and the call being checked.
        """
        planned = self.holdout_calls_planned
        if planned <= 0:
            return 0.0
        worst = max(self.max_student_reserved_usd or 0.0, projected_student or 0.0)
        expected_calls = planned * self._calls_per_predictor_invocation_locked()
        estimate = expected_calls * worst
        typical = self._student_cost_percentile_locked()
        if typical is not None:
            estimate = min(estimate, expected_calls * typical * HOLDOUT_RESERVE_MARGIN)
        return estimate + worst

    def _phase_limit_locked(self, projected_student: float | None = None) -> float | None:
        if self.budget_usd is None:
            return None
        cap = float(self.budget_usd)
        if self.phase == OPTIMIZATION_PHASE:
            return max(0.0, cap - self._holdout_reserve_locked(projected_student))
        return cap

    def begin_phase(self, phase: str, holdout_calls_planned: int | None = None) -> None:
        """Switch the limit: optimization keeps the holdout reserve back, the others get the full cap.

        Calls still waiting from the previous phase wake up and are refused.
        """
        with self._lock:
            self.phase = phase
            self._epoch += 1
            self._owner_ident = threading.get_ident()
            if holdout_calls_planned is not None:
                self.holdout_calls_planned = max(0, int(holdout_calls_planned))
            self._settled.notify_all()

    def refusal_count(self) -> int:
        """Calls refused without latching (phase limit or outlived phase)."""
        with self._lock:
            return self.phase_refusals + self.late_refusals

    def drain(self, timeout_s: float = SPEND_DRAIN_MAX_WAIT_S) -> dict[str, Any]:
        """Wait (bounded) until no call is waiting to reserve and none is in flight.

        Called after a phase switch, before the spend evidence is sampled. A
        timeout is recorded and reported; the calls still in flight keep their
        full reservation in the evidence, so it stays an upper bound.
        """
        started = time.monotonic()
        with self._lock:
            while self._waiting > 0 or self._inflight_calls > 0:
                remaining = timeout_s - (time.monotonic() - started)
                if remaining <= 0:
                    break
                # Polled: a waiter that gives up does not notify.
                self._settled.wait(timeout=min(remaining, SPEND_DRAIN_POLL_S))
            result = {
                "phase": self.phase,
                "drained": self._waiting == 0 and self._inflight_calls == 0,
                "waited_s": round(time.monotonic() - started, 3),
                "inflight_calls": self._inflight_calls,
                "waiting_calls": self._waiting,
                "inflight_reserved_usd": self.inflight_reserved_usd,
            }
            self.drains.append(result)
        if not result["drained"]:
            self._notify({"event": "spend-drain-timeout", **result, "timeout_s": timeout_s})
        return result

    def _record_settlement_locked(self, amount: float) -> None:
        now = time.monotonic()
        self._settlements.append((now, amount))
        while self._settlements and self._settlements[0][0] < now - SPEND_RATE_WINDOW_S:
            self._settlements.popleft()
        self._settled.notify_all()

    def _snapshot_locked(self) -> dict[str, Any]:
        now = time.monotonic()
        elapsed = max(0.0, now - self.started_monotonic)
        committed = self._committed_locked()
        recent = sum(amount for at, amount in self._settlements if at >= now - SPEND_RATE_WINDOW_S)
        recent_span = min(SPEND_RATE_WINDOW_S, elapsed)
        return {
            "started_at": self.started_at,
            "elapsed_s": round(elapsed, 1),
            "phase": self.phase,
            "approved_budget_usd": self.budget_usd,
            "committed_usd": committed,
            "inflight_reserved_usd": self.inflight_reserved_usd,
            "reserved_upper_bound_usd": self.reserved_upper_bound_usd,
            "attributed_cost_usd": self.attributed_cost_usd,
            "rate_usd_per_min": committed / (elapsed / 60) if elapsed > 0 else 0.0,
            "recent_rate_usd_per_min": recent / (recent_span / 60) if recent_span > 0 else 0.0,
            "rate_window_s": SPEND_RATE_WINDOW_S,
            "phase_limit_usd": self._phase_limit_locked(),
            "holdout_reserve_usd": self._holdout_reserve_locked() if self.phase == OPTIMIZATION_PHASE else 0.0,
            "holdout_calls_planned": self.holdout_calls_planned,
            "max_call_reserved_usd": self.max_call_reserved_usd,
            "phase_exhausted": self.phase_exhausted,
            "phase_refusals": self.phase_refusals,
            "late_refusals": self.late_refusals,
            "inflight_calls": self._inflight_calls,
            "waiting_calls": self._waiting,
            "drains": [dict(item) for item in self.drains],
            "holdout_student_call_usd": self._student_cost_percentile_locked(),
            "student_calls_per_predictor_invocation": self._calls_per_predictor_invocation_locked(),
            "throttled_calls": self.throttled_calls,
            "throttle_wait_s": round(self.throttle_wait_s, 3),
            "projection": dict(self.latest_projection) if self.latest_projection else None,
        }

    def spend_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def _fail(self, error: SpendBudgetExceeded | SpendEvidenceError) -> None:
        if self.failure is None:
            self.failure = error

    def set_gateway_prices(
        self,
        prices: Mapping[str, tuple[float, float]],
        lookup: Mapping[str, Any],
        roles: set[str] | frozenset[str],
    ) -> None:
        self.gateway_prices = dict(prices)
        self.gateway_roles = frozenset(roles)
        self.price_lookup = dict(lookup)

    def prices_for(self, model: str | None, role: str = "student") -> tuple[float, float, str] | None:
        key = normalize_price_key(model)
        if role == "reflection" and self.reflection_prices is not None:
            return (*self.reflection_prices, "reflection-flag")
        if key is not None and key in self.model_prices:
            return (*self.model_prices[key], "model-flag")
        if key is not None and role in self.gateway_roles and key in self.gateway_prices:
            return (*self.gateway_prices[key], "gateway")
        if self.input_usd_per_million is not None and self.output_usd_per_million is not None:
            return (self.input_usd_per_million, self.output_usd_per_million, "global")
        return None

    def projected_reservation(
        self,
        input_token_ceiling: int,
        output_token_ceiling: int,
        role: str = "student",
        model: str | None = None,
    ) -> float:
        prices = self.prices_for(model, role)
        if prices is None:
            return 0.0
        return token_price(input_token_ceiling, output_token_ceiling, prices[0], prices[1])

    def reserve(
        self,
        input_token_ceiling: int,
        output_token_ceiling: int,
        call_identity: Mapping[str, Any] | None = None,
    ) -> int:
        role = str((call_identity or {}).get("role") or "student")
        model = (call_identity or {}).get("requested_model")
        prices = self.prices_for(model, role)
        projected = (
            token_price(input_token_ceiling, output_token_ceiling, prices[0], prices[1])
            if prices is not None
            else 0.0
        )
        blocked_event: dict[str, Any] | None = None
        blocked_error: SpendBudgetExceeded | None = None
        call_id = 0
        # Read the latch, check the limit, and reserve under one lock, and latch a
        # refusal before releasing it, so no concurrent call can slip past either.
        # The lock is not reentrant: nothing in this block may take it again.
        # Waiting releases it (Condition.wait) and rechecks everything after.
        with self._lock:
            if self.enforce and self.failure is not None:
                # Fail closed for the rest of the run: once a call was blocked or
                # returned unusable usage, no later call may reach a provider, even
                # if an evaluator swallowed the first error and kept going.
                raise type(self.failure)(str(self.failure))
            if prices is None and self.enforce:
                error = SpendEvidenceError("no-price-basis-for-model")
                self._fail(error)
                raise error
            admitted = not self.enforce
            wait_started: float | None = None
            # The phase this call belongs to, and the optimization phase this
            # thread was last admitted in (None for a fresh thread).
            entry_epoch = self._epoch
            thread_epoch = (
                None
                if threading.get_ident() == self._owner_ident
                else getattr(self._thread, "optimization_epoch", None)
            )
            while not admitted:
                if self.failure is not None:
                    raise type(self.failure)(str(self.failure))
                if self._epoch != entry_epoch or (thread_epoch is not None and thread_epoch != self._epoch):
                    # The phase changed while this call waited, or the thread is
                    # left over from an optimization phase that already ended (a
                    # straggler DSPy abandoned). Refuse it without latching: it
                    # must not spend the holdout's reserve or land after the
                    # final spend evidence.
                    self.late_refusals += 1
                    blocked_error = SpendBudgetExceeded("call-outlived-its-phase")
                    blocked_event = {
                        "event": "late-call-refused",
                        "role": role,
                        "model": normalize_price_key(model),
                        "phase": self.phase,
                        "reason": "phase-changed-while-waiting" if self._epoch != entry_epoch else "thread-from-ended-optimization",
                        "next_reservation_usd": projected,
                        "late_refusals": self.late_refusals,
                    }
                    break
                if self.phase == OPTIMIZATION_PHASE and self.phase_exhausted is not None:
                    # The optimization phase stays closed once its limit was reached;
                    # only the first refusal is reported.
                    self.phase_refusals += 1
                    blocked_error = SpendBudgetExceeded("optimization-phase-limit-reached")
                    break
                limit = float(self._phase_limit_locked(projected if role == "student" else None))
                next_total = self.reserved_upper_bound_usd + projected
                if next_total <= limit + 1e-12:
                    admitted = True
                    break
                committed = self._committed_locked()
                now = time.monotonic()
                if wait_started is None:
                    wait_started = now
                fits_after_settling = committed + projected <= limit + 1e-12
                remaining = self.throttle_max_wait_s - (now - wait_started)
                if fits_after_settling and self.inflight_reserved_usd > 1e-15 and remaining > 0:
                    # Throttle: the call fits once in-flight calls settle, so wait for
                    # them instead of refusing it.
                    if self._last_throttle_event is None or now - self._last_throttle_event >= SPEND_THROTTLE_EVENT_INTERVAL_S:
                        self._last_throttle_event = now
                        # Emitted under the lock: the observer only writes the event
                        # stream and never calls back into the ledger.
                        self._notify({
                            "event": "spend-throttled",
                            "phase": self.phase,
                            "role": role,
                            "committed_usd": committed,
                            "inflight_reserved_usd": self.inflight_reserved_usd,
                            "next_reservation_usd": projected,
                            "limit_usd": limit,
                            "approved_budget_usd": self.budget_usd,
                            "waiting_calls": self._waiting + 1,
                        })
                    self._waiting += 1
                    try:
                        self._settled.wait(timeout=min(remaining, SPEND_THROTTLE_POLL_S))
                    finally:
                        self._waiting -= 1
                    continue
                reason = (
                    "throttle-wait-timeout"
                    if fits_after_settling and self.inflight_reserved_usd > 1e-15
                    else "next-call-reservation-exceeds-limit"
                )
                optimization = self.phase == OPTIMIZATION_PHASE
                blocked_error = SpendBudgetExceeded(
                    "optimization-phase-limit-reached" if optimization else "next-call-reservation-exceeds-budget"
                )
                if optimization:
                    # The holdout reserve stays available: no run-wide latch.
                    self.phase_exhausted = reason
                    self.phase_refusals += 1
                else:
                    self._fail(blocked_error)
                blocked_event = {
                    "event": "budget-blocked",
                    "role": role,
                    "model": normalize_price_key(model),
                    "phase": self.phase,
                    "scope": "optimization-phase" if optimization else "cap",
                    "latched": not optimization,
                    "reason": reason,
                    "next_reservation_usd": projected,
                    "reserved_upper_bound_usd": self.reserved_upper_bound_usd,
                    "committed_usd": committed,
                    "inflight_reserved_usd": self.inflight_reserved_usd,
                    "limit_usd": limit,
                    "holdout_reserve_usd": float(self.budget_usd) - limit if optimization else 0.0,
                    "approved_budget_usd": self.budget_usd,
                    "calls_attempted": self.calls_attempted,
                }
                break
            if wait_started is not None and admitted:
                self.throttled_calls += 1
                self.throttle_wait_s += time.monotonic() - wait_started
            if admitted:
                self.calls_attempted += 1
                call_id = self.calls_attempted
                self.reserved_upper_bound_usd += projected
                self.inflight_reserved_usd += projected
                self._inflight_calls += 1
                self.max_call_reserved_usd = max(self.max_call_reserved_usd, projected)
                if role == "student":
                    self.student_calls_admitted += 1
                    self.max_student_reserved_usd = max(self.max_student_reserved_usd or 0.0, projected)
                if self.phase == OPTIMIZATION_PHASE:
                    self._thread.optimization_epoch = self._epoch
                entry = {
                    "call_id": call_id,
                    "status": "reserved",
                    "phase": self.phase,
                    "role": role,
                    "model": normalize_price_key(model),
                    "price_source": prices[2] if prices is not None else None,
                    "input_usd_per_million": prices[0] if prices is not None else None,
                    "output_usd_per_million": prices[1] if prices is not None else None,
                    "input_token_ceiling": input_token_ceiling,
                    "output_token_ceiling": output_token_ceiling,
                    "reserved_upper_bound_usd": projected,
                }
                if call_identity is not None:
                    identity = dict(call_identity)
                    canonical_json_bytes(identity)
                    entry["configured_identity"] = identity
                self.entries.append(entry)
        if blocked_error is not None:
            if blocked_event is not None:
                self._notify(blocked_event)
            raise blocked_error
        return call_id

    def _settle_inflight_locked(self, entry: Mapping[str, Any]) -> None:
        # The call left flight; its reservation stays in reserved_upper_bound_usd
        # (committed) until complete() releases the unneeded part.
        self.inflight_reserved_usd = max(0.0, self.inflight_reserved_usd - float(entry["reserved_upper_bound_usd"]))
        self._inflight_calls = max(0, self._inflight_calls - 1)

    def mark_error(self, call_id: int) -> None:
        with self._lock:
            entry = self.entries[call_id - 1]
            entry["status"] = "provider-error-billing-ambiguous"
            self.usage_complete = False
            self._settle_inflight_locked(entry)
            # Billing is ambiguous, so the full reservation is committed.
            self._record_settlement_locked(float(entry["reserved_upper_bound_usd"]))
            event = self._call_event("call-failed", entry)
        self._notify(event)

    def complete(self, call_id: int, response: Any) -> None:
        usage = response.get("usage") if isinstance(response, Mapping) else getattr(response, "usage", None)
        input_tokens = usage_token_count(usage, "prompt_tokens", "input_tokens")
        output_tokens = usage_token_count(usage, "completion_tokens", "output_tokens")
        billable: tuple[int, int, int] | None = (
            billable_usage_bound(usage, input_tokens, output_tokens)
            if input_tokens is not None and output_tokens is not None
            else None
        )
        error: SpendEvidenceError | None = None
        with self._lock:
            entry = self.entries[call_id - 1]
            self._settle_inflight_locked(entry)
            # Until usage proves otherwise the full reservation is committed.
            settled_amount = float(entry["reserved_upper_bound_usd"])
            # DSPy's canonical Response defaults absent provider usage to zero
            # tokens. A real call always consumes tokens, so zero input and zero
            # output means the usage is unknown, not that the call was free.
            if (
                input_tokens is None
                or output_tokens is None
                or billable is None
                or (input_tokens == 0 and output_tokens == 0)
            ):
                entry["status"] = "usage-missing"
                self.usage_complete = False
                if self.enforce:
                    error = SpendEvidenceError("provider-usage-missing")
            elif self.enforce and (
                input_tokens > int(entry["input_token_ceiling"])
                or billable[2] > int(entry["output_token_ceiling"])
            ):
                entry["status"] = "usage-exceeds-reservation"
                self.usage_complete = False
                error = SpendEvidenceError("provider-usage-exceeds-reservation")
            else:
                attributed = None
                settled = None
                if entry["input_usd_per_million"] is not None and entry["output_usd_per_million"] is not None:
                    input_price = float(entry["input_usd_per_million"])
                    output_price = float(entry["output_usd_per_million"])
                    # Attribution prices the reported counters; the settled bound
                    # prices the conservative billable counters, capped at what was
                    # reserved. The cap only binds when enforced, where the checks
                    # above keep the reported usage inside the reservation.
                    attributed = token_price(input_tokens, output_tokens, input_price, output_price)
                    settled = token_price(billable[0], billable[1], input_price, output_price)
                    if self.enforce:
                        settled = min(float(entry["reserved_upper_bound_usd"]), settled)
                        attributed = min(attributed, settled)
                    self.attributed_cost_usd += attributed
                    # Usage is known and within the reservation, so release the part
                    # the billable bound does not need. In-flight calls and calls with
                    # missing or ambiguous usage keep their full worst-case
                    # reservation, so the total stays an upper bound. Holding every
                    # completed call at its output cap overstated spend about 26x on
                    # a 4,096-token student cap.
                    self.reserved_upper_bound_usd -= float(entry["reserved_upper_bound_usd"]) - settled
                    settled_amount = settled
                    if entry["role"] == "student":
                        self.max_student_settled_usd = max(self.max_student_settled_usd or 0.0, settled)
                        self._student_settled.append(settled)
                        self._student_percentile_stale = True
                entry.update({
                    "status": "complete",
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "billable_input_tokens": billable[0],
                    "billable_output_tokens": billable[1],
                    "attributed_cost_usd": attributed,
                    "settled_upper_bound_usd": settled,
                    "response_identity": response_identity_receipt(response),
                })
                self.calls_completed += 1
            self._record_settlement_locked(settled_amount)
            event = self._call_event("call-completed", entry)
            if error is not None:
                self._fail(error)
        self._notify(event)
        if error is not None:
            raise error

    def price_configuration(self) -> dict[str, Any]:
        """The hash-bound price inputs; resolved gateway prices are included."""
        return {
            "spend_enforcement": "ledger" if self.enforce else "none",
            "global": (
                [self.input_usd_per_million, self.output_usd_per_million]
                if self.input_usd_per_million is not None
                else None
            ),
            "reflection": list(self.reflection_prices) if self.reflection_prices is not None else None,
            "models": {model: list(pair) for model, pair in sorted(self.model_prices.items())},
            "gateway": {model: list(pair) for model, pair in sorted(self.gateway_prices.items())},
            "gateway_roles": sorted(self.gateway_roles),
            "resolution_order": ["reflection-flag", "model-flag", "gateway", "global"],
        }

    def evidence(self) -> dict[str, Any]:
        with self._lock:
            def basis(pair: tuple[float, float] | None, source: str = "user-supplied") -> dict[str, Any] | None:
                if pair is None:
                    return None
                return {
                    "source": source,
                    "input_usd_per_million": pair[0],
                    "output_usd_per_million": pair[1],
                    "scope": "token-price-attribution-not-provider-invoice",
                }

            default_pair = (
                (self.input_usd_per_million, self.output_usd_per_million)
                if self.input_usd_per_million is not None and self.output_usd_per_million is not None
                else None
            )
            return {
                "spend_enforcement": "ledger" if self.enforce else "none",
                "approved_budget_usd": self.budget_usd,
                "reserved_upper_bound_usd": self.reserved_upper_bound_usd,
                "attributed_cost_usd": self.attributed_cost_usd,
                "unpriced_calls": sum(1 for entry in self.entries if entry["input_usd_per_million"] is None),
                "calls_attempted": self.calls_attempted,
                "calls_completed": self.calls_completed,
                "usage_complete": self.usage_complete,
                "client_num_retries": 0,
                "provider_invoice_verified": False,
                "budget_scope": "optimizer-student-and-reflection-lm-calls-only",
                "price_basis": basis(default_pair),
                "reflection_price_basis": basis(self.reflection_prices),
                "model_price_basis": (
                    {model: basis(pair) for model, pair in sorted(self.model_prices.items())}
                    if self.model_prices
                    else None
                ),
                "gateway_price_basis": (
                    {model: basis(pair, "understudy-gateway") for model, pair in sorted(self.gateway_prices.items())}
                    if self.gateway_prices
                    else None
                ),
                "gateway_price_lookup": self.price_lookup,
                "reservations_are_cumulative": False,
                "reservation_policy": "settle-completed-calls-to-billable-usage-bound",
                "admission_policy": "committed-plus-in-flight-within-phase-limit-throttle-before-refusing",
                "spend_governor": self._snapshot_locked(),
                "entries": [dict(entry) for entry in self.entries],
            }


def parse_model_prices(values: list[str] | None) -> dict[str, tuple[float, float]]:
    """Parse repeated MODEL=INPUT,OUTPUT flags (USD per million tokens)."""
    prices: dict[str, tuple[float, float]] = {}
    for value in values or []:
        model, separator, pair = value.partition("=")
        parts = pair.split(",")
        if not model.strip() or separator != "=" or len(parts) != 2:
            raise ValueError("--model-price must look like MODEL=INPUT,OUTPUT")
        input_price = non_negative_float(parts[0], "model price input")
        output_price = non_negative_float(parts[1], "model price output")
        if input_price == 0 and output_price == 0:
            raise ValueError("--model-price needs a non-zero input or output price")
        prices[str(normalize_price_key(model.strip()))] = (input_price, output_price)
    return prices


def parse_gateway_price(item: Mapping[str, Any]) -> tuple[float, float] | None:
    """Read a price pair from one gateway model entry.

    Accepted shapes (USD): pricing.{input,output}_usd_per_million, per-token
    pricing.{prompt,completion}, or top-level {input,output}_usd_per_million.
    """

    def number(value: Any) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return parsed if math.isfinite(parsed) and parsed >= 0 else None

    for source in (item.get("pricing"), item):
        if not isinstance(source, Mapping):
            continue
        input_price = number(source.get("input_usd_per_million"))
        output_price = number(source.get("output_usd_per_million"))
        if input_price is not None and output_price is not None and (input_price or output_price):
            return input_price, output_price
    pricing = item.get("pricing")
    if isinstance(pricing, Mapping):
        prompt = number(pricing.get("prompt"))
        completion = number(pricing.get("completion"))
        if prompt is not None and completion is not None and (prompt or completion):
            return prompt * 1_000_000, completion * 1_000_000
    return None


def gateway_routed_roles(routes: Mapping[str, Mapping[str, Any]], gateway_url: str | None) -> set[str]:
    """Roles whose bound route executes on the Understudy gateway.

    Gateway-published prices apply only to these; a bridge route to another
    provider keeps its flag or global price. The route id alone is not enough,
    since a bridge route may claim it with any base URL: the bound credential-free
    base URL must also be the gateway's.
    """
    if not gateway_url:
        return set()
    try:
        gateway_base_sha256 = text_sha256(credential_free_api_base(gateway_url, append_v1=True)[0])
    except ValueError:
        return set()
    return {
        role
        for role, route in routes.items()
        if route.get("route_id") == "understudy-gateway" and route.get("base_url_sha256") == gateway_base_sha256
    }


def fetch_gateway_prices(
    gateway_url: str,
    api_key: str,
    models: set[str],
    timeout: float = 10.0,
) -> tuple[dict[str, tuple[float, float]], dict[str, Any]]:
    """Read per-model prices from the gateway's model list, if it publishes any.

    Never raises: an unreachable or price-less gateway yields no prices. The
    request goes only to the configured Understudy gateway, without following
    redirects, so the key cannot be forwarded to another host. It is a model
    list read, not an inference call, and is never metered.
    """
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *redirect_args: Any, **redirect_kwargs: Any) -> None:
            return None

    try:
        base_url, _ = credential_free_api_base(gateway_url, append_v1=True)
        request = urllib.request.Request(
            f"{base_url}/models",
            headers={"authorization": f"Bearer {api_key}", "accept": "application/json"},
        )
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        return {}, {"status": "unavailable", "reason": type(error).__name__}
    items = payload.get("data") if isinstance(payload, Mapping) else payload
    if not isinstance(items, list):
        return {}, {"status": "unavailable", "reason": "unexpected-response-shape"}
    prices: dict[str, tuple[float, float]] = {}
    for item in items:
        if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
            continue
        pair = parse_gateway_price(item)
        key = normalize_price_key(item["id"])
        if pair is not None and key in models:
            prices[str(key)] = pair
    status = "ok" if prices else "no-prices-published"
    return prices, {"status": status, "models_listed": len(items), "models_priced": sorted(prices)}


class ReportableInputError(ValueError):
    """Invalid runtime input whose message names flags only, never row content or
    paths, so it is safe to report as the failure reason."""


class SplitError(ReportableInputError):
    """A train/dev/holdout split that would let holdout rows drive optimization."""


def is_holdout_split(value: Any) -> bool:
    return str(value).casefold() == "holdout"


def validate_split_names(train_split: str, dev_split: str) -> None:
    # Holdout rows are matched case-insensitively, train and dev rows exactly, so a
    # dev split named Holdout would optimize on the rows later reported as unseen.
    if is_holdout_split(train_split) or is_holdout_split(dev_split):
        raise SplitError("split-invalid: --train-split and --dev-split must not name the holdout split")
    if train_split == dev_split:
        raise SplitError("split-invalid: --train-split and --dev-split must differ")


def require_disjoint_holdout(holdout: list[Any], used: list[Any]) -> None:
    """Assert by row identity that no holdout row is a train or dev row."""
    used_ids = {id(row) for row in used}
    if any(id(row) in used_ids for row in holdout):
        raise SplitError("split-invalid: holdout rows overlap the train or dev rows")


def split_train_dev(rows: list[dict[str, Any]], split_key: str, train_split: str, dev_split: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    validate_split_names(train_split, dev_split)
    if any(split_key in row for row in rows):
        train = [row for row in rows if str(row.get(split_key)) == train_split]
        dev = [row for row in rows if str(row.get(split_key)) == dev_split]
        holdout_count = len([row for row in rows if is_holdout_split(row.get(split_key))])
    else:
        train = rows[:1]
        dev = rows[1:] or rows[:1]
        holdout_count = 0
    if not train:
        raise ValueError(f"no train rows found for {split_key}={train_split}")
    if not dev:
        raise ValueError(f"no dev rows found for {split_key}={dev_split}")
    return train, dev, holdout_count


def holdout_rows_for(rows: list[dict[str, Any]], split_key: str) -> list[dict[str, Any]]:
    if not any(split_key in row for row in rows):
        return []
    return [row for row in rows if is_holdout_split(row.get(split_key))]


MATCH_MODES = ("exact", "case-insensitive")
# GEPA 0.1.4 Pareto frontiers; all but instance need objective_scores from the metric.
FRONTIER_TYPES = ("instance", "objective", "hybrid", "cartesian")


def normalize_label(value: Any, match_mode: str) -> str:
    text = str(value).strip()
    if match_mode == "case-insensitive":
        return " ".join(text.split()).casefold()
    return text


def exact_match_feedback(output_keys: list[str], gold: Any, pred: Any, match_mode: str = "exact") -> Any:
    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    matches = []
    gaps = []
    for key in output_keys:
        expected = str(field_value(gold, key, "")).strip()
        actual = str(field_value(pred, key, "")).strip()
        ok = normalize_label(actual, match_mode) == normalize_label(expected, match_mode)
        matches.append(ok)
        if not ok:
            # Say so when the only difference is letter case, so the reflector fixes the
            # format directly instead of inventing decision rules to explain a casing miss.
            hint = " (differs only in letter case)" if actual.casefold() == expected.casefold() else ""
            gaps.append(f"{key}: expected {expected!r}, got {actual!r}{hint}")
    score = sum(1.0 for item in matches if item) / len(matches) if matches else 0.0
    feedback = "All output fields matched." if not gaps else "Output mismatches: " + "; ".join(gaps)
    return ScoreWithFeedback(score=score, feedback=feedback)


# A declarative multi-predictor program: one typed DSPy predictor per spec entry,
# scored per predictor, with the mean as the GEPA score. See
# docs/dspy-gepa-hill-climbing.md "Multi-predictor task specs".
TASK_SPEC_SCHEMA_VERSION = "understudy.dspy_gepa_task_spec.v1"
TASK_SPEC_KINDS = ("label", "label-set", "text")
TASK_SPEC_MODULES = ("predict", "cot")
TASK_SPEC_PREDICTOR_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
TASK_SPEC_FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
# dspy.Module members a predictor attribute must not shadow (rechecked against the
# installed dspy when the program is built), and the field ChainOfThought adds.
TASK_SPEC_RESERVED_NAMES = frozenset({
    "batch", "callbacks", "deepcopy", "dump_state", "forward", "get_lm", "history",
    "inspect_history", "load", "load_state", "map_named_predictors", "named_parameters",
    "named_predictors", "named_sub_modules", "parameters", "predictors", "reset_copy",
    "save", "set_lm",
})
# Field names (inputs and outputs) that fail late or read back wrong: the field
# ChainOfThought adds; dspy.Example/Prediction members, which attribute access
# returns instead of the value (rechecked against the installed dspy); names the
# Signature class or pydantic reject (plus any model_ prefix); and the keyword
# arguments Predict consumes instead of passing to the signature.
TASK_SPEC_RESERVED_FIELDS = frozenset({
    "reasoning",
    "completions", "copy", "from_completions", "get", "get_lm_usage", "inputs", "items",
    "keys", "labels", "set_lm_usage", "toDict", "values", "with_inputs", "without",
    "fields", "instructions", "model_config", "signature",
    "config", "demos", "lm", "new_signature", "prediction",
})


def task_spec_reserved_field(name: str) -> bool:
    return name in TASK_SPEC_RESERVED_FIELDS or name.startswith("model_")


def field_value(record: Any, key: str, default: Any = None) -> Any:
    """Read one field from a dspy.Example, Prediction, mapping, or namespace by key.

    getattr on an Example or Prediction returns the bound method for names such as
    labels or items rather than the stored value, so stores are read by key.
    """
    if isinstance(record, Mapping):
        return record.get(key, default)
    if callable(getattr(type(record), "__getitem__", None)):
        try:
            return record[key]
        except (KeyError, IndexError, TypeError):
            return default
    return getattr(record, key, default)
TASK_SPEC_MAX_PREDICTORS = 32
TASK_SPEC_MAX_LABELS = 256
TASK_SPEC_MAX_INSTRUCTIONS = 20000
# Feedback quotes labels in backticks, as the DSPy tutorial does; chr() keeps the
# character out of this TypeScript template literal.
BACKTICK = chr(96)


class TaskSpecError(ValueError):
    """An invalid task spec or gold value. Messages carry spec paths, predictor
    names and row indexes only, never row content, so they are safe to report."""


def validate_task_spec(raw: Any) -> dict[str, Any]:
    """Validate a parsed understudy.dspy_gepa_task_spec.v1 object and normalize it."""

    def bad(path: str, problem: str) -> TaskSpecError:
        return TaskSpecError(f"task-spec-invalid: {path} {problem}")

    if not isinstance(raw, dict):
        raise bad("spec", "must be a JSON object")
    unknown = sorted(set(raw) - {"schema_version", "description", "inputs", "module", "predictors"})
    if unknown:
        raise bad("spec", f"has unknown keys {unknown}")
    if raw.get("schema_version") != TASK_SPEC_SCHEMA_VERSION:
        raise bad("schema_version", f"must be {TASK_SPEC_SCHEMA_VERSION}")
    if "description" in raw and not isinstance(raw["description"], str):
        raise bad("description", "must be a string")
    inputs = raw.get("inputs")
    if (
        not isinstance(inputs, list)
        or not inputs
        or not all(isinstance(key, str) and TASK_SPEC_FIELD_NAME.match(key) for key in inputs)
        or len(set(inputs)) != len(inputs)
    ):
        raise bad("inputs", "must be a non-empty list of unique field names")
    if any(task_spec_reserved_field(key) for key in inputs):
        raise bad("inputs", "must not use a reserved field name")
    module = raw.get("module", "predict")
    if module not in TASK_SPEC_MODULES:
        raise bad("module", "must be predict or cot")
    predictors = raw.get("predictors")
    if not isinstance(predictors, list) or not predictors or len(predictors) > TASK_SPEC_MAX_PREDICTORS:
        raise bad("predictors", f"must be a list of 1 to {TASK_SPEC_MAX_PREDICTORS} predictors")
    names: set[str] = set()
    outputs: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(predictors):
        path = f"predictors[{index}]"
        if not isinstance(entry, dict):
            raise bad(path, "must be an object")
        unknown = sorted(set(entry) - {"name", "output", "instructions", "type"})
        if unknown:
            raise bad(path, f"has unknown keys {unknown}")
        name = entry.get("name")
        if not isinstance(name, str) or not TASK_SPEC_PREDICTOR_NAME.match(name):
            raise bad(f"{path}.name", "must match ^[a-z][a-z0-9_]{0,63}$")
        if name in TASK_SPEC_RESERVED_NAMES or name.startswith("_"):
            raise bad(f"{path}.name", "is reserved by dspy.Module")
        if name in names:
            raise bad(f"{path}.name", "repeats another predictor's name")
        names.add(name)
        output = entry.get("output", name)
        if not isinstance(output, str) or not TASK_SPEC_FIELD_NAME.match(output):
            raise bad(f"{path}.output", "must be a field name")
        if task_spec_reserved_field(output) or output in inputs:
            raise bad(f"{path}.output", "must not be reserved or an input")
        if output in outputs:
            raise bad(f"{path}.output", "repeats another predictor's output")
        outputs.add(output)
        instructions = entry.get("instructions")
        if instructions is not None and (
            not isinstance(instructions, str)
            or not instructions.strip()
            or len(instructions) > TASK_SPEC_MAX_INSTRUCTIONS
        ):
            raise bad(f"{path}.instructions", f"must be non-empty text of at most {TASK_SPEC_MAX_INSTRUCTIONS} characters")
        field_type = entry.get("type")
        if not isinstance(field_type, dict) or field_type.get("kind") not in TASK_SPEC_KINDS:
            raise bad(f"{path}.type.kind", "must be label, label-set, or text")
        kind = field_type["kind"]
        unknown = sorted(set(field_type) - {"kind", "labels"})
        if unknown:
            raise bad(f"{path}.type", f"has unknown keys {unknown}")
        normalized_type: dict[str, Any] = {"kind": kind}
        if kind == "text":
            if "labels" in field_type:
                raise bad(f"{path}.type.labels", "is not allowed for text")
        else:
            labels = field_type.get("labels")
            if (
                not isinstance(labels, list)
                or not labels
                or len(labels) > TASK_SPEC_MAX_LABELS
                or not all(isinstance(label, str) and label.strip() == label and label for label in labels)
                or len(set(labels)) != len(labels)
            ):
                raise bad(
                    f"{path}.type.labels",
                    f"must be 1 to {TASK_SPEC_MAX_LABELS} unique non-empty strings without surrounding whitespace",
                )
            if len({normalize_label(label, "case-insensitive") for label in labels}) != len(labels):
                raise bad(f"{path}.type.labels", "must stay unique when letter case is ignored")
            normalized_type["labels"] = list(labels)
        normalized.append({
            "name": name,
            "output": output,
            "instructions": instructions,
            "type": normalized_type,
        })
    return {
        "schema_version": TASK_SPEC_SCHEMA_VERSION,
        "inputs": list(inputs),
        "module": module,
        "predictors": normalized,
    }


def load_task_spec(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise TaskSpecError("task-spec-invalid: --task-spec must be a non-symlink regular file")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise TaskSpecError("task-spec-invalid: --task-spec must contain valid JSON") from None
    return validate_task_spec(raw)


def task_spec_gold(predictor: Mapping[str, Any], value: Any) -> Any:
    """Normalize one gold value: a label string, a label list in spec order, or text.

    A label-set accepts a list of labels or a {label: bool} object (the DSPy
    tutorial's format; absent labels are false). Raises ValueError with a reason
    that never quotes the value.
    """
    kind = predictor["type"]["kind"]
    if kind == "text":
        if not isinstance(value, str):
            raise ValueError("expected a string")
        return value
    labels = predictor["type"]["labels"]
    if kind == "label":
        if not isinstance(value, str):
            raise ValueError("expected a string label")
        if value not in labels:
            raise ValueError("label is not in the spec's label set")
        return value
    if isinstance(value, dict):
        if not all(isinstance(flag, bool) for flag in value.values()):
            raise ValueError("label-set object values must be true or false")
        chosen = [label for label, flag in value.items() if flag]
        named = list(value)
    elif isinstance(value, list):
        if not all(isinstance(label, str) for label in value):
            raise ValueError("label-set list must contain strings")
        if len(set(value)) != len(value):
            raise ValueError("label-set list repeats a label")
        chosen = named = list(value)
    else:
        raise ValueError("expected a list of labels or a {label: bool} object")
    if any(label not in labels for label in named):
        raise ValueError("label is not in the spec's label set")
    chosen_set = set(chosen)
    return [label for label in labels if label in chosen_set]


def validate_task_spec_rows(spec: Mapping[str, Any], rows: list[Any], used: list[Any]) -> None:
    """Check every used row against the spec before any provider call.

    Errors name the row's index in the samples file and the predictor, never content.
    """
    used_ids = {id(row) for row in used}
    for index, row in enumerate(rows):
        if id(row) not in used_ids:
            continue
        if not isinstance(row, dict):
            raise TaskSpecError(f"task-spec-row-invalid: sample row {index} is not an object")
        for key in spec["inputs"]:
            if key not in row:
                raise TaskSpecError(f"task-spec-row-invalid: sample row {index} is missing input {key}")
        for predictor in spec["predictors"]:
            output = predictor["output"]
            if output not in row:
                raise TaskSpecError(
                    f"task-spec-gold-invalid: sample row {index} has no gold {output} for predictor {predictor['name']}"
                )
            try:
                task_spec_gold(predictor, row[output])
            except ValueError as error:
                raise TaskSpecError(
                    f"task-spec-gold-invalid: sample row {index}, predictor {predictor['name']}: {error}"
                ) from None


def task_spec_output_type(predictor: Mapping[str, Any]) -> Any:
    """label -> Literal[...], label-set -> list[Literal[...]], text -> str."""
    from typing import Literal

    kind = predictor["type"]["kind"]
    if kind == "text":
        return str
    literal = Literal[tuple(predictor["type"]["labels"])]  # type: ignore[valid-type]
    return list[literal] if kind == "label-set" else literal  # type: ignore[valid-type]


def task_spec_signature(dspy: Any, spec: Mapping[str, Any], predictor: Mapping[str, Any]) -> Any:
    fields: dict[str, Any] = {key: (str, dspy.InputField()) for key in spec["inputs"]}
    fields[predictor["output"]] = (task_spec_output_type(predictor), dspy.OutputField())
    if predictor.get("instructions"):
        return dspy.Signature(fields, predictor["instructions"])
    return dspy.Signature(fields)


def build_task_spec_program(dspy: Any, spec: Mapping[str, Any]) -> Any:
    """One dspy.Predict or dspy.ChainOfThought per predictor, as attributes named
    after the predictors, so DSPy names them "<name>" or "<name>.predict"."""
    from dspy.utils.exceptions import AdapterParseError

    module_type = dspy.ChainOfThought if spec["module"] == "cot" else dspy.Predict
    predictors = [dict(predictor) for predictor in spec["predictors"]]
    input_keys = list(spec["inputs"])
    members = {
        name
        for record_type in (dspy.Example, dspy.Prediction)
        for name in dir(record_type)
        if not name.startswith("_")
    }
    for key in [*input_keys, *(predictor["output"] for predictor in predictors)]:
        if key in members:
            raise TaskSpecError(f"task-spec-invalid: field name {key} is a dspy.Example or dspy.Prediction member")

    class TaskSpecProgram(dspy.Module):
        def __init__(self) -> None:
            super().__init__()
            for predictor in predictors:
                if hasattr(self, predictor["name"]):
                    raise TaskSpecError(f"task-spec-invalid: predictor name {predictor['name']} is reserved by dspy.Module")
                setattr(self, predictor["name"], module_type(task_spec_signature(dspy, spec, predictor)))

        def forward(self, **inputs: Any) -> Any:
            values = {key: inputs[key] for key in input_keys}
            outputs = {}
            for predictor in predictors:
                module = getattr(self, predictor["name"])
                try:
                    result = module(**values)
                except AdapterParseError as error:
                    # One predictor's unparseable answer (a label outside the
                    # Literal, say) scores 0 for that predictor instead of failing
                    # the row: a failed row reports no objective_scores, and GEPA's
                    # objective frontiers average only the rows that report them.
                    # Spend stops reach here as LM errors, never as parse errors.
                    if spend_cause(error) is not None:
                        raise
                    outputs[predictor["output"]] = None
                    self._trace_parse_failure(module, values, predictor["output"], error)
                    continue
                outputs[predictor["output"]] = field_value(result, predictor["output"])
            return dspy.Prediction(**outputs)

        @staticmethod
        def _trace_parse_failure(module: Any, values: Mapping[str, Any], output: str, error: Any) -> None:
            # Predict records nothing when it raises, so GEPA would find no trace
            # for this predictor and could not reflect on its format failures.
            # Record the raw response the way Predict records a parsed one.
            trace = dspy.settings.trace
            if trace is None or dspy.settings.max_trace_size <= 0:
                return
            inner = module.predictors()[0]
            if len(trace) >= dspy.settings.max_trace_size:
                trace.pop(0)
            trace.append((inner, dict(values), dspy.Prediction(**{output: getattr(error, "lm_response", None)})))

    return TaskSpecProgram()


def task_spec_predictor_routing(program: Any, spec: Mapping[str, Any]) -> dict[str, str]:
    """Map each DSPy predictor name (what GEPA passes as pred_name) to its spec name."""
    names = [predictor["name"] for predictor in spec["predictors"]]
    routing: dict[str, str] = {}
    for dspy_name, _ in program.named_predictors():
        head = str(dspy_name).split(".", 1)[0]
        if head not in names or head in routing.values():
            raise TaskSpecError("task-spec-invalid: unexpected DSPy predictor layout")
        routing[str(dspy_name)] = head
    if sorted(routing.values()) != sorted(names):
        raise TaskSpecError("task-spec-invalid: unexpected DSPy predictor layout")
    return routing


def task_spec_subject(spec: Mapping[str, Any]) -> str:
    return spec["inputs"][0] if len(spec["inputs"]) == 1 else "input"


def quoted(value: Any) -> str:
    return f"{BACKTICK}{value}{BACKTICK}"


def task_spec_component(
    predictor: Mapping[str, Any],
    gold: Any,
    predicted: Any,
    match_mode: str,
    subject: str,
) -> tuple[float, str]:
    """Score one predictor's output and explain it in the DSPy tutorial's style.

    None means the predictor's answer could not be parsed (TaskSpecProgram turns
    DSPy's AdapterParseError into None), which scores 0 with format feedback, as
    the DSPy AIME tutorial's metric does for an answer that is not an integer.
    """
    output = predictor["output"]
    kind = predictor["type"]["kind"]
    if predicted is None:
        if kind == "text":
            return 0.0, (
                f"Your {output} answer could not be parsed from your response. "
                f"The expected {output} is {quoted(gold)}. Reply with the {output} field in the required format."
            )
        labels = predictor["type"]["labels"]
        expected = quoted(repr(list(gold or []))) if kind == "label-set" else quoted(gold)
        shape = "a list of the allowed labels" if kind == "label-set" else "one of the allowed labels"
        return 0.0, (
            f"Your {output} answer could not be parsed as {shape}: {quoted(repr(labels))}. "
            f"The correct {output} is {expected}. Answer with labels copied exactly as listed, "
            "with the same letter case and spelling, and nothing else."
        )
    if kind == "label-set":
        labels = predictor["type"]["labels"]
        def norm(value: Any) -> str:
            return normalize_label(value, match_mode)
        if isinstance(predicted, (list, tuple, set)):
            values = list(predicted)
        else:
            values = [] if predicted is None or predicted == "" else [predicted]
        predicted_set = {norm(value) for value in values}
        gold_set = {norm(label) for label in gold or []}
        known = {norm(label) for label in labels}
        hit = [label for label in labels if norm(label) in gold_set and norm(label) in predicted_set]
        wrong = [label for label in labels if norm(label) not in gold_set and norm(label) in predicted_set]
        missed = [label for label in labels if norm(label) in gold_set and norm(label) not in predicted_set]
        outside = sorted(str(value).strip() for value in values if norm(value) not in known)
        # Per-label agreement over the spec's label set, as the tutorial scores it.
        score = (len(labels) - len(wrong) - len(missed)) / len(labels)
        if score == 1.0 and not outside:
            return score, (
                f"The {output} classification is perfect. You correctly identified that the {subject} "
                f"falls under the following {output}: {quoted(repr(hit))}."
            )
        text = (
            f"The {output} classification is not perfect. You correctly identified that the {subject} "
            f"falls under the following {output}: {quoted(repr(hit))}.\n"
        )
        if wrong:
            text += (
                f"However, you incorrectly identified that the {subject} falls under the following "
                f"{output}: {quoted(repr(wrong))}. The {subject} DOES NOT fall under these {output}.\n"
            )
        if missed:
            lead = "Additionally, you" if wrong else "However, you"
            text += (
                f"{lead} didn't identify the following {output} that the {subject} actually falls "
                f"under: {quoted(repr(missed))}.\n"
            )
        if outside:
            text += f"These values are not valid {output} labels: {quoted(repr(outside))}.\n"
        text += f"Think about how you could have reasoned to get the correct {output} labels."
        return score, text
    expected = str(gold)
    actual = "" if predicted is None else str(predicted).strip()
    if normalize_label(actual, match_mode) == normalize_label(expected, match_mode):
        if kind == "label":
            return 1.0, (
                f"You correctly classified the {output} of the {subject} as {quoted(expected)}. "
                f"This {subject} is indeed of {quoted(expected)} {output}."
            )
        return 1.0, f"Your {output} matches the expected {output}."
    hint = " It differs only in letter case." if actual.casefold() == expected.casefold() else ""
    if kind == "label":
        return 0.0, (
            f"You incorrectly classified the {output} of the {subject} as {quoted(actual)}. "
            f"The correct {output} is {quoted(expected)}.{hint} "
            f"Think about how you could have reasoned to get the correct {output} label."
        )
    return 0.0, (
        f"Your {output} was {quoted(actual)}, but the expected {output} is {quoted(expected)}.{hint}"
    )


def task_spec_components(
    spec: Mapping[str, Any], gold: Any, prediction: Any, match_mode: str,
) -> dict[str, tuple[float, str]]:
    subject = task_spec_subject(spec)
    return {
        predictor["name"]: task_spec_component(
            predictor,
            field_value(gold, predictor["output"]),
            field_value(prediction, predictor["output"]),
            match_mode,
            subject,
        )
        for predictor in spec["predictors"]
    }


def task_spec_feedback(
    spec: Mapping[str, Any],
    routing: Mapping[str, str],
    gold: Any,
    prediction: Any,
    match_mode: str,
    pred_name: str | None = None,
) -> Any:
    """GEPA metric result: the mean of the predictor scores, per-predictor
    objective_scores, and feedback for the predictor GEPA is updating.

    At pred_name=None (plain scoring) the feedback covers every predictor.
    """
    from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

    parts = task_spec_components(spec, gold, prediction, match_mode)
    total = sum(score for score, _ in parts.values()) / len(parts)
    objective_scores = {name: score for name, (score, _) in parts.items()}
    target = None
    if pred_name is not None:
        target = routing.get(pred_name) or str(pred_name).split(".", 1)[0]
    if target in parts:
        feedback = parts[target][1]
    else:
        feedback = "\n".join(f"{name}: {text}" for name, (_, text) in parts.items())
    return ScoreWithFeedback(score=total, feedback=feedback, objective_scores=objective_scores)


def task_spec_predicted(spec: Mapping[str, Any], prediction: Any) -> dict[str, Any]:
    """JSON-safe predicted outputs for the holdout artifact."""
    predicted: dict[str, Any] = {}
    for predictor in spec["predictors"]:
        value = field_value(prediction, predictor["output"])
        if predictor["type"]["kind"] == "label-set":
            values = value if isinstance(value, (list, tuple, set)) else ([] if value is None else [value])
            predicted[predictor["output"]] = sorted(str(item).strip() for item in values)
        else:
            predicted[predictor["output"]] = "" if value is None else str(value).strip()
    return predicted


def dspy_run_dir(args: argparse.Namespace) -> Path:
    return Path(args.repo) / ".understudy" / "optimize-workload" / "dspy-gepa"


def dspy_run_state_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "run-state.json"


def dspy_events_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "events.jsonl"


def dspy_best_so_far_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "best-so-far.json"


def dspy_stop_file_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "STOP"


def dspy_holdout_evaluation_path(args: argparse.Namespace) -> Path:
    return dspy_run_dir(args) / "holdout-evaluation.json"


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
        "events_path": dspy_events_path(args),
        "best_so_far_path": dspy_best_so_far_path(args),
        "holdout_evaluation_path": dspy_holdout_evaluation_path(args),
    }
    # These fixed paths may hold an earlier run's file; list them only once this
    # run has cleared or written them.
    owned = getattr(args, "owned_artifacts", set())
    return {
        name: artifact_path(repo, path)
        for name, path in paths.items()
        if (path.exists() and (name not in {"best_so_far_path", "holdout_evaluation_path"} or name in owned))
        or name in {"package_state_path", "config_path", "run_state_path"}
    }


def write_dspy_run_state(
    args: argparse.Namespace,
    ledger: SpendLedger,
    status: str,
    reason: str | None,
    extra: Mapping[str, Any] | None = None,
    phase: str | None = None,
) -> None:
    evidence = ledger.evidence()
    payload = {
        "schema_version": "understudy.dspy_gepa_run_state.v2",
        "status": status,
        "phase": phase,
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
    write_dspy_run_state(args, ledger, status, reason, phase=getattr(args, "phase", None))
    evidence = ledger.evidence()
    events = getattr(args, "events", None)
    if events is not None:
        events.emit(
            "run-failed",
            status=status,
            reason=reason,
            phase=getattr(args, "phase", None),
            calls_completed=evidence["calls_completed"],
            attributed_cost_usd=evidence["attributed_cost_usd"],
        )
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


def litellm_version_in_bounds(version: str) -> bool:
    match = re.match(r"^(\d+)\.(\d+)", version)
    if match is None:
        return False
    parsed = (int(match.group(1)), int(match.group(2)))
    return LITELLM_MIN_VERSION <= parsed and parsed[0] < LITELLM_MAX_MAJOR_EXCLUSIVE


def require_exact_optimizer_packages(
    workload_package_pins: Mapping[str, Any] | None = None,
    project_state: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        actual = {
            "dspy": importlib.metadata.version("dspy"),
            "gepa": importlib.metadata.version("gepa"),
            "cloudpickle": importlib.metadata.version("cloudpickle"),
        }
        litellm_version = importlib.metadata.version("litellm")
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimePackageVersionError("runtime-package-version-mismatch") from error
    if actual != {
        "dspy": DSPY_VERSION,
        "gepa": GEPA_VERSION,
        "cloudpickle": CLOUDPICKLE_VERSION,
    }:
        raise RuntimePackageVersionError("runtime-package-version-mismatch")
    if not litellm_version_in_bounds(litellm_version):
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
        "requested": [DSPY_PACKAGE_SPEC, GEPA_PACKAGE_SPEC, CLOUDPICKLE_PACKAGE_SPEC],
        "actual": actual,
        "bounded": {
            "litellm": {"requested": LITELLM_PACKAGE_SPEC, "actual": litellm_version},
        },
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
    required_max_tokens: int | None = None,
    max_tokens_reason: str = "context-window-gate-max-tokens-below-run-cap",
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
    # The gate proves the prompt fits with max_tokens of output room; a smaller
    # value than the run's bound output cap for that role proves nothing.
    if required_max_tokens is not None and numeric["max_tokens"] < required_max_tokens:
        raise WorkloadAdmissionError(max_tokens_reason)
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
    if not is_sha256(validation.get("loaded_bundle_sha256")):
        raise WorkloadAdmissionError("bundle-validation-requires-loaded-endpoint-bundle-sha256")
    if (
        not isinstance(validation.get("loaded_bundle_schema_version"), str)
        or not validation.get("loaded_bundle_schema_version")
    ):
        raise WorkloadAdmissionError("bundle-validation-requires-loaded-endpoint-bundle-schema")
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
    if not is_sha256(bridge_config.get("endpoint_bundle_sha256")):
        raise WorkloadAdmissionError("bridge-config-requires-endpoint-bundle-sha256")
    if validation.get("loaded_bundle_sha256") != bridge_config.get("endpoint_bundle_sha256"):
        raise WorkloadAdmissionError("loaded-endpoint-bundle-sha256-mismatch")
    endpoint_schema = bridge_config.get("endpoint_bundle_schema_version")
    if not isinstance(endpoint_schema, str) or not endpoint_schema:
        raise WorkloadAdmissionError("bridge-config-requires-endpoint-bundle-schema")
    if validation.get("loaded_bundle_schema_version") != endpoint_schema:
        raise WorkloadAdmissionError("loaded-endpoint-bundle-schema-mismatch")
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
        required_max_tokens=int(config["inference"]["max_tokens"]),
        max_tokens_reason="source-context-window-gate-max-tokens-below-student-cap",
    )
    validate_context_window_gate(
        validation.get("reflection_context_window_gate"),
        prompt_hash_field="reflection_prompt_sha256",
        prompt_tokens_field="reflection_prompt_tokens",
        context_limit_field="reflection_context_limit",
        overflow_reason="reflection-renderer-context-window-overflow",
        required_max_tokens=int(config["inference"]["reflection_max_tokens"]),
        max_tokens_reason="reflection-context-window-gate-max-tokens-below-reflection-cap",
    )
    runtime_routes = config.get("inference", {}).get("routes")
    if not isinstance(runtime_routes, Mapping):
        raise WorkloadAdmissionError("runtime-route-bindings-missing")
    for role, gate_name in (
        ("student", "context_window_gate"),
        ("reflection", "reflection_context_window_gate"),
    ):
        route_receipt = runtime_routes.get(role)
        gate = validation.get(gate_name)
        gate_route = gate.get("route") if isinstance(gate, Mapping) else None
        if (
            not isinstance(route_receipt, Mapping)
            or not isinstance(gate_route, Mapping)
            or gate_route.get("id") != route_receipt.get("route_id")
            or gate_route.get("sha256") != route_receipt.get("route_binding_sha256")
        ):
            raise WorkloadAdmissionError(f"{role}-route-binding-mismatch")
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
    expected_bundle_sha = offline_admission["bundle_validation"]["loaded_bundle_sha256"]
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
        "route_bindings": export_context["config"]["inference"]["routes"],
    }
    manifest_path = run_dir / "bundle-manifest.json"
    write_owner_only_json(manifest_path, manifest)
    return manifest


def new_provider_engine(api_key: str, api_base: str) -> Any:
    from dspy.clients.engines import LiteLLMEngine

    return LiteLLMEngine(api_key=api_key, api_base=api_base)


class MeteredEngine:
    """Reserve spend before and record usage after every provider call.

    DSPy 3.4 deprecates BaseLM.forward() overrides and 3.5 removes them; the
    engine contract (complete(Request) -> Response) is the supported seam, and
    every DSPy LM call path crosses it. The cap fails closed: a call without a
    numeric output ceiling, or whose response lacks usage, raises. Copies made
    by DSPy share this engine, so they also share the one ledger. There is no
    async counterpart, so an async call fails instead of running unmetered.
    """

    def __init__(
        self,
        inner: Any,
        spend_ledger: SpendLedger,
        role: str,
        route_receipt: Mapping[str, Any],
    ) -> None:
        self._inner = inner
        self._spend_ledger = spend_ledger
        self._role = role
        self._route_receipt = dict(route_receipt)

    def __deepcopy__(self, memo: dict[int, Any]) -> MeteredEngine:
        return self

    def _output_token_ceiling(self, request: Any) -> int:
        config = getattr(request, "config", None)
        extensions = getattr(config, "extensions", None) or {}
        value = (
            getattr(config, "max_tokens", None)
            or extensions.get("max_tokens")
            or extensions.get("max_completion_tokens")
        )
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            if not self._spend_ledger.enforce:
                return 0  # observe-only: no cap to size, so a missing ceiling is not an error
            raise ValueError("LM call is missing a numeric output-token ceiling")
        parsed = int(value)
        if parsed <= 0 or parsed != value:
            raise ValueError("LM output-token ceiling must be a positive integer")
        return parsed

    def complete(self, request: Any) -> Any:
        # repr() of the canonical request covers messages, system text, tools
        # and config, and over-counts bytes versus the wire payload, which keeps
        # the input-side reservation an upper bound.
        message_bytes = len(repr(request).encode("utf-8"))
        message_count = len(getattr(request, "messages", None) or []) + 1
        call_id = self._spend_ledger.reserve(
            input_token_ceiling_from_bytes(message_bytes, message_count),
            self._output_token_ceiling(request),
            {
                "role": self._role,
                "route_id": self._route_receipt["route_id"],
                "route_binding_sha256": self._route_receipt["route_binding_sha256"],
                "requested_model": self._route_receipt["requested_model"],
                "executed_model": self._route_receipt["executed_model"],
                "dspy_model": self._route_receipt["dspy_model"],
                "base_url_sha256": self._route_receipt["base_url_sha256"],
                "base_host_sha256": self._route_receipt["base_host_sha256"],
            },
        )
        try:
            response = self._inner.complete(request)
        except BaseException:
            self._spend_ledger.mark_error(call_id)
            raise
        self._spend_ledger.complete(call_id, response)
        return response

    def stream(self, request: Any) -> Any:
        raise RuntimeError("streaming is not metered by the spend ledger")

    def close(self) -> None:
        close = getattr(self._inner, "close", None)
        if callable(close):
            close()


def spend_cause(error: BaseException) -> SpendBudgetExceeded | SpendEvidenceError | None:
    """DSPy wraps exceptions raised inside an engine (LMUnexpectedError); find ours in the chain."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        if isinstance(current, (SpendBudgetExceeded, SpendEvidenceError)):
            return current
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return None


def load_seed_instructions(path: Path) -> dict[str, str]:
    """Read warm-start instructions from a previous run's artifact or a plain text file.

    Accepts best-so-far.json ({"instructions": {...}}), candidate.json
    ({"optimized_instructions": {...}}), a {predictor: text} object, or plain text
    (applied to every predictor).
    """
    text = path.read_text(encoding="utf-8")
    try:
        payload = json.loads(text)
    except ValueError:
        return {"*": text.strip()} if text.strip() else {}
    if isinstance(payload, dict):
        for key in ("instructions", "optimized_instructions"):
            if isinstance(payload.get(key), dict):
                payload = payload[key]
                break
        if payload and all(isinstance(key, str) and isinstance(value, str) for key, value in payload.items()):
            return dict(payload)
    raise ValueError(f"{path.name} does not contain instructions to seed from")


def apply_instructions(
    program: Any,
    instructions: Mapping[str, str],
    aliases: Mapping[str, str] | None = None,
) -> None:
    """Set predictor instructions keyed by DSPy predictor name, a task-spec
    predictor name (via aliases), or "*" for every predictor."""
    named = dict(program.named_predictors())
    aliases = aliases or {}
    instructions = {aliases.get(key, key): text for key, text in instructions.items()}
    unknown = sorted(set(instructions) - set(named) - {"*"})
    if unknown:
        raise ValueError(f"seed instructions name unknown predictors {unknown}; this program has {sorted(named)}")
    for name, predictor in named.items():
        text = instructions.get(name) or instructions.get("*")
        if not text:
            continue
        signature = predictor.signature
        setter = getattr(signature, "with_instructions", None)
        if callable(setter):
            predictor.signature = setter(text)
        else:
            signature.instructions = text


def require_positive_int(value: Any, label: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise ValueError(f"{label} must be at least 1")
    return parsed


def proposer_skill_path(value: str) -> Path:
    path = Path(value).resolve()
    if path.is_dir():
        skill = path / "SKILL.md"
        if not skill.is_file() or skill.is_symlink():
            raise ValueError("--proposer-skill directory must contain a regular SKILL.md")
        return path
    if not path.is_file() or path.is_symlink():
        raise ValueError("--proposer-skill path does not exist or is not a regular file")
    return path


def optional_positive_float(value: Any, label: str) -> float | None:
    if value is None:
        return None
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError(f"{label} must be a positive number")
    return parsed


def validate_search_options(args: argparse.Namespace) -> None:
    """Parse search settings in place and reject bad or bridge-incompatible ones before any call."""
    args.rounds = require_positive_int(args.rounds, "--rounds")
    args.proposals_per_iteration = require_positive_int(args.proposals_per_iteration, "--proposals-per-iteration")
    if args.stop_after_stale is not None:
        args.stop_after_stale = require_positive_int(args.stop_after_stale, "--stop-after-stale")
    if args.proposer_max_chars is not None:
        args.proposer_max_chars = require_positive_int(args.proposer_max_chars, "--proposer-max-chars")
    args.stop_at_score = optional_positive_float(args.stop_at_score, "--stop-at-score")
    args.max_minutes = optional_positive_float(args.max_minutes, "--max-minutes")
    args.min_round_gain = float(args.min_round_gain)
    if not math.isfinite(args.min_round_gain) or args.min_round_gain < 0:
        raise ValueError("--min-round-gain must be a non-negative number")
    if args.match_mode not in MATCH_MODES:
        raise ValueError("--match-mode must be exact or case-insensitive")
    for skill in args.proposer_skill or []:
        proposer_skill_path(skill)
    if args.seed_instructions:
        seed = Path(args.seed_instructions)
        if not seed.is_file() or seed.is_symlink():
            raise ValueError("--seed-instructions file does not exist")
        # The seed is bound by content hash, and this run rewrites best-so-far.json,
        # candidate.json and everything else under its artifact and log dirs, so a
        # seed read from there would stop the identical command from resuming.
        resolved_seed = seed.resolve()
        for owned in (dspy_run_dir(args).parent, Path(args.log_dir)):
            if resolved_seed.is_relative_to(owned.resolve()):
                raise ReportableInputError(
                    "seed-instructions-inside-run-artifacts: copy the seed file out of "
                    ".understudy/optimize-workload and the --log-dir before seeding from it"
                )
    if args.frontier_type not in FRONTIER_TYPES:
        raise ValueError("--frontier-type must be instance, objective, hybrid, or cartesian")
    validate_split_names(args.train_split, args.dev_split)
    args.task_spec_data = None
    if args.task_spec:
        if args.program_bridge:
            raise ValueError("--task-spec is not supported with --program-bridge")
        if split_keys(args.input_keys or "") or split_keys(args.output_keys or ""):
            raise ValueError("--task-spec defines the input and output keys; drop --input-keys and --output-keys")
        args.task_spec_data = load_task_spec(Path(args.task_spec))
        if args.module is not None and args.module != args.task_spec_data["module"]:
            raise TaskSpecError("task-spec-invalid: --module differs from the spec's module")
        args.module = args.task_spec_data["module"]
        args.input_keys = ",".join(args.task_spec_data["inputs"])
        args.output_keys = ",".join(predictor["output"] for predictor in args.task_spec_data["predictors"])
    elif args.frontier_type != "instance":
        # Objective frontiers need per-objective scores, which only spec metrics return.
        raise ValueError("--frontier-type objective, hybrid, and cartesian need --task-spec")
    if args.module is None:
        args.module = "predict"
    if args.program_bridge:
        # A bridge owns its seed program, metric and holdout. These flags act on
        # the built-in signature scaffold only.
        for flag, used in (
            ("--seed-instructions", bool(args.seed_instructions)),
            ("--evaluate-holdout", bool(args.evaluate_holdout)),
            ("--match-mode", args.match_mode != "exact"),
            ("--no-spend-ledger", bool(args.no_spend_ledger)),
        ):
            if used:
                raise ValueError(f"{flag} is not supported with --program-bridge")


def search_settings(args: argparse.Namespace, repo: Path) -> dict[str, Any]:
    """Hash-bound climb and search settings; file inputs are bound by content hash."""
    seed_path = Path(args.seed_instructions).resolve() if args.seed_instructions else None
    skills = [proposer_skill_path(skill) for skill in args.proposer_skill or []]
    return {
        "rounds": int(args.rounds),
        "min_round_gain": float(args.min_round_gain),
        "proposals_per_iteration": int(args.proposals_per_iteration),
        "stop_after_stale": int(args.stop_after_stale) if args.stop_after_stale is not None else None,
        "stop_at_score": float(args.stop_at_score) if args.stop_at_score is not None else None,
        "max_minutes": float(args.max_minutes) if args.max_minutes is not None else None,
        "proposer_skills": [
            {
                "logical_path": logical_path(repo, skill),
                "sha256": file_sha256(skill / "SKILL.md" if skill.is_dir() else skill),
            }
            for skill in skills
        ],
        "proposer_note": args.proposer_note,
        "proposer_max_chars": int(args.proposer_max_chars) if args.proposer_max_chars is not None else None,
        "seed_instructions": (
            {"logical_path": logical_path(repo, seed_path), "sha256": file_sha256(seed_path)}
            if seed_path is not None
            else None
        ),
        "match_mode": args.match_mode,
        "component_selector": args.component_selector,
        "frontier_type": args.frontier_type,
        "stop_file": artifact_path(repo, dspy_stop_file_path(args)),
    }


class SpendStopper:
    """GEPA stop callback that ends optimization before it reaches the phase limit.

    GEPA 0.1.4 calls stoppers between iterations with its state, whose
    total_num_evals is the round's metric-call count. Each call records the
    committed spend since the previous one (one iteration; the first sample also
    covers the seed evaluation) and stops the round when the optimization phase
    is already exhausted, or when spend so far (committed plus in flight) plus
    1.5x the largest of the recent iteration costs plus one worst-case call
    reservation would cross the phase limit. Iteration costs use committed spend,
    which never decreases, so a call still in flight at one check counts in the
    iteration it settles in and no iteration cost is negative. Stopping before
    calls are refused matters: GEPA scores a refused rollout as a miss. It also
    emits the per-iteration spend-rate telemetry and a one-time projection
    warning. One instance serves every round of a run.
    """

    def __init__(
        self,
        ledger: SpendLedger,
        events: RunEvents,
        max_metric_calls: int,
        rounds: int,
    ) -> None:
        self._ledger = ledger
        self._events = events
        self._max_metric_calls = int(max_metric_calls)
        self._rounds = int(rounds)
        self._round = 0
        self._history: list[float] = []
        self._iterations = 0
        self._last_committed = ledger.spend_snapshot()["committed_usd"]
        self._round_start_committed = self._last_committed
        self._round_first: tuple[int, float] | None = None
        self._calls_in_round = 0
        self._warned = False
        self.fired: dict[str, Any] | None = None
        self.fired_round: int | None = None

    def describe(self) -> list[Any]:
        return ["SpendStopper"]

    def start_round(self, round_index: int) -> None:
        self._round = int(round_index)
        self._round_first = None
        self._round_start_committed = self._ledger.spend_snapshot()["committed_usd"]
        self._calls_in_round = 0

    def fired_in_round(self, round_index: int) -> bool:
        return self.fired_round == round_index

    def __call__(self, gepa_state: Any) -> bool:
        try:
            return self._check(gepa_state)
        except Exception:
            # A telemetry failure must never stop or break a run on its own.
            return self._ledger.phase_exhausted is not None

    def _check(self, gepa_state: Any) -> bool:
        if self.fired is not None and self.fired_round == self._round:
            return True
        snap = self._ledger.spend_snapshot()
        # Between iterations nothing should be in flight, but a straggler can
        # be: the stop check counts its full reservation (spent), while the
        # iteration cost uses committed spend, which only grows.
        spent = float(snap["reserved_upper_bound_usd"])
        committed = float(snap["committed_usd"])
        delta = max(0.0, committed - self._last_committed)
        self._last_committed = max(self._last_committed, committed)
        calls_in_round = self._calls_in_round + 1
        self._calls_in_round = calls_in_round
        if calls_in_round > 1:
            self._iterations += 1
        self._history.append(delta)
        recent = self._history[-SPEND_STOP_RECENT_ITERATIONS:]
        expected_next = max(recent) if recent else 0.0
        evals_raw = getattr(gepa_state, "total_num_evals", None)
        evals = int(evals_raw) if isinstance(evals_raw, (int, float)) and not isinstance(evals_raw, bool) else None
        usd_per_eval: float | None = None
        if evals is not None:
            if self._round_first is None:
                self._round_first = (evals, committed)
                if evals > 0:
                    usd_per_eval = max(0.0, committed - self._round_start_committed) / evals
            elif evals > self._round_first[0]:
                usd_per_eval = max(0.0, committed - self._round_first[1]) / (evals - self._round_first[0])
            if usd_per_eval is None and self._ledger.latest_projection:
                usd_per_eval = self._ledger.latest_projection.get("usd_per_metric_call")
        remaining_evals = (
            max(0, self._max_metric_calls - evals) + self._max_metric_calls * max(0, self._rounds - self._round)
            if evals is not None
            else None
        )
        projected = (
            spent + remaining_evals * usd_per_eval
            if remaining_evals is not None and usd_per_eval is not None
            else None
        )
        phase_limit = snap["phase_limit_usd"]
        rate = snap["recent_rate_usd_per_min"] or snap["rate_usd_per_min"]
        minutes_to_limit = (
            max(0.0, float(phase_limit) - spent) / rate
            if isinstance(phase_limit, (int, float)) and rate and rate > 0
            else None
        )
        projection = {
            "round": self._round,
            "iteration": calls_in_round - 1,
            "metric_calls": evals,
            "metric_call_budget": self._max_metric_calls,
            "rounds": self._rounds,
            "iteration_cost_usd": delta,
            "expected_next_iteration_usd": expected_next,
            "usd_per_metric_call": usd_per_eval,
            "projected_usd": projected,
            "projected_minutes_to_phase_limit": round(minutes_to_limit, 2) if minutes_to_limit is not None else None,
        }
        self._ledger.latest_projection = projection
        self._events.emit("spend-rate", **{
            key: snap[key]
            for key in (
                "phase", "committed_usd", "inflight_reserved_usd", "attributed_cost_usd", "rate_usd_per_min",
                "recent_rate_usd_per_min", "phase_limit_usd", "holdout_reserve_usd", "approved_budget_usd",
            )
        }, **projection)
        if (
            not self._warned
            and self._iterations >= SPEND_PROJECTION_WARNING_AFTER_ITERATIONS
            and projected is not None
            and isinstance(phase_limit, (int, float))
            and projected > phase_limit
        ):
            self._warned = True
            self._events.emit(
                "spend-projection-warning",
                projected_usd=projected,
                phase_limit_usd=phase_limit,
                approved_budget_usd=snap["approved_budget_usd"],
                committed_usd=snap["committed_usd"],
                round=self._round,
                metric_calls=evals,
            )
        if not self._ledger.enforce or not isinstance(phase_limit, (int, float)):
            return False
        reason: str | None = None
        headroom = float(snap["max_call_reserved_usd"])
        if snap["phase_exhausted"] is not None:
            reason = "optimization-phase-limit-reached"
        elif spent + SPEND_STOP_ITERATION_MARGIN * expected_next + headroom > float(phase_limit) + 1e-12:
            reason = "next-iteration-would-cross-phase-limit"
        if reason is None:
            return False
        self.fired = {
            "reason": reason,
            "round": self._round,
            "metric_calls": evals,
            "committed_usd": snap["committed_usd"],
            "reserved_upper_bound_usd": spent,
            "phase_limit_usd": phase_limit,
            "holdout_reserve_usd": snap["holdout_reserve_usd"],
            "approved_budget_usd": snap["approved_budget_usd"],
            "expected_next_iteration_usd": expected_next,
            "call_reservation_headroom_usd": headroom,
        }
        self.fired_round = self._round
        self._events.emit("budget-stop", **self.fired)
        return True


# DSPy's ParallelExecutor raises this bare Exception, without a cause, once a
# batch's errors reach max_errors.
DSPY_CANCELLED_EXECUTION_MESSAGE = "Execution cancelled due to errors or interruption."


def optimization_phase_stop(error: BaseException, ledger: SpendLedger) -> bool:
    """An error raised because the optimization phase limit refused a call.

    True only when the phase is exhausted without a run-wide failure and the
    refusal is in the exception chain (DSPy keeps it as the cause of the
    LMUnexpectedError it wraps engine errors in), or the error is DSPy's
    cause-less executor cancellation after refusals. Any other error keeps its
    own classification, even after the phase was exhausted.
    """
    if ledger.failure is not None or ledger.phase_exhausted is None:
        return False
    cause = spend_cause(error)
    if cause is not None:
        return isinstance(cause, SpendBudgetExceeded)
    return (
        type(error) is Exception
        and str(error) == DSPY_CANCELLED_EXECUTION_MESSAGE
        and ledger.refusal_count() > 0
    )


def spend_stop_recoverable(error: BaseException, ledger: SpendLedger) -> bool:
    """A compile that raised because the optimization phase limit refused a call."""
    return optimization_phase_stop(error, ledger)


def without_gepa_results(program: Any) -> Any:
    """A copy of program without the DSPy GEPA results a compile attached to it.

    A recovered candidate must not carry an earlier round's detailed_results,
    or its stats would be reported next to this round's instructions.
    """
    recovered = copy.deepcopy(program)
    try:
        delattr(recovered, "detailed_results")
    except AttributeError:
        pass
    return recovered


def recover_spend_stopped_candidate(
    program_to_climb: Any,
    round_index: int,
    best_path: Path,
    config_sha256: str,
) -> tuple[Any, dict[str, Any]] | None:
    """The best candidate a spend-stopped compile leaves behind, or None.

    The streamed best-so-far for this config and round (written only for a
    candidate scored on the whole dev split) is applied to the program the
    round started from; a later round that streamed nothing falls back to the
    previous round's result. Round 1 without a streamed best has no candidate.
    Neither carries GEPA stats: this round's compile returned none.
    """
    best: Any = None
    if best_path.exists():
        try:
            best = json.loads(best_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            best = None
    if (
        isinstance(best, dict)
        and best.get("config_sha256") == config_sha256
        and best.get("round") == round_index
        and isinstance(best.get("instructions"), dict)
        and best["instructions"]
    ):
        recovered = without_gepa_results(program_to_climb)
        apply_instructions(recovered, best["instructions"])
        return recovered, {"source": "best-so-far", "average_score": best.get("average_score")}
    if round_index > 1:
        return without_gepa_results(program_to_climb), {"source": "previous-round", "average_score": None}
    return None


def fully_scored_candidate(
    progress: GepaProgress,
    program_to_climb: Any,
    round_index: int,
) -> tuple[Any, dict[str, Any]] | None:
    """The best candidate this round scored on the whole dev split without a refused call.

    Falls back to the previous round's result, which was fully scored. Round 1
    with no fully scored candidate (the seed's own evaluation was refused) has
    none. Neither carries GEPA results, so its stats are reported separately.
    """
    full = [
        item for item in progress.evaluations
        if not item["partial"] and item["instructions"] and isinstance(item["average_score"], (int, float))
    ]
    if full:
        best = max(full, key=lambda item: float(item["average_score"]))
        recovered = without_gepa_results(program_to_climb)
        apply_instructions(recovered, best["instructions"])
        return recovered, {"source": "fully-scored-candidate", "average_score": float(best["average_score"])}
    if round_index > 1:
        return without_gepa_results(program_to_climb), {"source": "previous-round", "average_score": None}
    return None


def build_gepa_search_kwargs(
    args: argparse.Namespace,
    events: RunEvents,
    stop_file: Path,
    best_path: Path,
    round_index: int,
    config_sha256: str | None = None,
    spend_stopper: SpendStopper | None = None,
    progress: GepaProgress | None = None,
) -> dict[str, Any]:
    """dspy.GEPA keyword arguments for callbacks, stoppers and proposal strategy."""
    from gepa.utils.stop_condition import (
        FileStopper,
        NoImprovementStopper,
        ScoreThresholdStopper,
        TimeoutStopCondition,
    )

    # gepa.optimize still adds its own max_metric_calls stopper (and a gepa.stop
    # file stopper inside the log dir) next to these.
    stoppers: list[Any] = [FileStopper(str(stop_file))]
    if spend_stopper is not None:
        # Right after the stop file, so GEPA's any() reaches it every iteration
        # (its telemetry included) unless the run is stopping anyway.
        stoppers.append(spend_stopper)
    if args.stop_after_stale is not None:
        stoppers.append(NoImprovementStopper(int(args.stop_after_stale)))
    if args.stop_at_score is not None:
        stoppers.append(ScoreThresholdStopper(float(args.stop_at_score)))
    if args.max_minutes is not None:
        stoppers.append(TimeoutStopCondition(float(args.max_minutes) * 60))
    inner: dict[str, Any] = {
        "use_cloudpickle": True,
        "callbacks": [progress or GepaProgress(events, best_path, round_index, config_sha256)],
        "stop_callbacks": stoppers,
    }
    if args.frontier_type != "instance":
        # GEPA's own default is instance; other frontiers read the metric's objective_scores.
        inner["frontier_type"] = args.frontier_type
    proposals = int(args.proposals_per_iteration)
    if proposals > 1:
        from gepa.strategies.proposal_sampling import IndependentSampling
        from gepa.strategies.proposal_selection import BestImprovement

        inner["sampling_strategy"] = IndependentSampling(proposals)
        inner["selection_strategy"] = BestImprovement()
        inner["acceptance_criterion"] = "strict_improvement"
    kwargs: dict[str, Any] = {"gepa_kwargs": inner}
    if args.proposer_skill or args.proposer_note or args.proposer_max_chars is not None:
        from dspy.teleprompt.gepa import InstructionProposer

        kwargs["instruction_proposer"] = InstructionProposer(
            skills=[proposer_skill_path(skill) for skill in args.proposer_skill] or None,
            additional_instructions=args.proposer_note,
            max_chars=int(args.proposer_max_chars) if args.proposer_max_chars is not None else None,
        )
    return kwargs


def round_log_dir(log_dir: Path, round_index: int) -> Path:
    # Each round is its own GEPA run. Round 1 keeps the bound log dir; later
    # rounds resume from their own subdirectory under the same binding.
    return log_dir if round_index == 1 else log_dir / f"round-{round_index}"


def predictor_instructions(program: Any) -> dict[str, str]:
    """Return each predictor's current instruction text, keyed by predictor name."""
    named = getattr(program, "named_predictors", None)
    if not callable(named):
        return {}
    return {
        str(name): str(getattr(getattr(predictor, "signature", None), "instructions", ""))
        for name, predictor in named()
    }


def gepa_best_index(optimized: Any) -> int | None:
    """DspyGEPAResult.best_idx (the first highest aggregate score), or None."""
    detailed = getattr(optimized, "detailed_results", None)
    scores = getattr(detailed, "val_aggregate_scores", None)
    if not scores:
        return None
    return max(range(len(scores)), key=lambda index: float(scores[index]))


def gepa_run_stats(optimized: Any, partial_candidates: set[int] | frozenset[int] = frozenset()) -> dict[str, Any] | None:
    """Summarize DspyGEPAResult (present because track_stats=True); None if absent.

    DSPy scores a refused call as a miss, so a candidate whose dev evaluation
    had refused calls has a deflated score. Those candidates are listed and
    left out: the baseline score is null if the seed was one of them, and the
    best score is the best fully scored candidate's (null if there is none).
    """
    detailed = getattr(optimized, "detailed_results", None)
    scores = getattr(detailed, "val_aggregate_scores", None)
    if not scores:
        return None
    scores = [float(score) for score in scores]
    partial = sorted(index for index in partial_candidates if 0 <= index < len(scores))
    full = [index for index in range(len(scores)) if index not in partial]
    best_idx = max(full, key=lambda index: scores[index]) if full else None
    return {
        "split": "dev",
        "num_candidates": len(scores),
        "best_candidate_index": best_idx,
        "baseline_val_score": None if 0 in partial else scores[0],
        "best_val_score": scores[best_idx] if best_idx is not None else None,
        "total_metric_calls": getattr(detailed, "total_metric_calls", None),
        "num_full_val_evals": getattr(detailed, "num_full_val_evals", None),
        "partial": bool(partial),
        "partial_candidate_indices": partial,
    }


def score_program_on_rows(
    program: Any,
    rows: list[dict[str, Any]],
    input_keys: list[str],
    output_keys: list[str],
    to_example: Callable[[dict[str, Any]], Any],
    threads: int,
    on_progress: Callable[[int, int, float], None] | None = None,
    match_mode: str = "exact",
    task_spec: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Score a program on rows; spend errors abort, others count as failures.

    The score follows match_mode, and both exact and case-insensitive scores are
    always reported so a casing-only gain cannot pass for task skill. A task spec
    scores each predictor and reports them under by_predictor.
    """
    predictor_names = [predictor["name"] for predictor in task_spec["predictors"]] if task_spec else []
    progress_lock = threading.Lock()
    finished = {"done": 0, "score": 0.0}

    def record(score: float) -> None:
        if on_progress is None:
            return
        with progress_lock:
            finished["done"] += 1
            finished["score"] += score
            done, total_score = finished["done"], finished["score"]
        # Report about ten times per pass, plus the last row.
        step = max(1, len(rows) // 10)
        if done % step == 0 or done == len(rows):
            on_progress(done, len(rows), total_score / done)

    def run(index: int) -> dict[str, Any]:
        row = rows[index]
        gold = to_example(row)
        try:
            prediction = program(**{key: row[key] for key in input_keys})
        except Exception as error:
            if spend_cause(error) is not None:
                raise
            record(0.0)
            return {
                "predicted": None,
                "score": 0.0,
                "by_match": {mode: 0.0 for mode in MATCH_MODES},
                "by_predictor": {mode: {name: 0.0 for name in predictor_names} for mode in MATCH_MODES},
                "error": type(error).__name__,
            }
        if task_spec is not None:
            predicted = task_spec_predicted(task_spec, prediction)
            by_predictor = {
                mode: {
                    name: part[0]
                    for name, part in task_spec_components(task_spec, gold, prediction, mode).items()
                }
                for mode in MATCH_MODES
            }
            by_match = {
                mode: sum(by_predictor[mode].values()) / len(predictor_names) for mode in MATCH_MODES
            }
        else:
            predicted = {key: str(field_value(prediction, key, "")).strip() for key in output_keys}
            by_predictor = {mode: {} for mode in MATCH_MODES}
            by_match = {
                mode: float(exact_match_feedback(output_keys, gold, prediction, mode).score)
                for mode in MATCH_MODES
            }
        score = by_match[match_mode]
        record(score)
        return {
            "predicted": predicted,
            "score": score,
            "by_match": by_match,
            "by_predictor": by_predictor,
            "error": None,
        }

    with ThreadPoolExecutor(max_workers=max(1, threads)) as pool:
        results = list(pool.map(run, range(len(rows))))
    count = len(results)

    def mean(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    summary: dict[str, Any] = {
        "score": mean([item["score"] for item in results]),
        "by_match": {mode: mean([item["by_match"][mode] for item in results]) for mode in MATCH_MODES},
        "errors": sum(1 for item in results if item["error"]),
        "rows": results,
    }
    if task_spec is not None:
        summary["by_predictor"] = {
            name: {
                "score": mean([item["by_predictor"][match_mode][name] for item in results]),
                "by_match": {
                    mode: mean([item["by_predictor"][mode][name] for item in results]) for mode in MATCH_MODES
                },
            }
            for name in predictor_names
        }
    return summary


def evaluate_holdout(
    baseline: Any,
    optimized: Any,
    rows: list[dict[str, Any]],
    input_keys: list[str],
    output_keys: list[str],
    to_example: Callable[[dict[str, Any]], Any],
    threads: int,
    ledger: SpendLedger,
    events: RunEvents | None = None,
    match_mode: str = "exact",
    task_spec: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Baseline vs optimized score on the holdout rows, after the candidate is frozen.

    A spend stop mid-evaluation keeps the frozen candidate: the result is marked
    incomplete instead of discarding it.
    """
    evaluation: dict[str, Any] = {
        "schema_version": "understudy.dspy_gepa_holdout_evaluation.v1",
        "status": "complete",
        "count": len(rows),
        "metric": "exact_match" if match_mode == "exact" else "case_insensitive_match",
        "match_mode": match_mode,
        "used_for_selection": False,
        "baseline": None,
        "optimized": None,
        "delta": None,
        "rows": [],
    }
    if task_spec is not None:
        # Each predictor is scored on its own; the program score is their mean.
        evaluation["aggregate"] = "mean-of-predictor-scores"
        evaluation["predictors"] = [predictor["name"] for predictor in task_spec["predictors"]]

    def reporter(program_name: str) -> Callable[[int, int, float], None] | None:
        if events is None:
            return None
        return lambda done, total, running_score: events.emit(
            "holdout-progress",
            program=program_name,
            done=done,
            total=total,
            running_score=round(running_score, 4),
        )

    def program_summary(result: Mapping[str, Any]) -> dict[str, Any]:
        summary = {key: result[key] for key in ("score", "errors", "by_match")}
        if "by_predictor" in result:
            summary["by_predictor"] = result["by_predictor"]
        return summary

    failure_before = ledger.failure
    try:
        baseline_result = score_program_on_rows(
            baseline, rows, input_keys, output_keys, to_example, threads, reporter("baseline"), match_mode,
            task_spec,
        )
        evaluation["baseline"] = program_summary(baseline_result)
        optimized_result = score_program_on_rows(
            optimized, rows, input_keys, output_keys, to_example, threads, reporter("optimized"), match_mode,
            task_spec,
        )
        evaluation["optimized"] = program_summary(optimized_result)
    except Exception as error:
        cause = spend_cause(error)
        if cause is None:
            raise
        evaluation["status"] = (
            "incomplete-budget" if isinstance(cause, SpendBudgetExceeded) else "incomplete-spend-evidence"
        )
        return evaluation
    if ledger.failure is not None and ledger.failure is not failure_before:
        # DSPy swallowed a spend stop and scored the row as a failure.
        evaluation["status"] = (
            "incomplete-budget"
            if isinstance(ledger.failure, SpendBudgetExceeded)
            else "incomplete-spend-evidence"
        )
        return evaluation
    evaluation["delta"] = evaluation["optimized"]["score"] - evaluation["baseline"]["score"]
    if task_spec is not None:
        evaluation["delta_by_predictor"] = {
            name: evaluation["optimized"]["by_predictor"][name]["score"]
            - evaluation["baseline"]["by_predictor"][name]["score"]
            for name in evaluation["predictors"]
        }

    def expected(row: Mapping[str, Any]) -> dict[str, Any]:
        if task_spec is None:
            return {key: str(row[key]).strip() for key in output_keys}
        return {
            predictor["output"]: task_spec_gold(predictor, row[predictor["output"]])
            for predictor in task_spec["predictors"]
        }

    # Expected labels and predictions only; inputs stay out of the artifact.
    evaluation["rows"] = [
        {
            "expected": expected(row),
            "baseline": base["predicted"],
            "optimized": opt["predicted"],
            "baseline_score": base["score"],
            "optimized_score": opt["score"],
        }
        for row, base, opt in zip(rows, baseline_result["rows"], optimized_result["rows"])
    ]
    return evaluation


def holdout_summary(evaluation: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if evaluation is None:
        return None
    return {key: value for key, value in evaluation.items() if key != "rows"}


def _dspy_gepa_execute(args: argparse.Namespace, ledger: SpendLedger) -> None:
    events: RunEvents = getattr(args, "events", None) or RunEvents(None)
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

    task_spec: dict[str, Any] | None = getattr(args, "task_spec_data", None)
    # Samples load and splits are checked before any network access, so a bad
    # split or (with a task spec) a bad gold value stops the run before the
    # gateway price lookup or any provider call.
    rows = load_rows(args.samples) if args.samples else []
    input_keys = split_keys(args.input_keys or "")
    output_keys = split_keys(args.output_keys or "")
    if program_bridge_path is None:
        if not rows or not input_keys or not output_keys:
            raise ValueError("samples, input keys, and output keys are required without a program bridge")
        train_rows, dev_rows, holdout_count = split_train_dev(
            rows, args.split_key, args.train_split, args.dev_split,
        )
    else:
        train_rows = []
        dev_rows = []
        holdout_count = len([row for row in rows if is_holdout_split(row.get(args.split_key, ""))])
    # Holdout rows are loaded only for the opt-in evaluation that runs after the
    # candidate is frozen; they never reach GEPA, the metric, or a stopper.
    holdout_rows = holdout_rows_for(rows, args.split_key) if args.evaluate_holdout else []
    require_disjoint_holdout(holdout_rows_for(rows, args.split_key), [*train_rows, *dev_rows])
    if args.evaluate_holdout:
        if not holdout_rows:
            raise ValueError(f"--evaluate-holdout needs rows with {args.split_key}=holdout")
        for row in holdout_rows:
            missing = [key for key in [*input_keys, *output_keys] if key not in row]
            if missing and task_spec is None:
                raise ValueError("holdout row is missing keys")
    if task_spec is not None:
        validate_task_spec_rows(task_spec, rows, [*train_rows, *dev_rows, *holdout_rows])
    events.emit("data-loaded", train=len(train_rows), dev=len(dev_rows), holdout=holdout_count)

    gateway_url = os.environ.get("UNDERSTUDY_GATEWAY_URL")
    student_route, student_api_key, student_api_base = resolve_lm_route(
        "student", args.model, bridge_config, gateway_url,
    )
    reflection_route, reflection_api_key, reflection_api_base = resolve_lm_route(
        "reflection", args.reflection_model, bridge_config, gateway_url,
    )
    gateway_roles = gateway_routed_roles(
        {"student": student_route, "reflection": reflection_route}, gateway_url,
    )
    if args.prices_from_gateway == "off":
        ledger.set_gateway_prices({}, {"status": "off"}, set())
    elif not gateway_roles:
        if args.prices_from_gateway == "require":
            raise ValueError("--prices-from-gateway require needs a gateway-routed model")
        ledger.set_gateway_prices({}, {"status": "no-gateway-routed-roles"}, set())
    else:
        wanted = {
            str(normalize_price_key(route["requested_model"]))
            for role, route in (("student", student_route), ("reflection", reflection_route))
            if role in gateway_roles
        }
        gateway_prices, lookup = fetch_gateway_prices(
            str(gateway_url), os.environ.get("UNDERSTUDY_API_KEY", ""), wanted,
        )
        ledger.set_gateway_prices(gateway_prices, lookup, gateway_roles)
        if args.prices_from_gateway == "require" and sorted(wanted - set(gateway_prices)):
            raise ValueError("the gateway published no prices for a gateway-routed model")
    if ledger.enforce:
        for role, route in (("student", student_route), ("reflection", reflection_route)):
            if ledger.prices_for(route["requested_model"], role) is None:
                raise ValueError(f"no price basis for the {role} model")

    bridge_module = load_program_bridge(program_bridge_path) if program_bridge_path else None

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
        # The spec file is bound by content hash and by its normalized form.
        "task_spec": (
            {
                "logical_path": logical_path(repo, Path(args.task_spec)),
                "sha256": file_sha256(Path(args.task_spec).resolve()),
                "spec": task_spec,
            }
            if task_spec is not None
            else None
        ),
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
            "round_log_dirs": "round 1 uses log_dir; round N uses log_dir/round-N",
        },
        "search": search_settings(args, repo),
        "evaluation": {
            "evaluate_holdout": bool(args.evaluate_holdout),
            "holdout_used_for_selection": False,
            "match_mode": args.match_mode,
        },
        "inference": {
            "max_tokens": args.max_tokens,
            "reflection_max_tokens": args.reflection_max_tokens,
            "student_sampling": {
                "temperature": args.temperature,
                "reasoning_effort": args.reasoning_effort,
            },
            "reflection_sampling": {
                "temperature": args.reflection_temperature,
                "reasoning_effort": args.reflection_reasoning_effort,
            },
            "routes": {
                "student": student_route,
                "reflection": reflection_route,
            },
            "cache": False,
            "num_retries": 0,
            "shared_cumulative_spend_ledger": True,
            "optimizer_inference_cap_usd": ledger.budget_usd,
            "input_usd_per_million": ledger.input_usd_per_million,
            "output_usd_per_million": ledger.output_usd_per_million,
            "price_basis_scope": (
                "conservative-user-supplied-basis-for-both-models"
                if ledger.reflection_prices is None and not ledger.model_prices and not ledger.gateway_prices
                else "per-call-resolved-reflection-model-gateway-global"
            ),
            "prices": ledger.price_configuration(),
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

    def build_lm(
        role: str,
        route: Mapping[str, Any],
        api_key: str,
        api_base: str,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str,
    ) -> Any:
        # A custom engine owns the connection, so the credential and base URL go
        # on the inner engine, never on dspy.LM. Every call crosses the meter.
        engine = MeteredEngine(new_provider_engine(api_key, api_base), ledger, role, route)
        lm_kwargs: dict[str, Any] = {
            "engine": engine,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "cache": False,
            "num_retries": 0,
        }
        if reasoning_effort != "none":
            lm_kwargs["reasoning_effort"] = reasoning_effort
        lm = dspy.LM(route["dspy_model"], **lm_kwargs)
        if getattr(lm, "model", None) != route["dspy_model"]:
            raise ValueError(f"{role} DSPy model does not match the bound executed model")
        return lm

    student_lm = build_lm(
        "student",
        student_route,
        student_api_key,
        student_api_base,
        args.max_tokens,
        args.temperature,
        args.reasoning_effort,
    )
    # GEPA reflection returns a structured instruction proposal that is far
    # longer than a student answer; a student-sized cap truncates it and the
    # proposal silently fails, so reflection has its own output cap.
    reflection_lm = build_lm(
        "reflection",
        reflection_route,
        reflection_api_key,
        reflection_api_base,
        args.reflection_max_tokens,
        args.reflection_temperature,
        args.reflection_reasoning_effort,
    )
    if student_lm is reflection_lm:
        raise ValueError("student and reflection LMs must be separate instances")
    dspy.configure(lm=student_lm)

    exporter = None
    bridge_state = None
    baseline_feedback = None
    routing: dict[str, str] = {}
    predictors_per_row = len(task_spec["predictors"]) if task_spec is not None else 1
    if bridge_module is None:
        if task_spec is not None:
            # Rows were checked against the spec above; gold values are normalized
            # (a label-set becomes its label list in spec order).
            student = build_task_spec_program(dspy, task_spec)
            routing = task_spec_predictor_routing(student, task_spec)

            def to_example(row: dict[str, Any]) -> Any:
                gold = {
                    predictor["output"]: task_spec_gold(predictor, row[predictor["output"]])
                    for predictor in task_spec["predictors"]
                }
                return dspy.Example(
                    **{key: row[key] for key in input_keys}, **gold,
                ).with_inputs(*input_keys)

            def score_with_feedback(gold: Any, pred: Any, pred_name: str | None = None) -> Any:
                return task_spec_feedback(task_spec, routing, gold, pred, args.match_mode, pred_name)
        else:
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

            def score_with_feedback(gold: Any, pred: Any, pred_name: str | None = None) -> Any:
                return exact_match_feedback(output_keys, gold, pred, args.match_mode)

        trainset = [to_example(row) for row in train_rows]
        valset = [to_example(row) for row in dev_rows]
        baseline_instructions = predictor_instructions(student)
        # Optional warm start from a previous run; the unseeded student stays
        # the holdout baseline. Seeds are validated before any provider call.
        starting_program = student
        if args.seed_instructions:
            starting_program = copy.deepcopy(student)
            apply_instructions(
                starting_program,
                load_seed_instructions(Path(args.seed_instructions)),
                {name: dspy_name for dspy_name, name in routing.items()},
            )
            events.emit("seeded", instructions=predictor_instructions(starting_program))
        args.phase = "baseline"
        write_dspy_run_state(args, ledger, "running", None, phase="baseline")
        events.emit("phase", name="baseline")
        baseline_prediction = student(**{key: train_rows[0][key] for key in input_keys})
        # The baseline run is the first observation of student calls per
        # predictor invocation (parse fallbacks), which sizes the holdout reserve.
        ledger.record_predictor_invocations(predictors_per_row)
        baseline_feedback = score_with_feedback(trainset[0], baseline_prediction)

        def metric(gold: Any, pred: Any, trace: Any = None, pred_name: str | None = None, pred_trace: Any = None) -> Any:
            if pred_name is None:
                # DSPy scores a program run with pred_name=None (per-predictor
                # feedback passes a name): one run is predictors_per_row
                # predictor invocations that reached the metric.
                ledger.record_predictor_invocations(predictors_per_row)
            return score_with_feedback(gold, pred, pred_name)
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
        baseline_instructions = predictor_instructions(student)
        starting_program = student
        trainset = list(program["trainset"])
        valset = list(program["valset"])
        metric = program["metric"]
        if not trainset or not valset or not callable(metric):
            raise ValueError("program bridge requires non-empty trainset/valset and a callable metric")
        teacher = program.get("teacher")
        if teacher is not None:
            raise UnsupportedTeacherError("dspy-3.4.1-gepa-teacher-not-supported")
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
        admission_spend_evidence["route_bindings"] = config_payload["inference"]["routes"]
        args.phase = "admission"
        write_dspy_run_state(
            args,
            ledger,
            "admitted",
            None,
            {
                "config_sha256": config_sha256,
                "admission_receipt_sha256": receipt["receipt_sha256"],
                "budget_allocation": budget_allocation,
                "route_bindings": config_payload["inference"]["routes"],
                "provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
                "optimizer_provider_calls": False,
                "endpoint_provider_calls": bool(live_admission and live_admission.get("call_count", 0) > 0),
            },
            phase="admission",
        )
        events.emit("run-finished", status="admitted", optimizer_started=False)
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
            "route_bindings": config_payload["inference"]["routes"],
            "spend_evidence": admission_spend_evidence,
        })
        return

    stop_file = dspy_stop_file_path(args)
    if stop_file.exists():
        # A stale STOP from an earlier run must not end this one.
        stop_file.unlink()
        events.emit("stop-file-cleared")
    # Fixed-path artifacts from an earlier run must not pass for this run's. The
    # holdout evaluation is rescored each run; best-so-far survives only a resume
    # of the same config, which keeps the best its earlier attempt found.
    dspy_holdout_evaluation_path(args).unlink(missing_ok=True)
    best_path = dspy_best_so_far_path(args)
    if best_path.exists():
        try:
            prior_best = json.loads(best_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            prior_best = None
        if not isinstance(prior_best, dict) or prior_best.get("config_sha256") != config_sha256:
            best_path.unlink()
            events.emit("best-so-far-cleared")
    args.owned_artifacts = {"best_so_far_path"}
    # From here the holdout evaluation keeps its reserve: optimization runs under
    # cap - reserve, calibrated by the baseline call's settled cost.
    ledger.begin_phase(
        OPTIMIZATION_PHASE,
        holdout_calls_planned=len(holdout_rows) * 2 * predictors_per_row if args.evaluate_holdout else 0,
    )
    governor_at_start = ledger.spend_snapshot()
    args.phase = "optimizing"
    write_dspy_run_state(args, ledger, "running", None, {"config_sha256": config_sha256}, phase="optimizing")
    events.emit(
        "phase",
        name="optimizing",
        max_metric_calls=args.max_metric_calls,
        rounds=args.rounds,
        phase_limit_usd=governor_at_start["phase_limit_usd"],
        holdout_reserve_usd=governor_at_start["holdout_reserve_usd"],
    )
    rounds_log: list[dict[str, Any]] = []
    program_to_climb = starting_program
    optimized = starting_program
    spend_stopper = SpendStopper(ledger, events, args.max_metric_calls, args.rounds)
    stopped_by: str | None = None
    spend_stop: dict[str, Any] | None = None
    final_stats: dict[str, Any] | None = None
    final_stats_status = "unavailable"
    for round_index in range(1, args.rounds + 1):
        round_dir = round_log_dir(log_dir, round_index)
        round_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        spend_stopper.start_round(round_index)
        progress = GepaProgress(events, best_path, round_index, config_sha256, ledger)
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
            log_dir=str(round_dir),
            track_stats=args.track_stats,
            track_best_outputs=True,
            seed=args.seed,
            **build_gepa_search_kwargs(
                args, events, stop_file, dspy_best_so_far_path(args), round_index, config_sha256, spend_stopper,
                progress,
            ),
        )
        events.emit("round-started", round=round_index, of=args.rounds)
        recovered_from: dict[str, Any] | None = None
        compiled: Any = None
        try:
            compiled = teleprompter.compile(program_to_climb, trainset=trainset, valset=valset)
            optimized = compiled
        except Exception as error:
            # The optimization phase limit refused a call and GEPA let it out. Keep
            # the best candidate the run already streamed; without one this stays
            # a budget-blocked failure.
            if not spend_stop_recoverable(error, ledger):
                raise
            recovered = recover_spend_stopped_candidate(program_to_climb, round_index, best_path, config_sha256)
            if recovered is None:
                raise
            optimized, recovered_from = recovered
        if ledger.failure is not None:
            # DSPy scores a failed rollout as a miss; a spend stop is never a miss.
            raise ledger.failure
        partial_candidates = {
            int(item["candidate_idx"])
            for item in progress.evaluations
            if item["partial"] and isinstance(item["candidate_idx"], int)
        }
        round_stats = gepa_run_stats(compiled, partial_candidates) if compiled is not None else None
        if compiled is not None and (partial_candidates or progress.refusals_in_round() > 0):
            # DSPy swallowed refused calls as misses, so GEPA may have picked a
            # candidate whose dev score is not a real score. Keep its pick only if
            # it was fully scored; otherwise take the best fully scored candidate
            # of this round, then the previous round's result.
            best_index = gepa_best_index(compiled)
            if best_index is None or best_index in partial_candidates:
                reselected = fully_scored_candidate(progress, program_to_climb, round_index)
                if reselected is None:
                    raise NoScoredCandidateError("no-candidate-fully-scored")
                optimized, recovered_from = reselected
        if round_stats is None:
            stats_status = "unavailable"
        else:
            stats_status = "partial" if round_stats["partial"] else "complete"
        spend_stopped = spend_stopper.fired_in_round(round_index) or ledger.phase_exhausted is not None
        stopped_by_file = stop_file.exists()
        seed_score = round_stats["baseline_val_score"] if round_stats else None
        best_score = round_stats["best_val_score"] if round_stats else None
        if recovered_from is not None and recovered_from.get("average_score") is not None:
            best_score = recovered_from["average_score"]
        entry = {
            "round": round_index,
            "seed_val_score": seed_score,
            "best_val_score": best_score,
            "gain": (best_score - seed_score) if seed_score is not None and best_score is not None else None,
            "metric_calls": round_stats["total_metric_calls"] if round_stats else None,
            "stopped_by_stop_file": stopped_by_file,
            "stopped_by_spend_governor": spend_stopped,
            # "unavailable" when compile raised and the candidate was recovered
            # (its GEPA results are gone), "partial" when refused calls deflated
            # some dev scores (those candidates are left out of the scores).
            "gepa_stats_status": stats_status,
        }
        if recovered_from is not None:
            entry["recovered_candidate_from"] = recovered_from["source"]
        rounds_log.append(entry)
        events.emit("round-finished", **entry)
        final_stats = round_stats
        final_stats_status = stats_status
        program_to_climb = optimized
        # Every stop below reads the dev split only, or the spend ledger.
        if spend_stopped:
            stopped_by = "spend-governor"
            spend_stop = dict(spend_stopper.fired) if spend_stopper.fired_in_round(round_index) else {
                "reason": "optimization-phase-limit-reached",
                "round": round_index,
            }
            spend_stop["phase_exhausted"] = ledger.phase_exhausted
            spend_stop["compile_raised"] = compiled is None
            if recovered_from is not None:
                spend_stop["recovered_candidate_from"] = recovered_from["source"]
            break
        if stopped_by_file:
            break
        if best_score is not None and best_score >= 1.0:
            break
        if entry["gain"] is not None and entry["gain"] <= args.min_round_gain:
            break
    # Optimization is over. Calls it left behind (a straggler DSPy abandoned, or
    # one still waiting to reserve) are refused from here, and calls still in
    # flight get a bounded wait before any spend evidence is sampled.
    ledger.begin_phase(FINALIZING_PHASE)
    ledger.drain()
    optimized_instructions = predictor_instructions(optimized)
    instructions_changed = optimized_instructions != baseline_instructions
    # Per-predictor view for spec runs, keyed by spec name; the instruction maps
    # above stay keyed by DSPy predictor name so they can seed a later run.
    predictor_records = (
        {
            name: {
                "dspy_predictor": dspy_name,
                "output": next(p["output"] for p in task_spec["predictors"] if p["name"] == name),
                "kind": next(p["type"]["kind"] for p in task_spec["predictors"] if p["name"] == name),
                "baseline_instructions": baseline_instructions.get(dspy_name),
                "optimized_instructions": optimized_instructions.get(dspy_name),
                "instructions_changed": baseline_instructions.get(dspy_name) != optimized_instructions.get(dspy_name),
            }
            for dspy_name, name in routing.items()
        }
        if task_spec is not None
        else None
    )
    args.phase = "optimization-finished"
    events.emit(
        "phase",
        name="optimization-finished",
        instructions_changed=instructions_changed,
        gepa_stats=final_stats,
        stopped_by=stopped_by,
    )
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

    def sampled_spend_evidence() -> dict[str, Any]:
        evidence = ledger.evidence()
        evidence["sampling"] = {
            "student": config_payload["inference"]["student_sampling"],
            "reflection": config_payload["inference"]["reflection_sampling"],
        }
        evidence["route_bindings"] = config_payload["inference"]["routes"]
        return evidence

    holdout_path = dspy_holdout_evaluation_path(args)
    spend_evidence = sampled_spend_evidence()
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
        "max_tokens": args.max_tokens,
        "reflection_max_tokens": args.reflection_max_tokens,
        "spend_enforcement": spend_evidence["spend_enforcement"],
        "baseline_first_score": float(baseline_feedback.score) if baseline_feedback else None,
        "baseline_first_feedback": baseline_feedback.feedback if baseline_feedback else None,
        "baseline_first_objective_scores": (
            dict(baseline_feedback.objective_scores) if task_spec is not None and baseline_feedback else None
        ),
        "baseline_instructions": baseline_instructions,
        "optimized_instructions": optimized_instructions,
        "instructions_changed": instructions_changed,
        "task_spec": config_payload["task_spec"],
        "predictors": predictor_records,
        "instructions_changed_by_predictor": (
            {name: record["instructions_changed"] for name, record in predictor_records.items()}
            if predictor_records is not None
            else None
        ),
        "gepa_stats": final_stats,
        # complete, partial (refused calls deflated some dev scores; those
        # candidates are left out), or unavailable (a recovered candidate).
        "gepa_stats_status": final_stats_status,
        "search": config_payload["search"],
        "rounds": rounds_log,
        # "spend-governor" when the run stopped early to stay inside the
        # optimization phase limit; the candidate is GEPA's best so far.
        "stopped_by": stopped_by,
        "spend_stop": spend_stop,
        # The candidate is frozen here, before any holdout row is scored.
        "holdout_evaluation_requested": bool(args.evaluate_holdout),
        "holdout_evaluation_path": artifact_path(repo, holdout_path) if args.evaluate_holdout else None,
        "optimized_program_class": optimized.__class__.__name__,
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "route_bindings": config_payload["inference"]["routes"],
        "canonical_bundle_sha256": bundle_manifest["canonical_bundle_sha256"] if bundle_manifest else None,
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    }
    optimize_dir = repo / ".understudy" / "optimize-workload"
    candidate_path = optimize_dir / "candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    write_owner_only_json(candidate_path, candidate)
    candidate_sha256 = file_sha256(candidate_path)

    holdout_evaluation: dict[str, Any] | None = None
    if args.evaluate_holdout:
        # Scored once, after optimization and after the candidate is frozen, so
        # the holdout never influences selection. Both programs share the ledger.
        args.phase = "evaluating-holdout"
        # The holdout runs under the full cap, including the reserve kept back
        # while optimizing.
        ledger.begin_phase(HOLDOUT_PHASE)
        write_dspy_run_state(args, ledger, "running", None, {"config_sha256": config_sha256}, phase="evaluating-holdout")
        events.emit("phase", name="evaluating-holdout", rows=len(holdout_rows), limit_usd=ledger.budget_usd)
        holdout_evaluation = evaluate_holdout(
            student,
            optimized,
            holdout_rows,
            input_keys,
            output_keys,
            to_example,
            args.num_threads,
            ledger,
            events,
            args.match_mode,
            task_spec,
        )
        holdout_evaluation["candidate_sha256"] = candidate_sha256
        holdout_evaluation["config_sha256"] = config_sha256
        write_owner_only_json(holdout_path, holdout_evaluation)
        args.owned_artifacts.add("holdout_evaluation_path")
        ledger.drain()

    spend_evidence = sampled_spend_evidence()
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
        "holdout_evaluated_after_optimization": holdout_evaluation is not None,
        "holdout_evaluation": holdout_summary(holdout_evaluation),
        "spend_enforcement": spend_evidence["spend_enforcement"],
        "stopped_by": stopped_by,
        "train_count": len(trainset),
        "dev_count": len(valset),
        "candidate": artifact_path(repo, candidate_path),
        "candidate_sha256": candidate_sha256,
        "config_sha256": config_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    }
    write_owner_only_json(proof_path, proof)
    extra = {
        "config_sha256": config_sha256,
        "candidate_sha256": candidate_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "route_bindings": config_payload["inference"]["routes"],
        "stopped_by": stopped_by,
    }
    args.phase = "finished"
    write_dspy_run_state(args, ledger, "candidate-created", None, extra, phase="finished")
    events.emit(
        "run-finished",
        status="candidate-created",
        calls_completed=spend_evidence["calls_completed"],
        attributed_cost_usd=spend_evidence["attributed_cost_usd"],
        committed_usd=spend_evidence["spend_governor"]["committed_usd"],
        instructions_changed=instructions_changed,
        gepa_stats=final_stats,
        stopped_by=stopped_by,
        holdout_evaluation=holdout_summary(holdout_evaluation),
    )
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v2",
        "status": "candidate-created",
        "adapter": "dspy-gepa",
        "model": args.model,
        "reflection_model": args.reflection_model,
        "provider_calls": spend_evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "auth_source": os.environ.get("UNDERSTUDY_AUTH_SOURCE", "unknown"),
        "lm_routes_configured": True,
        "understudy_gateway_route_used": any(
            route["route_id"] == "understudy-gateway"
            for route in config_payload["inference"]["routes"].values()
        ),
        "credentials_configured": {"student": True, "reflection": True},
        "route_bindings": config_payload["inference"]["routes"],
        "train_count": len(trainset),
        "dev_count": len(valset),
        "holdout_count_excluded": holdout_count,
        "holdout_evaluation": holdout_summary(holdout_evaluation),
        "max_metric_calls": args.max_metric_calls,
        "instructions_changed": instructions_changed,
        "instructions_changed_by_predictor": candidate["instructions_changed_by_predictor"],
        "stopped_by": stopped_by,
        "spend_stop": spend_stop,
        "spend_governor": spend_evidence["spend_governor"],
        "spend_enforcement": spend_evidence["spend_enforcement"],
        "config_sha256": config_sha256,
        "candidate_sha256": candidate_sha256,
        "budget_allocation": budget_allocation,
        "bundle_sha256": bundle_manifest["bundle_sha256"] if bundle_manifest else None,
        "canonical_bundle_sha256": bundle_manifest["canonical_bundle_sha256"] if bundle_manifest else None,
        "candidate_path": artifact_path(repo, candidate_path),
        "proof_packet_path": artifact_path(repo, proof_path),
        "run_state_path": artifact_path(repo, dspy_run_state_path(args)),
        "events_path": artifact_path(repo, dspy_events_path(args)),
        "artifacts": dspy_artifacts(args),
        "spend_evidence": spend_evidence,
    })


def default_num_threads(args: argparse.Namespace) -> int:
    """16 evaluation threads for the built-in scaffold; 1 for a program bridge.

    A bridge runs workload Python that may hold stateful tools, and the bridge
    contract makes no thread-safety promise, so it keeps the old default.
    """
    return 1 if args.program_bridge else 16


def dspy_gepa(args: argparse.Namespace) -> None:
    if args.num_threads is None:
        args.num_threads = default_num_threads(args)
    if args.log_dir is None:
        args.log_dir = str(dspy_run_dir(args) / "gepa-log")
    args.phase = "setup"
    events = RunEvents(dspy_events_path(args), echo=args.progress)
    args.events = events
    try:
        ledger = SpendLedger(
            args.budget_usd,
            args.input_usd_per_million,
            args.output_usd_per_million,
            args.reflection_input_usd_per_million,
            args.reflection_output_usd_per_million,
            parse_model_prices(args.model_price),
            enforce=not args.no_spend_ledger,
        )
    except ValueError:
        events.emit("run-failed", status="error", reason="invalid-spend-configuration")
        emit({
            "schema_version": "understudy.dspy_gepa_adapter.v2",
            "status": "error",
            "reason": "invalid-spend-configuration",
            "adapter": "dspy-gepa",
            "model": args.model,
            "reflection_model": args.reflection_model,
            "provider_calls": False,
            "optimizer_execution": False,
        })
        raise SystemExit(3)
    ledger.observer = events.ledger_event
    try:
        validate_search_options(args)
        if args.no_spend_ledger and args.program_bridge:
            raise ValueError("--no-spend-ledger is not supported with --program-bridge")
    except (TaskSpecError, ReportableInputError) as error:
        # Spec errors name a spec path, predictor or row index, never row content;
        # the others name flags.
        emit_dspy_failure(args, ledger, "error", str(error), 3)
    except ValueError:
        emit_dspy_failure(args, ledger, "error", "invalid-runtime-input", 3)
    events.emit(
        "run-started",
        model=args.model,
        reflection_model=args.reflection_model,
        spend_enforcement="ledger" if ledger.enforce else "none",
        approved_budget_usd=ledger.budget_usd,
        max_metric_calls=args.max_metric_calls,
        max_tokens=args.max_tokens,
        reflection_max_tokens=args.reflection_max_tokens,
        evaluate_holdout=bool(args.evaluate_holdout),
        admission_only=bool(args.admission_only),
        rounds=args.rounds,
        proposals_per_iteration=args.proposals_per_iteration,
        match_mode=args.match_mode,
        component_selector=args.component_selector,
        frontier_type=args.frontier_type,
        task_spec_predictors=(
            [predictor["name"] for predictor in args.task_spec_data["predictors"]]
            if args.task_spec_data is not None
            else None
        ),
    )
    try:
        _dspy_gepa_execute(args, ledger)
    except KeyboardInterrupt:
        emit_dspy_failure(args, ledger, "cancelled", "optimizer-cancelled", 130)
    except Exception as error:
        # DSPy wraps errors raised inside an engine call, and GEPA may score a
        # failed rollout as a miss, so a spend stop is found in the exception
        # chain or in the ledger itself before the error type decides.
        cause = spend_cause(error) or ledger.failure
        optimizing = getattr(args, "phase", None) == "optimizing"
        if cause is None and optimizing and optimization_phase_stop(error, ledger):
            # DSPy's cause-less executor cancellation after refused calls.
            cause = SpendBudgetExceeded("optimization-phase-limit-reached")
        if isinstance(cause, SpendBudgetExceeded):
            if isinstance(cause, NoScoredCandidateError):
                reason = str(cause)
            elif optimizing and optimization_phase_stop(error, ledger):
                # The optimization phase limit refused a call and nothing was
                # left to finalize.
                reason = "optimization-phase-limit-reached"
            else:
                reason = "next-call-reservation-exceeds-budget"
            emit_dspy_failure(args, ledger, "budget-blocked", reason, 4)
        elif isinstance(cause, SpendEvidenceError):
            emit_dspy_failure(args, ledger, "spend-evidence-error", str(cause), 5)
        elif isinstance(error, RuntimePackageVersionError):
            emit_dspy_failure(args, ledger, "error", "runtime-package-version-mismatch", 3)
        elif isinstance(error, ResumeBindingError):
            emit_dspy_failure(args, ledger, "resume-blocked", str(error), 6)
        elif isinstance(error, WorkloadAdmissionError):
            emit_dspy_failure(args, ledger, "admission-blocked", str(error), 6)
        elif isinstance(error, UnsupportedTeacherError):
            emit_dspy_failure(args, ledger, "error", str(error), 3)
        elif isinstance(error, (TaskSpecError, ReportableInputError)):
            emit_dspy_failure(args, ledger, "error", str(error), 3)
        elif isinstance(error, ImportError):
            emit_dspy_failure(args, ledger, "error", "runtime-dependency-error", 3)
        elif isinstance(error, ValueError):
            emit_dspy_failure(args, ledger, "error", "invalid-runtime-input", 3)
        else:
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
    # Preflight asks whether call_count concurrent worst-case reservations fit,
    # so nothing settles and nothing may wait.
    ledger = SpendLedger(
        args.budget_usd,
        args.input_usd_per_million,
        args.output_usd_per_million,
        throttle_max_wait_s=0,
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
    # None means "predict", or the task spec's module when --task-spec is given.
    dspy_gepa_parser.add_argument("--module", choices=("predict", "cot"), default=None)
    dspy_gepa_parser.add_argument("--model", required=True)
    dspy_gepa_parser.add_argument("--reflection-model", required=True)
    dspy_gepa_parser.add_argument("--max-metric-calls", type=positive_int_arg, default=3)
    dspy_gepa_parser.add_argument("--split-key", default="split")
    dspy_gepa_parser.add_argument("--train-split", default="train")
    dspy_gepa_parser.add_argument("--dev-split", default="dev")
    dspy_gepa_parser.add_argument("--max-tokens", type=positive_int_arg, default=2048)
    dspy_gepa_parser.add_argument("--reflection-max-tokens", type=positive_int_arg, default=2048)
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
    dspy_gepa_parser.add_argument("--budget-usd", default=None)
    dspy_gepa_parser.add_argument("--input-usd-per-million", default=None)
    dspy_gepa_parser.add_argument("--output-usd-per-million", default=None)
    dspy_gepa_parser.add_argument("--reflection-input-usd-per-million", default=None)
    dspy_gepa_parser.add_argument("--reflection-output-usd-per-million", default=None)
    dspy_gepa_parser.add_argument("--model-price", action="append", default=[])
    dspy_gepa_parser.add_argument(
        "--prices-from-gateway", choices=("auto", "off", "require"), default="auto",
    )
    dspy_gepa_parser.add_argument("--no-spend-ledger", action="store_true")
    dspy_gepa_parser.add_argument("--reflection-minibatch-size", type=positive_int_arg, default=1)
    dspy_gepa_parser.add_argument(
        "--candidate-selection-strategy", choices=("pareto", "current_best"), default="pareto",
    )
    dspy_gepa_parser.add_argument(
        "--component-selector", choices=("round_robin", "all"), default="round_robin",
    )
    dspy_gepa_parser.add_argument("--use-merge", type=bool_arg, default=False)
    dspy_gepa_parser.add_argument("--max-merge-invocations", type=non_negative_int_arg, default=5)
    # Default: 16 for the built-in scaffold, 1 for --program-bridge (see dspy_gepa).
    dspy_gepa_parser.add_argument("--num-threads", type=positive_int_arg, default=None)
    dspy_gepa_parser.add_argument("--seed", type=int, default=0)
    dspy_gepa_parser.add_argument("--log-dir", default=None)
    dspy_gepa_parser.add_argument("--track-stats", type=bool_arg, default=False)
    dspy_gepa_parser.add_argument("--program-bridge", default=None)
    dspy_gepa_parser.add_argument("--program-bridge-config", default=None)
    dspy_gepa_parser.add_argument("--program-project", default=None)
    dspy_gepa_parser.add_argument("--admission-only", action="store_true")
    dspy_gepa_parser.add_argument("--admission-receipt", default=None)
    dspy_gepa_parser.add_argument("--evaluate-holdout", action="store_true")
    dspy_gepa_parser.add_argument("--match-mode", choices=MATCH_MODES, default="exact")
    dspy_gepa_parser.add_argument("--seed-instructions", default=None)
    dspy_gepa_parser.add_argument("--task-spec", default=None)
    dspy_gepa_parser.add_argument("--frontier-type", default="instance")
    # Search settings are parsed by validate_search_options so a bad value
    # fails with the run's JSON error payload instead of an argparse exit.
    dspy_gepa_parser.add_argument("--rounds", default="1")
    dspy_gepa_parser.add_argument("--min-round-gain", default="0")
    dspy_gepa_parser.add_argument("--stop-after-stale", default=None)
    dspy_gepa_parser.add_argument("--stop-at-score", default=None)
    dspy_gepa_parser.add_argument("--max-minutes", default=None)
    dspy_gepa_parser.add_argument("--proposals-per-iteration", default="1")
    dspy_gepa_parser.add_argument("--proposer-skill", action="append", default=[])
    dspy_gepa_parser.add_argument("--proposer-note", default=None)
    dspy_gepa_parser.add_argument("--proposer-max-chars", default=None)
    dspy_gepa_parser.add_argument("--progress", action="store_true")
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
