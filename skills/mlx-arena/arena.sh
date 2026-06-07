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
#   first         first-run: show loading screen, serve smallest verified model, open Pi
#   first-window  same as first, but also opens a new macOS Terminal window
#   play-window   open the blind local-vs-frontier gauntlet in a new macOS Terminal window
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
MLX_BIN="$(dirname "$MLX_PYTHON")"
SESSION="${SESSION:-mlx-arena}"
STATE="$LAB/.understudy/local-model-lab/arena"
LOGS="$STATE/logs"
SYS_PROMPT="${SYS_PROMPT:-You are a helpful, concise assistant. Answer directly.}"
UNDERSTUDY_TERMINAL_APP="${UNDERSTUDY_TERMINAL_APP:-auto}"
UNDERSTUDY_TERMINAL_PROFILE="${UNDERSTUDY_TERMINAL_PROFILE:-}"

# Two corners of the arena. Defaults: verified Gemma 4 E2B via mlx-vlm vs
# smallest NVIDIA (Nemotron), MLX 4-bit. Stock mlx-community Gemma 4 E2B repos
# had loader/config mismatches in testing; the first rung is Understudy's
# self-converted snapshot from google/gemma-4-e2b-it.
LEFT_LABEL="${LEFT_LABEL:-google}"
LEFT_REPO="${LEFT_REPO:-$LAB/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit}"
LEFT_PORT="${LEFT_PORT:-8081}"
LEFT_PROVIDER="${LEFT_PROVIDER:-mlx-google}"
LEFT_LOADER="${LEFT_LOADER:-mlx_vlm}"

RIGHT_LABEL="${RIGHT_LABEL:-nvidia}"
RIGHT_REPO="${RIGHT_REPO:-mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit}"
RIGHT_PORT="${RIGHT_PORT:-8082}"
RIGHT_PROVIDER="${RIGHT_PROVIDER:-mlx-nvidia}"
RIGHT_LOADER="${RIGHT_LOADER:-mlx_lm}"

# First-run defaults: smallest verified Gemma 4 rung that generated locally in
# testing. Serve it with mlx-vlm; use FIRST_REPO=mlx-community/gemma-3-1b-it-4bit
# FIRST_LOADER=mlx_lm only as a tiny fallback when the Gemma 4 snapshot is absent.
FIRST_LABEL="${FIRST_LABEL:-gemma4-e2b}"
FIRST_REPO="${FIRST_REPO:-$LAB/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit}"
FIRST_PORT="${FIRST_PORT:-8081}"
FIRST_PROVIDER="${FIRST_PROVIDER:-mlx-gemma4-e2b}"
FIRST_NAME="${FIRST_NAME:-Gemma 4 E2B 4-bit}"
FIRST_LOADER="${FIRST_LOADER:-mlx_vlm}"

mkdir -p "$LOGS"

_need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
_need_pi() {
  command -v pi >/dev/null 2>&1 || {
    echo "missing dependency: pi" >&2
    echo "install with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent" >&2
    exit 1
  }
}

_server_command() { # loader repo port
  local loader="$1" repo="$2" port="$3"
  case "$loader" in
    mlx_lm)
      printf '%q -m mlx_lm server --model %q --host 127.0.0.1 --port %q --trust-remote-code' \
        "$MLX_PYTHON" "$repo" "$port"
      ;;
    mlx_vlm)
      [ -x "$MLX_BIN/mlx_vlm.server" ] || {
        echo "missing mlx_vlm.server in $MLX_BIN — install with:" >&2
        echo "  uv pip install --python $MLX_PYTHON 'mlx-vlm>=0.6'" >&2
        exit 1
      }
      printf '%q --model %q --host 127.0.0.1 --port %q --trust-remote-code --top-logprobs-k 5' \
        "$MLX_BIN/mlx_vlm.server" "$repo" "$port"
      ;;
    *)
      echo "unknown loader: $loader (expected mlx_lm or mlx_vlm)" >&2
      exit 1
      ;;
  esac
}

_serve() { # label repo port loader
  local label="$1" repo="$2" port="$3"
  local loader="${4:-mlx_lm}"
  _serve_with_loader "$label" "$repo" "$port" "$loader"
}

