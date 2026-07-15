export const localClassifierRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import statistics
import sys
import time
from collections import Counter
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


def read_jsonl(path: Path, expected_sha256: str) -> list[dict[str, Any]]:
    raw = path.read_bytes()
    if sha256_bytes(raw) != expected_sha256:
        raise ValueError(f"split hash changed after dataset preparation: {path}")
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"split row {index} is not an object: {path}")
        for key in ("example_id", "group_id", "text", "label"):
            if not isinstance(value.get(key), str) or not value[key]:
                raise ValueError(f"split row {index} is missing {key}: {path}")
        rows.append(value)
    return rows


def phase(run_id: str, name: str, message: str, **extra: Any) -> None:
    emit({
        "type": "phase",
        "run_id": run_id,
        "phase": name,
        "message": message,
        **extra,
    })


def synchronize(torch: Any, device: Any) -> None:
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize(device)


def safe_ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def classification_metrics(
    expected: list[int], predicted: list[int], labels: list[str]
) -> dict[str, Any]:
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


def directory_evidence(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    for candidate in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = candidate.relative_to(path).as_posix().encode("utf-8")
        payload = candidate.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
        size += len(payload)
    return digest.hexdigest(), size


class RowsDataset:
    def __init__(self, rows: list[dict[str, Any]], tokenizer: Any, label_to_id: dict[str, int], max_length: int):
        self.rows = rows
        self.tokenizer = tokenizer
        self.label_to_id = label_to_id
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, Any]:
        row = self.rows[index]
        encoded = self.tokenizer(row["text"], truncation=True, max_length=self.max_length)
        encoded["labels"] = self.label_to_id[row["label"]]
        return encoded


