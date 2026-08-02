#!/usr/bin/env bash
set -euo pipefail

SOCKET="${TAILSCALE_SOCKET:-$HOME/.tailscale/tailscaled.sock}"
STATE="${TAILSCALE_STATE:-$HOME/.tailscale/tailscaled.state}"
LOG="${TAILSCALE_LOG:-$HOME/.tailscale/tailscaled.log}"
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
command -v tailscaled >/dev/null || { echo "tailscaled is required; install Tailscale without sudo in this environment." >&2; exit 2; }
command -v tailscale >/dev/null || { echo "tailscale is required; install Tailscale without sudo in this environment." >&2; exit 2; }

mkdir -p "$(dirname "$SOCKET")"
if ! tailscale --socket="$SOCKET" status --json >/dev/null 2>&1; then
  if ! pgrep -f "tailscaled .*--socket=$SOCKET" >/dev/null 2>&1; then
    nohup tailscaled \
      --tun=userspace-networking \
      --socket="$SOCKET" \
      --state="$STATE" \
      --socks5-server=localhost:1055 \
      --outbound-http-proxy-listen=localhost:1055 \
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
  tailscale --socket="$SOCKET" up \
    --authkey="$TAILSCALE_AUTH_KEY" \
    --hostname="devin-${HOST:-box}" \
    --advertise-tags=tag:devin \
    --accept-routes=false \
    --ssh=false
else
  echo "Tailscale is already enrolled; no-op."
fi

if (( SMOKE )); then
  node "$(dirname "$0")/spark-reachability-probe.mjs" --socket "$SOCKET"
fi
