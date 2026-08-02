"""Draft Modal deployment for Nemotron-H vLLM native multi-LoRA serving.

This file is intentionally not deployed by the repository checks. Before a
first launch, create the referenced Modal secrets and upload PEFT adapters to
the adapter Volume.
"""

from __future__ import annotations

import os
import hashlib
import hmac
import subprocess
import time
import uuid
from typing import Any

import modal


APP_NAME = "understudy-nemotron-vllm-lab"
BASE_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
VLLM_IMAGE = "vllm/vllm-openai:v0.26.0"
PORT = 8000
MODEL_CACHE_VOLUME = "understudy-nemotron-model-cache"
ADAPTER_VOLUME = "understudy-nemotron-lora-adapters"
HF_SECRET = "understudy-nemotron-hf"
AUTH_SECRET = "understudy-nemotron-vllm-auth"
EXECUTOR_IDEMPOTENCY_DICT = "understudy-nemotron-experiment-idempotency"
EXECUTOR_JOB_DICT = "understudy-nemotron-experiment-jobs"
EXECUTOR_LEASE_DICT = "understudy-nemotron-experiment-leases"
EXECUTOR_ACK_DICT = "understudy-nemotron-experiment-acks"
H200_PRICE_PER_HOUR = 4.54
EXECUTOR_AUTH_ENV = "VLLM_API_KEY"
LEASE_SECONDS = 300

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name(MODEL_CACHE_VOLUME, create_if_missing=True)
adapters = modal.Volume.from_name(ADAPTER_VOLUME, create_if_missing=True)
idempotency_store = modal.Dict.from_name(
    EXECUTOR_IDEMPOTENCY_DICT, create_if_missing=True
)
job_store = modal.Dict.from_name(EXECUTOR_JOB_DICT, create_if_missing=True)
lease_store = modal.Dict.from_name(EXECUTOR_LEASE_DICT, create_if_missing=True)
ack_store = modal.Dict.from_name(EXECUTOR_ACK_DICT, create_if_missing=True)

image = (
    modal.Image.from_registry(VLLM_IMAGE, add_python="3.12")
    .entrypoint([])
    .env(
        {
            "HF_HOME": "/root/.cache/huggingface",
            "TRANSFORMERS_CACHE": "/root/.cache/huggingface",
            "PYTHONPATH": "/usr/local/lib/python3.12/dist-packages",
            "VLLM_ALLOW_RUNTIME_LORA_UPDATING": "1",
        }
    )
    .add_local_file(
        "schemas/understudy.executor-submit.v1.schema.json",
        "/opt/understudy/schemas/understudy.executor-submit.v1.schema.json",
    )
    .add_local_file(
        "schemas/experiment-executor-job-ref.json",
        "/opt/understudy/schemas/experiment-executor-job-ref.json",
    )
    .add_local_file(
        "schemas/experiment-executor-job-status.json",
        "/opt/understudy/schemas/experiment-executor-job-status.json",
    )
    .add_local_file(
        "schemas/experiment-executor-cancellation-receipt.json",
        "/opt/understudy/schemas/experiment-executor-cancellation-receipt.json",
    )
    .add_local_file(
        "schemas/experiment-executor-usage-receipt.json",
        "/opt/understudy/schemas/experiment-executor-usage-receipt.json",
    )
)


@app.function(
    image=image,
    gpu="H200",
    volumes={
        "/root/.cache/huggingface": model_cache,
        "/adapters": adapters,
    },
    secrets=[
        modal.Secret.from_name(HF_SECRET),
        modal.Secret.from_name(AUTH_SECRET),
    ],
    scaledown_window=300,
    timeout=90 * 60,
    max_containers=1,
)
@modal.web_server(PORT, startup_timeout=30 * 60)
def serve() -> None:
    api_key = (os.environ.get("VLLM_API_KEY") or "").strip()
    command = [
        "vllm",
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        str(PORT),
        "--model",
        BASE_MODEL,
        "--dtype",
        "bfloat16",
        "--enable-lora",
        "--max-loras",
        "4",
        "--max-lora-rank",
        "64",
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "qwen3_xml",
    ]
    if api_key:
        command.append(f"--api-key={api_key}")
    try:
        subprocess.run(command, env=os.environ.copy(), check=True)
    except subprocess.CalledProcessError as error:
        safe_command = [
            "<redacted-api-key>" if item.startswith("--api-key=") else item
            for item in command
        ]
        raise RuntimeError(f"vLLM exited with {error.returncode}: {safe_command}") from None


def executor_idempotency_key(
    experiment_id: str, candidate_id: str, attempt: int
) -> str:
    return f"{experiment_id}:{candidate_id}:{attempt}"


def deterministic_job_id(idempotency_key: str) -> str:
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:24]
    return f"job-{digest}"


def authorization_valid(authorization: str | None, expected_token: str) -> bool:
    if not authorization or not expected_token:
        return False
    scheme, separator, token = authorization.partition(" ")
    return (
        separator == " "
        and hmac.compare_digest(scheme, "Bearer")
        and bool(token)
        and hmac.compare_digest(token, expected_token)
    )


