#!/usr/bin/env bash
# mlx-arena — side-by-side local LLM arena on Apple Silicon.
#
# Serves two open-weight models with Apple MLX (mlx_lm.server, one per port),
# binds each to the Pi coding agent as an OpenAI-compatible provider, and lays
# them out in a two-pane tmux session you (or an agent) can drive in lockstep.
#
# This is the runnable core of the `mlx-arena` skill. It is intentionally a thin,
# boring orchestrator: MLX does inference, Pi is the harness, tmux is the surface.
#
# Subcommands:
#   up            start both MLX servers + the two-pane tmux arena
#   ask "<text>"  send the same prompt to BOTH panes (lockstep compare)
#   left "<text>" / right "<text>"   send a prompt to one pane only
#   capture       print a text snapshot of both panes
#   logs          tail both MLX server logs
#   status        show server health + tmux session state
#   down          tear everything down (servers + session)
#   attach        attach your terminal to the arena (interactive)
#
# Config via env (defaults target this repo's local MLX venv layout):
#   MLX_PYTHON   python with mlx_lm installed   (default: $LAB/.understudy/venvs/mlx/bin/python)
#   LAB          working dir for logs/state      (default: $PWD)
#   LEFT_LABEL/LEFT_REPO/LEFT_PORT/LEFT_PROVIDER
#   RIGHT_LABEL/RIGHT_REPO/RIGHT_PORT/RIGHT_PROVIDER
#   SESSION      tmux session name               (default: mlx-arena)
#   SYS_PROMPT   system prompt for both Pi panes
set -euo pipefail

LAB="${LAB:-$PWD}"
MLX_PYTHON="${MLX_PYTHON:-$LAB/.understudy/venvs/mlx/bin/python}"
SESSION="${SESSION:-mlx-arena}"
STATE="$LAB/.understudy/local-model-lab/arena"
LOGS="$STATE/logs"
SYS_PROMPT="${SYS_PROMPT:-You are a helpful, concise assistant. Answer directly.}"

# Two corners of the arena. Defaults: smallest Google (Gemma) vs smallest NVIDIA (Nemotron), MLX 4-bit.
# NOTE on Google: Gemma 4 E2B MLX quants don't yet load on mlx_lm 0.31.3 (KV-shared-layer
# weight mismatch — see SKILL.md "Known model-compat gotchas"). gemma-3-1b-it-4bit is the
# smallest Google chat model that loads cleanly today; bump LEFT_REPO when mlx_lm adds Gemma 4.
LEFT_LABEL="${LEFT_LABEL:-google}"
LEFT_REPO="${LEFT_REPO:-mlx-community/gemma-3-1b-it-4bit}"
LEFT_PORT="${LEFT_PORT:-8081}"
LEFT_PROVIDER="${LEFT_PROVIDER:-mlx-google}"

RIGHT_LABEL="${RIGHT_LABEL:-nvidia}"
RIGHT_REPO="${RIGHT_REPO:-mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit}"
RIGHT_PORT="${RIGHT_PORT:-8082}"
RIGHT_PROVIDER="${RIGHT_PROVIDER:-mlx-nvidia}"

mkdir -p "$LOGS"

_need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }

_serve() { # label repo port
  local label="$1" repo="$2" port="$3"
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" 2>/dev/null | grep -q 200; then
    echo "  [$label] already serving on :$port"; return 0
  fi
  echo "  [$label] starting mlx_lm.server $repo on :$port"
  nohup "$MLX_PYTHON" -m mlx_lm server --model "$repo" --host 127.0.0.1 --port "$port" \
    --trust-remote-code >"$LOGS/srv-$label.log" 2>&1 &
  echo "$!" >"$STATE/srv-$label.pid"
}

_wait_health() { # port label
  local port="$1" label="$2" i
  for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" 2>/dev/null)" = "200" ] \
      && { echo "  [$label] healthy on :$port (${i}s)"; return 0; }
    sleep 1
  done
  echo "  [$label] FAILED to become healthy — see $LOGS/srv-$label.log" >&2; return 1
}

_pi_cmd() { # provider model
  printf 'pi --provider %q --model %q --no-tools --no-context-files --no-skills --no-extensions --no-prompt-templates --system-prompt %q' \
    "$1" "$2" "$SYS_PROMPT"
}

cmd_up() {
  _need tmux; _need curl; _need pi
  [ -x "$MLX_PYTHON" ] || { echo "MLX_PYTHON not executable: $MLX_PYTHON" >&2; exit 1; }
  echo "Starting MLX servers…"
  _serve "$LEFT_LABEL"  "$LEFT_REPO"  "$LEFT_PORT"
  _serve "$RIGHT_LABEL" "$RIGHT_REPO" "$RIGHT_PORT"
  _wait_health "$LEFT_PORT"  "$LEFT_LABEL"
  _wait_health "$RIGHT_PORT" "$RIGHT_LABEL"

  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session  -d -s "$SESSION" -x 220 -y 50 -n arena
  tmux send-keys -t "$SESSION:arena.0" "$(_pi_cmd "$LEFT_PROVIDER"  "$LEFT_REPO")"  C-m
  tmux split-window -h -t "$SESSION:arena"
  tmux send-keys -t "$SESSION:arena.1" "$(_pi_cmd "$RIGHT_PROVIDER" "$RIGHT_REPO")" C-m
  tmux select-layout -t "$SESSION:arena" even-horizontal
  tmux set-option -t "$SESSION" pane-border-status top 2>/dev/null || true
  tmux select-pane -t "$SESSION:arena.0" -T " LEFT · $LEFT_LABEL · $LEFT_REPO " 2>/dev/null || true
  tmux select-pane -t "$SESSION:arena.1" -T " RIGHT · $RIGHT_LABEL · $RIGHT_REPO " 2>/dev/null || true
  sleep 2
  echo
  echo "Arena '$SESSION' is up:  LEFT=$LEFT_LABEL ($LEFT_REPO)   RIGHT=$RIGHT_LABEL ($RIGHT_REPO)"
  echo "  attach:   tmux attach -t $SESSION    (detach with Ctrl-b d)"
  echo "  lockstep: $0 ask \"your prompt\""
}

