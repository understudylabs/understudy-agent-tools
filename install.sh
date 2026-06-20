#!/usr/bin/env bash
# Install Understudy agent tools and hand the user back to an agent skill surface.
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
AGENT_PLATFORMS="${UNDERSTUDY_AGENT_PLATFORMS:-auto}"
AGENT_PLATFORMS_EXPLICIT=0
[ -n "${UNDERSTUDY_AGENT_PLATFORMS:-}" ] && AGENT_PLATFORMS_EXPLICIT=1
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
    --agents|--agent) AGENT_PLATFORMS="${2:?missing agent platform list}"; AGENT_PLATFORMS_EXPLICIT=1; shift ;;
    --no-agents) AGENT_PLATFORMS="none"; AGENT_PLATFORMS_EXPLICIT=1; NO_CLAUDE=1; LAUNCH_CLAUDE=0 ;;
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
Usage: install.sh [--yes] [--non-interactive] [--resume] [--from-step N] [--only-step N] [--keep-login] [--agents auto|all|claude-code|cursor|codex|opencode|none] [--no-claude] [--no-launch-claude]

Installs the Understudy CLI + detected coding-agent skill/plugin surfaces, then
hands the user back to the selected coding agent when possible. It does not
download model weights, start MLX, launch the ladder server, or make frontier
calls. Those are guided by the Understudy onboarding skill after the user is in
their coding agent.

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
  --agents LIST         agent adapters to install: auto, all, claude-code, cursor, codex, opencode, none
                        comma-separated lists are accepted, e.g. claude-code,cursor
  --no-agents           skip all coding-agent plugin installs and launches
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
  UNDERSTUDY_AGENT_PLATFORMS     auto, all, claude-code, cursor, codex, opencode, none, or comma list
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
normalize_agent_platform() {
  case "$1" in
    claude|claude_code|claudecode) printf '%s\n' "claude-code" ;;
    cursor|codex|opencode|all|auto|none|claude-code) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
validate_agent_platforms() {
  local token normalized count mode
  count=0
  mode=""
  for token in $(printf '%s\n' "$AGENT_PLATFORMS" | tr ',;' '  '); do
    count=$((count + 1))
    normalized="$(normalize_agent_platform "$token")"
    case "$normalized" in
      auto|all|none) mode="$normalized" ;;
      claude-code|cursor|codex|opencode) ;;
      *)
        fail_line "Unknown agent adapter '$token'. Use auto, all, claude-code, cursor, codex, opencode, none, or a comma list of explicit adapters."
        return 1
        ;;
    esac
  done
  if [ "$count" -eq 0 ]; then
    fail_line "No agent adapter selection provided. Use auto, all, claude-code, cursor, codex, opencode, or none."
    return 1
  fi
  if [ -n "$mode" ] && [ "$count" -gt 1 ]; then
    fail_line "Agent adapter mode '$mode' cannot be combined with other values. Use '$mode' alone, or use a comma list like claude-code,cursor."
    return 1
  fi
}
agent_platform_requested() {
  local wanted token normalized
  wanted="$(normalize_agent_platform "$1")"
  for token in $(printf '%s\n' "$AGENT_PLATFORMS" | tr ',;' '  '); do
    normalized="$(normalize_agent_platform "$token")"
    case "$normalized" in
      all) return 0 ;;
      none|auto) ;;
      "$wanted") return 0 ;;
    esac
  done
  return 1
}
detect_claude_code() {
  need claude
}
detect_cursor() {
  need cursor ||
    [ -d "$HOME/.cursor" ] ||
    [ -d "/Applications/Cursor.app" ] ||
    [ -d "$HOME/Applications/Cursor.app" ]
}
detect_codex() {
  need codex
}
detect_opencode() {
  need opencode ||
    [ -x "$HOME/.opencode/bin/opencode" ] ||
    [ -d "$HOME/.config/opencode" ] ||
    [ -d "$HOME/.local/share/opencode" ]
}
default_agent_platform() {
  if [ "$NO_CLAUDE" != "1" ] && detect_claude_code; then
    printf '%s\n' "claude-code"
  elif detect_cursor; then
    printf '%s\n' "cursor"
  elif detect_codex; then
    printf '%s\n' "codex"
  elif detect_opencode; then
    printf '%s\n' "opencode"
  else
    printf '%s\n' "none"
  fi
}
detected_agent_label() {
  local name="$1" label="$2"
  if [ "$name" = "claude-code" ] && [ "$NO_CLAUDE" = "1" ]; then
    printf '%s\n' "$label (disabled by --no-claude)"
  elif case "$name" in
      claude-code) detect_claude_code ;;
      cursor) detect_cursor ;;
      codex) detect_codex ;;
      opencode) detect_opencode ;;
      *) return 1 ;;
    esac
  then
    printf '%s\n' "$label (detected)"
  else
    printf '%s\n' "$label (not detected)"
  fi
}
noninteractive_enabled() {
  case "$NONINTERACTIVE" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}
