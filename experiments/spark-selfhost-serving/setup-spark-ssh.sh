#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SPARK_DEVIN_SSH_KEY_B64:-}" ]]; then
  echo "SPARK_DEVIN_SSH_KEY_B64 must be set" >&2
  exit 2
fi

SSH_DIR="${SSH_DIR:-${HOME}/.ssh}"
KEY_PATH="${SPARK_DEVIN_SSH_KEY_PATH:-${SSH_DIR}/spark-devin}"
CONFIG_PATH="${SSH_CONFIG_PATH:-${SSH_DIR}/config}"
TAILSCALE_SOCKET="${TAILSCALE_SOCKET:-${HOME}/tsstate/tailscaled.sock}"
BEGIN="# BEGIN understudy Spark access"
END="# END understudy Spark access"

umask 077
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
printf '%s' "$SPARK_DEVIN_SSH_KEY_B64" | base64 --decode >"$KEY_PATH"
chmod 600 "$KEY_PATH"

printf 'key fingerprint: '
ssh-keygen -lf "$KEY_PATH"

touch "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"
tmp_config="$(mktemp "${CONFIG_PATH}.XXXXXX")"
awk -v begin="$BEGIN" -v end="$END" '
  $0 == begin { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "$CONFIG_PATH" >"$tmp_config"
cat >>"$tmp_config" <<EOF
$BEGIN
Host understudy-alpha
    HostName 100.109.118.78
    User devin
    Port 22
    IdentityFile $KEY_PATH
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ConnectTimeout 20
    ProxyCommand tailscale --socket=$TAILSCALE_SOCKET nc %h %p

Host understudy-bravo
    HostName 100.100.181.10
    User devin
    Port 22
    IdentityFile $KEY_PATH
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ConnectTimeout 20
    ProxyCommand tailscale --socket=$TAILSCALE_SOCKET nc %h %p
$END
EOF
mv "$tmp_config" "$CONFIG_PATH"

# Userspace networking has no TUN interface; this box has no nc, and its socat
# lacks SOCKS5 support, so tailscale nc is the required ProxyCommand.
echo "SSH config entries installed for understudy-alpha and understudy-bravo"
