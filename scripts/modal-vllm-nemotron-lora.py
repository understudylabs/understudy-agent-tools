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
EXECUTOR_LAUNCH_CLAIM_DICT = "understudy-nemotron-experiment-launch-claims"
H200_PRICE_PER_HOUR = 4.54
EXECUTOR_AUTH_ENV = "VLLM_API_KEY"
LAUNCH_ACK_GRACE_SECONDS = 60
SCHEMA_DIRECTORY = os.environ.get(
    "UNDERSTUDY_EXECUTOR_SCHEMA_DIRECTORY", "/opt/understudy/schemas"
)

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name(MODEL_CACHE_VOLUME, create_if_missing=True)
adapters = modal.Volume.from_name(ADAPTER_VOLUME, create_if_missing=True)
idempotency_store = modal.Dict.from_name(
    EXECUTOR_IDEMPOTENCY_DICT, create_if_missing=True
)
job_store = modal.Dict.from_name(EXECUTOR_JOB_DICT, create_if_missing=True)
launch_claim_store = modal.Dict.from_name(
    EXECUTOR_LAUNCH_CLAIM_DICT, create_if_missing=True
)

image = (
    modal.Image.from_registry(VLLM_IMAGE, add_python="3.12")
    .entrypoint([])
    .pip_install("jsonschema==4.25.1")
    .env(
        {
            "HF_HOME": "/root/.cache/huggingface",
            "TRANSFORMERS_CACHE": "/root/.cache/huggingface",
            "PYTHONPATH": "/usr/local/lib/python3.12/dist-packages",
            "VLLM_ALLOW_RUNTIME_LORA_UPDATING": "1",
        }
    )
    .add_local_dir("schemas", "/opt/understudy/schemas")
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
    ],
    scaledown_window=300,
    timeout=90 * 60,
    max_containers=1,
)
@modal.web_server(PORT, startup_timeout=30 * 60, requires_proxy_auth=True)
def serve() -> None:
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
        "--reasoning-parser",
        "nemotron_v3",
        "--tool-call-parser",
        "qwen3_xml",
    ]
    # vLLM receives no application credential. Modal's web proxy authenticates
    # requests before forwarding them to this unauthenticated loopback server,
    # keeping secrets out of vLLM argv, environment parsing, and startup logs.
    # Modal's web_server launcher must return after spawning the server so the
    # proxy can complete readiness registration and begin forwarding requests.
    subprocess.Popen(command, env=os.environ.copy())


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


def submission_action(
    record: dict[str, Any] | None, launch_claim_acquired: bool = False
) -> str:
    if record is None:
        return "create_record"
    if record.get("function_call_id") or record.get("launch_state") == "launched":
        return "return_existing"
    if record.get("launch_state") in {"launching", "ambiguous"}:
        return "return_ambiguous"
    return "spawn" if launch_claim_acquired else "return_ambiguous"


def monotonic_status(record: dict[str, Any], status: str, **updates: Any) -> dict[str, Any]:
    current = dict(record)
    if current.get("status") == "cancelled" and status != "cancelled":
        return current
    current.update({"status": status, **updates})
    return current


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def job_ref(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "executor": "modal",
        "job_id": record["job_id"],
        "idempotency_key": record["idempotency_key"],
        "submitted_at": record["submitted_at"],
    }


def _schema(name: str) -> dict[str, Any]:
    import json

    with open(f"{SCHEMA_DIRECTORY}/{name}.json", encoding="utf-8") as schema_file:
        return json.load(schema_file)


def _validate_payload(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    from jsonschema import Draft202012Validator, FormatChecker

    validator = Draft202012Validator(_schema(name), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(payload), key=str)
    if errors:
        raise ValueError(f"payload does not match {name}")
    return payload


def _artifact_request(body: dict[str, Any]) -> dict[str, Any]:
    from fastapi import HTTPException

    try:
        _validate_payload("experiment-executor-submit-request", body)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="submit request does not match understudy.executor-submit.v1",
        ) from None
    if "holdout" in body:
        raise HTTPException(status_code=400, detail="holdout context is not accepted")
    return body


@app.function(image=image, gpu="H200", timeout=60 * 60)
def execute_experiment(job_id: str, request: dict[str, Any]) -> None:
    started = time.time()
    job = dict(job_store.get(job_id, {}))
    if job.get("status") != "cancelled":
        job = monotonic_status(
            job, "running", started_at_epoch=started, observed_at=iso_now()
        )
        job_store.put(job_id, job)
    try:
        # The deployed executor is intentionally a thin paid-work boundary.
        # Workflow code submits immutable artifact references; it does not run
        # a poller or embed provider orchestration here.
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job = monotonic_status(job, "succeeded", observed_at=iso_now())
    except Exception as error:
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job = monotonic_status(
                job,
                "failed",
                failure_code=type(error).__name__,
                observed_at=iso_now(),
            )
        raise
    finally:
        finished = time.time()
        job = dict(job_store.get(job_id, job))
        if job.get("status") != "cancelled":
            job.update({
                "finished_at_epoch": finished,
                "duration_seconds": finished - started,
                "observed_at": iso_now(),
            })
            job_store.put(job_id, job)