_serve_with_loader() { # label repo port loader
  local label="$1" repo="$2" port="$3" loader="$4"
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" 2>/dev/null | grep -q 200; then
    echo "  [$label] already serving on :$port"; return 0
  fi
  echo "  [$label] starting $loader $repo on :$port"
  local server_session="${SESSION}-server-$label"
  local command_text log_path
  command_text="$(_server_command "$loader" "$repo" "$port")"
  log_path="$LOGS/srv-$label.log"
  tmux kill-session -t "$server_session" 2>/dev/null || true
  tmux new-session -d -s "$server_session" -n server \
    "mkdir -p $(printf %q "$LOGS"); exec $command_text >$(printf %q "$log_path") 2>&1"
  echo "$server_session" >"$STATE/srv-$label.session"
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

_pi_cmd_with_prompt() { # provider model prompt
  printf 'pi --provider %q --model %q --no-tools --no-context-files --no-skills --no-extensions --no-prompt-templates --system-prompt %q' \
    "$1" "$2" "$3"
}

_ensure_pi_provider() { # provider model port
  local provider="$1" model="$2" port="$3"
  _need node
  PROVIDER="$provider" MODEL="$model" PORT="$port" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const file = path.join(os.homedir(), ".pi", "agent", "models.json");
const provider = process.env.PROVIDER;
const model = process.env.MODEL;
const port = process.env.PORT;
const modelEntry = {
  id: model,
  name: provider,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const providerEntry = {
  name: provider,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  api: "openai-completions",
  apiKey: "mlx",
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  },
  models: [modelEntry],
};

fs.mkdirSync(path.dirname(file), { recursive: true });
let config = {};
if (fs.existsSync(file)) {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
}

if (Array.isArray(config)) {
  const previous = config.find((item) => item && item.id === provider);
  config = { providers: {} };
  if (previous) config.providers[provider] = previous;
} else if (config && typeof config === "object") {
  config.providers = config.providers && typeof config.providers === "object" ? config.providers : {};
  if (config[provider] && !config.providers[provider]) {
    config.providers[provider] = config[provider];
    delete config[provider];
  }
} else {
  config = { providers: {} };
}

const existing = config.providers[provider] || {};
const existingModels = Array.isArray(existing.models) ? existing.models : [];
const withoutModel = existingModels.filter((item) => item && item.id !== model);
config.providers[provider] = {
  ...existing,
  ...providerEntry,
  models: [modelEntry, ...withoutModel],
};

fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`  [pi] provider ${provider} -> ${providerEntry.baseUrl} (${model})`);
NODE
}

_prepare_tmux_session() { # session
  local session="$1"
  tmux set-option -t "$session" extended-keys on 2>/dev/null || true
  tmux set-option -t "$session" extended-keys-format csi-u 2>/dev/null || true
  tmux set-option -t "$session" pane-border-status top 2>/dev/null || true
}

cmd_up() {
  _need tmux; _need curl; _need_pi
  [ -x "$MLX_PYTHON" ] || { echo "MLX_PYTHON not executable: $MLX_PYTHON" >&2; exit 1; }
  echo "Starting MLX servers…"
  _serve "$LEFT_LABEL"  "$LEFT_REPO"  "$LEFT_PORT" "$LEFT_LOADER"
  _serve "$RIGHT_LABEL" "$RIGHT_REPO" "$RIGHT_PORT" "$RIGHT_LOADER"
  _wait_health "$LEFT_PORT"  "$LEFT_LABEL"
  _wait_health "$RIGHT_PORT" "$RIGHT_LABEL"

  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session  -d -s "$SESSION" -x 220 -y 50 -n arena
  _prepare_tmux_session "$SESSION"
  tmux send-keys -t "$SESSION:arena.0" "$(_pi_cmd "$LEFT_PROVIDER"  "$LEFT_REPO")"  C-m
  tmux split-window -h -t "$SESSION:arena"
  tmux send-keys -t "$SESSION:arena.1" "$(_pi_cmd "$RIGHT_PROVIDER" "$RIGHT_REPO")" C-m
  tmux select-layout -t "$SESSION:arena" even-horizontal
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
  for f in "$STATE"/srv-*.session; do
    [ -f "$f" ] && tmux kill-session -t "$(cat "$f")" 2>/dev/null || true
  done
  for f in "$STATE"/srv-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -f "$STATE"/srv-*.pid "$STATE"/srv-*.session
  echo "arena down (servers + session stopped)"
}
cmd_attach() { tmux attach -t "$SESSION"; }

