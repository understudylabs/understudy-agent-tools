#!/usr/bin/env python3
"""Probe the userspace Tailscale SOCKS5 ACL boundary without writing remotely."""

from __future__ import annotations

import os
import socket
import struct
import sys
import time
from dataclasses import dataclass

PROXY = ("127.0.0.1", 1055)
TIMEOUT_SECONDS = 5.5


@dataclass(frozen=True)
class Target:
    scope: str
    label: str
    host: str
    port: int


# Operators may add generic non-Spark targets as
# "non-Spark tailnet host A=host.example:22,non-Spark tailnet host B=host:443".
# Do not put personal device names or addresses in this source file.
TARGETS = [
    Target("ALLOWED", "spark-246e", "100.109.118.78", 22),
    Target("ALLOWED", "spark-246e", "100.109.118.78", 443),
    Target("ALLOWED", "spark-246e", "100.109.118.78", 5153),
    Target("ALLOWED", "spark-74c4", "100.100.181.10", 22),
    Target("ALLOWED", "spark-74c4", "100.100.181.10", 443),
    Target("ALLOWED", "spark-74c4", "100.100.181.10", 5153),
    Target("DENIED", "spark-246e:8080 (openshell-gateway)", "100.109.118.78", 8080),
    Target("DENIED", "spark-246e:3000", "100.109.118.78", 3000),
    Target("DENIED", "spark-74c4:8080 (openshell-gateway)", "100.100.181.10", 8080),
]


def extra_targets() -> list[Target]:
    raw = os.environ.get("NON_SPARK_TARGETS", "").strip()
    if not raw:
        return []
    result: list[Target] = []
    for item in raw.split(","):
        label, separator, address = item.partition("=")
        host, separator2, port_text = address.rpartition(":")
        if not separator or not separator2 or not label or not host:
            raise ValueError("NON_SPARK_TARGETS entries must be label=host:port")
        result.append(Target("DENIED", label.strip(), host.strip(), int(port_text)))
    return result


def probe(target: Target) -> tuple[str, float]:
    started = time.monotonic()
    sock = socket.socket()
    sock.settimeout(TIMEOUT_SECONDS)
    try:
        sock.connect(PROXY)
        sock.sendall(b"\x05\x01\x00")
        if sock.recv(2) != b"\x05\x00":
            return "proxy negotiation failed", time.monotonic() - started
        encoded_host = target.host.encode()
        if len(encoded_host) > 255:
            return "host name too long", time.monotonic() - started
        sock.sendall(
            b"\x05\x01\x00\x03"
            + bytes([len(encoded_host)])
            + encoded_host
            + struct.pack("!H", target.port)
        )
        reply = sock.recv(10)
        if not reply:
            return "no SOCKS reply", time.monotonic() - started
        code = reply[1]
        if code != 0:
            return f"refused instantly (socks-code={code})", time.monotonic() - started
        sock.settimeout(1.0)
        try:
            banner = sock.recv(64)
        except socket.timeout:
            return "open (no banner)", time.monotonic() - started
        if not banner:
            return "connect then reset", time.monotonic() - started
        return f"open (banner={banner[:40]!r})", time.monotonic() - started
    except socket.timeout:
        # The ACL drops disallowed destinations instead of returning a SOCKS
        # refusal. That produces a roughly five-second stall; an in-scope
        # address with no listener returns an immediate refusal instead.
        return "dropped (timeout)", time.monotonic() - started
    except OSError as error:
        return f"error ({type(error).__name__})", time.monotonic() - started
    finally:
        sock.close()


def main() -> int:
    targets = TARGETS + extra_targets()
    print("| Scope | Target | Port | Result | Seconds |")
    print("|---|---|---:|---|---:|")
    failures = 0
    for target in targets:
        result, elapsed = probe(target)
        print(
            f"| {target.scope} | {target.label} | {target.port} | "
            f"{result} | {elapsed:.1f} |"
        )
        if target.scope == "ALLOWED" and result.startswith("dropped"):
            failures += 1
        if target.scope == "DENIED" and result.startswith("open"):
            failures += 1
    return failures


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(f"probe configuration failed: {error}", file=sys.stderr)
        raise SystemExit(2)
