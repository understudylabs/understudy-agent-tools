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
CLAUDE_PERMISSION_MODE="${UNDERSTUDY_CLAUDE_PERMISSION_MODE:-auto}"
USER_PROMPT_OVERRIDE="${UNDERSTUDY_INITIAL_CLAUDE_PROMPT:-}"
INITIAL_CLAUDE_PROMPT=""
KEEP_LOGIN="${UNDERSTUDY_KEEP_LOGIN:-0}"
NO_CLAUDE=0
START_STEP=1
ONLY_STEP=""
RESUME=0
YES=0
NONINTERACTIVE="${UNDERSTUDY_NONINTERACTIVE:-${CI:-0}}"
REQUIRE_CONFIRM="${UNDERSTUDY_REQUIRE_CONFIRM:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --non-interactive|--noninteractive|--no-input) NONINTERACTIVE=1 ;;
    --require-confirm) REQUIRE_CONFIRM=1 ;;
    --no-claude) NO_CLAUDE=1 ;;
    --no-launch-claude) LAUNCH_CLAUDE=0 ;;
    --launch-claude) LAUNCH_CLAUDE=1 ;;
    --keep-login) KEEP_LOGIN=1 ;;
    --fresh-login) KEEP_LOGIN=0 ;;
    --from-step) START_STEP="${2:?missing step number}"; shift ;;
    --only-step) ONLY_STEP="${2:?missing step number}"; shift ;;
    --resume) RESUME=1 ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--non-interactive] [--resume] [--from-step N] [--only-step N] [--keep-login] [--no-claude] [--no-launch-claude]

Installs the Understudy CLI + Claude Code skill/plugin surface, then hands the
user back to Claude Code, where the coding agent runs the agent-first sign-up
(email one-time code through `understudy login`) and onboarding. It does not
download model weights, start MLX, launch the ladder server, or make
frontier calls. Those are guided by the /understudy:onboard skill after the
user is in their coding agent.

If you are already signed in, the installer signs you out by default so the
agent-first sign-up can be experienced (or demoed) from scratch. Only the
login state is touched — profile, models, and history under ~/.understudy are
preserved, and the old credentials file is kept as a timestamped backup.
Pass --keep-login to keep the existing sign-in.

Options:
  --yes                 approve the installer prompt
  --non-interactive     use safe defaults without prompting
  --require-confirm     fail instead of using defaults when no prompt TTY exists
  --resume              continue from the next unfinished install step
  --from-step N         start from step 1, 2, or 3
  --only-step N         run only step 1, 2, or 3
  --keep-login          keep an existing sign-in instead of resetting it
  --fresh-login         reset an existing sign-in for agent-first sign-up (default)
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
  UNDERSTUDY_NONINTERACTIVE      set to 1 to use safe defaults without prompting
  UNDERSTUDY_REQUIRE_CONFIRM     set to 1 to fail when no prompt TTY exists
  UNDERSTUDY_KEEP_LOGIN          set to 1 to keep an existing sign-in
  UNDERSTUDY_LAUNCH_CLAUDE      set to 0 to skip opening Claude Code
  UNDERSTUDY_CLAUDE_ARGS        optional extra args when launching Claude Code
  UNDERSTUDY_CLAUDE_PERMISSION_MODE Claude Code permission mode, default auto
  UNDERSTUDY_INITIAL_CLAUDE_PROMPT initial prompt passed to Claude Code
  NO_COLOR                      disable all installer styling
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

# ── presentation ─────────────────────────────────────────────────────
# Fancy output needs a TTY on stdout; pipes, CI, and dumb terminals get
# the plain `understudy <message>` lines so logs and tests stay stable.
FANCY=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  FANCY=1
fi