@app.function(
    image=image,
    timeout=60 * 60,
    secrets=[modal.Secret.from_name(AUTH_SECRET)],
    max_containers=1,
)
@modal.concurrent(max_inputs=1)
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
        if record is None:
            submitted_at = iso_now()
            record = {
                "job_id": job_id,
                "idempotency_key": idempotency_key,
                "submitted_at": submitted_at,
                "status": "queued",
                "observed_at": submitted_at,
                "artifact_refs": [],
                "request": request,
            }
            await job_store.put.aio(job_id, record, skip_if_exists=True)
            record = await job_store.get.aio(job_id, record)
        if record.get("idempotency_key") != idempotency_key:
            raise HTTPException(status_code=409, detail="job id collision")
        if record.get("function_call_id"):
            return _validate_payload("experiment-executor-job-ref", job_ref(record))

        launch_claim = {
            "job_id": job_id,
            "claimed_at": iso_now(),
            "claimed_at_epoch": time.time(),
        }
        # Modal assigns a fresh opaque FunctionCall ID to every spawn and does
        # not accept an idempotency key. This immutable pre-spawn claim makes
        # paid launch at-most-once. If this process dies after claiming, a
        # retry returns the existing job and inspect reports the ambiguous
        # acknowledgement fail-closed; it never guesses by spawning again.
        launch_claim_acquired = await launch_claim_store.put.aio(
            job_id, launch_claim, skip_if_exists=True
        )
        action = submission_action(record, launch_claim_acquired)
        if action != "spawn":
            if record.get("launch_state") is None:
                record.update({
                    "launch_state": "ambiguous",
                    "launch_claimed_at": (
                        await launch_claim_store.get.aio(job_id, launch_claim)
                    )["claimed_at"],
                    "launch_claimed_at_epoch": (
                        await launch_claim_store.get.aio(job_id, launch_claim)
                    )["claimed_at_epoch"],
                    "observed_at": iso_now(),
                })
                await job_store.put.aio(job_id, record)
            return _validate_payload("experiment-executor-job-ref", job_ref(record))

        record.update({
            "launch_state": "launching",
            "launch_claimed_at": launch_claim["claimed_at"],
            "launch_claimed_at_epoch": launch_claim["claimed_at_epoch"],
            "observed_at": iso_now(),
        })
        await job_store.put.aio(job_id, record)
        try:
            call = await execute_experiment.spawn.aio(job_id, request)
        except Exception:
            record.update({
                "status": "failed",
                "launch_state": "ambiguous",
                "failure_code": "launch_failed_after_claim",
                "observed_at": iso_now(),
            })
            await job_store.put.aio(job_id, record)
            raise HTTPException(status_code=503, detail="executor launch failed") from None
        record = await job_store.get.aio(job_id, record)
        record.update({
            "function_call_id": call.object_id,
            "launch_state": "launched",
            "observed_at": iso_now(),
        })
        await job_store.put.aio(job_id, record)
        return _validate_payload("experiment-executor-job-ref", job_ref(record))

    @api.get("/experiments/{job_id}")
    async def inspect_experiment(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        state = record.get("status", "failed")
        failure_code = record.get("failure_code")
        if (
            not record.get("function_call_id")
            and record.get("launch_claimed_at_epoch")
            and time.time() - record["launch_claimed_at_epoch"] > LAUNCH_ACK_GRACE_SECONDS
            and state not in {"cancelled", "failed"}
        ):
            state = "failed"
            failure_code = "launch_acknowledgement_lost"
        payload = {
            "state": state,
            "observed_at": iso_now(),
            "artifact_refs": record.get("artifact_refs", []),
        }
        if failure_code:
            payload["failure_code"] = failure_code
        return _validate_payload("experiment-executor-job-status", payload)

    @api.delete("/experiments/{job_id}")
    async def cancel_experiment(
        job_id: str, authorization: str | None = Header(default=None)
    ) -> dict[str, Any]:
        if not authorization_valid(authorization, os.environ.get(EXECUTOR_AUTH_ENV, "")):
            raise HTTPException(status_code=401, detail="unauthorized")
        record = await job_store.get.aio(job_id)
        if not record:
            raise HTTPException(status_code=404, detail="job not found")
        observed_at = iso_now()
        if record.get("status") in {"succeeded", "failed", "cancelled"}:
            disposition = "already_terminal"
        else:
            record.update({"status": "cancelled", "observed_at": observed_at})
            await job_store.put.aio(job_id, record)
            call_id = record.get("function_call_id")
            if call_id:
                await modal.FunctionCall.from_id(call_id).cancel.aio(
                    terminate_containers=True
                )
            disposition = "cancelled"
        return _validate_payload(
            "experiment-executor-cancellation-receipt",
            {
                "job": job_ref(record),
                "disposition": disposition,
                "observed_at": observed_at,
            },
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
        duration = record.get("duration_seconds")
        if duration is None and record.get("started_at_epoch"):
            duration = max(0.0, time.time() - record["started_at_epoch"])
        estimated_usd = (
            duration / 3600 * H200_PRICE_PER_HOUR if duration is not None else None
        )
        return _validate_payload(
            "experiment-executor-usage-receipt",
            {
                "evidence_scope": "unknown",
                "requests": None,
                "input_tokens": None,
                "output_tokens": None,
                "actual_usd": None,
                "estimated_usd": estimated_usd,
                "upper_bound_usd": estimated_usd,
                "observed_at": iso_now(),
            },
        )

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