_terminal_kind() {
  local requested="${UNDERSTUDY_TERMINAL_APP:-auto}"
  case "$requested" in
    terminal|Terminal|Terminal.app) echo "terminal"; return 0 ;;
    iterm|iTerm|iTerm2|iTerm.app|iTerm2.app) echo "iterm"; return 0 ;;
    ghostty|Ghostty|Ghostty.app) echo "ghostty"; return 0 ;;
    auto) ;;
    *) echo "$requested"; return 0 ;;
  esac

  case "${TERM_PROGRAM:-}" in
    Apple_Terminal) echo "terminal" ;;
    iTerm.app|iTerm2|iTerm) echo "iterm" ;;
    ghostty|Ghostty) echo "ghostty" ;;
    *) echo "terminal" ;;
  esac
}

_open_terminal_attach() { # tmux-session-name
  local target="$1"
  _open_terminal_run "tmux attach -t $(printf '%q' "$target")"
  echo "  [window] follow along with: tmux attach -t $target"
}

_open_terminal_run() { # command
  local command_text="$1" kind log_path quoted_command quoted_log quoted_log_line wrapped_command
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "  [window] new terminal windows are only automated on macOS; run: $command_text"
    return 0
  fi

  mkdir -p "$LOGS"
  log_path="$LOGS/window-$(date -u +%Y%m%dT%H%M%SZ).log"
  quoted_command="$(printf '%q' "$command_text")"
  quoted_log="$(printf '%q' "$log_path")"
  quoted_log_line="$(printf '%q' "[understudy] command: $command_text")"
  wrapped_command="echo '[understudy] window command log: $log_path'; printf '%s\n' $quoted_log_line >>$quoted_log; eval $quoted_command 2>&1 | tee -a $quoted_log; status=\${pipestatus[1]:-\$?}; if [ \"\$status\" -ne 0 ]; then echo; echo '[understudy] window command failed with status' \"\$status\"; echo '[understudy] log:' $quoted_log; echo '[understudy] press Return to close this window'; read _; fi; exit \"\$status\""
  echo "  [window] log: $log_path"

  kind="$(_terminal_kind)"
  case "$kind" in
    ghostty)
      if command -v ghostty >/dev/null 2>&1; then
        nohup ghostty -e /bin/zsh -lc "$wrapped_command" >/dev/null 2>&1 &
        echo "  [window] opened Ghostty"
        return 0
      fi
      if open -Ra Ghostty 2>/dev/null; then
        open -na Ghostty --args -e /bin/zsh -lc "$wrapped_command"
        echo "  [window] opened Ghostty"
        return 0
      fi
      echo "  [window] Ghostty not found; falling back to Terminal.app"
      ;;
    iterm)
      if command -v osascript >/dev/null 2>&1; then
        if TERMINAL_COMMAND="$wrapped_command" osascript <<'APPLESCRIPT' >/dev/null 2>&1
tell application "iTerm2"
  activate
  create window with default profile command (system attribute "TERMINAL_COMMAND")
end tell
APPLESCRIPT
        then
          echo "  [window] opened iTerm2"
          return 0
        fi
        if TERMINAL_COMMAND="$wrapped_command" osascript <<'APPLESCRIPT' >/dev/null 2>&1
tell application "iTerm"
  activate
  create window with default profile command (system attribute "TERMINAL_COMMAND")