def train(request_path: Path) -> None:
    started = time.perf_counter()
    request = read_json(request_path)
    run_id = str(request["run_id"])
    model_id = str(request["model_id"])
    model_revision = request.get("model_revision")
    seed = int(request["seed"])
    max_length = int(request["max_length"])
    epochs = int(request["epochs"])
    batch_size = int(request["batch_size"])
    learning_rate = float(request["learning_rate"])
    manifest = read_json(Path(request["dataset_manifest_path"]))

    phase_times: dict[str, float] = {}
    mark = time.perf_counter()
    phase(run_id, "preparing", "Verifying the immutable local dataset and group-aware split.")
    split_policy = manifest.get("split_policy", {})
    if manifest.get("schema_version") != "understudy.capture_import.classification_dataset.v2":
        raise ValueError("training requires classification dataset schema v2")
    if (
        split_policy.get("name") != "deterministic-stratified-group-aware-v2"
        or split_policy.get("group_normalization") != "casefold-reference-stripping-v1"
        or split_policy.get("no_group_overlap") is not True
        or not isinstance(split_policy.get("group_key"), str)
        or not split_policy["group_key"]
    ):
        raise ValueError("training requires explicit group-aware split evidence")

    split_rows: dict[str, list[dict[str, Any]]] = {}
    split_groups: dict[str, set[str]] = {}
    for split_name in ("train", "dev", "holdout"):
        split = manifest["splits"][split_name]
        rows = read_jsonl(Path(split["path"]), str(split["sha256"]))
        if len(rows) != int(split["row_count"]):
            raise ValueError(f"{split_name} row count changed after dataset preparation")
        split_rows[split_name] = rows
        split_groups[split_name] = {str(row["group_id"]) for row in rows}
    for left, right in (("train", "dev"), ("train", "holdout"), ("dev", "holdout")):
        overlap = split_groups[left] & split_groups[right]
        if overlap:
            raise ValueError(f"group leakage detected between {left} and {right}")
    labels = list(manifest["labels"])
    if len(labels) < 2 or any(not isinstance(label, str) or not label for label in labels):
        raise ValueError("dataset must define at least two non-empty labels")
    label_to_id = {label: index for index, label in enumerate(labels)}
    for split_name, rows in split_rows.items():
        unknown = sorted({str(row["label"]) for row in rows} - set(labels))
        if unknown:
            raise ValueError(f"{split_name} contains labels absent from the dataset manifest")
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression

    linear_vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        min_df=1,
        max_features=50_000,
        sublinear_tf=True,
    )
    linear_train = linear_vectorizer.fit_transform([row["text"] for row in split_rows["train"]])
    linear_model = LogisticRegression(max_iter=1_000, random_state=seed, class_weight="balanced")
    linear_model.fit(linear_train, [label_to_id[row["label"]] for row in split_rows["train"]])
    phase_times["preparing"] = (time.perf_counter() - mark) * 1000

    mark = time.perf_counter()
    phase(run_id, "downloading", "Resolving the pinned local training runtime and model weights.")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    import numpy as np
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, DataCollatorWithPadding, Trainer, TrainerCallback, TrainingArguments, set_seed

    set_seed(seed)
    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=model_revision)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_id,
        revision=model_revision,
        num_labels=len(labels),
        id2label={index: label for index, label in enumerate(labels)},
        label2id=label_to_id,
        ignore_mismatched_sizes=True,
    )
    phase_times["downloading"] = (time.perf_counter() - mark) * 1000

    train_dataset = RowsDataset(split_rows["train"], tokenizer, label_to_id, max_length)
    dev_dataset = RowsDataset(split_rows["dev"], tokenizer, label_to_id, max_length)
    model_path = Path(request["model_path"])
    checkpoint_path = Path(request["checkpoint_path"])
    checkpoint_path.mkdir(parents=True, exist_ok=True, mode=0o700)

    def compute_metrics(value: Any) -> dict[str, float]:
        logits, expected = value
        predicted = np.argmax(logits, axis=-1).tolist()
        metrics = classification_metrics(expected.tolist(), predicted, labels)
        return {"accuracy": metrics["accuracy"], "macro_f1": metrics["macro_f1"]}

    class PhaseCallback(TrainerCallback):
        def on_epoch_end(self, args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
            epoch = int(round(float(state.epoch or 0)))
            phase(run_id, "training", f"Finished training epoch {epoch} of {epochs}.", epoch=epoch, current=epoch, total=epochs)
            return control

    training_args = TrainingArguments(
        output_dir=str(checkpoint_path),
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=learning_rate,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_strategy="no",
        load_best_model_at_end=True,
        metric_for_best_model="macro_f1",
        greater_is_better=True,
        save_total_limit=1,
        seed=seed,
        data_seed=seed,
        report_to=[],
        disable_tqdm=True,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=dev_dataset,
        data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
        compute_metrics=compute_metrics,
        callbacks=[PhaseCallback()],
    )
    mark = time.perf_counter()
    phase(run_id, "training", f"Training {model_id} locally for {epochs} epoch(s).", epoch=0, current=0, total=epochs)
    trainer.train()
    phase_times["training"] = (time.perf_counter() - mark) * 1000

    mark = time.perf_counter()
    phase(run_id, "evaluating", "Running the one reserved held-out evaluation.")
    model.eval()
    device = next(model.parameters()).device
    expected_ids: list[int] = []
    predicted_ids: list[int] = []
    latencies: list[float] = []
    failures: list[dict[str, Any]] = []
    with torch.no_grad():
        for row in split_rows["holdout"]:
            encoded = tokenizer(row["text"], truncation=True, max_length=max_length, return_tensors="pt")
            encoded = {key: tensor.to(device) for key, tensor in encoded.items()}
            synchronize(torch, device)
            inference_started = time.perf_counter()
            logits = model(**encoded).logits[0]
            synchronize(torch, device)
            latency_ms = (time.perf_counter() - inference_started) * 1000
            predicted = int(torch.argmax(logits).item())
            expected = label_to_id[row["label"]]
            expected_ids.append(expected)
            predicted_ids.append(predicted)
            latencies.append(latency_ms)
            if predicted != expected and len(failures) < 25:
                failures.append({
                    "example_id": row["example_id"],
                    "group_id": row["group_id"],
                    "text_sha256": sha256_bytes(row["text"].encode("utf-8")),
                    "expected_label": labels[expected],
                    "predicted_label": labels[predicted],
                })
    heldout_metrics = classification_metrics(expected_ids, predicted_ids, labels)
    linear_predictions = linear_model.predict(
        linear_vectorizer.transform([row["text"] for row in split_rows["holdout"]])
    ).tolist()
    linear_metrics = classification_metrics(expected_ids, linear_predictions, labels)
    majority_label = Counter(row["label"] for row in split_rows["train"]).most_common(1)[0][0]
    majority_predictions = [label_to_id[majority_label] for _ in expected_ids]
    majority_metrics = classification_metrics(expected_ids, majority_predictions, labels)
    failure_count = sum(1 for expected, predicted in zip(expected_ids, predicted_ids, strict=True) if expected != predicted)
    weakest_classes = sorted(
        (
            {"label": item["label"], "recall": item["recall"], "f1": item["f1"], "support": item["support"]}
            for item in heldout_metrics["per_class"]
        ),
        key=lambda item: (item["recall"], item["f1"], item["label"]),
    )[:5]
    minimum_recall = min((item["recall"] for item in heldout_metrics["per_class"]), default=0.0)
    if heldout_metrics["macro_f1"] <= linear_metrics["macro_f1"]:
        verdict_status = "not_better"
        verdict_reason = "The trained model did not beat the TF-IDF logistic baseline on held-out macro-F1."
    elif heldout_metrics["macro_f1"] < 0.75 or minimum_recall < 0.5:
        verdict_status = "improved_not_ready"
        verdict_reason = "The trained model beat the linear baseline, but held-out macro-F1 or weakest-class recall is below the conservative bar."
    else:
        verdict_status = "promising"
        verdict_reason = "The trained model cleared the initial held-out quality bars; repeat validation is still required before use."
    phase_times["evaluating"] = (time.perf_counter() - mark) * 1000

    mark = time.perf_counter()
    phase(run_id, "saving", "Saving the local classifier and immutable evaluation evidence.")
    model_path.mkdir(parents=True, exist_ok=True, mode=0o700)
    trainer.save_model(str(model_path))
    tokenizer.save_pretrained(str(model_path))
    model_sha256, model_size_bytes = directory_evidence(model_path)
    phase_times["saving"] = (time.perf_counter() - mark) * 1000

    resolved_revision = getattr(model.config, "_commit_hash", None) or model_revision
    runtime_packages = []
    for package in ("torch", "transformers", "accelerate", "safetensors", "scikit-learn"):
        try:
            runtime_packages.append(f"{package}=={importlib.metadata.version(package)}")
        except importlib.metadata.PackageNotFoundError:
            pass
    result = {
        "schema_version": "understudy.capture_import.classification_run.v1",
        "run_id": run_id,
        "generated_at": request["generated_at"],
        "status": "completed",
        "local_only": True,
        "data_boundary": {"dataset_uploaded": False, "telemetry_sent": False, "model_download_required": True},
        "training": request["training"],
        "resource_preflight": request["resource_preflight"],
        "dataset": request["dataset_evidence"],
        "split_evidence": {
            "policy": "deterministic-stratified-group-aware-v2",
            "group_key": split_policy["group_key"],
            "group_normalization": "casefold-reference-stripping-v1",
            "no_group_overlap": True,
            "verified_no_group_overlap": True,
            "group_counts": {name: len(groups) for name, groups in split_groups.items()},
        },
        "model": {
            "requested_id": model_id,
            "resolved_id": str(getattr(model.config, "_name_or_path", model_id)),
            "revision": resolved_revision,
            "format": "transformers-sequence-classification",
            "path": str(model_path),
            "sha256": model_sha256,
            "size_bytes": model_size_bytes,
            "labels": labels,
        },
        "runtime": {
            "runtime_sha256": request["runtime_sha256"],
            "python_version": ".".join(map(str, sys.version_info[:3])),
            "packages": runtime_packages,
            "device": str(device),
            "seed": seed,
        },
        "baseline": {"name": "majority-class", "label": majority_label, "accuracy": majority_metrics["accuracy"], "macro_f1": majority_metrics["macro_f1"]},
        "linear_baseline": {"name": "tfidf-logistic-regression", "accuracy": linear_metrics["accuracy"], "macro_f1": linear_metrics["macro_f1"]},
        "verdict": {
            "status": verdict_status,
            "comparison_baseline": "tfidf-logistic-regression",
            "one_run_only": True,
            "reason": verdict_reason,
        },
        "heldout": {
            "row_count": len(expected_ids),
            "accuracy": heldout_metrics["accuracy"],
            "macro_f1": heldout_metrics["macro_f1"],
            "latency_ms_p50": statistics.median(latencies) if latencies else 0.0,
            "per_class": heldout_metrics["per_class"],
            "weakest_classes": weakest_classes,
            "confusion_matrix": heldout_metrics["confusion_matrix"],
            "failures": failures,
            "failure_count": failure_count,
            "failures_truncated": failure_count > len(failures),
        },
        "timings_ms": {"total": (time.perf_counter() - started) * 1000, **phase_times},
        "events_path": request["events_path"],
        "manifest_path": request["run_manifest_path"],
    }
    emit({"type": "result", "result": result})


def predict(request: dict[str, Any]) -> None:
    run = read_json(Path(request["run_manifest_path"]))
    if run.get("status") != "completed" or not isinstance(run.get("model"), dict):
        raise ValueError("prediction requires a completed classification run")
    model_path = Path(run["model"]["path"])
    if not model_path.is_dir():
        raise ValueError("the completed run's model artifact is missing")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(str(model_path), local_files_only=True)
    model.eval()
    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")
    model.to(device)
    encoded = tokenizer(request["text"], truncation=True, max_length=int(request["max_length"]), return_tensors="pt")
    encoded = {key: tensor.to(device) for key, tensor in encoded.items()}
    with torch.no_grad():
        synchronize(torch, device)
        started = time.perf_counter()
        logits = model(**encoded).logits[0]
        probabilities = torch.softmax(logits, dim=-1)
        synchronize(torch, device)
        latency_ms = (time.perf_counter() - started) * 1000
    labels = list(run["model"]["labels"])
    scores = sorted(
        ({"label": label, "score": float(probabilities[index].item())} for index, label in enumerate(labels)),
        key=lambda item: item["score"],
        reverse=True,
    )
    emit({
        "schema_version": "understudy.capture_import.classification_prediction.v1",
        "run_id": run["run_id"],
        "text_sha256": sha256_bytes(request["text"].encode("utf-8")),
        "label": scores[0]["label"],
        "scores": scores,
        "model_id": run["model"]["resolved_id"],
        "latency_ms": latency_ms,
        "local_only": True,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    train_parser = subparsers.add_parser("train")
    train_parser.add_argument("--request", required=True)
    predict_parser = subparsers.add_parser("predict")
    predict_request = predict_parser.add_mutually_exclusive_group(required=True)
    predict_request.add_argument("--request")
    predict_request.add_argument("--request-stdin", action="store_true")
    args = parser.parse_args()
    if args.command == "train":
        train(Path(args.request))
    else:
        request = json.loads(sys.stdin.read()) if args.request_stdin else read_json(Path(args.request))
        if not isinstance(request, dict):
            raise ValueError("prediction request must be a JSON object")
        predict(request)


if __name__ == "__main__":
    main()
`;
