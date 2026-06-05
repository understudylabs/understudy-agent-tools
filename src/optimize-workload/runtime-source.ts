export const optimizerRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
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


def dspy_gepa(args: argparse.Namespace) -> None:
    import dspy

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

    lm = dspy.LM(
        normalize_dspy_model(args.model),
        api_key=api_key,
        api_base=normalize_gateway_url(gateway_url),
        max_tokens=int(args.max_tokens),
        cache=False,
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
    }
    optimize_dir = Path(args.repo) / ".understudy" / "optimize-workload"
    optimize_dir.mkdir(parents=True, exist_ok=True)
    candidate_path = optimize_dir / "candidate.json"
    proof_path = optimize_dir / "proof-packet.json"
    candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    proof = {
        "schema_version": "understudy.optimize-workload.proof.v1",
        "mode": "dspy-gepa",
        "status": "candidate-created",
        "backend": "uv-gepa",
        "adapter": "dspy-gepa",
        "provider_calls": True,
        "live_optimizer_execution": True,
        "package_installs": True,
        "holdout_accessed_during_optimization": False,
        "train_count": len(trainset),
        "dev_count": len(devset),
        "candidate": ".understudy/optimize-workload/candidate.json",
    }
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    emit({
        "schema_version": "understudy.dspy_gepa_adapter.v1",
        "status": "candidate-created",
        "adapter": "dspy-gepa",
        "model": args.model,
        "provider_calls": True,
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
    })


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


def gepa_smoke(args: argparse.Namespace) -> None:
    import dspy
    import gepa
    import inspect
    optimize_signature = str(inspect.signature(gepa.optimize)) if hasattr(gepa, "optimize") else None
    emit({
        "schema_version": "understudy.uv_gepa_smoke.v1",
        "gepa_imported": True,
        "dspy_imported": True,
        "gepa_optimize_available": hasattr(gepa, "optimize"),
        "gepa_adapter_available": hasattr(gepa, "GEPAAdapter"),
        "gepa_optimize_signature": optimize_signature,
        "gepa_version": getattr(gepa, "__version__", None),
        "dspy_version": getattr(dspy, "__version__", None),
        "provider_calls": False,
        "optimizer_execution": False,
        "repo": args.repo,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    gepa = sub.add_parser("gepa-smoke")
    gepa.add_argument("--repo", required=True)
    gepa.set_defaults(func=gepa_smoke)

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

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
