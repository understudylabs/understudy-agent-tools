import importlib.util
import json
import os
import pathlib
import struct
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import MagicMock, patch


ROOT = pathlib.Path(__file__).parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


CONTRACT = load("nemotron_long_context_contract", SCRIPTS / "nemotron_long_context_contract.py")
EXPORT = load("nemotron_long_context_export", SCRIPTS / "export-tinker-nemotron-long-context.py")
PARITY = load("nemotron_long_context_parity", SCRIPTS / "nemotron-long-context-parity.py")
CANARY = load("nemotron_serving_parity_canary", SCRIPTS / "nemotron-serving-parity-canary.py")

PARITY_TOOLS = [{
    "type": "function",
    "function": {
        "name": "lookup",
        "description": "Lookup a value",
        "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}},
    },
}]
PARITY_SAMPLING = {
    "temperature": 0,
    "top_p": None,
    "max_tokens": 4096,
    "tool_choice": "auto",
    "chat_template_kwargs": {"enable_thinking": False},
}


def identity_decorator(*_args, **_kwargs):
    return lambda function: function


fake_modal = types.ModuleType("modal")
fake_app = MagicMock()
fake_app.function.side_effect = identity_decorator
fake_modal.App = MagicMock(return_value=fake_app)
fake_modal.Volume = MagicMock()
fake_modal.Volume.from_name.return_value = MagicMock()
fake_modal.Secret = MagicMock()
fake_modal.Secret.from_name.return_value = MagicMock()
fake_modal.Image = MagicMock()
fake_modal.Image.from_registry.return_value = MagicMock()
fake_modal.web_server = identity_decorator
previous_modal = sys.modules.get("modal")
sys.modules["modal"] = fake_modal
DEPLOY = load("nemotron_long_context_deploy", SCRIPTS / "modal-vllm-nemotron-long-context.py")
MERGE = load("nemotron_long_context_merge", SCRIPTS / "modal-nemotron-merge-export.py")
if previous_modal is None:
    del sys.modules["modal"]
else:
    sys.modules["modal"] = previous_modal


def write_safetensors(path: pathlib.Path, tensors: dict[str, list[int]]):
    offset = 0
    header = {}
    payload = bytearray()
    for name, shape in tensors.items():
        elements = 1
        for dimension in shape:
            elements *= dimension
        size = elements * 2
        header[name] = {"dtype": "BF16", "shape": shape, "data_offsets": [offset, offset + size]}
        payload.extend(b"\0" * size)
        offset += size
    encoded = json.dumps(header, separators=(",", ":")).encode()
    path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + payload)


def adapter(root: pathlib.Path, tensors: dict[str, list[int]], targets: list[str]):
    root.mkdir()
    (root / "adapter_config.json").write_text(json.dumps({
        "base_model_name_or_path": CONTRACT.BASE_MODEL,
        "target_modules": targets,
        "r": 16,
    }))
    write_safetensors(root / "adapter_model.safetensors", tensors)


