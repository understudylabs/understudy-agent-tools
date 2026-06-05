"""Default inference backend resolution.

Optimization always needs inference, so the **default path is Understudy
inference**: the lanes check whether the developer is logged in and route model
calls through the Understudy gateway (one credential, all providers,
credit-metered). When not logged in, the lanes **recommend `understudy login`**
and **fall back to the developer's own provider keys** if they'd rather not
register. So login is the expected default, not a hard gate — BYO keys remain
supported for the register-averse.

Credential resolution mirrors the agent CLI (`understudy_agent/auth.py`):
`UNDERSTUDY_API_KEY` env wins, then the macOS `Understudy-credentials` keychain
blob. The secret is never logged; `login_status()` returns only a boolean +
source.
"""
from __future__ import annotations

import getpass
import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass

UNDERSTUDY_API_KEY_ENV = "UNDERSTUDY_API_KEY"
UNDERSTUDY_API_BASE_ENV = "UNDERSTUDY_API_BASE"
CREDENTIALS_SERVICE = "Understudy-credentials"


def understudy_inference_base() -> str | None:
    """The OpenAI-compatible Understudy gateway base, from env, or None.

    The public package never hardcodes the hosted endpoint (oss-release-boundary:
    no hosted control-plane URLs in public code). `understudy login` / the env
    supplies `UNDERSTUDY_API_BASE`; we append the `/v1` OpenAI-compatible path.
    """
    base = os.environ.get(UNDERSTUDY_API_BASE_ENV, "").strip()
    if not base:
        return None
    return base.rstrip("/") + "/v1"


def _keychain_credential() -> str | None:
    """Best-effort macOS keychain read of the Understudy credential blob."""
    if platform.system() != "Darwin" or shutil.which("security") is None:
        return None
    try:
        account = getpass.getuser()
    except Exception:
        return None
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", account, "-s", CREDENTIALS_SERVICE, "-w"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return None
    if not out:
        return None
    try:
        blob = json.loads(out)
    except (json.JSONDecodeError, ValueError):
        return out or None  # legacy: raw key stored directly
    if isinstance(blob, dict):
        api_key = blob.get("apiKey")
        if isinstance(api_key, str) and api_key:
            return api_key
        oauth = blob.get("oauth")
        if isinstance(oauth, dict):
            token = oauth.get("accessToken")
            if isinstance(token, str) and token:
                return token
    return None


def understudy_credential(*, allow_keychain: bool = True) -> str | None:
    """The usable Understudy bearer, or None. Env wins, then keychain."""
    env = os.environ.get(UNDERSTUDY_API_KEY_ENV, "").strip()
    if env:
        return env
    return _keychain_credential() if allow_keychain else None


def login_status(*, allow_keychain: bool = True) -> dict[str, object]:
    """Whether the developer is logged in to Understudy, and from where. No secret."""
    if os.environ.get(UNDERSTUDY_API_KEY_ENV, "").strip():
        return {"logged_in": True, "source": "env"}
    if allow_keychain and _keychain_credential():
        return {"logged_in": True, "source": "keychain"}
    return {"logged_in": False, "source": None}


@dataclass
class InferenceBackend:
    kind: str  # "understudy" | "byo"
    base_url: str | None  # set for understudy; None for byo (provider-native)
    api_key: str | None  # never logged
    note: str


def resolve_backend(*, prefer_understudy: bool = True, allow_keychain: bool = True) -> InferenceBackend:
    """Default backend: Understudy inference when logged in + configured, else BYO.

    Routing to Understudy needs both a credential and the gateway base
    (`UNDERSTUDY_API_BASE`, set by `understudy login`/env). Either missing →
    recommend login and fall back to the developer's own provider keys.
    """
    if prefer_understudy:
        cred = understudy_credential(allow_keychain=allow_keychain)
        base = understudy_inference_base()
        if cred and base:
            return InferenceBackend(
                kind="understudy",
                base_url=base,
                api_key=cred,
                note="Logged in to Understudy — routing through Understudy inference.",
            )
    return InferenceBackend(
        kind="byo",
        base_url=None,
        api_key=None,
        note=(
            "Run `understudy login` to use Understudy inference (one key, all "
            "providers). Falling back to your own provider keys."
        ),
    )


def build_dspy_lm(model: str, backend: InferenceBackend | None = None):
    """Build a `dspy.LM` for the resolved backend (lazy dspy import).

    Understudy: OpenAI-compatible gateway (`openai/<model>` + api_base/api_key).
    BYO: native `provider/model` (dspy resolves the provider's own env keys).
    """
    import dspy

    backend = backend or resolve_backend()
    if backend.kind == "understudy":
        return dspy.LM(f"openai/{model}", api_base=backend.base_url, api_key=backend.api_key)
    return dspy.LM(model)
