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
#   cleanup       remove stale Understudy tmux sessions and MLX listeners
#   diagnose      print log locations + recent launcher/tmux/listener state
#   attach        attach your terminal to the arena (interactive)
#
# Config via env (defaults target this repo's local MLX venv layout):
#   MLX_PYTHON   python with mlx_lm installed   (default: $LAB/.understudy/venvs/mlx/bin/python)
#   LAB          working dir for logs/state      (default: ~/.understudy/agent-tools)
#   UNDERSTUDY_MODEL_HOME local model cache      (default: ~/.understudy/models)
#   LEFT_LABEL/LEFT_REPO/LEFT_PORT/LEFT_PROVIDER
#   RIGHT_LABEL/RIGHT_REPO/RIGHT_PORT/RIGHT_PROVIDER
#   SESSION      tmux session name               (default: mlx-arena)
#   SYS_PROMPT   system prompt for both Pi panes
#   UNDERSTUDY_DEBUG=1 writes $LAB/.understudy/local-model-lab/arena/logs/actions.log
#   UNDERSTUDY_WINDOW_HOLD=1 keeps launched terminal windows open after command exit
set -euo pipefail

LAB="${LAB:-${UNDERSTUDY_LAB:-$HOME/.understudy/agent-tools}}"
UNDERSTUDY_MODEL_HOME="${UNDERSTUDY_MODEL_HOME:-$HOME/.understudy/models}"
MLX_PYTHON="${MLX_PYTHON:-$LAB/.understudy/venvs/mlx/bin/python}"
MLX_BIN="$(dirname "$MLX_PYTHON")"
SESSION="${SESSION:-mlx-arena}"
STATE="$LAB/.understudy/local-model-lab/arena"
LOGS="$STATE/logs"
SYS_PROMPT="${SYS_PROMPT:-You are a helpful, concise assistant. Answer directly.}"
UNDERSTUDY_TERMINAL_APP="${UNDERSTUDY_TERMINAL_APP:-auto}"
UNDERSTUDY_TERMINAL_PROFILE="${UNDERSTUDY_TERMINAL_PROFILE:-}"
UNDERSTUDY_DEBUG="${UNDERSTUDY_DEBUG:-0}"
UNDERSTUDY_WINDOW_HOLD="${UNDERSTUDY_WINDOW_HOLD:-0}"
UNDERSTUDY_CLEANUP_PREFIXES="${UNDERSTUDY_CLEANUP_PREFIXES:-$SESSION mlx-arena}"

# Two corners of the arena. Defaults: verified Gemma 4 E2B via mlx-vlm vs
# smallest NVIDIA (Nemotron), MLX 4-bit. Stock mlx-community Gemma 4 E2B repos
# had loader/config mismatches in testing; the first rung is Understudy's
# self-converted snapshot from google/gemma-4-e2b-it.
LEFT_LABEL="${LEFT_LABEL:-google}"
LEFT_REPO="${LEFT_REPO:-$UNDERSTUDY_MODEL_HOME/gemma-4-e2b-it-mlx-vlm-4bit}"
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
FIRST_REPO="${FIRST_REPO:-$UNDERSTUDY_MODEL_HOME/gemma-4-e2b-it-mlx-vlm-4bit}"
FIRST_PORT="${FIRST_PORT:-8081}"
FIRST_PROVIDER="${FIRST_PROVIDER:-mlx-gemma4-e2b}"
FIRST_NAME="${FIRST_NAME:-Gemma 4 E2B 4-bit}"
FIRST_LOADER="${FIRST_LOADER:-mlx_vlm}"
UNDERSTUDY_CLEANUP_PORTS="${UNDERSTUDY_CLEANUP_PORTS:-$LEFT_PORT $RIGHT_PORT $FIRST_PORT}"

mkdir -p "$LOGS"

_now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}
_debug_log() {
  _truthy "$UNDERSTUDY_DEBUG" || return 0
  mkdir -p "$LOGS"
  printf '%s %s\n' "$(_now_utc)" "$*" >>"$LOGS/actions.log"
}
_debug_echo() {
  _debug_log "$*"
  _truthy "$UNDERSTUDY_DEBUG" || return 0
  printf '  [debug] %s\n' "$*"
}
_cleanup_ports() {
  printf '%s\n' $UNDERSTUDY_CLEANUP_PORTS | awk 'NF && !seen[$0]++'
}

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
    _debug_echo "serve skip label=$label port=$port reason=already-healthy"
    echo "  [$label] already serving on :$port"; return 0
  fi
  echo "  [$label] starting $loader $repo on :$port"
  local server_session="${SESSION}-server-$label"
  local command_text log_path
  command_text="$(_server_command "$loader" "$repo" "$port")"
  log_path="$LOGS/srv-$label.log"
  _debug_echo "serve start label=$label loader=$loader repo=$repo port=$port session=$server_session log=$log_path"
  tmux kill-session -t "$server_session" 2>/dev/null || true
  tmux new-session -d -s "$server_session" -n server \
    "mkdir -p $(printf %q "$LOGS"); exec $command_text >$(printf %q "$log_path") 2>&1"
  echo "$server_session" >"$STATE/srv-$label.session"
}