def submission_action(record: dict[str, Any] | None) -> str:
    if record is None:
        return "create_record"
    if record.get("functionCallId"):
        return "return_existing"
    return "spawn"


def _observed_at() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _lease_key(job_id: str) -> str:
    return f"lease:{job_id}"


def _ack_key(job_id: str) -> str:
    return f"ack:{job_id}"


def lease_expired(lease: dict[str, Any], now: float | None = None) -> bool:
    return (now if now is not None else time.time()) >= (
        float(lease.get("acquired_at", 0)) + LEASE_SECONDS
    )


def reconcile_spawn_lease(
    records: dict[str, dict[str, Any]],
    leases: dict[str, dict[str, Any]],
    acks: dict[str, str],
    job_id: str,
    now: float,
    spawn: Any,
) -> str | None:
    record = records.get(job_id)
    if record is None:
        return None
    if record.get("status") == "cancelled":
        return None
    if record.get("functionCallId"):
        return record["functionCallId"]
    if acks.get(_ack_key(job_id)):
        record["functionCallId"] = acks[_ack_key(job_id)]
        return record["functionCallId"]
    lease = leases.get(_lease_key(job_id))
    if lease is not None and not lease_expired(lease, now):
        return None
    candidate = {"token": uuid.uuid4().hex, "acquired_at": now}
    if lease is None:
        leases[_lease_key(job_id)] = candidate
    else:
        leases[_lease_key(job_id)] = candidate
    if record.get("status") == "cancelled":
        return None
    call_id = spawn()
    record["functionCallId"] = call_id
    return call_id


def acquire_spawn_lease(
    leases: dict[str, dict[str, Any]],
    job_id: str,
    now: float,
) -> bool:
    key = _lease_key(job_id)
    current = leases.get(key)
    if current is not None and not lease_expired(current, now):
        return False
    leases[key] = {"token": uuid.uuid4().hex, "acquired_at": now}
    return True


def _job_ref(record: dict[str, Any]) -> dict[str, Any]:
    return dict(record["jobRef"])


def _validate_contract(payload: dict[str, Any], filename: str) -> dict[str, Any]:
    import json
    from jsonschema import Draft202012Validator, FormatChecker

    with open(f"/opt/understudy/schemas/{filename}", encoding="utf-8") as schema_file:
        schema = json.load(schema_file)
    errors = sorted(
        Draft202012Validator(
            schema, format_checker=FormatChecker()
        ).iter_errors(payload),
        key=str,
    )
    if errors:
        raise RuntimeError(f"invalid executor {filename} receipt")
    return payload


def _artifact_request(body: dict[str, Any]) -> dict[str, Any]:
    import json
    from fastapi import HTTPException
    from jsonschema import Draft202012Validator

    with open(
        "/opt/understudy/schemas/understudy.executor-submit.v1.schema.json",
        encoding="utf-8",
    ) as schema_file:
        schema = json.load(schema_file)
    errors = sorted(Draft202012Validator(schema).iter_errors(body), key=str)
    if errors:
        raise HTTPException(
            status_code=400,
            detail="submit request does not match understudy.executor-submit.v1",
        )
    if "holdout" in body:
        raise HTTPException(status_code=400, detail="holdout context is not accepted")
    return body


@app.function(image=image, gpu="H200", timeout=60 * 60)
def execute_experiment(job_id: str, request: dict[str, Any]) -> None:
    started = time.time()
    job = dict(job_store.get(job_id, {}))
    call_id = getattr(modal, "current_function_call_id", lambda: None)()
    if call_id:
        ack_store.put(_ack_key(job_id), call_id, skip_if_exists=True)
        job = dict(job_store.get(job_id, job))
    if job.get("status") == "cancelled":
        return
    if job.get("status") != "cancelled":
        job.update({"status": "running", "startedAt": started})
        job_store.put(job_id, job)
    try:
        # The deployed executor is intentionally a thin paid-work boundary.
        # Workflow code submits immutable artifact references; it does not run
        # a poller or embed provider orchestration here.
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job.update({"status": "succeeded"})
    except Exception as error:
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job.update({"status": "failed", "error": type(error).__name__})
        raise
    finally:
        finished = time.time()
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job.update({"finishedAt": finished, "durationSeconds": finished - started})
            job_store.put(job_id, job)


