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
    --model-session-url) MODEL_SESSION_URL="${2:?missing URL}"; shift ;;
    --model-base-url) MODEL_SESSION_URL="${2:?missing URL}"; shift ;;
    --model-dir) MODEL_DIR="${2:?missing path}"; shift ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--no-claude] [--no-model] [--no-window] [--no-gauntlet]

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
  UNDERSTUDY_INSTALL_PACKAGE  optional npm package spec override
  SESSION                     tmux session prefix, default mlx-arena
EOF
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1munderstudy\033[0m %s\n' "$*"; }
section() {
  printf '\n\033[1munderstudy\033[0m %s\n' "$*"
}
need() { command -v "$1" >/dev/null 2>&1; }
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
  remove_previous_global_package

  if [ -n "$INSTALL_PACKAGE" ]; then
    say "Installing Understudy package from $INSTALL_PACKAGE"
    npm install -g "$INSTALL_PACKAGE"
    return 0
  fi

  need git || {
    say "git is required to install Understudy from the public repo."
    exit 1
  }

  say "Installing Understudy package from $INSTALL_REPO_URL#$INSTALL_REF"
  rm -rf "$INSTALL_SOURCE_DIR"
  mkdir -p "$(dirname "$INSTALL_SOURCE_DIR")"
  git clone --depth 1 --branch "$INSTALL_REF" "$INSTALL_REPO_URL" "$INSTALL_SOURCE_DIR" >/dev/null
  npm install --prefix "$INSTALL_SOURCE_DIR" --ignore-scripts >/dev/null
  npm run --prefix "$INSTALL_SOURCE_DIR" build >/dev/null
  npm install -g --ignore-scripts "$INSTALL_SOURCE_DIR" >/dev/null
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

section "Welcome. We are going to create your first local Understudy."
say "Understudy starts with a small open-weight model on your Mac."
say "You compare it against a frontier model, then climb the ladder with better data, evals, GEPA/RLM, bigger local models, or remote runs."
say "The point is concrete: build a replacement model for work you currently send to a frontier model."

if ! need uv; then
  say "uv is required for the isolated MLX runtime."
  confirm "Install uv from astral.sh now?" || exit 1
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

install_tmux

section "Step 1/5: install the CLI and Pi harness."
install_understudy_package
npm install -g @earendil-works/pi-coding-agent

PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"
ARENA="$PKG_DIR/skills/mlx-arena/arena.sh"
if [ ! -x "$ARENA" ]; then
  say "Could not find executable arena launcher at $ARENA."
  say "If this is a local checkout, run from the repo with: skills/mlx-arena/arena.sh first-window"
  exit 1
fi

section "Step 2/5: install the Claude Code skills."
install_claude_plugin

mkdir -p "$LAB" "$MODEL_DIR" "$HOME/.understudy/models"
if [ ! -x "$LAB/.understudy/venvs/mlx/bin/python" ]; then
  say "Creating isolated MLX runtime."
  uv venv "$LAB/.understudy/venvs/mlx" --python 3.12
  uv pip install --python "$LAB/.understudy/venvs/mlx/bin/python" \
    'mlx-lm>=0.31' 'mlx-vlm>=0.6' 'huggingface_hub>=0.27'
fi

download_file() {
  local name="$1"
  local url="$2"
  local target="$MODEL_DIR/$name"
  local partial="$target.part"
  [ -s "$target" ] && return 0
  mkdir -p "$(dirname "$target")"
  rm -f "$target"
  curl -fL --progress-bar "$url" -o "$partial"
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
  section "Step 3/5: download the first local Understudy."
  say "Model: Gemma 4 E2B IT, MLX-VLM 4-bit, about 3.3GB."
  say "Why this rung: small enough to run locally, strong enough to make the replacement loop tangible."
  say "Source: signed Understudy snapshot at $MODEL_SESSION_URL"
  confirm "Download this verified open-weight snapshot now?" || exit 1
  download_model_snapshot
else
  section "Step 3/5: use the existing local Understudy weights."
  say "Model directory: $MODEL_DIR"
fi

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

if [ "$NO_GAUNTLET" = "0" ]; then
  section "Step 5/5: run the local-vs-frontier duel."
  say "Pi opens a side-by-side harness: local Understudy on the left, frontier baseline on the right."
  say "The shared tmux session is ${SESSION:-mlx-arena}-play; the agent can send prompts and you can watch or take over."
  say "After the stock questions, point Understudy at a dataset or codebase."
  say "Then use the skills to generate task-specific evals and climb: better prompts, GEPA/RLM, larger Gemma/Nemotron, or remote training."
  if [ "$NO_WINDOW" = "1" ]; then
    LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
      LEFT_REPO="$MODEL_DIR" LEFT_LOADER=mlx_vlm LOCAL_NAME="Gemma 4 E2B" "$ARENA" play
  else
    LAB="$LAB" MLX_PYTHON="$LAB/.understudy/venvs/mlx/bin/python" \
      LEFT_REPO="$MODEL_DIR" LEFT_LOADER=mlx_vlm LOCAL_NAME="Gemma 4 E2B" "$ARENA" play-window
  fi
else
  section "Next: run the local-vs-frontier duel."
  say "  LAB=\"$LAB\" MLX_PYTHON=\"$LAB/.understudy/venvs/mlx/bin/python\" LEFT_REPO=\"$MODEL_DIR\" LEFT_LOADER=mlx_vlm \"$ARENA\" play"
fi

section "Where this goes next."
say "Bring a codebase or dataset. Understudy will make a baseline environment, score local versus frontier, and keep climbing until a cheaper replacement is credible."
say "If Claude Code was open during install, type /reload-plugins there so the Understudy skills become visible in that same session."
