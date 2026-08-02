"""HTTP client for the local AutomationBench environment service."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class EnvServiceError(RuntimeError):
    """Raised when the local environment service rejects a request."""


def _request_json(url: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method=method)
    request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise EnvServiceError(f"{method} {url} failed with HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise EnvServiceError(f"{method} {url} failed: {error}") from error


@dataclass
class EnvService:
    repo: str
    process: subprocess.Popen[str] | None = None
    port: int | None = None

    def start(self) -> "EnvService":
        if self.process is not None:
            return self
        self.process = subprocess.Popen(
            ["node", "scripts/automationbench-rl-service.mjs"],
            cwd=self.repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            self.stop()
            raise EnvServiceError(f"environment service did not print a port: {stderr}")
        self.port = int(line)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if self.health().get("ok") is True:
                    return self
            except EnvServiceError:
                if self.process.poll() is not None:
                    stderr = self.process.stderr.read() if self.process.stderr is not None else ""
                    self.stop()
                    raise EnvServiceError(f"environment service exited during startup: {stderr}")
            time.sleep(0.1)
        self.stop()
        raise EnvServiceError("timed out waiting for environment service health")

    def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        self.process = None
        self.port = None

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise EnvServiceError("environment service is not running")
        return f"http://127.0.0.1:{self.port}"

    def _json(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        return _request_json(f"{self.base_url}{path}", method, body)

    def health(self) -> dict[str, Any]:
        return self._json("/health")

    def protocol(self) -> dict[str, Any]:
        return self._json("/protocol")

    def hashes(self) -> dict[str, Any]:
        return self._json("/hashes")

    def tasks(self, split: str, frozen_holdout_sha256: str | None = None) -> list[dict[str, Any]]:
        suffix = (
            f"&frozen_holdout_sha256={frozen_holdout_sha256}"
            if frozen_holdout_sha256
            else ""
        )
        return self._json(f"/tasks?split={split}{suffix}")

    def reset(self, task_id: str, frozen_holdout_sha256: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"task_id": task_id}
        if frozen_holdout_sha256:
            body["frozen_holdout_sha256"] = frozen_holdout_sha256
        return self._json("/reset", "POST", body)

    def step(self, episode_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._json(
            "/step",
            "POST",
            {"episode_id": episode_id, "action": {"name": name, "arguments": arguments}},
        )

    def finish(self, episode_id: str) -> dict[str, Any]:
        return self._json("/finish", "POST", {"episode_id": episode_id})

    def delete_episode(self, episode_id: str) -> None:
        self._json(f"/episode/{episode_id}", "DELETE")