select_agent_platforms() {
  local answer default
  [ "$AGENT_PLATFORMS_EXPLICIT" = "0" ] || return 0
  should_run_step 2 || return 0
  [ "$YES" = "0" ] || return 0
  noninteractive_enabled && return 0
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 0

  default="$(default_agent_platform)"
  section "Choose Coding Agent"
  say "Where should Understudy install its agent plugin?"
  say "  ${G2}1.${R} $(detected_agent_label "claude-code" "Claude Code")"
  say "  ${G3}2.${R} $(detected_agent_label "cursor" "Cursor")"
  say "  ${G4}3.${R} $(detected_agent_label "codex" "Codex")"
  say "  ${G5}4.${R} $(detected_agent_label "opencode" "OpenCode")"
  say "  ${G6}5.${R} All detected coding agents"
  say "  ${G6}6.${R} CLI only, no coding-agent plugins"
  say "Press Enter for: $default."

  if ! printf "  %s?%s Install target %s[1/2/3/4/5/6 or name]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null; then
    return 0
  fi
  if ! read -r answer </dev/tty 2>/dev/null; then
    return 0
  fi
  case "$answer" in
    "") AGENT_PLATFORMS="$default" ;;
    1|claude|claude-code|claude_code|claudecode) AGENT_PLATFORMS="claude-code" ;;
    2|cursor) AGENT_PLATFORMS="cursor" ;;
    3|codex) AGENT_PLATFORMS="codex" ;;
    4|opencode|open-code|open_code) AGENT_PLATFORMS="opencode" ;;
    5|all|auto) AGENT_PLATFORMS="auto" ;;
    6|none|cli|cli-only|cli_only) AGENT_PLATFORMS="none" ;;
    *) AGENT_PLATFORMS="$answer" ;;
  esac
  validate_agent_platforms || exit 2
}
should_install_claude_adapter() {
  [ "$NO_CLAUDE" = "1" ] && return 1
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_claude_code; return ;;
  esac
  agent_platform_requested "claude-code"
}
should_install_cursor_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_cursor; return ;;
  esac
  agent_platform_requested "cursor"
}
should_install_codex_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_codex; return ;;
  esac
  agent_platform_requested "codex"
}
should_install_opencode_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_opencode; return ;;
  esac
  agent_platform_requested "opencode"
}
agent_plan_label() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    auto) printf '%s\n' "Autodetect and install available agent adapters." ;;
    none) printf '%s\n' "Skip coding-agent plugin adapters." ;;
    all) printf '%s\n' "Install all supported agent adapters." ;;
    *) printf '%s\n' "Install requested agent adapter(s): $AGENT_PLATFORMS." ;;
  esac
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

resolve_plugin_repo() {
  local manifest_dir="$1" repo="$PKG_DIR"
  if [ ! -f "$repo/$manifest_dir/plugin.json" ]; then
    repo="$(cd "$(dirname "$0")" && pwd)"
  fi
  if [ ! -f "$repo/$manifest_dir/plugin.json" ]; then
    repo="$(pwd)"
  fi
  if [ ! -f "$repo/$manifest_dir/plugin.json" ]; then
    return 1
  fi
  printf '%s\n' "$repo"
}
resolve_skill_repo() {
  local repo
  repo="$(cd "$(dirname "$0")" && pwd)"
  if [ ! -f "$repo/skills/understudy/SKILL.md" ]; then
    repo="$(pwd)"
  fi
  if [ ! -f "$repo/skills/understudy/SKILL.md" ]; then
    repo="$PKG_DIR"
  fi
  if [ ! -f "$repo/skills/understudy/SKILL.md" ]; then
    return 1
  fi
  printf '%s\n' "$repo"
}