if [ "$FANCY" = "1" ]; then
  R=$'\033[0m' B=$'\033[1m' D=$'\033[2m'
  case "${COLORTERM:-}" in
    *truecolor*|*24bit*)
      # stage-light gradient: indigo -> cyan -> spring green
      G1=$'\033[38;2;139;132;250m' G2=$'\033[38;2;120;156;250m'
      G3=$'\033[38;2;97;181;246m'  G4=$'\033[38;2;72;204;231m'
      G5=$'\033[38;2;56;222;205m'  G6=$'\033[38;2;72;235;170m'
      ;;
    *)
      G1=$'\033[38;5;105m' G2=$'\033[38;5;111m' G3=$'\033[38;5;75m'
      G4=$'\033[38;5;44m'  G5=$'\033[38;5;43m'  G6=$'\033[38;5;48m'
      ;;
  esac
  AC="$G3" OKC=$'\033[38;5;42m' WARNC=$'\033[33m' ERRC=$'\033[31m'
  trap 'printf "\033[?25h" 2>/dev/null || true' EXIT
else
  R="" B="" D="" G1="" G2="" G3="" G4="" G5="" G6=""
  AC="" OKC="" WARNC="" ERRC=""
fi

log() { printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >>"$LOG_FILE"; }
say() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s│%s %s\n' "$D" "$R" "$*"
  else
    printf '\033[1munderstudy\033[0m %s\n' "$*"
  fi
  log "$*"
}
ok() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s✓%s %s\n' "$OKC" "$R" "$*"
  else
    printf '\033[1munderstudy\033[0m %s\n' "$*"
  fi
  log "$*"
}
warn() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s!%s %s\n' "$WARNC" "$R" "$*"
  else
    printf '\033[1munderstudy\033[0m %s\n' "$*"
  fi
  log "$*"
}
fail_line() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s✗%s %s\n' "$ERRC" "$R" "$*"
  else
    printf '\033[1munderstudy\033[0m %s\n' "$*"
  fi
  log "$*"
}
section() {
  if [ "$FANCY" = "1" ]; then
    # bash 3.2 (macOS default) counts bytes, not characters, in ${#var}
    # and substring expansion — measure with wc -m and build the rule
    # character by character so multibyte titles stay valid UTF-8.
    local title="$*" len n pad=""
    len=$(printf '%s' "$title" | wc -m)
    n=$((54 - len))
    [ "$n" -lt 2 ] && n=2
    # bash 3.2's lexer misparses an unbraced $pad butted against the
    # multibyte ─ ("pad\xe2: unbound variable" under set -u) — keep braces
    while [ "$n" -gt 0 ]; do pad="${pad}─"; n=$((n - 1)); done
    printf '\n  %s──%s %s%s%s %s%s%s\n' "$AC" "$R" "$B" "$title" "$R" "$AC" "$pad" "$R"
  else
    printf '\n\033[1munderstudy\033[0m %s\n' "$*"
  fi
  log "$*"
}
banner() {
  if [ "$FANCY" != "1" ]; then
    return 0
  fi
  printf '\n'
  printf '  %s%s%s\n' "$G1" '                   __               __            __' "$R"
  printf '  %s%s%s\n' "$G2" '  __  ______  ____/ /__  __________/ /___  ______/ /_  __' "$R"
  printf '  %s%s%s\n' "$G3" ' / / / / __ \/ __  / _ \/ ___/ ___/ __/ / / / __  / / / /' "$R"
  printf '  %s%s%s\n' "$G4" '/ /_/ / / / / /_/ /  __/ /  (__  ) /_/ /_/ / /_/ / /_/ /' "$R"
  printf '  %s%s%s\n' "$G5" '\__,_/_/ /_/\__,_/\___/_/  /____/\__/\__,_/\__,_/\__, /' "$R"
  printf '  %s%s%s\n' "$G6" '                                                /____/' "$R"
  printf '\n  %severy frontier model deserves an understudy%s\n' "$D" "$R"
}
# run_logged <label> <command...> — run quietly into the install log,
# with a live spinner on a TTY and a plain line everywhere else.
run_logged() {
  local label="$1"
  shift
  log "RUN $*"
  local status=0
  if [ "$FANCY" = "1" ]; then
    local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0 start=$SECONDS
    "$@" >>"$LOG_FILE" 2>&1 &
    local pid=$!
    printf '\033[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s %s%ss%s ' "$AC" "${frames[$((i % 10))]}" "$R" "$label" "$D" "$((SECONDS - start))" "$R"
      i=$((i + 1))
      sleep 0.1
    done
    wait "$pid" || status=$?
    printf '\r\033[2K\033[?25h'
    if [ "$status" = "0" ]; then
      ok "$label ${D}($((SECONDS - start))s)${R}"
      return 0
    fi
  else
    if "$@" >>"$LOG_FILE" 2>&1; then
      return 0
    fi
    status="$?"
  fi
  fail_line "Command failed: $*"
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
  local answer
  [ "$YES" = "1" ] && return 0
  case "$NONINTERACTIVE" in
    1|true|TRUE|yes|YES|on|ON)
      if [ "$REQUIRE_CONFIRM" = "1" ]; then
        say "Confirmation is required but running non-interactively; rerun in a terminal or pass --yes."
        return 1
      fi
      say "Running non-interactively; using installer defaults."
      return 0
      ;;
  esac
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    say "No interactive terminal is available for prompts."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
  if ! printf "  %s?%s %s %s[y/N]%s " "$G4" "$R" "$1" "$D" "$R" >/dev/tty 2>/dev/null; then
    say "No interactive terminal is available for prompts."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
  if ! read -r answer </dev/tty 2>/dev/null; then
    say "No interactive terminal input is available."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
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
    run_logged "Install Understudy package" npm install -g "$INSTALL_PACKAGE"
    return 0
  fi

  need git || {
    say "git is required to install Understudy from the public repo."
    exit 1
  }

  say "Installing Understudy package from $INSTALL_REPO_URL#$INSTALL_REF"
  rm -rf "$INSTALL_SOURCE_DIR"
  mkdir -p "$(dirname "$INSTALL_SOURCE_DIR")"
  run_logged "Download Understudy ($INSTALL_REF)" git clone --depth 1 --branch "$INSTALL_REF" "$INSTALL_REPO_URL" "$INSTALL_SOURCE_DIR"
  package_commit="$(git -C "$INSTALL_SOURCE_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  say "Understudy package commit: $package_commit"
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$package_commit" >"$STATE_DIR/package-commit"
  run_logged "Install dependencies" npm install --prefix "$INSTALL_SOURCE_DIR" --ignore-scripts
  run_logged "Build the CLI" npm run --prefix "$INSTALL_SOURCE_DIR" build
  run_logged "Link the understudy command" npm install -g --ignore-scripts "$INSTALL_SOURCE_DIR"
}