_wait_health() { # port label
  local port="$1" label="$2" i
  _debug_echo "health wait label=$label port=$port"
  for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" 2>/dev/null)" = "200" ] \
      && { _debug_echo "health ok label=$label port=$port seconds=$i"; echo "  [$label] healthy on :$port (${i}s)"; return 0; }
    sleep 1
  done
  _debug_echo "health failed label=$label port=$port log=$LOGS/srv-$label.log"
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

_refresh_agent_card() { # name repo port loader provider tmux-session
  local name="$1" repo="$2" port="$3" loader="$4" provider="$5" tmux_session="$6"
  local health_url="http://127.0.0.1:$port/v1/models" endpoint="http://127.0.0.1:$port/v1" healthy="false"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$health_url" 2>/dev/null || true)" = "200" ] && healthy="true"
  UNDERSTUDY_CARD_NAME="$name" \
  UNDERSTUDY_CARD_MODEL="$repo" \
  UNDERSTUDY_CARD_PORT="$port" \
  UNDERSTUDY_CARD_ENDPOINT="$endpoint" \
  UNDERSTUDY_CARD_HEALTH_URL="$health_url" \
  UNDERSTUDY_CARD_HEALTHY="$healthy" \
  UNDERSTUDY_CARD_LOADER="$loader" \
  UNDERSTUDY_CARD_PROVIDER="$provider" \
  UNDERSTUDY_CARD_SESSION="$tmux_session" \
  UNDERSTUDY_CARD_LOGS="$LOGS" \
  UNDERSTUDY_CARD_CWD="$(pwd)" \
  node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const home = os.homedir();
