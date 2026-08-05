"""Provider-free static safety checks for the private Tinker serving entrypoint."""

from pathlib import Path


SHIM = (Path(__file__).parents[1] / "scripts" / "tinker-openai-shim.py").read_text()
MODAL_SHIM = (
    Path(__file__).parents[1] / "scripts" / "modal-tinker-openai-shim.py"
).read_text()


def test_request_accounting_wraps_request_parsing() -> None:
    increment = SHIM.index("active_requests += 1")
    protected = SHIM.index("try:", increment)
    parse = SHIM.index("body = parse_chat_request", protected)
    cleanup = SHIM.index("active_requests -= 1", parse)
    assert increment < protected < parse < cleanup


def test_network_auth_requires_attested_modal_runtime_or_token() -> None:
    assert 'os.environ.get("TINKER_TRUSTED_PROXY_AUTH") == "modal"' in SHIM
    assert 'bool(os.environ.get("MODAL_TASK_ID"))' in SHIM
    assert "and not trusted_modal_proxy" in SHIM


def test_tool_calls_override_finish_reason() -> None:
    assert 'if message.get("tool_calls"):' in SHIM
    assert 'finish_reason = "tool_calls"' in SHIM


def test_logs_expose_only_error_class() -> None:
    error_log = 'log_event("error", request_id=request_id, error=type(error).__name__)'
    assert error_log in SHIM
    assert "detail=str(error)" not in SHIM


def test_modal_registry_override_uses_secret_plane() -> None:
    assert 'modal.Secret.from_dict(' in MODAL_SHIM
    assert '"TINKER_MODEL_REGISTRY_JSON_OVERRIDE": registry_override' in MODAL_SHIM
    assert 'os.environ.get("TINKER_MODEL_REGISTRY_JSON_OVERRIDE")' in MODAL_SHIM
    assert '.env({"TINKER_MODEL_REGISTRY_JSON"' not in MODAL_SHIM