# ── agent-first sign-in ──────────────────────────────────────────────
# The sign-up itself belongs to the coding agent (`understudy login`
# sends an email code; `understudy login --code` finishes). The
# installer only resets login state so that experience starts from
# scratch — everything else under ~/.understudy is preserved.
CREDENTIALS_FILE="$HOME/.understudy/credentials.json"
KNOWN_EMAIL=""

credentials_email() {
  need node || return 0
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(c.email)process.stdout.write(c.email)}catch(e){}' "$CREDENTIALS_FILE" 2>/dev/null || true
}

prepare_agent_first_signin() {
  [ -n "$ONLY_STEP" ] && return 0
  section "Prepare the agent-first sign-in."
  if [ -f "$CREDENTIALS_FILE" ]; then
    KNOWN_EMAIL="$(credentials_email)"
    if [ "$KEEP_LOGIN" = "1" ]; then
      say "Keeping the existing Understudy sign-in (--keep-login)."
      return 0
    fi
    local backup
    backup="$HOME/.understudy/credentials.json.bak-$(date -u +"%Y%m%dT%H%M%SZ")"
    mv "$CREDENTIALS_FILE" "$backup"
    rm -f "$HOME/.understudy/login-pending.json"
    if [ -n "$KNOWN_EMAIL" ]; then
      ok "Signed out $KNOWN_EMAIL so the agent can run the sign-up from scratch."
    else
      ok "Signed out so the agent can run the sign-up from scratch."
    fi
    say "Only the login state was reset; profile, models, and history under ~/.understudy are untouched."
    say "Credentials backup: $backup"
    say "Restore it without re-signing in: mv \"$backup\" \"$CREDENTIALS_FILE\""
    say "Keep the sign-in next time with --keep-login."
  else
    say "No existing sign-in found; the coding agent will run the first sign-up."
  fi
  if [ -z "$KNOWN_EMAIL" ]; then
    KNOWN_EMAIL="$(git config --get user.email 2>/dev/null || true)"
  fi
}

