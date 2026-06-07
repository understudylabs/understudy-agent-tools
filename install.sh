#!/usr/bin/env bash
# Install Understudy agent tools, prepare the first local model, and open the
# first-run Understudy window.
set -euo pipefail

MODEL_SESSION_URL="${UNDERSTUDY_MODEL_SESSION_URL:-https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit&ttl=21600}"
MODEL_DIR="${UNDERSTUDY_MODEL_DIR:-$HOME/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit}"
LAB="${UNDERSTUDY_LAB:-$HOME/.understudy/agent-tools}"
INSTALL_REPO_URL="${UNDERSTUDY_INSTALL_REPO_URL:-https://github.com/UnderstudyLabs/understudy-agent-tools.git}"
INSTALL_REF="${UNDERSTUDY_INSTALL_REF:-main}"
INSTALL_PACKAGE="${UNDERSTUDY_INSTALL_PACKAGE:-}"
INSTALL_SOURCE_DIR="${UNDERSTUDY_INSTALL_SOURCE_DIR:-$LAB/source/understudy-agent-tools}"
STATE_DIR="${UNDERSTUDY_INSTALL_STATE_DIR:-$LAB/install-state}"
INSTALLER_COMMIT="${UNDERSTUDY_INSTALLER_COMMIT:-unknown}"
START_STEP=1
ONLY_STEP=""
RESUME=0
YES=0
NO_MODEL=0
NO_WINDOW=0
NO_GAUNTLET=0
NO_CLAUDE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-model) NO_MODEL=1 ;;
    --no-window) NO_WINDOW=1 ;;
    --no-gauntlet) NO_GAUNTLET=1 ;;
    --no-claude) NO_CLAUDE=1 ;;
    --from-step) START_STEP="${2:?missing step number}"; shift ;;
    --only-step) ONLY_STEP="${2:?missing step number}"; shift ;;
    --resume) RESUME=1 ;;
    --model-session-url) MODEL_SESSION_URL="${2:?missing URL}"; shift ;;
    --model-base-url) MODEL_SESSION_URL="${2:?missing URL}"; shift ;;
    --model-dir) MODEL_DIR="${2:?missing path}"; shift ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--from-step N] [--only-step N] [--resume] [--no-claude] [--no-model] [--no-window] [--no-gauntlet]

Installs the Understudy CLI + Claude skill/plugin surface, prepares Apple MLX,
downloads the verified Gemma 4 E2B 4-bit first rung, and opens the first local
Understudy in a new Terminal window on macOS.

Environment overrides:
  UNDERSTUDY_MODEL_SESSION_URL stable session endpoint that returns signed model file URLs
  UNDERSTUDY_MODEL_DIR        local model destination
  UNDERSTUDY_LAB              local runtime/log directory
  UNDERSTUDY_INSTALL_REPO_URL public repo URL, default https://github.com/UnderstudyLabs/understudy-agent-tools.git
  UNDERSTUDY_INSTALL_REF      Git ref for public repo install, default main
  UNDERSTUDY_INSTALL_SOURCE_DIR local repo checkout, default $UNDERSTUDY_LAB/source/understudy-agent-tools
  UNDERSTUDY_INSTALL_STATE_DIR install markers, default $UNDERSTUDY_LAB/install-state
  UNDERSTUDY_INSTALL_LOG_DIR   install logs, default $UNDERSTUDY_LAB/logs
  UNDERSTUDY_INSTALLER_COMMIT  optional script commit label when caller knows it
  UNDERSTUDY_INSTALL_PACKAGE  optional npm package spec override
  SESSION                     tmux session prefix, default mlx-arena
EOF
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