class NemotronLongContextServingTest(unittest.TestCase):
    def test_canary_requires_readiness_before_any_inference_post(self):
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError("https://serve/health", 503, "cold", {}, None)
        rows = [{
            "case_id": "first", "model": "model", "messages": [], "tools": [],
            "sampling": {}, "expected_assistant_message": {},
        }]
        receipt = CANARY.run(rows, "https://serve/v1/chat/completions", "https://serve/health", {}, "a" * 64, readiness_attempts=1, opener=opener)
        self.assertFalse(receipt["ready"])
        self.assertEqual(receipt["inference_posts"], 0)
        self.assertEqual(opener.open.call_count, 1)

    def test_canary_rejects_hash_only_expected_message_before_network(self):
        opener = MagicMock()
        row = {
            "case_id": "continuation", "model": "model", "messages": [], "tools": [],
            "sampling": {}, "expected_assistant_message_sha256": "e" * 64,
        }
        with self.assertRaisesRegex(ValueError, "expected_assistant_message as dict"):
            CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "e" * 64, opener=opener)
        opener.open.assert_not_called()

    def test_canary_rejects_expected_message_hash_mismatch_before_network(self):
        opener = MagicMock()
        row = {
            "case_id": "first", "model": "model", "messages": [], "tools": [],
            "sampling": {}, "expected_assistant_message": {},
            "expected_assistant_message_sha256": "f" * 64,
        }
        with self.assertRaisesRegex(ValueError, "expected assistant message hash mismatch"):
            CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "f" * 64, opener=opener)
        opener.open.assert_not_called()

    def test_canary_rejects_dependency_coerced_tool_arguments_before_network(self):
        opener = MagicMock()
        row = {
            "case_id": "continuation", "model": "model",
            "messages": [{
                "role": "assistant",
                "tool_calls": [{
                    "id": "call-1", "type": "function",
                    "function": {"name": "lookup", "arguments": {"x": 1}},
                }],
            }],
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "expected_assistant_message": {"tool_calls": []},
        }
        with self.assertRaisesRegex(ValueError, "arguments must remain a JSON string"):
            CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "f" * 64, opener=opener)
        opener.open.assert_not_called()

    def test_canary_accepts_wire_string_tool_arguments_without_coercion(self):
        class Response:
            status = 200
            def __init__(self, body=b"{}"):
                self.body = body
            def read(self):
                return self.body

        expected = {
            "tool_calls": [{
                "id": "call-2", "type": "function",
                "function": {"name": "lookup", "arguments": "{\"x\":1}"},
            }],
        }
        body = json.dumps({
            "choices": [{"message": expected, "finish_reason": "tool_calls"}],
            "usage": {"completion_tokens": 1},
        }).encode()
        opener = MagicMock()
        opener.open.side_effect = [Response(), Response(body)]
        row = {
            "case_id": "continuation", "model": "model",
            "messages": [{"role": "assistant", **expected}],
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "expected_assistant_message": expected,
        }
        receipt = CANARY.run(
            [row], "https://serve/v1/chat/completions", "https://serve/health", {},
            "f" * 64, readiness_attempts=1, opener=opener,
        )
        self.assertTrue(receipt["passed"])
        self.assertEqual(receipt["inference_posts"], 1)

    def test_canary_rejects_source_context_overflow_before_network(self):
        opener = MagicMock()
        row = {
            "case_id": "continuation", "model": "model",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS,
            "sampling": {**PARITY_SAMPLING, "max_tokens": 256},
            "expected_assistant_message": {"tool_calls": []},
            "source_prompt_tokens": 63_500,
            "source_context_limit": 65_536,
            "source_context_safety_margin": 2_048,
        }
        with self.assertRaisesRegex(ValueError, "exceeds source sampler context budget before network"):
            CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "f" * 64, opener=opener)
        opener.open.assert_not_called()

    def test_canary_accepts_source_context_budget_at_boundary(self):
        class Response:
            status = 200
            def __init__(self, body=b"{}"):
                self.body = body
            def read(self):
                return self.body

        expected = {"tool_calls": []}
        body = json.dumps({
            "choices": [{"message": expected, "finish_reason": "stop"}],
            "usage": {"completion_tokens": 1},
        }).encode()
        opener = MagicMock()
        opener.open.side_effect = [Response(), Response(body)]
        row = {
            "case_id": "continuation", "model": "model",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS,
            "sampling": {**PARITY_SAMPLING, "max_tokens": 256},
            "expected_assistant_message": expected,
            "source_prompt_tokens": 63_232,
            "source_context_limit": 65_536,
            "source_context_safety_margin": 2_048,
        }
        receipt = CANARY.run(
            [row], "https://serve/v1/chat/completions", "https://serve/health", {},
            "f" * 64, readiness_attempts=1, opener=opener,
        )
        self.assertTrue(receipt["passed"])

    def test_canary_exposes_redirect_and_suppresses_dependent_continuation(self):
        class Response:
            def __init__(self, status, body=b"{}"):
                self.status = status
                self.body = body
            def read(self):
                return self.body

        opener = MagicMock()
        opener.open.side_effect = [
            Response(200),
            urllib.error.HTTPError("https://serve/v1/chat/completions", 303, "redirect", {}, None),
        ]
        base = {
            "model": "model",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS,
            "sampling": PARITY_SAMPLING,
            "expected_assistant_message": {"tool_calls": []},
        }
        rows = [{**base, "case_id": "first"}, {**base, "case_id": "continuation", "continuation_of": "first"}]
        receipt = CANARY.run(rows, "https://serve/v1/chat/completions", "https://serve/health", {}, "b" * 64, readiness_attempts=1, opener=opener)
        self.assertEqual(receipt["inference_posts"], 1)
        self.assertEqual(receipt["rows"][0]["outcome"], "transport_failure")
        self.assertIsNone(receipt["rows"][0]["action_parity"])
        self.assertEqual(receipt["rows"][1]["outcome"], "suppressed_parent_transport_failure")
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(receipt["artifact_sha256"], "b" * 64)
        self.assertRegex(receipt["bundle_sha256"], r"^[a-f0-9]{64}$")

    def test_canary_allows_bounded_readiness_rechecks_but_one_inference_post(self):
        class Response:
            def __init__(self, status, body=b"{}"):
                self.status = status
                self.body = body
            def read(self):
                return self.body

        expected = {"tool_calls": [{"function": {"name": "lookup", "arguments": "{\"x\":1}"}}]}
        body = json.dumps({"choices": [{"message": expected, "finish_reason": "tool_calls"}], "usage": {"completion_tokens": 8}}).encode()
        opener = MagicMock()
        opener.open.side_effect = [
            urllib.error.HTTPError("https://serve/health", 303, "pending", {}, None),
            Response(200),
            Response(200, body),
        ]
        row = {
            "case_id": "first", "model": "model",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "expected_assistant_message": expected,
        }
        receipt = CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "c" * 64, readiness_attempts=2, opener=opener)
        self.assertTrue(receipt["passed"])
        self.assertEqual([item["status"] for item in receipt["readiness"]], [303, 200])
        self.assertEqual(receipt["inference_posts"], 1)

    def test_canary_retains_redacted_shape_for_malformed_response(self):
        class Response:
            def __init__(self, status, body=b"{}"):
                self.status = status
                self.body = body
            def read(self):
                return self.body

        malformed = {
            "choices": [{"message": ["secret-generated-content"], "finish_reason": "stop"}],
            "usage": {"completion_tokens": 7, "private_extension": "secret"},
            "provider_private": "secret",
        }
        body = json.dumps(malformed).encode()
        opener = MagicMock()
        opener.open.side_effect = [Response(200), Response(200, body)]
        row = {
            "case_id": "continuation", "model": "model",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "expected_assistant_message": {"tool_calls": []},
        }
        receipt = CANARY.run([row], "https://serve/v1/chat/completions", "https://serve/health", {}, "d" * 64, opener=opener)
        result = receipt["rows"][0]
        self.assertEqual(result["outcome"], "malformed_response")
        self.assertEqual(result["parse_error_type"], "AttributeError")
        self.assertEqual(result["parse_error_stage"], "actual_tool_calls")
        self.assertEqual(result["body_bytes"], len(body))
        self.assertRegex(result["body_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(result["response_shape"]["top_level_keys"], ["choices", "provider_private", "usage"])
        self.assertEqual(result["response_shape"]["message_type"], "list")
        self.assertEqual(result["response_shape"]["usage_value_types"], {
            "completion_tokens": "int", "private_extension": "str",
        })
        self.assertNotIn("secret", json.dumps(result))

    def test_canary_shape_records_tool_call_structure_without_values(self):
        message = {
            "content": None,
            "tool_calls": [{
                "id": "secret-id",
                "type": "function",
                "function": {"name": "secret-name", "arguments": "secret-arguments"},
            }],
        }
        shape = CANARY._response_shape({
            "choices": [{"message": message, "finish_reason": "tool_calls"}],
            "usage": {"completion_tokens": 1},
        })
        self.assertEqual(shape["tool_call_0_keys"], ["function", "id", "type"])
        self.assertEqual(shape["tool_call_0_function_keys"], ["arguments", "name"])
        self.assertNotIn("secret", json.dumps(shape))

    def test_modal_merge_is_cpu_only_hash_bound_and_private(self):
        source = (SCRIPTS / "modal-nemotron-merge-export.py").read_text()
        self.assertIn("cpu=8", source)
        self.assertIn("memory=65536", source)
        self.assertNotIn('gpu=', source)
        self.assertIn("expected_adapter_sha256", source)
        self.assertIn("expected_config_sha256", source)
        self.assertIn('"holdout_accessed": False', source)
        self.assertIn('merge_strategy="shard"', source)

    def test_compatible_adapter_can_use_multi_lora(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "adapter"
            adapter(root, {
                "base_model.model.layers.0.mixer.q_proj.lora_A.weight": [16, 32],
                "base_model.model.layers.0.mixer.q_proj.lora_B.weight": [32, 16],
            }, ["q_proj"])
            inspection = CONTRACT.inspect_peft_adapter(root)
            self.assertTrue(inspection["multi_lora_faithful"])
            self.assertEqual(CONTRACT.choose_artifact_kind(inspection)[0], "peft-lora")

    def test_nonempty_incompatible_tensor_forces_merged_hf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "adapter"
            adapter(root, {
                "base_model.model.layers.0.mixer.gate_proj.lora_A.weight": [16, 32],
                "base_model.model.layers.0.mixer.gate_proj.lora_B.weight": [32, 16],
            }, ["gate_proj"])
            inspection = CONTRACT.inspect_peft_adapter(root)
            self.assertFalse(inspection["multi_lora_faithful"])
            self.assertEqual(CONTRACT.choose_artifact_kind(inspection)[0], "merged-hf")

    def test_unknown_nonempty_tensor_fails_closed_to_merged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "adapter"
            adapter(root, {"unexpected.weight": [4, 4]}, ["q_proj"])
            inspection = CONTRACT.inspect_peft_adapter(root)
            self.assertEqual(CONTRACT.choose_artifact_kind(inspection)[0], "merged-hf")

    def test_export_requires_explicit_confirmation_before_provider_import(self):
        args = types.SimpleNamespace(confirm_export=False, tinker_path="tinker://x", output_dir=pathlib.Path("/tmp/x"))
        with patch.object(EXPORT, "_provider_weights") as provider:
            with self.assertRaisesRegex(ValueError, "--confirm-export"):
                EXPORT.export_command(args)
            provider.assert_not_called()

    def test_export_downloads_the_exact_bf16_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "base"
            fake_hub = types.ModuleType("huggingface_hub")
            download = MagicMock(return_value=str(destination))
            fake_hub.snapshot_download = download
            with patch.object(EXPORT.importlib.util, "find_spec", return_value=object()), patch.dict(
                sys.modules, {"huggingface_hub": fake_hub}
            ):
                self.assertEqual(EXPORT._pinned_base_snapshot(destination), destination)
            download.assert_called_once_with(
                repo_id=CONTRACT.BASE_MODEL,
                revision=CONTRACT.BASE_REVISION,
                local_dir=str(destination),
            )

    def test_modal_command_pins_bf16_revision_and_131k_without_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact_root = root / "model-a"
            artifact_root.mkdir()
            (artifact_root / "config.json").write_text("{}")
            digest, files = CONTRACT.sha256_tree(artifact_root)
            receipt = {
                "schema_version": CONTRACT.EXPORT_SCHEMA,
                "created_at": "2026-08-04T00:00:00Z",
                "base_model": CONTRACT.BASE_MODEL,
                "base_revision": CONTRACT.BASE_REVISION,
                "source_checkpoint": {"ref": "tinker://x"},
                "inspection": {"incompatible_nonempty_tensors": [{}], "multi_lora_faithful": False},
                "selection": {"artifact_kind": "merged-hf"},
                "artifact": {"path": str(artifact_root), "sha256": digest, "files": files},
                "serving": {
                    "max_model_len": 131072, "truncate_messages": False,
                    "reasoning_parser": "nano_v3", "tool_call_parser": "qwen3_coder",
                    "reasoning_parser_plugin_sha256": CONTRACT.REASONING_PARSER_PLUGIN_SHA256,
                    "renderer": CONTRACT.RENDERER,
                    "chat_template_kwargs": CONTRACT.CHAT_TEMPLATE_KWARGS,
                },
                "privacy": {"holdout_accessed": False, "dev_labels_accessed": False},
            }
            with patch.object(DEPLOY, "MODEL_ROOT", root):
                command = DEPLOY.build_vllm_command("model-a", receipt)
            joined = " ".join(command)
            self.assertIn("--max-model-len 131072", joined)
            self.assertIn("--tokenizer-revision " + CONTRACT.BASE_REVISION, joined)
            self.assertIn("--reasoning-parser nano_v3", joined)
            self.assertIn("--reasoning-parser-plugin " + CONTRACT.REASONING_PARSER_PLUGIN, joined)
            self.assertIn("--tool-call-parser qwen3_coder", joined)
            self.assertNotIn("truncate", joined)

    def test_modal_deployment_is_proxy_authenticated_and_fused(self):
        source = (SCRIPTS / "modal-vllm-nemotron-long-context.py").read_text()
        self.assertIn("requires_proxy_auth=True", source)
        self.assertIn('GPU_OPTIONS = ["H200", "B200", "H100:2"]', source)
        self.assertIn('"event": "serving_gpu_inventory"', source)
        self.assertIn("ARTIFACT_SECRET_NAME", source)
        self.assertIn("max_containers=1", source)
        self.assertIn("SCALEDOWN_WINDOW_SECONDS = 300", source)
        self.assertIn('"PYTHONPATH": "/opt/understudy"', source)
        self.assertIn("copy=True", source)
        self.assertNotIn("--api-key", source)
        self.assertIn("REASONING_PARSER_PLUGIN_SHA256", source)

    def test_two_gpu_fallback_enables_tensor_parallelism(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact_root = root / "model-a"
            artifact_root.mkdir()
            (artifact_root / "config.json").write_text("{}")
            digest, files = CONTRACT.sha256_tree(artifact_root)
            receipt = {
                "schema_version": CONTRACT.EXPORT_SCHEMA,
                "created_at": "2026-08-04T00:00:00Z",
                "base_model": CONTRACT.BASE_MODEL,
                "base_revision": CONTRACT.BASE_REVISION,
                "source_checkpoint": {"ref": "tinker://x"},
                "inspection": {"incompatible_nonempty_tensors": [{}], "multi_lora_faithful": False},
                "selection": {"artifact_kind": "merged-hf"},
                "artifact": {"path": str(artifact_root), "sha256": digest, "files": files},
                "serving": {
                    "max_model_len": 131072, "truncate_messages": False,
                    "reasoning_parser": "nano_v3", "tool_call_parser": "qwen3_coder",
                    "reasoning_parser_plugin_sha256": CONTRACT.REASONING_PARSER_PLUGIN_SHA256,
                    "renderer": CONTRACT.RENDERER,
                    "chat_template_kwargs": CONTRACT.CHAT_TEMPLATE_KWARGS,
                },
                "privacy": {"holdout_accessed": False, "dev_labels_accessed": False},
            }
            with patch.object(DEPLOY, "MODEL_ROOT", root):
                command = DEPLOY.build_vllm_command("model-a", receipt, gpu_count=2)
            self.assertEqual(command[-2:], ["--tensor-parallel-size", "2"])

    def test_proxy_auth_contract_requires_both_headers(self):
        with self.assertRaises(ValueError):
            CONTRACT.require_proxy_auth_environment({"MODAL_PROXY_KEY": "key"})
        self.assertEqual(
            CONTRACT.require_proxy_auth_environment({"MODAL_PROXY_KEY": "key", "MODAL_PROXY_SECRET": "secret"}),
            ("key", "secret"),
        )

    def test_full_messages_and_tool_ids_are_preserved_in_parity(self):
        messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": [{"type": "text", "text": "run"}]},
            {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "lookup", "arguments": "{\"x\":1}"}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": "result"},
        ]
        row = {
            "case_id": "case-1", "messages": messages, "input_tokens": 130000,
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "truncated": False, "finish_reason": "tool_calls",
            "completion_tokens": 42,
            "assistant_message": {"tool_calls": [{"function": {"name": "lookup", "arguments": "{\"x\":1}"}}]},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            left, right = root / "tinker.jsonl", root / "vllm.jsonl"
            line = json.dumps(row) + "\n"
            left.write_text(line); right.write_text(line)
            receipt = PARITY.score(left, right, "a" * 64)
        self.assertTrue(receipt["passed"])
        self.assertTrue(receipt["messages_preserved"])
        self.assertTrue(receipt["tools_preserved"])
        self.assertTrue(receipt["sampling_contract_preserved"])
        self.assertFalse(receipt["truncation_observed"])
        self.assertFalse(receipt["generation_truncation_observed"])

    def test_parity_rejects_truncation_or_changed_messages(self):
        base = {
            "case_id": "case-1", "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS, "sampling": PARITY_SAMPLING,
            "input_tokens": 12, "truncated": False, "finish_reason": "stop", "assistant_message": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); left = root / "a"; right = root / "b"
            left.write_text(json.dumps(base) + "\n")
            changed = dict(base); changed["messages"] = [{"role": "user", "content": "y"}]
            right.write_text(json.dumps(changed) + "\n")
            with self.assertRaisesRegex(ValueError, "messages changed"):
                PARITY.score(left, right, "b" * 64)

    def test_parity_rejects_output_cap_truncation(self):
        row = {
            "case_id": "case-1",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS,
            "sampling": {**PARITY_SAMPLING, "max_tokens": 256},
            "input_tokens": 12,
            "completion_tokens": 256,
            "truncated": False,
            "finish_reason": "length",
            "assistant_message": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            left, right = root / "a", root / "b"
            line = json.dumps(row) + "\n"
            left.write_text(line); right.write_text(line)
            receipt = PARITY.score(left, right, "c" * 64)
        self.assertFalse(receipt["passed"])
        self.assertTrue(receipt["generation_truncation_observed"])

    def test_parity_rejects_changed_tools_or_sampling(self):
        base = {
            "case_id": "case-1",
            "messages": [{"role": "user", "content": "x"}],
            "tools": PARITY_TOOLS,
            "sampling": PARITY_SAMPLING,
            "input_tokens": 12,
            "truncated": False,
            "finish_reason": "stop",
            "assistant_message": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            left, right = root / "a", root / "b"
            left.write_text(json.dumps(base) + "\n")
            changed_tools = {**base, "tools": [*PARITY_TOOLS, {
                "type": "function",
                "function": {"name": "other", "parameters": {"type": "object"}},
            }]}
            right.write_text(json.dumps(changed_tools) + "\n")
            with self.assertRaisesRegex(ValueError, "tool catalog changed"):
                PARITY.score(left, right, "d" * 64)

            changed_sampling = {**base, "sampling": {**PARITY_SAMPLING, "max_tokens": 256}}
            right.write_text(json.dumps(changed_sampling) + "\n")
            with self.assertRaisesRegex(ValueError, "sampling contract changed"):
                PARITY.score(left, right, "e" * 64)


if __name__ == "__main__":
    unittest.main()
