"""Inference backend resolution — Understudy-first, BYO fallback."""
from __future__ import annotations

from understudy_agent_tools.inference import (
    UNDERSTUDY_API_BASE_ENV,
    UNDERSTUDY_API_KEY_ENV,
    login_status,
    resolve_backend,
    understudy_credential,
)

# allow_keychain=False keeps these deterministic on any machine (a dev's real
# keychain credential must not change test outcomes).


def test_login_status_env(monkeypatch):
    monkeypatch.setenv(UNDERSTUDY_API_KEY_ENV, "sk_test")
    assert login_status(allow_keychain=False) == {"logged_in": True, "source": "env"}


def test_login_status_logged_out(monkeypatch):
    monkeypatch.delenv(UNDERSTUDY_API_KEY_ENV, raising=False)
    assert login_status(allow_keychain=False) == {"logged_in": False, "source": None}


def test_credential_env_wins_and_strips(monkeypatch):
    monkeypatch.setenv(UNDERSTUDY_API_KEY_ENV, "  sk_x  ")
    assert understudy_credential(allow_keychain=False) == "sk_x"


def test_resolve_backend_defaults_to_understudy_when_logged_in_and_configured(monkeypatch):
    monkeypatch.setenv(UNDERSTUDY_API_KEY_ENV, "sk_test")
    monkeypatch.setenv(UNDERSTUDY_API_BASE_ENV, "https://gw.example.com")
    backend = resolve_backend(allow_keychain=False)
    assert backend.kind == "understudy"
    assert backend.base_url == "https://gw.example.com/v1"
    assert backend.api_key == "sk_test"


def test_resolve_backend_byo_when_credential_but_no_base(monkeypatch):
    monkeypatch.setenv(UNDERSTUDY_API_KEY_ENV, "sk_test")
    monkeypatch.delenv(UNDERSTUDY_API_BASE_ENV, raising=False)
    backend = resolve_backend(allow_keychain=False)
    assert backend.kind == "byo"  # logged in but gateway base not configured
    assert "understudy login" in backend.note


def test_resolve_backend_falls_back_to_byo_and_recommends_login(monkeypatch):
    monkeypatch.delenv(UNDERSTUDY_API_KEY_ENV, raising=False)
    monkeypatch.delenv(UNDERSTUDY_API_BASE_ENV, raising=False)
    backend = resolve_backend(allow_keychain=False)
    assert backend.kind == "byo"
    assert backend.base_url is None and backend.api_key is None
    assert "understudy login" in backend.note  # nudges the default path


def test_prefer_understudy_false_forces_byo(monkeypatch):
    monkeypatch.setenv(UNDERSTUDY_API_KEY_ENV, "sk_test")
    monkeypatch.setenv(UNDERSTUDY_API_BASE_ENV, "https://gw.example.com")
    backend = resolve_backend(prefer_understudy=False, allow_keychain=False)
    assert backend.kind == "byo"