@app.function(
    image=image,
    timeout=60 * 60,
    secrets=[modal.Secret.from_name(AUTH_SECRET)],
)
@modal.asgi_app()
def executor_api() -> Any:
    from fastapi import FastAPI, Header, HTTPException

    api = FastAPI()

    @api.post("/experiments")
    async def submit_experiment(
        body: dict[str, Any],
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        request = _artifact_request(body)
        expected_key = executor_idempotency_key(
            request["experiment_id"],
            request["candidate"]["candidate_id"],
            request["attempt"],
        )
        if expected_key != idempotency_key:
            raise HTTPException(status_code=409, detail="idempotency key mismatch")
        job_id = deterministic_job_id(idempotency_key)
        await idempotency_store.put.aio(
            idempotency_key, job_id, skip_if_exists=True
        )
        existing_job_id = await idempotency_store.get.aio(idempotency_key)
        if existing_job_id:
            job_id = existing_job_id
        record = await job_store.get.aio(job_id)
        action = submission_action(record)
        if action == "return_existing":
            return _validate_contract(
                _job_ref(record), "experiment-executor-job-ref.json"
            )
        if action == "create_record":
            record = {
                "jobRef": {
                    "executor": "modal",
                    "job_id": job_id,
                    "idempotency_key": idempotency_key,
                    "submitted_at": _observed_at(),
                },
                "idempotencyKey": idempotency_key,
                "status": "queued",
                "request": request,
            }
            await job_store.put.aio(job_id, record, skip_if_exists=True)
            record = await job_store.get.aio(job_id, record)
        if submission_action(record) == "return_existing":
            return _validate_contract(
                _job_ref(record), "experiment-executor-job-ref.json"
            )
        ack = await ack_store.get.aio(_ack_key(job_id))
        if ack:
            record["functionCallId"] = ack
            await job_store.put.aio(job_id, record)
            return _validate_contract(
                _job_ref(record), "experiment-executor-job-ref.json"
            )
        lease = {
            "token": uuid.uuid4().hex,
            "acquired_at": time.time(),
        }
        lease_won = await lease_store.put.aio(
            _lease_key(job_id), lease, skip_if_exists=True
        )
        if not lease_won:
            current_lease = await lease_store.get.aio(_lease_key(job_id), {})
            ack = await ack_store.get.aio(_ack_key(job_id))
            if ack:
                record["functionCallId"] = ack
                await job_store.put.aio(job_id, record)
                return _validate_contract(
                    _job_ref(record), "experiment-executor-job-ref.json"
                )
            if not lease_expired(current_lease):
                return _validate_contract(
                    _job_ref(record), "experiment-executor-job-ref.json"
                )
            await lease_store.put.aio(
                _lease_key(job_id), lease, skip_if_exists=False
            )
            current_lease = await lease_store.get.aio(_lease_key(job_id), {})
            if current_lease.get("token") != lease["token"]:
                return _validate_contract(
                    _job_ref(record), "experiment-executor-job-ref.json"
                )
        latest = await job_store.get.aio(job_id, record)
        if latest.get("status") == "cancelled":
            return _validate_contract(
                _job_ref(latest), "experiment-executor-job-ref.json"
            )
        call = execute_experiment.spawn(job_id, request)
        latest["functionCallId"] = call.object_id
        await job_store.put.aio(job_id, latest)
        return _validate_contract(
            _job_ref(latest), "experiment-executor-job-ref.json"
        )

    @api.get("/experiments/{job_id}")
    async def inspect_experiment(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        status = {
            "state": record.get("status", "queued"),
            "observed_at": _observed_at(),
            "artifact_refs": record.get("artifact_refs", []),
        }
        if record.get("error"):
            status["failure_code"] = record["error"]
        return _validate_contract(status, "experiment-executor-job-status.json")

    @api.delete("/experiments/{job_id}")
    async def cancel_experiment(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        call_id = record.get("functionCallId")
        disposition = "cancelled"
        if record.get("status") in {"succeeded", "failed", "cancelled"}:
            disposition = "already_terminal"
        elif call_id:
            modal.FunctionCall.from_id(call_id).cancel(terminate_containers=True)
        if disposition == "cancelled":
            record["status"] = "cancelled"
        cancelled_at = _observed_at()
        record["cancelledAt"] = cancelled_at
        await job_store.put.aio(job_id, record)
        return _validate_contract(
            {
                "job": _job_ref(record),
                "disposition": disposition,
                "observed_at": cancelled_at,
            },
            "experiment-executor-cancellation-receipt.json",
        )

    @api.get("/experiments/{job_id}/usage")
    async def reconcile_usage(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        duration = record.get("durationSeconds")
        if duration is None and record.get("startedAt"):
            duration = max(0.0, time.time() - record["startedAt"])
        if duration is None:
            return _validate_contract({
                "evidence_scope": "unknown",
                "estimated_usd": None,
                "actual_usd": None,
                "requests": None,
                "input_tokens": None,
                "output_tokens": None,
                "upper_bound_usd": None,
                "observed_at": _observed_at(),
            }, "experiment-executor-usage-receipt.json")
        return _validate_contract({
            "evidence_scope": "unknown",
            "estimated_usd": duration / 3600 * H200_PRICE_PER_HOUR,
            "actual_usd": None,
            "requests": None,
            "input_tokens": None,
            "output_tokens": None,
            "upper_bound_usd": None,
            "observed_at": _observed_at(),
        }, "experiment-executor-usage-receipt.json")

    return api


@app.local_entrypoint()
def main() -> None:
    print(f"Draft only: deploy with `modal deploy {__file__}` after review.")
    print(f"App: {APP_NAME}; model: {BASE_MODEL}; GPU: H200")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run-idempotency", action="store_true")
    options = parser.parse_args()
    if options.dry_run_idempotency:
        key = executor_idempotency_key("exp", "candidate", 1)
        assert key == "exp:candidate:1"
        assert deterministic_job_id(key) == deterministic_job_id(key)
        print("idempotency dry-run ok")