end tell
APPLESCRIPT
        then
          echo "  [window] opened iTerm"
          return 0
        fi
      fi
      echo "  [window] iTerm not found; falling back to Terminal.app"
      ;;
  esac

  command -v osascript >/dev/null 2>&1 || {
    echo "  [window] osascript not found; run: $command_text"
    return 0
  }
  TERMINAL_COMMAND="$wrapped_command" UNDERSTUDY_TERMINAL_PROFILE="$UNDERSTUDY_TERMINAL_PROFILE" osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  set targetProfile to system attribute "UNDERSTUDY_TERMINAL_PROFILE"
  set sourceSettings to missing value
  try
    set sourceSettings to current settings of selected tab of front window
  end try
  set newTab to do script (system attribute "TERMINAL_COMMAND")
  if targetProfile is not "" then
    try
      set current settings of newTab to settings set targetProfile
    end try
  else if sourceSettings is not missing value then
    try
      set current settings of newTab to sourceSettings
    end try
  end if
end tell
APPLESCRIPT
  echo "  [window] opened Terminal.app"
}

_first_loading_script() {
  cat <<'SH'
clear
printf '\n'
printf 'UNDERSTUDY LABS\n'
printf 'Preparing your first local understudy\n'
printf '\n'
printf 'Model: %s\n' "$FIRST_REPO"
printf 'Runtime: %s on Apple MLX\n' "$FIRST_LOADER"
printf 'Endpoint: http://127.0.0.1:%s/v1\n' "$FIRST_PORT"
printf '\n'
printf 'Downloading weights if needed, then loading them into unified memory.\n'
printf 'This stays on your machine. No prompts or outputs are uploaded.\n'
printf '\n'
while :; do
  printf '.'
  sleep 1
done
SH
}

_first_pi_system_prompt() {
  cat <<'PROMPT'
You are the user's first local Understudy. You are running privately on their Mac through Apple MLX. Start by saying you are ready, then invite them to try one real task. Keep the tone concise and practical. After one or two local-only prompts, suggest running the frontier head-to-head with skills/mlx-arena/arena.sh play so they can feel where local is already enough and where the frontier still wins.
PROMPT
}

