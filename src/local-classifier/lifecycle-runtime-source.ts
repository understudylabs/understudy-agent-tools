export const localClassifierLifecycleRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def synchronize(torch: Any, device: Any) -> None:
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize(device)


def load_model(run: dict[str, Any]) -> tuple[Any, Any, Any, list[str]]:
    model = run.get("model")
    if run.get("status") != "completed" or not isinstance(model, dict):
        raise ValueError("lifecycle operations require a completed classification run")
    model_path = Path(str(model.get("path", "")))
    if not model_path.is_dir():
        raise ValueError("the completed classifier model artifact is missing")
    labels = model.get("labels")
    if not isinstance(labels, list) or len(labels) < 2 or any(not isinstance(label, str) or not label for label in labels):
        raise ValueError("the completed classifier labels are invalid")

    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
    classifier = AutoModelForSequenceClassification.from_pretrained(str(model_path), local_files_only=True)
    classifier.eval()
    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
    classifier.to(device)
    return torch, tokenizer, classifier, device, labels


def infer(torch: Any, tokenizer: Any, model: Any, device: Any, text: str, max_length: int) -> tuple[int, list[float], float]:
    encoded = tokenizer(text, truncation=True, max_length=max_length, return_tensors="pt")
    encoded = {key: tensor.to(device) for key, tensor in encoded.items()}
    with torch.no_grad():
        synchronize(torch, device)
        started = time.perf_counter()
        logits = model(**encoded).logits[0]
        probabilities = torch.softmax(logits, dim=-1)
        synchronize(torch, device)
        latency_ms = (time.perf_counter() - started) * 1000
    predicted = int(torch.argmax(probabilities).item())
    return predicted, [float(value.item()) for value in probabilities], latency_ms


def safe_ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def classification_metrics(expected: list[int], predicted: list[int], labels: list[str]) -> dict[str, Any]:
    matrix = [[0 for _ in labels] for _ in labels]
    for gold, guess in zip(expected, predicted, strict=True):
        matrix[gold][guess] += 1
    per_class: list[dict[str, Any]] = []
    f1_values: list[float] = []
    for index, label in enumerate(labels):
        true_positive = matrix[index][index]
        false_positive = sum(matrix[row][index] for row in range(len(labels)) if row != index)
        false_negative = sum(matrix[index][column] for column in range(len(labels)) if column != index)
        precision = safe_ratio(true_positive, true_positive + false_positive)
        recall = safe_ratio(true_positive, true_positive + false_negative)
        f1 = safe_ratio(2 * precision * recall, precision + recall)
        support = sum(matrix[index])
        f1_values.append(f1)
        per_class.append({
            "label": label,
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": support,
        })
    correct = sum(1 for gold, guess in zip(expected, predicted, strict=True) if gold == guess)
    return {
        "accuracy": safe_ratio(correct, len(expected)),
        "macro_f1": safe_ratio(sum(f1_values), len(f1_values)),
        "per_class": per_class,
        "confusion_matrix": {"labels": labels, "rows": matrix},
    }


def evaluate(request: dict[str, Any]) -> None:
    run = read_json(Path(request["run_manifest_path"]))
    torch, tokenizer, model, device, labels = load_model(run)
    holdout_path = Path(request["holdout_path"])
    raw = holdout_path.read_bytes()
    if sha256_bytes(raw) != request["holdout_sha256"]:
        raise ValueError("the immutable holdout changed before repeat evaluation")
    rows: list[dict[str, Any]] = []
    for line in raw.decode("utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or any(not isinstance(row.get(key), str) or not row[key] for key in ("example_id", "group_id", "text", "label")):
            raise ValueError("the immutable holdout contains an invalid row")
        rows.append(row)
    if len(rows) != int(request["holdout_row_count"]):
        raise ValueError("the immutable holdout row count changed")

    label_to_id = {label: index for index, label in enumerate(labels)}
    expected_ids: list[int] = []
    predicted_ids: list[int] = []
    latencies: list[float] = []
    failures: list[dict[str, Any]] = []
    prediction_digest = hashlib.sha256()
    for row in rows:
        expected = label_to_id.get(row["label"])
        if expected is None:
            raise ValueError("the immutable holdout contains an unknown label")
        predicted, _, latency_ms = infer(torch, tokenizer, model, device, row["text"], int(request["max_length"]))
        expected_ids.append(expected)
        predicted_ids.append(predicted)
        latencies.append(latency_ms)
        prediction_digest.update(f'{row["example_id"]}\0{row["label"]}\0{labels[predicted]}\n'.encode("utf-8"))
        if predicted != expected and len(failures) < 25:
            failures.append({
                "example_id": row["example_id"],
                "group_id": row["group_id"],
                "text_sha256": sha256_bytes(row["text"].encode("utf-8")),
                "expected_label": row["label"],
                "predicted_label": labels[predicted],
            })
    metrics = classification_metrics(expected_ids, predicted_ids, labels)
    failure_count = sum(1 for expected, predicted in zip(expected_ids, predicted_ids, strict=True) if expected != predicted)
    weakest_classes = sorted(
        (
            {"label": item["label"], "recall": item["recall"], "f1": item["f1"], "support": item["support"]}
            for item in metrics["per_class"]
        ),
        key=lambda item: (item["recall"], item["f1"], item["label"]),
    )[:5]
    emit({
        "schema_version": "understudy.local_classifier.repeat_evaluation.runtime.v1",
        "run_id": run["run_id"],
        "row_count": len(rows),
        "accuracy": metrics["accuracy"],
        "macro_f1": metrics["macro_f1"],
        "latency_ms_p50": statistics.median(latencies) if latencies else 0.0,
        "per_class": metrics["per_class"],
        "weakest_classes": weakest_classes,
        "confusion_matrix": metrics["confusion_matrix"],
        "failures": failures,
        "failure_count": failure_count,
        "failures_truncated": failure_count > len(failures),
        "predictions_sha256": prediction_digest.hexdigest(),
        "device": str(device),
        "local_only": True,
    })


def predict_batch(request: dict[str, Any]) -> None:
    run = read_json(Path(request["run_manifest_path"]))
    torch, tokenizer, model, device, labels = load_model(run)
    rows = request.get("rows")
    if not isinstance(rows, list):
        raise ValueError("batch prediction rows must be an array")
    results: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("row_index"), int) or not isinstance(row.get("text"), str) or not row["text"]:
            raise ValueError("batch prediction contains an invalid row")
        predicted, probabilities, latency_ms = infer(torch, tokenizer, model, device, row["text"], int(request["max_length"]))
        results.append({
            "row_index": row["row_index"],
            "label": labels[predicted],
            "confidence": probabilities[predicted],
            "latency_ms": latency_ms,
        })
    emit({
        "schema_version": "understudy.local_classifier.batch_prediction.runtime.v1",
        "run_id": run["run_id"],
        "row_count": len(results),
        "rows": results,
        "device": str(device),
        "local_only": True,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("evaluate", "predict-batch"))
    parser.add_argument("--request-stdin", action="store_true", required=True)
    args = parser.parse_args()
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict):
        raise ValueError("lifecycle request must be a JSON object")
    if args.command == "evaluate":
        evaluate(request)
    else:
        predict_batch(request)


if __name__ == "__main__":
    main()
`;