cmd_ask() {
  local text="$*"
  tmux send-keys -t "$SESSION:arena.0" -l "$text"; tmux send-keys -t "$SESSION:arena.0" C-m
  tmux send-keys -t "$SESSION:arena.1" -l "$text"; tmux send-keys -t "$SESSION:arena.1" C-m
  echo "sent to both panes: $text"
}
cmd_left()  { tmux send-keys -t "$SESSION:arena.0" -l "$*"; tmux send-keys -t "$SESSION:arena.0" C-m; }
cmd_right() { tmux send-keys -t "$SESSION:arena.1" -l "$*"; tmux send-keys -t "$SESSION:arena.1" C-m; }

cmd_capture() {
  echo "===== LEFT · $LEFT_LABEL ====="
  tmux capture-pane -p -t "$SESSION:arena.0"
  echo; echo "===== RIGHT · $RIGHT_LABEL ====="
  tmux capture-pane -p -t "$SESSION:arena.1"
}

cmd_logs()   { tail -n 20 "$LOGS"/srv-*.log; }
cmd_status() {
  for p in "$LEFT_LABEL:$LEFT_PORT" "$RIGHT_LABEL:$RIGHT_PORT"; do
    local label="${p%%:*}" port="${p#*:}"
    printf "  %-8s :%s  -> HTTP %s\n" "$label" "$port" \
      "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" 2>/dev/null)"
  done
  tmux has-session -t "$SESSION" 2>/dev/null && echo "  tmux session '$SESSION': up" || echo "  tmux session '$SESSION': down"
}

cmd_down() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  for f in "$STATE"/srv-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -f "$STATE"/srv-*.pid
  echo "arena down (servers + session stopped)"
}
cmd_attach() { tmux attach -t "$SESSION"; }

# One-command bring-up of the BLIND HEAD-TO-HEAD game (blind_arena.ts):
# serve the local model with MLX, then launch the TypeScript game in tmux (Node runs the
# .ts directly via --experimental-strip-types). The only Python is mlx_lm.server.
# The frontier side reads ANTHROPIC_LOCAL_KEY (Opus 4.8) or routes via the gateway.
cmd_play() {
  _need tmux; _need curl; _need node
  [ -x "$MLX_PYTHON" ] || { echo "MLX python not found: $MLX_PYTHON — create it with:
  uv venv .understudy/venvs/mlx --python 3.12 && uv pip install --python $MLX_PYTHON 'mlx-lm>=0.31' 'huggingface_hub[cli]>=0.27'" >&2; exit 1; }
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
    || { echo "node >= 22.6 required to run the TypeScript game (have $(node -v))." >&2; exit 1; }
  here="$(cd "$(dirname "$0")" && pwd)"
  ( cd "$here/../.." && [ -d node_modules/openai ] || { echo "Installing arena deps (openai, @anthropic-ai/sdk)…"; npm install >/dev/null 2>&1; } )
  echo "Bringing up local model ${LEFT_REPO} on :${LEFT_PORT} (first run downloads weights)…"
  _serve "$LEFT_LABEL" "$LEFT_REPO" "$LEFT_PORT"
  _wait_health "$LEFT_PORT" "$LEFT_LABEL"
  local S="${SESSION}-play"
  # seed the frontier keys into the tmux global env (not echoed) so the game pane inherits them
  tmux start-server 2>/dev/null || true
  tmux setenv -g ANTHROPIC_LOCAL_KEY "${ANTHROPIC_LOCAL_KEY:-${ANTHROPIC_API_KEY:-}}"
  tmux setenv -g OPENAI_API_KEY "${OPENAI_API_KEY:-}"
  tmux kill-session -t "$S" 2>/dev/null || true
  tmux new-session -d -s "$S" -x 138 -y 60 -n arena
  tmux send-keys -t "$S" "clear && LOCAL_BASE=http://127.0.0.1:${LEFT_PORT}/v1 LOCAL_MODEL=${LEFT_REPO} LOCAL_NAME='${LOCAL_NAME:-Gemma 3 1B}' CATEGORY='${CATEGORY:-}' FRONTIER_MODEL='${FRONTIER_MODEL:-}' DATASET='${DATASET:-}' node --experimental-strip-types '$here/blind_arena.ts'" C-m
  echo "Ready → attach and play:   tmux attach -t $S     (detach: Ctrl-b d)"
}

case "${1:-up}" in
  up) cmd_up ;;
  play) cmd_play ;;
  ask) shift; cmd_ask "$@" ;;
  left) shift; cmd_left "$@" ;;
  right) shift; cmd_right "$@" ;;
  capture) cmd_capture ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  down) cmd_down ;;
  attach) cmd_attach ;;
  *) echo "usage: $0 {play|up|ask <text>|left <text>|right <text>|capture|logs|status|down|attach}" >&2; exit 2 ;;
esac
