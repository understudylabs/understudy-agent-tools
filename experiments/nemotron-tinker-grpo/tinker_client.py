"""Shared Tinker client construction for hosted experiment glue."""

from __future__ import annotations

import os

import tinker
from tinker import types


def create_service_client() -> tinker.ServiceClient:
    """Create a service client, optionally disabling pyqwest via an explicit env flag."""
    if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
        config = types.ClientConfigResponse(use_pyqwest_transport=False)
        return tinker.ServiceClient(_client_config=config.model_dump())
    return tinker.ServiceClient()
