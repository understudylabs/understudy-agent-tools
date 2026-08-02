import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "modal-vllm-nemotron-lora.py"
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

    def test_claim_recovery_converges_to_one_spawn(self):
        self.assertEqual(MODULE.submission_action(None), "create_record")
        record = {"job": "job-1", "status": "queued"}
        self.assertEqual(MODULE.submission_action(record), "spawn")
        record["functionCallId"] = "fc-1"
        self.assertEqual(MODULE.submission_action(record), "return_existing")
        self.assertEqual(MODULE.submission_action(record), "return_existing")


if __name__ == "__main__":
    unittest.main()
