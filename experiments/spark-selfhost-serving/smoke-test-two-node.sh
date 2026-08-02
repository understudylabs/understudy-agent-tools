#!/usr/bin/env bash
set -euo pipefail

hosts=(understudy-alpha understudy-bravo)

for host in "${hosts[@]}"; do
  echo "=== ${host} ==="
  ssh "$host" 'bash -s' <<'REMOTE'
set +e
echo "--- hostname ---"
hostname
echo "--- id ---"
id
echo "--- sudo -n true ---"
if sudo -n true >/dev/null 2>&1; then
  echo "sudo -n true: succeeded"
else
  status=$?
  echo "sudo -n true: failed (status ${status})"
fi
echo "--- SSH permissions ---"
ls -ld "$HOME/.ssh"
ls -l "$HOME/.ssh/authorized_keys"
echo "--- /home listing ---"
ls -la /home/
echo "--- protected home probe ---"
if ls -ld /home/understudy >/dev/null 2>&1; then
  echo "FAIL: /home/understudy was readable"
else
  echo "PASS: /home/understudy access denied"
fi
echo "--- listeners 443/5153 ---"
ss -ltnp 2>/dev/null | grep -E '(:443|:5153)([[:space:]]|$)' || true
echo "--- uname -m ---"
uname -m
echo "--- free -g ---"
free -g
echo "--- nvidia-smi ---"
nvidia-smi
REMOTE
done