LOG_DIR="${UNDERSTUDY_INSTALL_LOG_DIR:-$LAB/logs}"
LOG_FILE="${UNDERSTUDY_INSTALL_LOG_FILE:-$LOG_DIR/install-$(date -u +"%Y%m%dT%H%M%SZ").log}"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >>"$LOG_FILE"; }
say() {
  printf '\033[1munderstudy\033[0m %s\n' "$*"
  log "$*"
}
section() {
  printf '\n\033[1munderstudy\033[0m %s\n' "$*"
  log "$*"
}
run_logged() {
  log "RUN $*"
  if "$@" >>"$LOG_FILE" 2>&1; then
    return 0
  fi
  local status="$?"
  say "Command failed: $*"
  say "See install log: $LOG_FILE"
  tail -40 "$LOG_FILE" >&2 || true
  return "$status"
}
need() { command -v "$1" >/dev/null 2>&1; }
valid_step() {
  case "$1" in
    1|2|3|4|5) return 0 ;;
    *) echo "invalid step: $1 (expected 1-5)" >&2; exit 2 ;;
  esac
}
should_run_step() {
  local step="$1"
  if [ -n "$ONLY_STEP" ]; then
    [ "$step" = "$ONLY_STEP" ]
  else
    [ "$step" -ge "$START_STEP" ]
  fi
}
mark_step_done() {
  local step="$1"
  mkdir -p "$STATE_DIR"
  date -u +"%Y-%m-%dT%H:%M:%SZ" >"$STATE_DIR/step-$step.done"
  printf '%s\n' "$step" >"$STATE_DIR/last-step"
}
configure_resume() {
  local last_step
  valid_step "$START_STEP"
  [ -z "$ONLY_STEP" ] || valid_step "$ONLY_STEP"
  if [ "$RESUME" = "1" ] && [ -f "$STATE_DIR/last-step" ]; then
    last_step="$(cat "$STATE_DIR/last-step" 2>/dev/null || true)"
    case "$last_step" in
      1|2|3|4) START_STEP=$((last_step + 1)) ;;
      5) START_STEP=5 ;;
    esac
    say "Resuming from step $START_STEP based on $STATE_DIR/last-step"
  fi
}
confirm() {
  [ "$YES" = "1" ] && return 0
  if [ ! -r /dev/tty ]; then
    say "This install is running without an interactive terminal for prompts."
    say "Rerun with --yes to approve, for example: curl -fsSL .../install.sh | bash -s -- --yes"
    return 1
  fi
  printf "%s [y/N] " "$1" >/dev/tty
  read -r answer </dev/tty
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

install_tmux() {
  need tmux && return 0
  say "tmux is required for the visible handoff window."
  if need brew; then
    confirm "Install tmux with Homebrew now?" || exit 1
    brew install tmux
    return 0
  fi
  say "Install tmux first, then rerun this installer."
  say "On macOS with Homebrew: brew install tmux"
  exit 1
}

remove_previous_global_package() {
  local global_root global_prefix package_path bin_path
  global_root="$(npm root -g)"
  global_prefix="$(npm prefix -g)"
  package_path="$global_root/@understudylabs/understudy-agent-tools"

  if [ -e "$package_path" ] || [ -L "$package_path" ]; then
    say "Removing previous global Understudy install at $package_path"
    npm uninstall -g @understudylabs/understudy-agent-tools >/dev/null 2>&1 || true
    if [ -e "$package_path" ] || [ -L "$package_path" ]; then
      rm -rf "$package_path"
    fi
  fi

  for bin_path in "$global_prefix/bin/understudy" "$HOME/.local/bin/understudy"; do
    [ -e "$bin_path" ] || [ -L "$bin_path" ] || continue
    if [ -L "$bin_path" ] && readlink "$bin_path" 2>/dev/null | grep -q 'understudy-agent-tools'; then
      say "Removing stale Understudy command at $bin_path"
      rm -f "$bin_path"
    elif [ -f "$bin_path" ] && grep -q 'understudy-agent-tools' "$bin_path" 2>/dev/null; then
      say "Removing stale Understudy command at $bin_path"
      rm -f "$bin_path"
    fi
  done
}

install_understudy_package() {
  local package_commit
  remove_previous_global_package

  if [ -n "$INSTALL_PACKAGE" ]; then
    say "Installing Understudy package from $INSTALL_PACKAGE"
    run_logged npm install -g "$INSTALL_PACKAGE"
    return 0
  fi

  need git || {
    say "git is required to install Understudy from the public repo."
    exit 1
  }

  say "Installing Understudy package from $INSTALL_REPO_URL#$INSTALL_REF"
  rm -rf "$INSTALL_SOURCE_DIR"
  mkdir -p "$(dirname "$INSTALL_SOURCE_DIR")"
  run_logged git clone --depth 1 --branch "$INSTALL_REF" "$INSTALL_REPO_URL" "$INSTALL_SOURCE_DIR"
  package_commit="$(git -C "$INSTALL_SOURCE_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  say "Understudy package commit: $package_commit"
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$package_commit" >"$STATE_DIR/package-commit"
  run_logged npm install --prefix "$INSTALL_SOURCE_DIR" --ignore-scripts
  run_logged npm run --prefix "$INSTALL_SOURCE_DIR" build
  run_logged npm install -g --ignore-scripts "$INSTALL_SOURCE_DIR"
}

install_claude_plugin() {
  [ "$NO_CLAUDE" = "1" ] && return 0

  if ! need claude; then
    say "Claude Code CLI not found; skipping plugin install."
    say "Later, from a checkout, run: claude plugin marketplace add <repo> && claude plugin install understudy@understudy-skills"
    return 0
  fi

  local repo="$PKG_DIR"
  if [ ! -f "$repo/.claude-plugin/plugin.json" ]; then
    repo="$(cd "$(dirname "$0")" && pwd)"
  fi
  if [ ! -f "$repo/.claude-plugin/plugin.json" ]; then
    say "Could not find .claude-plugin/plugin.json; skipping Claude Code plugin install."
    return 0
  fi

  say "Installing the Understudy Claude Code plugin from $repo."
  if claude plugin list --json 2>/dev/null | grep -q 'understudy@understudy-skills'; then
    say "Understudy plugin already appears installed."
  else
    claude plugin marketplace add "$repo" >/dev/null
    claude plugin install understudy@understudy-skills >/dev/null
    say "Understudy plugin installed."
  fi
  say "In your Claude Code session, type /reload-plugins once to activate the skills."
}

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  say "This first-run local model installer currently targets Apple Silicon Macs."
  say "Install the CLI with npm, then use the non-MLX skills for this machine."
  exit 1
fi

need npm || {
  say "npm is required. Install Node.js 20+ first: https://nodejs.org"
  exit 1
}

configure_resume

section "Welcome. We are going to create your first local Understudy."
say "Install log: $LOG_FILE"
say "Installer script commit: $INSTALLER_COMMIT"
say "Install source ref: $INSTALL_REF"
say "Understudy starts with a small open-weight model on your Mac."
say "You compare it against a frontier model, then climb the ladder with better data, evals, GEPA/RLM, bigger local models, or remote runs."
say "The point is concrete: build a replacement model for work you currently send to a frontier model."
say ""
say "Install plan:"
say "  1. Download the Understudy CLI and Pi terminal harness from $INSTALL_REPO_URL#$INSTALL_REF."
say "  2. Install the CLI globally so agents can run durable Understudy commands."
say "  3. Install the Claude Code skills when Claude Code is available, unless --no-claude is set."
say "  4. Create an isolated local MLX runtime under $LAB."
if [ "$NO_MODEL" = "0" ]; then
  say "  5. Download the first model snapshot into $MODEL_DIR."
  say "     First rung: Gemma 4 E2B IT, MLX-VLM 4-bit, about 3.3GB."
else
  say "  5. Reuse an existing model snapshot at $MODEL_DIR."
fi
say "  6. Open a tmux/Pi window so you can meet the local model as your first Understudy."
if [ "$NO_GAUNTLET" = "0" ]; then
  say "  7. Ask again before running the local-vs-frontier duel."
  say "     Frontier attempts use local OpenAI/Anthropic keys or a configured AI gateway first, then fall back to Understudy glm-5.1."
else
  say "  7. Skip the remote frontier duel because --no-gauntlet is set."
fi
say ""
say "This installer writes only under $LAB, $HOME/.understudy, the global npm prefix, and Claude Code plugin state when enabled."
confirm "Continue with this Understudy installation?" || exit 1

if ! need uv; then
  say "uv is required for the isolated MLX runtime."
  confirm "Install uv from astral.sh now?" || exit 1
  curl -LsSf https://astral.sh/uv/install.sh | sh 2>&1 | tee -a "$LOG_FILE"
  export PATH="$HOME/.local/bin:$PATH"
fi

PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"
ARENA="$PKG_DIR/skills/mlx-arena/arena.sh"

if should_run_step 1; then
  section "Step 1/5: install the CLI and Pi harness."
  install_understudy_package
  run_logged npm install -g @earendil-works/pi-coding-agent
  PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"
  ARENA="$PKG_DIR/skills/mlx-arena/arena.sh"
  mark_step_done 1
else
  say "Skipping step 1/5: install the CLI and Pi harness."
fi

if (should_run_step 2 || should_run_step 4 || should_run_step 5) && [ ! -x "$ARENA" ]; then
  say "Could not find executable arena launcher at $ARENA."
  say "Rerun from step 1, or install the CLI first."
  exit 1
fi

if should_run_step 2; then
  section "Step 2/5: install the Claude Code skills."
  install_claude_plugin
  mark_step_done 2
else
  say "Skipping step 2/5: install the Claude Code skills."
fi

if should_run_step 3 || should_run_step 4 || should_run_step 5; then
  mkdir -p "$LAB" "$MODEL_DIR" "$HOME/.understudy/models"
  if [ ! -x "$LAB/.understudy/venvs/mlx/bin/python" ]; then
    say "Creating isolated MLX runtime."
    run_logged uv venv "$LAB/.understudy/venvs/mlx" --python 3.12
    run_logged uv pip install --python "$LAB/.understudy/venvs/mlx/bin/python" \
      'mlx-lm>=0.31' 'mlx-vlm>=0.6' 'huggingface_hub>=0.27'
  fi
fi

download_file() {
  local name="$1"
  local url="$2"
  local target="$MODEL_DIR/$name"
  local partial="$target.part"
  local expected_size current_size
  expected_size="$(curl -fsIL "$url" 2>/dev/null | awk 'tolower($1)=="content-length:" {gsub("\r","",$2); size=$2} END {print size}')"
  if [ -s "$target" ]; then
    if [ -n "$expected_size" ]; then
      current_size="$(wc -c <"$target" | tr -d ' ')"
      [ "$current_size" = "$expected_size" ] && return 0
      say "Replacing incomplete $name ($current_size/$expected_size bytes)"
    else
      return 0
    fi
  fi
  mkdir -p "$(dirname "$target")"
  rm -f "$target"
  curl -fL --progress-bar "$url" -o "$partial"
  if [ -n "$expected_size" ]; then
    current_size="$(wc -c <"$partial" | tr -d ' ')"
    if [ "$current_size" != "$expected_size" ]; then
      rm -f "$partial"
      say "Downloaded $name has unexpected size ($current_size/$expected_size bytes)."
      return 1
    fi
  fi
  mv "$partial" "$target"
}

download_model_snapshot() {
  local manifest="$LAB/model-session.json"
  curl -fsSL "$MODEL_SESSION_URL" -o "$manifest"
  "$LAB/.understudy/venvs/mlx/bin/python" - "$manifest" <<'PY' | while IFS=$'\t' read -r name url
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
for item in data["files"]:
    print(f"{item['name']}\t{item['url']}")
PY
  do
    say "Downloading $name"
    download_file "$name" "$url"
  done
}

if [ "$NO_MODEL" = "0" ]; then
  if should_run_step 3; then
    section "Step 3/5: download the first local Understudy."
    say "Model: Gemma 4 E2B IT, MLX-VLM 4-bit, about 3.3GB."
    say "Why this rung: small enough to run locally, strong enough to make the replacement loop tangible."
    say "Source: signed Understudy snapshot at $MODEL_SESSION_URL"
    confirm "Download this verified open-weight snapshot now?" || exit 1
    download_model_snapshot
    mark_step_done 3
  else
    say "Skipping step 3/5: download the first local Understudy."
  fi
else
  section "Step 3/5: use the existing local Understudy weights."
  say "Model directory: $MODEL_DIR"
  should_run_step 3 && mark_step_done 3
fi

if should_run_step 4; then
  install_tmux
  section "Step 4/5: meet the local Understudy."
  say "A new Terminal window will show the model loading locally so you can see it is yours, not a hosted frontier call."
  say "If an agent launched this, follow the same session with: tmux attach -t ${SESSION:-mlx-arena}-first"
  if [ "$NO_WINDOW" = "1" ]; then
    LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
      FIRST_REPO="$MODEL_DIR" FIRST_LOADER=mlx_vlm "$ARENA" first
  else
    LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
      FIRST_REPO="$MODEL_DIR" FIRST_LOADER=mlx_vlm "$ARENA" first-window
  fi
  mark_step_done 4
else
  say "Skipping step 4/5: meet the local Understudy."
fi

if [ "$NO_GAUNTLET" = "0" ]; then
  if should_run_step 5; then
    install_tmux
    section "Step 5/5: run the local-vs-frontier duel."
    say "Pi opens a side-by-side harness: local Understudy on the left, frontier baseline on the right."
    say "This step may make remote frontier calls using a local OpenAI/Anthropic key, a configured AI gateway, or your Understudy gateway fallback."
    say "The shared tmux session is ${SESSION:-mlx-arena}-play; the agent can send prompts and you can watch or take over."
    say "After the stock questions, point Understudy at a dataset or codebase."
    say "Then use the skills to generate task-specific evals and climb: better prompts, GEPA/RLM, larger Gemma/Nemotron, or remote training."
    confirm "Launch the remote frontier comparison now?" || {
      say "Skipping frontier comparison. Run it later with:"
      say "  LAB=\"$LAB\" MLX_PYTHON=\"$LAB/.understudy/venvs/mlx/bin/python\" LEFT_REPO=\"$MODEL_DIR\" LEFT_LOADER=mlx_vlm \"$ARENA\" play"
      exit 0
    }
    if [ "$NO_WINDOW" = "1" ]; then
      LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
        LEFT_REPO="$MODEL_DIR" LEFT_LOADER=mlx_vlm LOCAL_NAME="Gemma 4 E2B" "$ARENA" play
    else
      LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
        LEFT_REPO="$MODEL_DIR" LEFT_LOADER=mlx_vlm LOCAL_NAME="Gemma 4 E2B" "$ARENA" play-window
    fi
    mark_step_done 5
  else
    say "Skipping step 5/5: run the local-vs-frontier duel."
  fi
else
  if should_run_step 5; then
    section "Next: run the local-vs-frontier duel."
    say "  LAB=\"$LAB\" MLX_PYTHON=\"$LAB/.understudy/venvs/mlx/bin/python\" LEFT_REPO=\"$MODEL_DIR\" LEFT_LOADER=mlx_vlm \"$ARENA\" play"
    mark_step_done 5
  else
    say "Skipping step 5/5: run the local-vs-frontier duel."
  fi
fi

section "Where this goes next."
say "Bring a codebase or dataset. Understudy will make a baseline environment, score local versus frontier, and keep climbing until a cheaper replacement is credible."
say "If Claude Code was open during install, type /reload-plugins there so the Understudy skills become visible in that same session."