install_claude_plugin() {
  if ! should_install_claude_adapter; then
    say "Claude Code adapter not selected or not detected; skipping Claude Code plugin install."
    return 0
  fi
  if ! need claude; then
    say "Claude Code CLI not found; skipping plugin install."
    say "Later, from a checkout, run: claude plugin marketplace add <repo> && claude plugin install understudy@understudy-skills"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".claude-plugin")"; then
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

install_cursor_plugin() {
  if ! should_install_cursor_adapter; then
    say "Cursor adapter not selected or not detected; skipping Cursor plugin install."
    return 0
  fi

  local repo dest
  if ! repo="$(resolve_plugin_repo ".cursor-plugin")"; then
    say "Could not find .cursor-plugin/plugin.json; skipping Cursor plugin install."
    return 0
  fi

  dest="$HOME/.cursor/plugins/local/understudy"
  say "Installing the Understudy Cursor plugin from $repo."
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ] && [ "$(readlink "$dest" 2>/dev/null || true)" = "$repo" ]; then
    ok "Understudy Cursor plugin already points at $repo."
  else
    rm -rf "$dest"
    ln -s "$repo" "$dest"
    ok "Understudy Cursor plugin linked at $dest."
  fi
  say "In Cursor, restart the app or run Developer: Reload Window."
  say "Then ask Cursor Agent: Use the Understudy onboarding skill for this project."
}

install_codex_plugin() {
  if ! should_install_codex_adapter; then
    say "Codex adapter not selected or not detected; skipping Codex marketplace registration."
    return 0
  fi
  if ! need codex; then
    say "Codex CLI not found; skipping Codex marketplace registration."
    say "Later, from a checkout, run: codex plugin marketplace add <repo>"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".codex-plugin")"; then
    say "Could not find .codex-plugin/plugin.json; skipping Codex marketplace registration."
    return 0
  fi
  if [ ! -f "$repo/.agents/plugins/marketplace.json" ]; then
    say "Could not find .agents/plugins/marketplace.json; skipping Codex marketplace registration."
    return 0
  fi

  say "Registering the Understudy Codex marketplace from $repo."
  if codex plugin marketplace add "$repo" >>"$LOG_FILE" 2>&1; then
    ok "Understudy Codex marketplace registered."
  else
    say "Codex marketplace add failed; trying marketplace refresh."
    log "RUN codex plugin marketplace upgrade understudy-skills"
    if codex plugin marketplace upgrade understudy-skills >>"$LOG_FILE" 2>&1; then
      ok "Understudy Codex marketplace refreshed."
    else
      warn "Codex marketplace registration failed; continuing with the rest of the install."
      say "Manual recovery: run \`codex plugin marketplace remove understudy-skills\`, then \`codex plugin marketplace add $repo\`."
      say "Codex details are in the install log: $LOG_FILE"
      return 0
    fi
  fi
  say "In Codex, run /plugins, choose the understudy-skills marketplace, and install or enable the understudy plugin."
  say "Then ask Codex: Use the Understudy onboarding skill for this project."
}

