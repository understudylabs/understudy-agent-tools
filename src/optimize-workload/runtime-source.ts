export const optimizerRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import threading
from pathlib import Path
from typing import Any


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


def dspy_run_state_path(args: argparse.Namespace) -> Path:
    return Path(args.repo) / ".understudy" / "optimize-workload" / "dspy-gepa" / "run-state.json"


def write_dspy_run_state(
    args: argparse.Namespace,
    ledger: SpendLedger,
    status: str,
    reason: str | None,
) -> None:
    evidence = ledger.evidence()
    write_owner_only_json(dspy_run_state_path(args), {
        "schema_version": "understudy.dspy_gepa_run_state.v1",
        "status": status,
        "reason": reason,
        "adapter": "dspy-gepa",
        "model": args.model,
        "provider_calls": evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "spend_evidence": evidence,
    })


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
        "schema_version": "understudy.dspy_gepa_adapter.v1",
        "status": status,
        "reason": reason,
        "adapter": "dspy-gepa",
        "model": args.model,
        "provider_calls": evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "spend_evidence": evidence,
        "run_state_path": ".understudy/optimize-workload/dspy-gepa/run-state.json",
    })
    raise SystemExit(exit_code)


def _dspy_gepa_execute(args: argparse.Namespace, ledger: SpendLedger) -> None:
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

    rows = load_rows(args.samples)
    input_keys = split_keys(args.input_keys)
    output_keys = split_keys(args.output_keys)
    train_rows, dev_rows, holdout_count = split_train_dev(rows, args.split_key, args.train_split, args.dev_split)
    for row in [*train_rows, *dev_rows]:
        missing = [key for key in [*input_keys, *output_keys] if key not in row]
        if missing:
            raise ValueError(f"sample row is missing keys: {', '.join(missing)}")

    lm = BudgetedLM(
        normalize_dspy_model(args.model),
        spend_ledger=ledger,
        api_key=api_key,
        api_base=normalize_gateway_url(gateway_url),
        max_tokens=int(args.max_tokens),
        cache=False,
        num_retries=0,
    )
    dspy.configure(lm=lm)
    signature = dspy.Signature(f"{', '.join(input_keys)} -> {', '.join(output_keys)}")
    student = dspy.ChainOfThought(signature) if args.module == "cot" else dspy.Predict(signature)

    def to_example(row: dict[str, Any]) -> Any:
        return dspy.Example(**{key: row[key] for key in [*input_keys, *output_keys]}).with_inputs(*input_keys)

    trainset = [to_example(row) for row in train_rows]
    devset = [to_example(row) for row in dev_rows]

    baseline_prediction = student(**{key: train_rows[0][key] for key in input_keys})
    baseline_feedback = exact_match_feedback(output_keys, trainset[0], baseline_prediction)

    def metric(gold: Any, pred: Any, trace: Any = None, pred_name: str | None = None, pred_trace: Any = None) -> Any:
        return exact_match_feedback(output_keys, gold, pred)

    teleprompter = dspy.GEPA(
        metric=metric,
        max_metric_calls=int(args.max_metric_calls),
        reflection_minibatch_size=1,
        reflection_lm=lm,
        use_merge=False,
        track_stats=False,
    )
    optimized = teleprompter.compile(student, trainset=trainset, valset=devset)

    spend_evidence = ledger.evidence()
    candidate = {
        "schema_version": "understudy.dspy_gepa_candidate.v1",
        "adapter": "dspy-gepa",
        "model": args.model,
        "module": args.module,
        "input_keys": input_keys,
        "output_keys": output_keys,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "baseline_first_score": float(baseline_feedback.score),
        "baseline_first_feedback": baseline_feedback.feedback,
        "optimized_program_class": optimized.__class__.__name__,
        "spend_evidence": spend_evidence,
    }
    optimize_dir = Path(args.repo) / ".understudy" / "optimize-workload"
    optimize_dir.mkdir(parents=True, exist_ok=True)
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
        "dev_count": len(devset),
        "candidate": ".understudy/optimize-workload/candidate.json",
        "spend_evidence": spend_evidence,
    }
    write_owner_only_json(proof_path, proof)
    write_dspy_run_state(args, ledger, "candidate-created", None)
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v1",
        "status": "candidate-created",
        "adapter": "dspy-gepa",
        "model": args.model,
        "provider_calls": spend_evidence["calls_attempted"] > 0,
        "optimizer_execution": True,
        "auth_source": os.environ.get("UNDERSTUDY_AUTH_SOURCE", "unknown"),
        "gateway_url_configured": True,
        "api_key_configured": True,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "holdout_count_excluded": holdout_count,
        "max_metric_calls": int(args.max_metric_calls),
        "candidate_path": ".understudy/optimize-workload/candidate.json",
        "proof_packet_path": ".understudy/optimize-workload/proof-packet.json",
        "run_state_path": ".understudy/optimize-workload/dspy-gepa/run-state.json",
        "spend_evidence": spend_evidence,
    })


def dspy_gepa(args: argparse.Namespace) -> None:
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
    except KeyboardInterrupt:
        emit_dspy_failure(args, ledger, "cancelled", "optimizer-cancelled", 130)
    except ImportError:
        emit_dspy_failure(args, ledger, "error", "runtime-dependency-error", 3)
    except ValueError:
        emit_dspy_failure(args, ledger, "error", "invalid-runtime-input", 3)
    except Exception:
        emit_dspy_failure(args, ledger, "error", "optimizer-execution-failed", 3)


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
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    dspy_gepa_parser = sub.add_parser("dspy-gepa")
    dspy_gepa_parser.add_argument("--repo", required=True)
    dspy_gepa_parser.add_argument("--samples", required=True)
    dspy_gepa_parser.add_argument("--input-keys", required=True)
    dspy_gepa_parser.add_argument("--output-keys", required=True)
    dspy_gepa_parser.add_argument("--module", default="predict")
    dspy_gepa_parser.add_argument("--model", required=True)
    dspy_gepa_parser.add_argument("--max-metric-calls", default="3")
    dspy_gepa_parser.add_argument("--split-key", default="split")
    dspy_gepa_parser.add_argument("--train-split", default="train")
    dspy_gepa_parser.add_argument("--dev-split", default="dev")
    dspy_gepa_parser.add_argument("--max-tokens", default="256")
    dspy_gepa_parser.add_argument("--budget-usd", required=True)
    dspy_gepa_parser.add_argument("--input-usd-per-million", required=True)
    dspy_gepa_parser.add_argument("--output-usd-per-million", required=True)
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