cmd_first() {
  _need tmux; _need curl; _need_pi
  [ -x "$MLX_PYTHON" ] || { echo "MLX python not found: $MLX_PYTHON — create it with:
  uv venv .understudy/venvs/mlx --python 3.12 && uv pip install --python $MLX_PYTHON 'mlx-lm>=0.31' 'mlx-vlm>=0.6' 'huggingface_hub>=0.27'" >&2; exit 1; }

  local S="${SESSION}-first" first_prompt
  first_prompt="$(_first_pi_system_prompt)"
  tmux kill-session -t "$S" 2>/dev/null || true
  tmux new-session -d -s "$S" -x 112 -y 36 -n first
  _prepare_tmux_session "$S"
  tmux setenv -t "$S" FIRST_REPO "$FIRST_REPO"
  tmux setenv -t "$S" FIRST_LOADER "$FIRST_LOADER"
  tmux setenv -t "$S" FIRST_PORT "$FIRST_PORT"
  tmux send-keys -t "$S" "$(_first_loading_script)" C-m
  if [[ "${OPEN_WINDOW:-0}" = "1" ]]; then
    _open_terminal_attach "$S"
  fi

  echo "Preparing first Understudy: $FIRST_REPO via $FIRST_LOADER on :$FIRST_PORT"
  echo "Loading screen: tmux attach -t $S"
  _serve_with_loader "$FIRST_LABEL" "$FIRST_REPO" "$FIRST_PORT" "$FIRST_LOADER"
  _wait_health "$FIRST_PORT" "$FIRST_LABEL"
  _ensure_pi_provider "$FIRST_PROVIDER" "$FIRST_REPO" "$FIRST_PORT"

  tmux send-keys -t "$S" C-c
  tmux send-keys -t "$S" "clear && echo 'UNDERSTUDY LABS' && echo 'Your first local understudy is ready.' && echo && echo 'Model: $FIRST_REPO' && echo 'Endpoint: http://127.0.0.1:$FIRST_PORT/v1' && echo && $(_pi_cmd_with_prompt "$FIRST_PROVIDER" "$FIRST_REPO" "$first_prompt")" C-m
  tmux select-pane -t "$S" -T " FIRST UNDERSTUDY · $FIRST_NAME · $FIRST_REPO " 2>/dev/null || true
  echo "Ready → attach: tmux attach -t $S"
  echo "Next head-to-head: skills/mlx-arena/arena.sh play"
}

# One-command bring-up of the BLIND HEAD-TO-HEAD game (blind_arena.ts):
# serve the local model with MLX, then launch the TypeScript game in tmux (Node runs the
# .ts directly via --experimental-strip-types). The only Python is mlx_lm.server.
# The frontier side resolves OpenAI/Anthropic/custom AI gateway first, then falls
# back to the Understudy gateway model.
cmd_play() {
  _need tmux; _need curl; _need node
  [ -x "$MLX_PYTHON" ] || { echo "MLX python not found: $MLX_PYTHON — create it with:
  uv venv .understudy/venvs/mlx --python 3.12 && uv pip install --python $MLX_PYTHON 'mlx-lm>=0.31' 'huggingface_hub>=0.27'" >&2; exit 1; }
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
    || { echo "node >= 22.6 required to run the TypeScript game (have $(node -v))." >&2; exit 1; }
  here="$(cd "$(dirname "$0")" && pwd)"
  ( cd "$here/../.." && [ -d node_modules/openai ] || { echo "Installing arena deps (openai, @anthropic-ai/sdk)…"; npm install >/dev/null 2>&1; } )
  echo "Bringing up local model ${LEFT_REPO} on :${LEFT_PORT} (first run downloads weights)…"
  _serve "$LEFT_LABEL" "$LEFT_REPO" "$LEFT_PORT" "$LEFT_LOADER"
  _wait_health "$LEFT_PORT" "$LEFT_LABEL"
  local S="${SESSION}-play" frontier_model
  frontier_model="${FRONTIER_MODEL:-}"
  # seed the frontier keys into the tmux global env (not echoed) so the game pane inherits them
  tmux start-server 2>/dev/null || true
  tmux setenv -g ANTHROPIC_LOCAL_KEY "${ANTHROPIC_LOCAL_KEY:-${ANTHROPIC_API_KEY:-}}"
  tmux setenv -g OPENAI_API_KEY "${OPENAI_API_KEY:-}"
  tmux kill-session -t "$S" 2>/dev/null || true
  tmux new-session -d -s "$S" -x 138 -y 60 -n arena
  _prepare_tmux_session "$S"
  tmux send-keys -t "$S" "clear && LOCAL_BASE=http://127.0.0.1:${LEFT_PORT}/v1 LOCAL_MODEL=${LEFT_REPO} LOCAL_NAME='${LOCAL_NAME:-Gemma 4 E2B}' CATEGORY='${CATEGORY:-}' FRONTIER_MODEL='$frontier_model' DATASET='${DATASET:-}' node --experimental-strip-types '$here/blind_arena.ts'" C-m
  echo "Ready → attach and play:   tmux attach -t $S     (detach: Ctrl-b d)"
}

cmd_play_window() {
  local here quoted_here quoted_lab quoted_python quoted_repo quoted_loader quoted_name
  here="$(cd "$(dirname "$0")" && pwd)"
  quoted_here="$(printf '%q' "$here")"
  quoted_lab="$(printf '%q' "$LAB")"
  quoted_python="$(printf '%q' "$MLX_PYTHON")"
  quoted_repo="$(printf '%q' "$LEFT_REPO")"
  quoted_loader="$(printf '%q' "$LEFT_LOADER")"
  quoted_name="$(printf '%q' "${LOCAL_NAME:-Gemma 4 E2B}")"
  _open_terminal_run "cd $quoted_here/../.. && LAB=$quoted_lab MLX_PYTHON=$quoted_python LEFT_REPO=$quoted_repo LEFT_LOADER=$quoted_loader LOCAL_NAME=$quoted_name '$here/arena.sh' play; tmux attach -t ${SESSION}-play"
  echo "Opening stock local-vs-frontier gauntlet in a new Terminal window."
  echo "Follow along with: tmux attach -t ${SESSION}-play"
}

case "${1:-up}" in
  first) cmd_first ;;
  first-window) OPEN_WINDOW=1 cmd_first ;;
  play-window) cmd_play_window ;;
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
  *) echo "usage: $0 {first|first-window|play|play-window|up|ask <text>|left <text>|right <text>|capture|logs|status|down|attach}" >&2; exit 2 ;;
esac