compose_initial_prompt() {
  if [ -n "$USER_PROMPT_OVERRIDE" ]; then
    INITIAL_CLAUDE_PROMPT="$USER_PROMPT_OVERRIDE"
    return 0
  fi
  local signup="" email_clause
  if [ ! -f "$CREDENTIALS_FILE" ]; then
    if [ -n "$KNOWN_EMAIL" ]; then
      email_clause="run \`understudy login --email $KNOWN_EMAIL\`"
    else
      email_clause="ask me for my email, then run \`understudy login --email <my-email>\`"
    fi
    signup="Start with the agent-first Understudy sign-up: check \`understudy status --json\`, and if signed_in is false, $email_clause — it emails me a one-time code and exits. Ask me for the code from my inbox (or fetch it yourself if you have email access, reading only the Understudy sign-in email), finish with \`understudy login --code <code>\`, and confirm with \`understudy status --json\`. Then "
  fi
  if [ -n "$signup" ]; then
    INITIAL_CLAUDE_PROMPT="${signup}use the Understudy onboarding skill for this project. Guide me through getting my first local Understudy, launch the ladder climb, then help me pick a real problem or find local data so we can try to make the Understudy beat the frontier on that task slice."
  else
    INITIAL_CLAUDE_PROMPT="Use the Understudy onboarding skill for this project now. Guide me through getting my first local Understudy, launch the ladder climb, then help me pick a real problem or find local data so we can try to make the Understudy beat the frontier on that task slice."
  fi
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
    ok "Understudy plugin already appears installed."
  else
    run_logged "Register the plugin marketplace" claude plugin marketplace add "$repo"
    run_logged "Install the Understudy plugin" claude plugin install understudy@understudy-skills
    ok "Understudy plugin installed."
  fi
  say "In Claude Code, type /reload-plugins once to activate the skills."
  say "Then type /understudy:onboard so the agent can guide the first local Understudy."
}

launch_claude_code() {
  local claude_log
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

  section "Step 3/3 · Open Claude Code"
  say "Claude Code will open in: $(pwd)"
  say "The Understudy plugin will be loaded for this launch with --plugin-dir."
  say "Claude Code permission mode: $CLAUDE_PERMISSION_MODE."
  say "Claude Code will receive the first prompt automatically:"
  say "  ${D}$INITIAL_CLAUDE_PROMPT${R}"
  say "If you open a separate existing Claude Code session later, run /reload-plugins there once."
  say "Launching Claude Code now. Exit Claude to return to this shell."
  claude_log="$LOG_DIR/claude-$(date -u +"%Y%m%dT%H%M%SZ").log"
  say "Claude Code launch log: $claude_log"
  log "LAUNCH claude --permission-mode $CLAUDE_PERMISSION_MODE --plugin-dir $PKG_DIR ${UNDERSTUDY_CLAUDE_ARGS:-} <initial-prompt>"
  if need script; then
    # curl | sh leaves stdin attached to the pipe. `script` gives Claude Code a
    # real pseudo-terminal while also capturing the launch output for debugging.
    # macOS script(1) takes a positional command; Linux script(1) needs -c.
    # shellcheck disable=SC2086
    if [ "$(uname -s)" = "Darwin" ]; then
      script -q "$claude_log" claude --permission-mode "$CLAUDE_PERMISSION_MODE" --plugin-dir "$PKG_DIR" ${UNDERSTUDY_CLAUDE_ARGS:-} "$INITIAL_CLAUDE_PROMPT" </dev/tty >/dev/tty 2>&1 || {
        local status="$?"
        say "Claude Code exited with status $status."
        say "See Claude Code launch log: $claude_log"
        return "$status"
      }
    else
      say "script(1) command syntax varies on non-macOS; launching without a Claude Code transcript."
      # shellcheck disable=SC2086
      claude --permission-mode "$CLAUDE_PERMISSION_MODE" --plugin-dir "$PKG_DIR" ${UNDERSTUDY_CLAUDE_ARGS:-} "$INITIAL_CLAUDE_PROMPT" </dev/tty >/dev/tty 2>&1 || {
        local status="$?"
        say "Claude Code exited with status $status."
        return "$status"
      }
    fi
  else
    say "script(1) not found; launching without a Claude Code transcript."
    # shellcheck disable=SC2086
    claude --permission-mode "$CLAUDE_PERMISSION_MODE" --plugin-dir "$PKG_DIR" ${UNDERSTUDY_CLAUDE_ARGS:-} "$INITIAL_CLAUDE_PROMPT" </dev/tty >/dev/tty 2>&1 || {
      local status="$?"
      say "Claude Code exited with status $status."
      return "$status"
    }
  fi
  mark_step_done 3
}