link_opencode_path() {
  local src="$1" dest="$2" kind="$3" current
  if [ -L "$dest" ]; then
    current="$(readlink "$dest" 2>/dev/null || true)"
    if [ "$current" = "$src" ]; then
      return 0
    fi
    case "$current" in
      *understudy-agent-tools/skills/*|*understudy-agent-tools/.opencode/commands/*)
        rm -f "$dest"
        ln -s "$src" "$dest"
        return 0
        ;;
    esac
    warn "OpenCode $kind already exists at $dest; leaving it unchanged."
    return 1
  fi
  if [ -e "$dest" ]; then
    warn "OpenCode $kind already exists at $dest; leaving it unchanged."
    return 1
  fi
  ln -s "$src" "$dest"
}

install_opencode_plugin() {
  if ! should_install_opencode_adapter; then
    say "OpenCode adapter not selected or not detected; skipping OpenCode skill install."
    return 0
  fi

  local repo skill_root command_root skill skill_name linked skipped command_src command_dest
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping OpenCode skill install."
    return 0
  fi

  skill_root="$HOME/.config/opencode/skills"
  command_root="$HOME/.config/opencode/commands"
  mkdir -p "$skill_root" "$command_root"
  linked=0
  skipped=0

  say "Installing the Understudy OpenCode skills from $repo."
  for skill in "$repo"/skills/*; do
    [ -f "$skill/SKILL.md" ] || continue
    skill_name="$(basename "$skill")"
    if link_opencode_path "$skill" "$skill_root/$skill_name" "skill"; then
      linked=$((linked + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  command_src="$repo/.opencode/commands/understudy-onboard.md"
  command_dest="$command_root/understudy-onboard.md"
  if [ -f "$command_src" ]; then
    link_opencode_path "$command_src" "$command_dest" "command" || true
  fi

  ok "Understudy OpenCode skills linked: $linked; skipped existing conflicts: $skipped."
  say "In OpenCode, restart the TUI or open a new session so skills and commands reload."
  say "Then run /understudy-onboard, or ask OpenCode: Use the Understudy onboarding skill for this project."
}

install_agent_adapters() {
  install_claude_plugin
  install_cursor_plugin
  install_codex_plugin
  install_opencode_plugin
}

launch_claude_code() {
  local claude_log
  if [ "$NO_CLAUDE" != "0" ]; then
    say "Skipping Claude Code launch because --no-claude is set."
    mark_step_done 3
    return 0
  fi
  if ! should_install_claude_adapter; then
    say "Skipping Claude Code launch because the Claude Code adapter is not selected or detected."
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

validate_agent_platforms || exit 2
configure_resume

banner
if [ "$FANCY" = "1" ]; then
  section "Welcome"
else
  section "Welcome. We are going to install Understudy for your coding agent."
fi
say "This installer bootstraps the CLI and selected coding-agent skills, then drops you back into your coding agent when possible."
say "Source: $INSTALL_REPO_URL#$INSTALL_REF ${D}(installer commit: $INSTALLER_COMMIT)${R}"
say "Install log: $LOG_FILE"
say ""
select_agent_platforms
say "${B}Install plan${R}"
say "  ${G2}1.${R} Install the Understudy CLI."
if [ "$KEEP_LOGIN" = "1" ]; then
  say "  ${G3}·${R}  Keep the existing Understudy sign-in (--keep-login)."
else
  say "  ${G3}·${R}  Reset any existing sign-in so the agent-first sign-up starts fresh (backup kept; --keep-login skips)."
fi
say "  ${G4}2.${R} $(agent_plan_label)"
say "  ${G5}3.${R} Open Claude Code here when the Claude Code adapter is selected — otherwise finish with reload instructions."
say ""
say "Default install does not download weights, start MLX, launch the ladder server, or make frontier calls."
say "Those actions happen later through the Understudy onboarding skill, where the coding agent can coach the user and ask consent."
say "This installer writes only under $LAB, $HOME/.understudy, the global npm prefix, and selected coding-agent plugin state."
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
  section "Step 2/3 · Install agent adapters"
  install_agent_adapters
  mark_step_done 2
else
  say "Skipping step 2/3: install agent adapters."
fi

compose_initial_prompt

section "Where this goes next"
say "The installer is done. The next experience belongs inside your coding agent:"
say "  Claude Code: run /reload-plugins and then /understudy:onboard."
say "  Cursor: restart Cursor or run Developer: Reload Window, then ask Cursor Agent to use the Understudy onboarding skill."
say "  Codex: run /plugins, install or enable understudy, then ask Codex to use the Understudy onboarding skill."
say "  OpenCode: restart the TUI or open a new session, then run /understudy-onboard."
say "That lets the coding agent run the email-code sign-up itself, explain the first local Understudy, and open a terminal of the user's choice when needed."
if should_run_step 3; then
  launch_claude_code
else
  say "Skipping step 3/3: open Claude Code."
fi
