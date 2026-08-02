#!/usr/bin/env bash
set -euo pipefail

VERSION="${TAILSCALE_VERSION:-1.90.2}"
ARCH="${TAILSCALE_ARCH:-amd64}"
WORKDIR="${TAILSCALE_WORKDIR:-$HOME/.cache/tailscale/${VERSION}-${ARCH}}"
SOCKET="${TAILSCALE_SOCKET:-$HOME/.tailscale/tailscaled.sock}"
STATE="${TAILSCALE_STATE:-$HOME/.tailscale/tailscaled.state}"
LOG="${TAILSCALE_LOG:-$HOME/.tailscale/tailscaled.log}"
SOCKS5_PORT="${TAILSCALE_SOCKS5_PORT:-1055}"
HTTP_PROXY_PORT="${TAILSCALE_HTTP_PROXY_PORT:-1056}"
ADVERTISE_TAGS="${SPARK_ADVERTISE_TAGS:-}"
ARCHIVE="${WORKDIR}/tailscale_${VERSION}_${ARCH}.tgz"
BIN_DIR="${WORKDIR}/tailscale_${VERSION}_${ARCH}"
TAILSCALED="${BIN_DIR}/tailscaled"
TAILSCALE="${BIN_DIR}/tailscale"
SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --no-smoke) SMOKE=0 ;;
    --smoke) SMOKE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
  echo "TAILSCALE_AUTH_KEY is unset; enrollment is paused. Export the org secret and rerun." >&2
  exit 2
fi

if ! command -v tailscaled >/dev/null || ! command -v tailscale >/dev/null; then
  mkdir -p "$WORKDIR"
  if [[ ! -x "$TAILSCALED" || ! -x "$TAILSCALE" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      "https://pkgs.tailscale.com/stable/tailscale_${VERSION}_${ARCH}.tgz" \
      --output "$ARCHIVE"
    tar -xzf "$ARCHIVE" -C "$WORKDIR"
  fi
  export PATH="${BIN_DIR}:${PATH}"
fi

command -v tailscaled >/dev/null || { echo "tailscaled is required; install Tailscale without sudo in this environment." >&2; exit 2; }
command -v tailscale >/dev/null || { echo "tailscale is required; install Tailscale without sudo in this environment." >&2; exit 2; }

mkdir -p "$(dirname "$SOCKET")"
if ! tailscale --socket="$SOCKET" status --json >/dev/null 2>&1; then
  if ! pgrep -f "tailscaled .*--socket=$SOCKET" >/dev/null 2>&1; then
    nohup tailscaled \
      --tun=userspace-networking \
      --socket="$SOCKET" \
      --state="$STATE" \
      --socks5-server="localhost:${SOCKS5_PORT}" \
      --outbound-http-proxy-listen="localhost:${HTTP_PROXY_PORT}" \
      >"$LOG" 2>&1 &
  fi
  for _ in {1..30}; do
    tailscale --socket="$SOCKET" status --json >/dev/null 2>&1 && break
    sleep 1
  done
fi

STATE_JSON="$(tailscale --socket="$SOCKET" status --json 2>/dev/null || true)"
if ! grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"' <<<"$STATE_JSON"; then
  HOST="$(hostname -s | tr -cd 'a-zA-Z0-9-' | cut -c1-40)"
  UP_ARGS=(
    --auth-key="$TAILSCALE_AUTH_KEY"
    --hostname="devin-${HOST:-box}"
    --accept-routes=false
    --ssh=false
  )
  if [[ -n "$ADVERTISE_TAGS" ]]; then
    UP_ARGS+=(--advertise-tags="$ADVERTISE_TAGS")
  fi
  tailscale --socket="$SOCKET" up \
    "${UP_ARGS[@]}"
else
  echo "Tailscale is already enrolled; no-op."
fi

STATE_JSON="$(tailscale --socket="$SOCKET" status --json)"
printf '%s\n' "$STATE_JSON" | python3 -c '
import json
import sys

tags = json.load(sys.stdin).get("Self", {}).get("Tags", [])
print("self tags:", json.dumps(tags))
if "tag:devin" not in tags:
    raise SystemExit("expected tag:devin in Self.Tags")
'

if (( SMOKE )); then
  node "$(dirname "$0")/spark-reachability-probe.mjs" \
    --socket "$SOCKET" \
    --socks5-port "$SOCKS5_PORT"
fi