const now = new Date().toISOString();
const cardPath = path.join(home, ".understudy", "agent-card.json");
const companionPath = path.join(home, ".understudy", "companion.json");
const configPath = path.join(home, ".understudy", "config.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonMode600(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const existing = readJson(cardPath) || {};
const companionState = readJson(companionPath);
let companion = {
  alive: false,
  pid: null,
  stale_pid: null,
  path: null,
  state_file: companionPath,
};

if (companionState && typeof companionState === "object") {
  const pid = Number(companionState.pid ?? companionState.process?.pid ?? companionState.companion?.pid);
  const alive = pidAlive(pid);
  companion = {
    alive,
    pid: alive ? pid : null,
    stale_pid: !alive && Number.isInteger(pid) && pid > 0 ? pid : null,
    path: companionState.path ?? companionState.binary ?? companionState.command ?? companionState.process?.path ?? null,
    state_file: companionPath,
  };
  if (!alive && Number.isInteger(pid) && pid > 0) {
    const cleaned = { ...companionState };
    if ("pid" in cleaned) cleaned.pid = null;
    if (cleaned.process && typeof cleaned.process === "object" && "pid" in cleaned.process) {
      cleaned.process = { ...cleaned.process, pid: null };
    }
    if (cleaned.companion && typeof cleaned.companion === "object" && "pid" in cleaned.companion) {
      cleaned.companion = { ...cleaned.companion, pid: null };
    }
    try {
      writeJsonMode600(companionPath, cleaned);
    } catch {}
  }
}

const config = readJson(configPath) || {};
const model = process.env.UNDERSTUDY_CARD_MODEL;
const endpoint = process.env.UNDERSTUDY_CARD_ENDPOINT;
const port = process.env.UNDERSTUDY_CARD_PORT;
const payload = {
  model,
  messages: [{ role: "user", content: "Say hello from my local Understudy." }],
  max_tokens: 128,
};
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
const howToTalk = `curl -s ${endpoint}/chat/completions -H 'Content-Type: application/json' -d ${shellSingleQuote(JSON.stringify(payload))}`;
const cwd = process.env.UNDERSTUDY_CARD_CWD || process.cwd();
function observeListener(portValue) {
  if (!portValue) return { pid: null, command: null };
  try {
    const out = childProcess.execFileSync("lsof", ["-nP", `-iTCP:${portValue}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = out.split("\n").find((line) => /^p\d+$/.test(line))?.slice(1);
    if (!pid) return { pid: null, command: null };
    const command = childProcess.execFileSync("ps", ["-p", pid, "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { pid: Number(pid), command: command || null };
  } catch {
    return { pid: null, command: null };
  }
}
function inferRuntime(requestedLoader, observedCommand) {
  const command = observedCommand || "";
  if (command.includes("mlx_vlm.server") || command.includes("mlx-vlm")) {
    return { runtime: "mlx_vlm", served_by: "mlx_vlm.server" };
  }
  if (command.includes("mlx_lm") || command.includes("mlx-lm")) {
    return { runtime: "mlx_lm", served_by: "mlx_lm.server" };
  }
  if (requestedLoader === "mlx_vlm") {
    return { runtime: "mlx_vlm", served_by: "mlx_vlm.server" };
  }
  return { runtime: requestedLoader || null, served_by: requestedLoader ? `${requestedLoader}.server` : null };
}
const observed = observeListener(port);
const runtime = inferRuntime(process.env.UNDERSTUDY_CARD_LOADER, observed.command);

const card = {
  schema_version: "understudy.agent_card.v1",
  created_at: existing.created_at || now,
  updated_at: now,
  understudy: {
    model,
    name: process.env.UNDERSTUDY_CARD_NAME || null,
    endpoint,
    health_url: process.env.UNDERSTUDY_CARD_HEALTH_URL,
    healthy: process.env.UNDERSTUDY_CARD_HEALTHY === "true",
    served_by: runtime.served_by,
    runtime: runtime.runtime,
    requested_loader: process.env.UNDERSTUDY_CARD_LOADER || null,
    observed_listener: observed,
    provider: process.env.UNDERSTUDY_CARD_PROVIDER,
    tmux_session: process.env.UNDERSTUDY_CARD_SESSION,
    logs: process.env.UNDERSTUDY_CARD_LOGS,
    how_to_talk: howToTalk,
  },
  companion,
  project: {
    cwd,
    slug: path.basename(cwd),
  },
  org: {
    id: config.org_id ?? config.organization_id ?? config.org?.id ?? null,
  },
};

writeJsonMode600(cardPath, card);
console.log(`  [understudy] agent card -> ${cardPath}`);
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
  _refresh_agent_card "$LEFT_LABEL" "$LEFT_REPO" "$LEFT_PORT" "$LEFT_LOADER" "$LEFT_PROVIDER" "$SESSION"

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
  _debug_echo "down session=$SESSION"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux kill-session -t "${SESSION}-first" 2>/dev/null || true
  tmux kill-session -t "${SESSION}-play" 2>/dev/null || true
  for f in "$STATE"/srv-*.session; do
    [ -f "$f" ] && { _debug_echo "down kill recorded server session=$(cat "$f") file=$f"; tmux kill-session -t "$(cat "$f")" 2>/dev/null || true; }
  done
  for f in "$STATE"/srv-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -f "$STATE"/srv-*.pid "$STATE"/srv-*.session
  # unset API keys from the tmux global environment (set by cmd_play)
  for _var in ANTHROPIC_LOCAL_KEY ANTHROPIC_API_KEY OPENAI_API_KEY \
              FRONTIER_API_KEY AI_GATEWAY_API_KEY FRONTIER_BASE_URL \
              AI_GATEWAY_BASE_URL OPENAI_BASE_URL OPENAI_MODEL \
              ANTHROPIC_MODEL AI_GATEWAY_MODEL UNDERSTUDY_FALLBACK_MODEL \
              FRONTIER_FALLBACK FRONTIER_REASONING_EFFORT \
              FRONTIER_MAX_COMPLETION_TOKENS; do
    tmux setenv -gu "$_var" 2>/dev/null || true
  done
  echo "arena down (servers + session stopped)"
}
cmd_attach() { tmux attach -t "$SESSION"; }

_cleanup_kill_tmux_prefixes() {
  local dry_run="$1" name prefix killed=0
  command -v tmux >/dev/null 2>&1 || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    for prefix in $UNDERSTUDY_CLEANUP_PREFIXES; do
      case "$name" in
        "$prefix"|"$prefix"-*)
          _debug_echo "cleanup tmux session=$name prefix=$prefix dry_run=$dry_run"
          if [ "$dry_run" = "1" ]; then
            echo "  [cleanup] would kill tmux session $name"
          else
            tmux kill-session -t "$name" 2>/dev/null || true
            echo "  [cleanup] killed tmux session $name"
          fi
          killed=$((killed + 1))
          break
          ;;
      esac
    done
  done <<EOF
$(tmux list-sessions -F '#S' 2>/dev/null || true)
EOF
  [ "$killed" -gt 0 ] || echo "  [cleanup] no matching tmux sessions"
}

_cleanup_kill_ports() {
  local dry_run="$1" port pids pid command killed=0
  command -v lsof >/dev/null 2>&1 || { echo "  [cleanup] lsof not found; skipping port cleanup"; return 0; }
  for port in $UNDERSTUDY_CLEANUP_PORTS; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] || continue
    for pid in $pids; do
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$command" in
        *mlx_lm*|*mlx_vlm*|*mlx-vlm*|*uvicorn*)
          _debug_echo "cleanup port=$port pid=$pid command=$command dry_run=$dry_run"
          if [ "$dry_run" = "1" ]; then
            echo "  [cleanup] would kill MLX listener pid=$pid port=$port"
          else
            kill "$pid" 2>/dev/null || true
            echo "  [cleanup] killed MLX listener pid=$pid port=$port"
          fi
          killed=$((killed + 1))
          ;;
        *)
          _debug_echo "cleanup skip port=$port pid=$pid command=$command reason=not-mlx"
          echo "  [cleanup] skipping non-MLX listener pid=$pid port=$port"
          ;;
      esac
    done
  done
  [ "$killed" -gt 0 ] || echo "  [cleanup] no MLX listeners on ports: $UNDERSTUDY_CLEANUP_PORTS"
}

cmd_cleanup() {
  local dry_run=0
  case "${1:-}" in
    --dry-run|-n) dry_run=1 ;;
    ""|--force) ;;
    *) echo "usage: $0 cleanup [--dry-run|--force]" >&2; exit 2 ;;
  esac
  mkdir -p "$LOGS"
  _debug_echo "cleanup start dry_run=$dry_run prefixes=$UNDERSTUDY_CLEANUP_PREFIXES ports=$UNDERSTUDY_CLEANUP_PORTS logs=$LOGS"
  echo "Understudy arena cleanup"
  echo "  logs: $LOGS"
  echo "  prefixes: $UNDERSTUDY_CLEANUP_PREFIXES"
  echo "  ports: $UNDERSTUDY_CLEANUP_PORTS"
  _cleanup_kill_tmux_prefixes "$dry_run"
  _cleanup_kill_ports "$dry_run"
  if [ "$dry_run" = "0" ]; then
    rm -f "$STATE"/srv-*.pid "$STATE"/srv-*.session
    rm -f "$STATE"/window-env-*.sh
  else
    for _envf in "$STATE"/window-env-*.sh; do
      [ -f "$_envf" ] && echo "  [cleanup] would remove $_envf"
    done
  fi
  echo "cleanup complete"
}

cmd_diagnose() {
  mkdir -p "$LOGS"
  echo "Understudy arena diagnostics"
  echo "  LAB: $LAB"
  echo "  STATE: $STATE"
  echo "  LOGS: $LOGS"
  echo "  SESSION: $SESSION"
  echo "  terminal app: ${UNDERSTUDY_TERMINAL_APP:-auto}"
  echo "  debug: $UNDERSTUDY_DEBUG"
  echo "  window hold: $UNDERSTUDY_WINDOW_HOLD"
  echo
  echo "Recent launch logs:"
  ls -1t "$LOGS"/window-launch-*.log 2>/dev/null | head -5 || echo "  none"
  echo
  echo "Recent window command logs:"
  ls -1t "$LOGS"/window-*.log 2>/dev/null | grep -v '/window-launch-' | head -5 || echo "  none"
  echo
  echo "Recent install logs:"
  ls -1t "$LAB"/logs/install-*.log 2>/dev/null | head -5 || echo "  none"
  echo
  echo "tmux sessions:"
  tmux list-sessions 2>/dev/null || echo "  none"
  echo
  echo "Configured port listeners:"
  for port in $(_cleanup_ports); do
    echo "  :$port"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || echo "    none"
  done
  echo
  echo "To collect the newest launcher log:"
  echo "  tail -120 \"\$(ls -1t \"$LOGS\"/window-launch-*.log | head -1)\""
}

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

_sha256_text() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf 'unavailable'
  fi
}

_redact_command() {
  printf '%s' "$1" | sed -E \
    -e 's/(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_LOCAL_KEY|FRONTIER_API_KEY|AI_GATEWAY_API_KEY)=([^ ;]+)/\1=<redacted>/g' \
    -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/=-]+/\1<redacted>/g' \
    -e 's/(api[_-]?key=)[A-Za-z0-9._~+\/=-]+/\1<redacted>/Ig'
}

_log_window_launch() { # launch-log terminal-kind command window-log
  local launch_log="$1" kind="$2" command_text="$3" window_log="$4"
  mkdir -p "$LOGS"
  {
    printf 'timestamp=%s\n' "$(_now_utc)"
    printf 'terminal_kind=%s\n' "$kind"
    printf 'requested_terminal_app=%s\n' "${UNDERSTUDY_TERMINAL_APP:-auto}"
    printf 'term_program=%s\n' "${TERM_PROGRAM:-}"
    printf 'shell=%s\n' "${SHELL:-}"
    printf 'cwd=%s\n' "$(pwd)"
    printf 'script=%s\n' "$0"
    printf 'lab=%s\n' "$LAB"
    printf 'state=%s\n' "$STATE"
    printf 'logs=%s\n' "$LOGS"
    printf 'session=%s\n' "$SESSION"
    printf 'mlx_python=%s\n' "$MLX_PYTHON"
    printf 'model_home=%s\n' "$UNDERSTUDY_MODEL_HOME"
    printf 'window_log=%s\n' "$window_log"
    printf 'debug=%s\n' "$UNDERSTUDY_DEBUG"
    printf 'window_hold=%s\n' "$UNDERSTUDY_WINDOW_HOLD"
    printf 'command_sha256=%s\n' "$(_sha256_text "$command_text")"
    printf 'command_redacted=%s\n' "$(_redact_command "$command_text")"
    printf 'has_OPENAI_API_KEY=%s\n' "$([ -n "${OPENAI_API_KEY:-}" ] && echo yes || echo no)"
    printf 'has_ANTHROPIC_API_KEY=%s\n' "$([ -n "${ANTHROPIC_API_KEY:-}" ] && echo yes || echo no)"
    printf 'has_ANTHROPIC_LOCAL_KEY=%s\n' "$([ -n "${ANTHROPIC_LOCAL_KEY:-}" ] && echo yes || echo no)"
    printf 'has_FRONTIER_API_KEY=%s\n' "$([ -n "${FRONTIER_API_KEY:-}" ] && echo yes || echo no)"
    printf 'has_AI_GATEWAY_API_KEY=%s\n' "$([ -n "${AI_GATEWAY_API_KEY:-}" ] && echo yes || echo no)"
    printf '\n[tmux sessions]\n'
    tmux list-sessions 2>&1 || true
    printf '\n[port listeners]\n'
    for port in $(_cleanup_ports); do
      printf 'port %s: ' "$port"
      lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1 || true
    done
    printf '\n[apple script output]\n'
  } >"$launch_log"
}

_open_terminal_attach() { # tmux-session-name
  local target="$1"
  _open_terminal_run "tmux attach -t $(printf '%q' "$target")"
  echo "  [window] follow along with: tmux attach -t $target"
}

_write_window_env_file() {
  local env_file="$STATE/window-env-$(date -u +%Y%m%dT%H%M%SZ).sh"
  mkdir -p "$STATE"
  umask 077
  {
    printf 'export LAB=%q\n' "$LAB"
    printf 'export MLX_PYTHON=%q\n' "$MLX_PYTHON"
    printf 'export LEFT_REPO=%q\n' "$LEFT_REPO"
    printf 'export LEFT_LOADER=%q\n' "$LEFT_LOADER"
    printf 'export LOCAL_NAME=%q\n' "${LOCAL_NAME:-Gemma 4 E2B}"
    printf 'export UNDERSTUDY_MODEL_HOME=%q\n' "$UNDERSTUDY_MODEL_HOME"
    printf 'export OPENAI_API_KEY=%q\n' "${OPENAI_API_KEY:-}"
    printf 'export ANTHROPIC_API_KEY=%q\n' "${ANTHROPIC_API_KEY:-}"
    printf 'export ANTHROPIC_LOCAL_KEY=%q\n' "${ANTHROPIC_LOCAL_KEY:-}"
    printf 'export FRONTIER_API_KEY=%q\n' "${FRONTIER_API_KEY:-}"
    printf 'export AI_GATEWAY_API_KEY=%q\n' "${AI_GATEWAY_API_KEY:-}"
    printf 'export OPENAI_BASE_URL=%q\n' "${OPENAI_BASE_URL:-}"
    printf 'export FRONTIER_BASE_URL=%q\n' "${FRONTIER_BASE_URL:-}"
    printf 'export AI_GATEWAY_BASE_URL=%q\n' "${AI_GATEWAY_BASE_URL:-}"
    printf 'export FRONTIER_MODEL=%q\n' "${FRONTIER_MODEL:-}"
    printf 'export OPENAI_MODEL=%q\n' "${OPENAI_MODEL:-}"
    printf 'export ANTHROPIC_MODEL=%q\n' "${ANTHROPIC_MODEL:-}"
    printf 'export AI_GATEWAY_MODEL=%q\n' "${AI_GATEWAY_MODEL:-}"
    printf 'export UNDERSTUDY_FALLBACK_MODEL=%q\n' "${UNDERSTUDY_FALLBACK_MODEL:-}"
    printf 'export FRONTIER_FALLBACK=%q\n' "${FRONTIER_FALLBACK:-}"
    printf 'export FRONTIER_REASONING_EFFORT=%q\n' "${FRONTIER_REASONING_EFFORT:-}"
    printf 'export FRONTIER_MAX_COMPLETION_TOKENS=%q\n' "${FRONTIER_MAX_COMPLETION_TOKENS:-}"
    printf 'export UNDERSTUDY_DEBUG=%q\n' "$UNDERSTUDY_DEBUG"
    printf 'export UNDERSTUDY_WINDOW_HOLD=%q\n' "$UNDERSTUDY_WINDOW_HOLD"
    printf 'export UNDERSTUDY_TERMINAL_APP=%q\n' "$UNDERSTUDY_TERMINAL_APP"
    printf 'export UNDERSTUDY_TERMINAL_PROFILE=%q\n' "$UNDERSTUDY_TERMINAL_PROFILE"
  } >"$env_file"
  chmod 600 "$env_file"
  printf '%s\n' "$env_file"
}

_open_terminal_run() { # command
  local command_text="$1" kind stamp log_path launch_log quoted_command quoted_log quoted_log_line quoted_started_line quoted_hold quoted_debug wrapped_command
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "  [window] new terminal windows are only automated on macOS; run: $command_text"
    return 0
  fi

  mkdir -p "$LOGS"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log_path="$LOGS/window-$stamp.log"
  launch_log="$LOGS/window-launch-$stamp.log"
  quoted_command="$(printf '%q' "$command_text")"
  quoted_log="$(printf '%q' "$log_path")"
  quoted_log_line="$(printf '%q' "[understudy] command: $command_text")"
  quoted_started_line="$(printf '%q' "[understudy] started: $(_now_utc)")"
  quoted_hold="$(printf '%q' "$UNDERSTUDY_WINDOW_HOLD")"
  quoted_debug="$(printf '%q' "$UNDERSTUDY_DEBUG")"
  wrapped_command="echo '[understudy] window command log: $log_path'; { printf '%s\n' $quoted_started_line $quoted_log_line; printf '[understudy] cwd: %s\n' \"\$PWD\"; printf '[understudy] shell: %s\n' \"\${SHELL:-}\"; } >>$quoted_log; eval $quoted_command 2>&1 | tee -a $quoted_log; status=\${pipestatus[1]:-\$?}; hold=$quoted_hold; debug=$quoted_debug; if [ \"\$status\" -ne 0 ] || [ \"\$hold\" = \"1\" ] || [ \"\$hold\" = \"true\" ] || [ \"\$debug\" = \"1\" ] || [ \"\$debug\" = \"true\" ]; then echo; if [ \"\$status\" -ne 0 ]; then echo '[understudy] window command failed with status' \"\$status\"; else echo '[understudy] window command exited with status 0'; fi; echo '[understudy] log:' $quoted_log; echo '[understudy] press Return to close this window'; read _; fi; exit \"\$status\""
  echo "  [window] log: $log_path"
  echo "  [window] launch log: $launch_log"

  kind="$(_terminal_kind)"
  _log_window_launch "$launch_log" "$kind" "$command_text" "$log_path"
  _debug_echo "window launch kind=$kind app=${UNDERSTUDY_TERMINAL_APP:-auto} log=$log_path launch_log=$launch_log command_sha256=$(_sha256_text "$command_text")"
  case "$kind" in
    ghostty)
      if command -v ghostty >/dev/null 2>&1; then
        {
          printf 'launch_method=ghostty-cli\n'
          nohup ghostty -e /bin/zsh -lc "$wrapped_command" >/dev/null 2>&1 &
          printf 'launch_status=0\n'
        } >>"$launch_log" 2>&1
        _debug_echo "window opened kind=ghostty mode=cli"
        echo "  [window] opened Ghostty"
        return 0
      fi
      if open -Ra Ghostty 2>/dev/null; then
        printf 'launch_method=ghostty-open\n' >>"$launch_log"
        if open -na Ghostty --args -e /bin/zsh -lc "$wrapped_command" >>"$launch_log" 2>&1; then
          printf 'launch_status=0\n' >>"$launch_log"
          _debug_echo "window opened kind=ghostty mode=open"
          echo "  [window] opened Ghostty"
          return 0
        else
          printf 'launch_status=%s\n' "$?" >>"$launch_log"
          _debug_echo "window fallback reason=ghostty-open-failed"
          echo "  [window] Ghostty launch failed; falling back to Terminal.app"
        fi
      fi
      _debug_echo "window fallback reason=ghostty-not-found"
      echo "  [window] Ghostty not found; falling back to Terminal.app"
      ;;
    iterm)
      if command -v osascript >/dev/null 2>&1; then
        local status
        printf 'launch_method=osascript-iterm2\n' >>"$launch_log"
        if TERMINAL_COMMAND="$wrapped_command" osascript >>"$launch_log" 2>&1 <<'APPLESCRIPT'
tell application "iTerm2"
  activate
  create window with default profile command (system attribute "TERMINAL_COMMAND")
end tell
APPLESCRIPT
        then
          printf 'launch_status=0\n' >>"$launch_log"
          _debug_echo "window opened kind=iterm app=iTerm2"
          echo "  [window] opened iTerm2"
          return 0
        fi
        status="$?"
        printf 'launch_status=%s\n' "$status" >>"$launch_log"
        printf '\nlaunch_method=osascript-iterm\n' >>"$launch_log"
        if TERMINAL_COMMAND="$wrapped_command" osascript >>"$launch_log" 2>&1 <<'APPLESCRIPT'
tell application "iTerm"
  activate
  create window with default profile command (system attribute "TERMINAL_COMMAND")
end tell
APPLESCRIPT
        then
          printf 'launch_status=0\n' >>"$launch_log"
          _debug_echo "window opened kind=iterm app=iTerm"
          echo "  [window] opened iTerm"
          return 0
        fi
        status="$?"
        printf 'launch_status=%s\n' "$status" >>"$launch_log"
      fi
      _debug_echo "window fallback reason=iterm-not-found-or-applescript-failed"
      echo "  [window] iTerm not found; falling back to Terminal.app"
      ;;
  esac

  command -v osascript >/dev/null 2>&1 || {
    _debug_echo "window unable reason=osascript-not-found command=$command_text"
    printf 'launch_method=none\nlaunch_status=osascript-not-found\n' >>"$launch_log"
    echo "  [window] osascript not found; run: $command_text"
    return 0
  }
  printf 'launch_method=osascript-terminal\n' >>"$launch_log"
  if TERMINAL_COMMAND="$wrapped_command" UNDERSTUDY_TERMINAL_PROFILE="$UNDERSTUDY_TERMINAL_PROFILE" osascript >>"$launch_log" 2>&1 <<'APPLESCRIPT'
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
  then
    printf 'launch_status=0\n' >>"$launch_log"
    _debug_echo "window opened kind=terminal app=Terminal.app"
    echo "  [window] opened Terminal.app"
  else
    local status="$?"
    printf 'launch_status=%s\n' "$status" >>"$launch_log"
    _debug_echo "window failed kind=terminal app=Terminal.app status=$status"
    echo "  [window] Terminal.app launch failed; see $launch_log"
    return "$status"
  fi
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
You are the user's first local Understudy. You are running privately on their Mac through Apple MLX. Start by saying you are ready, then invite them to try one real task. Keep the tone concise and practical. After one or two local-only prompts, suggest profiling the user's real AI workload: inspect its prompts, traces, dataset rows, code path, and success criteria before comparing or optimizing models. Mention that a frontier head-to-head is available as an optional calibration step, but the main path is understanding and improving the actual workload.
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
  _refresh_agent_card "$FIRST_NAME" "$FIRST_REPO" "$FIRST_PORT" "$FIRST_LOADER" "$FIRST_PROVIDER" "$S"

  tmux send-keys -t "$S" C-c
  tmux send-keys -t "$S" "clear && echo 'UNDERSTUDY LABS' && echo 'Your first local understudy is ready.' && echo && echo 'Model: $FIRST_REPO' && echo 'Endpoint: http://127.0.0.1:$FIRST_PORT/v1' && echo && $(_pi_cmd_with_prompt "$FIRST_PROVIDER" "$FIRST_REPO" "$first_prompt")" C-m
  tmux select-pane -t "$S" -T " FIRST UNDERSTUDY · $FIRST_NAME · $FIRST_REPO " 2>/dev/null || true
  echo "Ready → attach: tmux attach -t $S"
  echo "Next: profile a real workload with skills/understand-workload/SKILL.md"
  echo "Optional calibration: skills/mlx-arena/arena.sh play"
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
  _refresh_agent_card "${LOCAL_NAME:-Gemma 4 E2B}" "$LEFT_REPO" "$LEFT_PORT" "$LEFT_LOADER" "$LEFT_PROVIDER" "$S"
  frontier_model="${FRONTIER_MODEL:-}"
  # seed the frontier keys into the tmux global env (not echoed) so the game pane inherits them
  tmux start-server 2>/dev/null || true
  tmux setenv -g ANTHROPIC_LOCAL_KEY "${ANTHROPIC_LOCAL_KEY:-${ANTHROPIC_API_KEY:-}}"
  tmux setenv -g ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"
  tmux setenv -g OPENAI_API_KEY "${OPENAI_API_KEY:-}"
  tmux setenv -g FRONTIER_API_KEY "${FRONTIER_API_KEY:-}"
  tmux setenv -g AI_GATEWAY_API_KEY "${AI_GATEWAY_API_KEY:-}"
  tmux setenv -g FRONTIER_BASE_URL "${FRONTIER_BASE_URL:-}"
  tmux setenv -g AI_GATEWAY_BASE_URL "${AI_GATEWAY_BASE_URL:-}"
  tmux setenv -g OPENAI_BASE_URL "${OPENAI_BASE_URL:-}"
  tmux setenv -g OPENAI_MODEL "${OPENAI_MODEL:-}"
  tmux setenv -g ANTHROPIC_MODEL "${ANTHROPIC_MODEL:-}"
  tmux setenv -g AI_GATEWAY_MODEL "${AI_GATEWAY_MODEL:-}"
  tmux setenv -g UNDERSTUDY_FALLBACK_MODEL "${UNDERSTUDY_FALLBACK_MODEL:-}"
  tmux setenv -g FRONTIER_FALLBACK "${FRONTIER_FALLBACK:-}"
  tmux setenv -g FRONTIER_REASONING_EFFORT "${FRONTIER_REASONING_EFFORT:-}"
  tmux setenv -g FRONTIER_MAX_COMPLETION_TOKENS "${FRONTIER_MAX_COMPLETION_TOKENS:-}"
  tmux kill-session -t "$S" 2>/dev/null || true
  tmux new-session -d -s "$S" -x 138 -y 60 -n arena
  _prepare_tmux_session "$S"
  tmux send-keys -t "$S" "clear && LOCAL_BASE=http://127.0.0.1:${LEFT_PORT}/v1 LOCAL_MODEL=${LEFT_REPO} LOCAL_NAME='${LOCAL_NAME:-Gemma 4 E2B}' CATEGORY='${CATEGORY:-}' FRONTIER_MODEL='$frontier_model' DATASET='${DATASET:-}' node --experimental-strip-types '$here/blind_arena.ts'" C-m
  echo "Ready → attach and play:   tmux attach -t $S     (detach: Ctrl-b d)"
}

cmd_play_window() {
  local here quoted_here env_file quoted_env_file
  here="$(cd "$(dirname "$0")" && pwd)"
  quoted_here="$(printf '%q' "$here")"
  env_file="$(_write_window_env_file)"
  quoted_env_file="$(printf '%q' "$env_file")"
  _open_terminal_run ". $quoted_env_file; rm -f $quoted_env_file; cd $quoted_here/../.. && '$here/arena.sh' play; tmux attach -t ${SESSION}-play"
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
  cleanup) shift; cmd_cleanup "$@" ;;
  diagnose) cmd_diagnose ;;
  attach) cmd_attach ;;
  *) echo "usage: $0 {first|first-window|play|play-window|up|ask <text>|left <text>|right <text>|capture|logs|status|down|cleanup [--dry-run|--force]|diagnose|attach}" >&2; exit 2 ;;
esac