need npm || {
  say "npm is required. Install Node.js 20+ first: https://nodejs.org"
  exit 1
}

configure_resume

banner
if [ "$FANCY" = "1" ]; then
  section "Welcome"
else
  section "Welcome. We are going to install Understudy for your coding agent."
fi
say "This installer bootstraps the CLI and Claude Code skills, then drops you back into your coding agent."
say "Source: $INSTALL_REPO_URL#$INSTALL_REF ${D}(installer commit: $INSTALLER_COMMIT)${R}"
say "Install log: $LOG_FILE"
say ""
say "${B}Install plan${R}"
say "  ${G2}1.${R} Install the Understudy CLI."
if [ "$KEEP_LOGIN" = "1" ]; then
  say "  ${G3}·${R}  Keep the existing Understudy sign-in (--keep-login)."
else
  say "  ${G3}·${R}  Reset any existing sign-in so the agent-first sign-up starts fresh (backup kept; --keep-login skips)."
fi
say "  ${G4}2.${R} Install or refresh the Claude Code skills when Claude Code is available."
say "  ${G5}3.${R} Open Claude Code here — the agent signs you up by email code, then onboards you."
say ""
say "Default install does not download weights, start MLX, launch the ladder server, or make frontier calls."
say "Those actions happen later through /understudy:onboard, where the coding agent can coach the user and ask consent."
say "This installer writes only under $LAB, $HOME/.understudy, the global npm prefix, and Claude Code plugin state when enabled."
confirm "Continue with this Understudy installation?" || exit 1

PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"

if should_run_step 1; then
  section "Step 1/3 · Install the CLI"
  install_understudy_package
  PKG_DIR="$(npm root -g)/@understudylabs/understudy-agent-tools"
  mark_step_done 1
else
  say "Skipping step 1/3: install the CLI."
fi

prepare_agent_first_signin

if should_run_step 2; then
  section "Step 2/3 · Install the Claude Code skills"
  install_claude_plugin
  mark_step_done 2
else
  say "Skipping step 2/3: install the Claude Code skills."
fi

compose_initial_prompt

section "Where this goes next"
say "The installer is done. The next experience belongs inside Claude Code:"
say "  The launched Claude Code session receives the sign-up + onboarding prompt automatically."
say "  If you continue in an already-open Claude Code session instead, run /reload-plugins and then /understudy:onboard."
say "That lets the coding agent run the email-code sign-up itself, explain the first local Understudy, and open a terminal of the user's choice when needed."
if should_run_step 3; then
  launch_claude_code
else
  say "Skipping step 3/3: open Claude Code."
fi
