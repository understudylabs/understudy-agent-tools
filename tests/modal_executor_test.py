import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import types
import unittest
from unittest.mock import MagicMock


ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "modal-vllm-nemotron-lora.py"
os.environ["UNDERSTUDY_EXECUTOR_SCHEMA_DIRECTORY"] = str(ROOT / "schemas")


def identity_decorator(*_args, **_kwargs):
    return lambda function: function


fake_modal = types.ModuleType("modal")
fake_app = MagicMock()
fake_app.function.side_effect = identity_decorator
fake_app.local_entrypoint.side_effect = identity_decorator
fake_modal.App = MagicMock(return_value=fake_app)
fake_modal.Volume = MagicMock()
fake_modal.Volume.from_name.return_value = MagicMock()
fake_modal.Dict = MagicMock()
fake_modal.Dict.from_name.return_value = MagicMock()
fake_modal.Image = MagicMock()
fake_modal.Image.from_registry.return_value = MagicMock()
fake_modal.Secret = MagicMock()
fake_modal.Secret.from_name.return_value = MagicMock()
fake_modal.FunctionCall = MagicMock()
fake_modal.web_server = identity_decorator
fake_modal.asgi_app = identity_decorator
fake_modal.concurrent = identity_decorator
sys.modules.setdefault("modal", fake_modal)

SPEC = importlib.util.spec_from_file_location("modal_executor", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ModalExecutorLogicTest(unittest.TestCase):
    def test_authorization_rejects_missing_malformed_and_wrong_credentials(self):
        self.assertFalse(MODULE.authorization_valid(None, "secret"))
        self.assertFalse(MODULE.authorization_valid("Basic secret", "secret"))
        self.assertFalse(MODULE.authorization_valid("Bearer wrong", "secret"))
        self.assertTrue(MODULE.authorization_valid("Bearer secret", "secret"))

    def test_atomic_launch_claim_allows_only_one_spawn(self):
        queued = {"job_id": "job-1", "status": "queued"}
        self.assertEqual(MODULE.submission_action(None), "create_record")
        self.assertEqual(MODULE.submission_action(queued, True), "spawn")
        self.assertEqual(MODULE.submission_action(queued, False), "return_ambiguous")

    def test_crash_after_claim_never_spawns_on_retry(self):
        launching = {
            "job_id": "job-1",
            "status": "queued",
            "launch_state": "launching",
        }
        self.assertEqual(
            MODULE.submission_action(launching, False), "return_ambiguous"
        )
        launching["function_call_id"] = "fc-1"
        launching["launch_state"] = "launched"
        self.assertEqual(
            MODULE.submission_action(launching, False), "return_existing"
        )

    def test_cancelled_state_is_monotonic(self):
        cancelled = {"job_id": "job-1", "status": "cancelled"}
        self.assertEqual(
            MODULE.monotonic_status(cancelled, "succeeded")["status"], "cancelled"
        )
        self.assertEqual(
            MODULE.monotonic_status(cancelled, "failed")["status"], "cancelled"
        )

    def test_vendored_executor_schemas_match_platform_manifest(self):
        manifest = json.loads(
            (ROOT / "schemas" / "understudy-train-contract-manifest.json").read_text()
        )
        names = [
            "experiment-executor-submit-request.json",
            "experiment-executor-job-ref.json",
            "experiment-executor-job-status.json",
            "experiment-executor-cancellation-receipt.json",
            "experiment-executor-usage-receipt.json",
        ]
        for name in names:
            digest = hashlib.sha256((ROOT / "schemas" / name).read_bytes()).hexdigest()
            self.assertEqual(digest, manifest["schemas"][name], name)

    def test_server_receipts_validate_against_vendored_schemas(self):
        job = {
            "executor": "modal",
            "job_id": "job-1",
            "idempotency_key": "exp-1:candidate-a:0",
            "submitted_at": "2026-08-02T00:00:00Z",
        }
        fixtures = {
            "experiment-executor-job-ref": job,
            "experiment-executor-job-status": {
                "state": "running",
                "observed_at": "2026-08-02T00:00:01Z",
                "artifact_refs": [],
            },
            "experiment-executor-cancellation-receipt": {
                "job": job,
                "disposition": "cancelled",
                "observed_at": "2026-08-02T00:00:02Z",
            },
            "experiment-executor-usage-receipt": {
                "evidence_scope": "unknown",
                "requests": None,
                "input_tokens": None,
                "output_tokens": None,
                "actual_usd": None,
                "estimated_usd": 1.0,
                "upper_bound_usd": 1.0,
                "observed_at": "2026-08-02T00:00:03Z",
            },
        }
        for name, payload in fixtures.items():
            self.assertEqual(MODULE._validate_payload(name, payload), payload)


if __name__ == "__main__":
    unittest.main()
