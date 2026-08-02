#!/usr/bin/env bash
set -euo pipefail

# No-sudo userspace Tailscale bootstrap for this private Spark access lane.
# The auth key is consumed by tailscale up and is never printed.

VERSION="${TAILSCALE_VERSION:-1.90.2}"
ARCH="${TAILSCALE_ARCH:-amd64}"
WORKDIR="${TAILSCALE_WORKDIR:-${HOME}/.cache/tailscale/${VERSION}-${ARCH}}"
STATE="${TAILSCALE_STATE_DIR:-${HOME}/tsstate}"
HOSTNAME="${TAILSCALE_HOSTNAME:-devin-spark-session}"
SOCKET="${TAILSCALE_SOCKET:-${STATE}/tailscaled.sock}"
TAILSCALED="${WORKDIR}/tailscale_${VERSION}_${ARCH}/tailscaled"
TAILSCALE="${WORKDIR}/tailscale_${VERSION}_${ARCH}/tailscale"
PIDFILE="${STATE}/tailscaled.pid"

if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
  echo "TAILSCALE_AUTH_KEY must be set" >&2
  exit 2
fi

mkdir -p "$WORKDIR" "$STATE"
archive="${WORKDIR}/tailscale_${VERSION}_${ARCH}.tgz"
if [[ ! -x "$TAILSCALED" || ! -x "$TAILSCALE" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://pkgs.tailscale.com/stable/tailscale_${VERSION}_${ARCH}.tgz" \
    --output "$archive"
  tar -xzf "$archive" -C "$WORKDIR"
fi

if ! "$TAILSCALE" --socket="$SOCKET" status >/dev/null 2>&1; then
  nohup "$TAILSCALED" \
    --tun=userspace-networking \
    --socket="$SOCKET" \
    --statedir="$STATE" \
    --socks5-server=localhost:1055 \
    --outbound-http-proxy-listen=localhost:1056 \
    >"${STATE}/tailscaled.log" 2>&1 &
  echo "$!" >"$PIDFILE"
  for _ in {1..50}; do
    "$TAILSCALE" --socket="$SOCKET" status >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

"$TAILSCALE" --socket="$SOCKET" up \
  --auth-key="$TAILSCALE_AUTH_KEY" \
  --hostname="$HOSTNAME" \
  --accept-routes=false

status_json="$("$TAILSCALE" --socket="$SOCKET" status --json)"
printf '%s\n' "$status_json" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
self_node = data.get("Self", {})
tags = self_node.get("Tags", [])
print("self hostname:", self_node.get("HostName", "<unknown>"))
print("self tailscale address:", (self_node.get("TailscaleIPs") or ["<unknown>"])[0])
print("self tags:", json.dumps(tags))
if "tag:devin" not in tags:
    raise SystemExit("expected tag:devin on self node")
'
