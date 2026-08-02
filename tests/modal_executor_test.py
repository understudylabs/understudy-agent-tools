import importlib.util
import hashlib
import json
import pathlib
import unittest

from jsonschema import Draft202012Validator, FormatChecker


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "modal-vllm-nemotron-lora.py"
SPEC = importlib.util.spec_from_file_location("modal_executor", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
SCHEMA_DIR = SCRIPT.parents[1] / "schemas"


class ModalExecutorLogicTest(unittest.TestCase):
    def test_canonical_manifest_and_jsonschema_validation(self):
        manifest = json.loads(
            (SCHEMA_DIR / "experiment-executor-contract-manifest.json").read_text()
        )
        for filename, expected in manifest["schemas"].items():
            if filename.startswith("experiment-executor-"):
                actual = hashlib.sha256((SCHEMA_DIR / filename).read_bytes()).hexdigest()
                self.assertEqual(actual, expected, filename)
        bundle = "".join(
            f"{filename}:{digest}\n"
            for filename, digest in sorted(manifest["schemas"].items())
        )
        self.assertEqual(
            hashlib.sha256(bundle.encode()).hexdigest(),
            manifest["bundle_sha256"],
        )
        job = {
            "executor": "modal",
            "job_id": "job-1",
            "idempotency_key": "exp-1:candidate-a:2",
            "submitted_at": "2026-08-02T00:00:00Z",
        }
        schema = json.loads((SCHEMA_DIR / "experiment-executor-job-ref.json").read_text())
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(job)

    def test_authorization_rejects_missing_malformed_and_wrong_credentials(self):
        self.assertFalse(MODULE.authorization_valid(None, "secret"))
        self.assertFalse(MODULE.authorization_valid("Basic secret", "secret"))
        self.assertFalse(MODULE.authorization_valid("Bearer wrong", "secret"))
        self.assertTrue(MODULE.authorization_valid("Bearer secret", "secret"))

    def test_claim_recovery_converges_to_one_spawn(self):
        self.assertEqual(MODULE.submission_action(None), "create_record")
        record = {"job": "job-1", "status": "queued"}
        self.assertEqual(MODULE.submission_action(record), "spawn")
        record["functionCallId"] = "fc-1"
        self.assertEqual(MODULE.submission_action(record), "return_existing")
        self.assertEqual(MODULE.submission_action(record), "return_existing")

    def test_lease_recovery_failure_windows_and_cancellation(self):
        records = {"job-1": {"status": "queued"}}
        leases = {}
        acks = {}
        calls = []

        def spawn():
            calls.append("function-call-1")
            return calls[-1]

        # Crash after claim: no durable record yet; retry creates the record.
        self.assertIsNone(
            MODULE.reconcile_spawn_lease({}, leases, acks, "job-1", 0, spawn)
        )
        # Crash after durable record: retry acquires a lease and spawns.
        self.assertEqual(
            MODULE.reconcile_spawn_lease(
                records, leases, acks, "job-1", 0, spawn
            ),
            "function-call-1",
        )
        self.assertEqual(len(calls), 1)

        # A concurrent retry observes the durable function call and does not spawn.
        self.assertEqual(
            MODULE.reconcile_spawn_lease(
                records, leases, acks, "job-1", 0, spawn
            ),
            "function-call-1",
        )
        self.assertEqual(len(calls), 1)

        # Crash after spawn before submit ack: worker ack is adopted on retry.
        records["job-2"] = {"status": "queued"}
        leases.clear()
        acks[MODULE._ack_key("job-2")] = "function-call-2"
        self.assertEqual(
            MODULE.reconcile_spawn_lease(
                records, leases, acks, "job-2", 0, spawn
            ),
            "function-call-2",
        )
        self.assertEqual(len(calls), 1)

        # Cancellation wins while the lease is held; no spawn follows.
        records["job-3"] = {"status": "cancelled"}
        self.assertIsNone(
            MODULE.reconcile_spawn_lease(
                records, leases, acks, "job-3", 0, spawn
            )
        )
        self.assertEqual(len(calls), 1)

    def test_concurrent_submitters_have_one_lease_winner(self):
        leases = {}
        calls = []
        self.assertTrue(MODULE.acquire_spawn_lease(leases, "job-race", 0))
        self.assertFalse(MODULE.acquire_spawn_lease(leases, "job-race", 0))
        calls.append("function-call-1")
        self.assertEqual(calls, ["function-call-1"])


if __name__ == "__main__":
    unittest.main()
