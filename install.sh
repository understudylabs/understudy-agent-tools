#!/usr/bin/env bash
# Install Understudy agent tools and hand the user back to Claude Code skills.
set -euo pipefail

LAB="${UNDERSTUDY_LAB:-$HOME/.understudy/agent-tools}"
INSTALL_REPO_URL="${UNDERSTUDY_INSTALL_REPO_URL:-https://github.com/UnderstudyLabs/understudy-agent-tools.git}"
INSTALL_REF="${UNDERSTUDY_INSTALL_REF:-main}"
INSTALL_PACKAGE="${UNDERSTUDY_INSTALL_PACKAGE:-}"
INSTALL_SOURCE_DIR="${UNDERSTUDY_INSTALL_SOURCE_DIR:-$LAB/source/understudy-agent-tools}"
STATE_DIR="${UNDERSTUDY_INSTALL_STATE_DIR:-$LAB/install-state}"
INSTALLER_COMMIT="${UNDERSTUDY_INSTALLER_COMMIT:-unknown}"
LAUNCH_CLAUDE="${UNDERSTUDY_LAUNCH_CLAUDE:-1}"
NO_CLAUDE=0
START_STEP=1
ONLY_STEP=""
RESUME=0
YES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-claude) NO_CLAUDE=1 ;;
    --no-launch-claude) LAUNCH_CLAUDE=0 ;;
    --launch-claude) LAUNCH_CLAUDE=1 ;;
    --from-step) START_STEP="${2:?missing step number}"; shift ;;
    --only-step) ONLY_STEP="${2:?missing step number}"; shift ;;
    --resume) RESUME=1 ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--resume] [--from-step N] [--only-step N] [--no-claude] [--no-launch-claude]

Installs the Understudy CLI + Claude Code skill/plugin surface, then hands the
user back to Claude Code. It does not download model weights, start MLX, install
Pi, launch tmux/iTerm, or make frontier calls. Those are guided by the
/understudy:onboard skill after the user is in their coding agent.

Options:
  --yes                 approve the installer prompt
  --resume              continue from the next unfinished install step
  --from-step N         start from step 1, 2, or 3
  --only-step N         run only step 1, 2, or 3
  --no-claude           skip Claude Code plugin install and final Claude launch
  --no-launch-claude    install plugin but do not open Claude Code at the end
  --launch-claude       open Claude Code at the end (default)
  --lab PATH            local Understudy runtime/log directory

Environment overrides:
  UNDERSTUDY_LAB                 local runtime/log directory, default ~/.understudy/agent-tools
  UNDERSTUDY_INSTALL_REPO_URL    public repo URL, default https://github.com/UnderstudyLabs/understudy-agent-tools.git
  UNDERSTUDY_INSTALL_REF         Git ref for public repo install, default main
  UNDERSTUDY_INSTALL_SOURCE_DIR  local repo checkout, default $UNDERSTUDY_LAB/source/understudy-agent-tools
  UNDERSTUDY_INSTALL_STATE_DIR   install markers, default $UNDERSTUDY_LAB/install-state
  UNDERSTUDY_INSTALL_LOG_DIR     install logs, default $UNDERSTUDY_LAB/logs
  UNDERSTUDY_INSTALL_LOG_FILE    exact install log path
  UNDERSTUDY_INSTALLER_COMMIT    optional script commit label when caller knows it
  UNDERSTUDY_INSTALL_PACKAGE     optional npm package spec override
  UNDERSTUDY_LAUNCH_CLAUDE      set to 0 to skip opening Claude Code
  UNDERSTUDY_CLAUDE_ARGS        optional extra args when launching Claude Code
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
    1|2|3) return 0 ;;
    *) echo "invalid step: $1 (expected 1-3)" >&2; exit 2 ;;
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
      1|2) START_STEP=$((last_step + 1)) ;;
      3) START_STEP=3 ;;
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
  say "In Claude Code, type /reload-plugins once to activate the skills."
  say "Then type /understudy:onboard so the agent can guide the first local Understudy."
}

launch_claude_code() {
  if [ "$NO_CLAUDE" != "0" ]; then
    say "Skipping Claude Code launch because --no-claude is set."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping Claude Code launch because --no-launch-claude is set."
    mark_step_done 3
    return 0
  fi
  if ! need claude; then
    say "Claude Code CLI not found; open Claude Code manually and run /reload-plugins then /understudy:onboard."
    mark_step_done 3
    return 0
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    say "No interactive terminal is available for Claude Code."
    say "Open Claude Code in this directory, then run /reload-plugins and /understudy:onboard."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3: open Claude Code."
  say "Claude Code will open in: $(pwd)"
  say "In Claude Code, type these slash commands:"
  say "  /reload-plugins"
  say "  /understudy:onboard"
  say "The onboarding skill will coach model download, terminal choice, tmux/Pi handoff, and any frontier comparison with explicit consent."
  say "Launching Claude Code now. Exit Claude to return to this shell."
  log "LAUNCH claude ${UNDERSTUDY_CLAUDE_ARGS:-}"
  # curl | sh leaves stdin attached to the pipe; reconnect Claude to the user's tty.
  # shellcheck disable=SC2086
  claude ${UNDERSTUDY_CLAUDE_ARGS:-} </dev/tty >/dev/tty 2>&1 || {
    local status="$?"
    say "Claude Code exited with status $status."
    return "$status"
  }
  mark_step_done 3
}

need npm || {
  say "npm is required. Install Node.js 20+ first: https://nodejs.org"
  exit 1
}

configure_resume

section "Welcome. We are going to install Understudy for your coding agent."
say "Install log: $LOG_FILE"
say "Installer script commit: $INSTALLER_COMMIT"
say "Install source ref: $INSTALL_REF"
say "This installer bootstraps the CLI and Claude Code skills, then drops you back into your coding agent."
say ""
say "Install plan:"
say "  1. Download and install the Understudy CLI from $INSTALL_REPO_URL#$INSTALL_REF."
say "  2. Install or refresh the Claude Code skills when Claude Code is available."
say "  3. Open Claude Code in this directory and show the next slash commands."
say ""
say "Default install does not download weights, start MLX, install Pi, launch tmux/iTerm, or make frontier calls."
say "Those actions happen later through /understudy:onboard, where the coding agent can coach the user and ask consent."
say "This installer writes only under $LAB, $HOME/.understudy, the global npm prefix, and Claude Code plugin state when enabled."
confirm "Continue with this Understudy installation?" || exit 1

PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"

if should_run_step 1; then
  section "Step 1/3: install the CLI."
  install_understudy_package
  PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"
  mark_step_done 1
else
  say "Skipping step 1/3: install the CLI."
fi

if should_run_step 2; then
  section "Step 2/3: install the Claude Code skills."
  install_claude_plugin
  mark_step_done 2
else
  say "Skipping step 2/3: install the Claude Code skills."
fi

section "Where this goes next."
say "The installer is done. The next experience belongs inside Claude Code:"
say "  1. /reload-plugins"
say "  2. /understudy:onboard"
say "That lets the coding agent explain the first local Understudy, open a terminal of the user's choice when needed, and run the same commands itself when appropriate."
if should_run_step 3; then
  launch_claude_code
else
  say "Skipping step 3/3: open Claude Code."
fi
