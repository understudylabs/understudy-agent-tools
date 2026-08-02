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
H200_PRICE_PER_HOUR = 4.54
EXECUTOR_AUTH_ENV = "VLLM_API_KEY"

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name(MODEL_CACHE_VOLUME, create_if_missing=True)
adapters = modal.Volume.from_name(ADAPTER_VOLUME, create_if_missing=True)
idempotency_store = modal.Dict.from_name(
    EXECUTOR_IDEMPOTENCY_DICT, create_if_missing=True
)
job_store = modal.Dict.from_name(EXECUTOR_JOB_DICT, create_if_missing=True)

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
        claimed = await idempotency_store.put.aio(
            idempotency_key, job_id, skip_if_exists=True
        )
        existing_job_id = await idempotency_store.get.aio(idempotency_key)
        if existing_job_id:
            job_id = existing_job_id
        record = await job_store.get.aio(job_id)
        action = submission_action(record)
        if action == "return_existing":
            return {"job": job_id, "status": record.get("status", "queued")}
        if action == "create_record":
            record = {
                "job": job_id,
                "idempotencyKey": idempotency_key,
                "status": "queued",
                "request": request,
            }
            await job_store.put.aio(job_id, record, skip_if_exists=True)
            record = await job_store.get.aio(job_id, record)
        if submission_action(record) == "return_existing":
            return {"job": job_id, "status": record.get("status", "queued")}
        call = execute_experiment.spawn(job_id, request)
        record["functionCallId"] = call.object_id
        await job_store.put.aio(job_id, record)
        return {"job": job_id, "status": "queued"}

    @api.get("/experiments/{job_id}")
    async def inspect_experiment(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        public = dict(record)
        public.pop("request", None)
        return {"job": job_id, "status": public.get("status", "unknown")}

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
        if call_id:
            modal.FunctionCall.from_id(call_id).cancel(terminate_containers=True)
        record["status"] = "cancelled"
        cancelled_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        record["cancelledAt"] = cancelled_at
        await job_store.put.aio(job_id, record)
        return {
            "job": job_id,
            "disposition": "cancelled",
            "observed_at": cancelled_at,
        }

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
            return {
                "job": job_id,
                "evidence_scope": "unknown",
                "estimated_usd": None,
                "actual_usd": None,
                "requests": None,
                "tokens": None,
                "gpu_seconds": None,
            }
        return {
            "job": job_id,
            "evidence_scope": "unknown",
            "estimated_usd": duration / 3600 * H200_PRICE_PER_HOUR,
            "actual_usd": None,
            "requests": None,
            "tokens": None,
            "gpu_seconds": duration,
        }

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
