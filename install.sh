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
LAUNCH_CLAUDE="${UNDERSTUDY_LAUNCH_AGENT:-${UNDERSTUDY_LAUNCH_CLAUDE:-1}}"
CLAUDE_PERMISSION_MODE="${UNDERSTUDY_CLAUDE_PERMISSION_MODE:-auto}"
USER_PROMPT_OVERRIDE="${UNDERSTUDY_INITIAL_CLAUDE_PROMPT:-}"
INITIAL_CLAUDE_PROMPT=""
AGENT_PLATFORMS="${UNDERSTUDY_AGENT_PLATFORMS:-auto}"
AGENT_PLATFORMS_EXPLICIT=0
AGENT_SELECTION_SOURCE="default"
AGENT_SELECTION_ANSWER=""
if [ -n "${UNDERSTUDY_AGENT_PLATFORMS:-}" ]; then
  AGENT_PLATFORMS_EXPLICIT=1
  AGENT_SELECTION_SOURCE="UNDERSTUDY_AGENT_PLATFORMS"
fi
LOWER_MY_ANT_BILL="${UNDERSTUDY_LOWER_MY_ANT_BILL:-0}"
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
    --agents|--agent) AGENT_PLATFORMS="${2:?missing agent platform list}"; AGENT_PLATFORMS_EXPLICIT=1; AGENT_SELECTION_SOURCE="--agents flag"; shift ;;
    --no-agents) AGENT_PLATFORMS="none"; AGENT_PLATFORMS_EXPLICIT=1; AGENT_SELECTION_SOURCE="--no-agents flag"; NO_CLAUDE=1; LAUNCH_CLAUDE=0 ;;
    --no-launch-claude|--no-launch-agent) LAUNCH_CLAUDE=0 ;;
    --launch-claude|--launch-agent) LAUNCH_CLAUDE=1 ;;
    --lower-my-ant-bill|--lower-my-anthropic-bill) LOWER_MY_ANT_BILL=1 ;;
    --keep-login) KEEP_LOGIN=1 ;;
    --fresh-login) KEEP_LOGIN=0 ;;
    --from-step) START_STEP="${2:?missing step number}"; shift ;;
    --only-step) ONLY_STEP="${2:?missing step number}"; shift ;;
    --resume) RESUME=1 ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--non-interactive] [--resume] [--from-step N] [--only-step N] [--keep-login] [--lower-my-ant-bill] [--agents auto|all|claude-code|cursor|codex|opencode|hermes|devin|none] [--no-claude] [--no-launch-agent]

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
  --lower-my-ant-bill   focus onboarding on lowering Anthropic/Claude API spend
  --lower-my-anthropic-bill
                        alias for --lower-my-ant-bill
  --agents LIST         agent adapters to install: auto, all, claude-code, cursor, codex, opencode, hermes, devin, none
                        comma-separated lists are accepted, e.g. claude-code,cursor
  --no-agents           skip all coding-agent plugin installs and launches
  --no-claude           skip Claude Code plugin install and final Claude launch
  --no-launch-agent     install adapters but do not open a coding agent at the end
  --no-launch-claude    legacy alias for --no-launch-agent
  --launch-agent        open a supported coding agent at the end (default)
  --launch-claude       legacy alias for --launch-agent
  --lab PATH            local Understudy runtime/log directory

Exit codes:
  0  success
  1  aborted or missing prerequisite
  2  usage error
  3  adapter install incomplete: adapters were requested but none installed,
     or an explicitly requested adapter failed

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
  UNDERSTUDY_LOWER_MY_ANT_BILL   set to 1 to focus onboarding on lowering Anthropic/Claude API spend
  UNDERSTUDY_AGENT_PLATFORMS     auto, all, claude-code, cursor, codex, opencode, hermes, devin, none, or comma list
  UNDERSTUDY_LAUNCH_AGENT       set to 0 to skip opening a coding agent
  UNDERSTUDY_LAUNCH_CLAUDE      set to 0 to skip opening a coding agent
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
    hermes|hermes_agent|hermes-agent) printf '%s\n' "hermes" ;;
    cursor|codex|opencode|devin|all|auto|none|claude-code) printf '%s\n' "$1" ;;
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
      claude-code|cursor|codex|opencode|hermes|devin) ;;
      *)
        fail_line "Unknown agent adapter '$token'. Use auto, all, claude-code, cursor, codex, opencode, hermes, devin, none, or a comma list of explicit adapters."
        return 1
        ;;
    esac
  done
  if [ "$count" -eq 0 ]; then
    fail_line "No agent adapter selection provided. Use auto, all, claude-code, cursor, codex, opencode, hermes, devin, or none."
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
detect_hermes() {
  need hermes ||
    [ -d "${HERMES_HOME:-$HOME/.hermes}" ]
}
detect_devin() {
  [ -n "${DEVIN:-}" ] ||
    [ -n "${DEVIN_SESSION_ID:-}" ] ||
    [ -d "$HOME/.devin" ]
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
  elif detect_hermes; then
    printf '%s\n' "hermes"
  elif detect_devin; then
    printf '%s\n' "devin"
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
      hermes) detect_hermes ;;
      devin) detect_devin ;;
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
lower_my_ant_bill_enabled() {
  case "$LOWER_MY_ANT_BILL" in
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
  say "  ${G6}5.${R} $(detected_agent_label "hermes" "Hermes Agent")"
  say "  ${G6}6.${R} $(detected_agent_label "devin" "Devin")"
  say "  ${G6}7.${R} All detected coding agents"
  say "  ${G6}8.${R} CLI only, no coding-agent plugins"
  say "Press Enter for: $default."

  if ! printf "  %s?%s Install target %s[1-8 or name]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null; then
    return 0
  fi
  if ! read -r answer </dev/tty 2>/dev/null; then
    return 0
  fi
  AGENT_SELECTION_SOURCE="menu"
  AGENT_SELECTION_ANSWER="$answer"
  case "$answer" in
    "") AGENT_PLATFORMS="$default" ;;
    1|claude|claude-code|claude_code|claudecode) AGENT_PLATFORMS="claude-code" ;;
    2|cursor) AGENT_PLATFORMS="cursor" ;;
    3|codex) AGENT_PLATFORMS="codex" ;;
    4|opencode|open-code|open_code) AGENT_PLATFORMS="opencode" ;;
    5|hermes|hermes-agent|hermes_agent) AGENT_PLATFORMS="hermes" ;;
    6|devin) AGENT_PLATFORMS="devin" ;;
    7|all|auto) AGENT_PLATFORMS="auto" ;;
    8|none|cli|cli-only|cli_only) AGENT_PLATFORMS="none" ;;
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
should_install_hermes_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_hermes; return ;;
  esac
  agent_platform_requested "hermes"
}
should_install_devin_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_devin; return ;;
  esac
  agent_platform_requested "devin"
}
agent_plan_label() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    auto) printf '%s\n' "Autodetect and install available agent adapters." ;;
    none) printf '%s\n' "Skip coding-agent plugin adapters." ;;
    all) printf '%s\n' "Install all supported agent adapters." ;;
    *) printf '%s\n' "Install requested agent adapter(s): $AGENT_PLATFORMS." ;;
  esac
}
# Support depends on this line: the install log must always record what was
# answered and what it resolved to, or a silent no-adapter install cannot be
# diagnosed from a customer log afterwards.
report_agent_selection() {
  if [ "$AGENT_SELECTION_SOURCE" = "menu" ]; then
    say "Agent adapter selection: $AGENT_PLATFORMS (answer: '$AGENT_SELECTION_ANSWER')"
  else
    say "Agent adapter selection: $AGENT_PLATFORMS (source: $AGENT_SELECTION_SOURCE)"
  fi
}

# ── adapter install accounting ───────────────────────────────────────
# Every install_* adapter function records installed / skipped / failed so
# the installer can summarize what actually happened, keep the final handoff
# honest, and refuse to look successful when the user asked for adapters and
# got none.
ADAPTER_RESULTS=""
ADAPTERS_ATTEMPTED=0
ADAPTERS_INSTALLED_COUNT=0
ADAPTERS_UNMET_COUNT=0
EXPLICIT_ADAPTER_FAILED=0

record_adapter() {
  local name="$1" status="$2" reason="$3"
  ADAPTER_RESULTS="${ADAPTER_RESULTS}${name}|${status}|${reason}
"
  log "ADAPTER $name $status ($reason)"
}
adapter_installed() {
  case "$ADAPTER_RESULTS" in
    *"$1|installed|"*) return 0 ;;
    *) return 1 ;;
  esac
}
adapter_explicitly_requested() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    auto|all|none) return 1 ;;
  esac
  agent_platform_requested "$1"
}
record_adapter_failure() {
  local name="$1" reason="$2"
  record_adapter "$name" "failed" "$reason"
  if adapter_explicitly_requested "$name"; then
    EXPLICIT_ADAPTER_FAILED=1
  fi
}
# A missing prerequisite is a quiet skip under autodetection, but an error
# when the user explicitly asked for this adapter (--agents / env): warn
# loudly and mark the run as failed instead of silently skipping.
adapter_prereq_missing() {
  local name="$1" reason="$2"
  if adapter_explicitly_requested "$name"; then
    warn "The $name adapter was explicitly requested but $reason."
    record_adapter_failure "$name" "$reason"
  else
    record_adapter "$name" "skipped" "$reason"
  fi
}
manual_adapter_instructions() {
  local repo
  repo="$(resolve_skill_repo 2>/dev/null || printf '%s' "$PKG_DIR")"
  say "Manual install commands, per platform:"
  say "  Claude Code: claude plugin marketplace add $repo && claude plugin install understudy@understudy-skills"
  say "  Cursor:      ln -s $repo \$HOME/.cursor/plugins/local/understudy"
  say "  Codex:       codex plugin marketplace add $repo"
  say "  OpenCode:    ln -s $repo/skills/understudy \$HOME/.config/opencode/skills/understudy"
  say "  Hermes:      add $repo/skills to skills.external_dirs in $(hermes_config_path), then /reload-skills"
  say "  Devin:       cloud-based, no local install — ask Devin to use the Understudy onboarding skill for this project"
  say "Or rerun this installer with an explicit adapter, e.g.: --agents claude-code"
}
summarize_agent_adapters() {
  local name status reason installed=0 unmet=0 selection
  selection="$(normalize_agent_platform "$AGENT_PLATFORMS")"
  ADAPTERS_ATTEMPTED=1
  say ""
  say "${B}Adapter summary${R}"
  while IFS='|' read -r name status reason; do
    [ -n "$name" ] || continue
    case "$status" in
      installed) ok "$name: $reason"; installed=$((installed + 1)) ;;
      failed) fail_line "$name: failed — $reason"; unmet=$((unmet + 1)) ;;
      disabled) say "$name: skipped — $reason" ;;
      *)
        say "$name: skipped — $reason"
        # A skip counts as an unmet adapter when it was a real candidate:
        # any candidate under auto/all, or an explicitly requested adapter.
        # Skips of adapters the user never asked for don't count, and
        # "disabled" (an explicit user flag) is handled above.
        case "$selection" in
          auto|all) unmet=$((unmet + 1)) ;;
          *) if adapter_explicitly_requested "$name"; then unmet=$((unmet + 1)); fi ;;
        esac
        ;;
    esac
  done <<EOF
$ADAPTER_RESULTS
EOF
  ADAPTERS_INSTALLED_COUNT="$installed"
  ADAPTERS_UNMET_COUNT="$unmet"

  if [ "$installed" -eq 0 ] && [ "$selection" != "none" ] && [ "$unmet" -gt 0 ]; then
    printf '\n'
    fail_line "${B}NO CODING-AGENT PLUGIN WAS INSTALLED.${R}"
    warn "The adapter selection was '$AGENT_PLATFORMS', but every candidate was skipped or failed (reasons above)."
    warn "The understudy CLI is installed, but the Understudy skills are NOT available in any coding agent until an adapter is installed."
    manual_adapter_instructions
    say "Install log: $LOG_FILE"
  elif [ "$installed" -eq 0 ] && [ "$selection" != "none" ]; then
    printf '\n'
    say "Every selected coding-agent adapter was disabled by a flag; treating this as a CLI-only install."
  elif [ "$EXPLICIT_ADAPTER_FAILED" = "1" ]; then
    printf '\n'
    fail_line "An explicitly requested agent adapter failed to install (see the adapter summary above)."
    manual_adapter_instructions
  fi
}
# Exit status for the whole install: 3 when adapters were requested but none
# installed, or when an explicitly requested adapter failed. 0 otherwise.
# Adapters the user disabled with an explicit flag (--no-claude) are the
# user's own choice and never turn the run into a failure.
adapter_exit_code() {
  if [ "$ADAPTERS_ATTEMPTED" != "1" ]; then
    printf '0\n'
    return 0
  fi
  if [ "$EXPLICIT_ADAPTER_FAILED" = "1" ]; then
    printf '3\n'
    return 0
  fi
  if [ "$ADAPTERS_INSTALLED_COUNT" -eq 0 ] && [ "$ADAPTERS_UNMET_COUNT" -gt 0 ] && [ "$(normalize_agent_platform "$AGENT_PLATFORMS")" != "none" ]; then
    printf '3\n'
    return 0
  fi
  printf '0\n'
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
  if ! { : </dev/tty >/dev/tty; } 2>/dev/null; then
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

is_github_noreply_email() {
  case "${1:-}" in
    *@users.noreply.github.com|*@noreply.github.com|noreply@github.com) return 0 ;;
    *) return 1 ;;
  esac
}

remember_known_email() {
  local candidate="${1:-}" source_label="${2:-email source}"
  [ -z "$candidate" ] && return 0
  if is_github_noreply_email "$candidate"; then
    say "Ignoring GitHub noreply email from $source_label; the agent will ask for a real sign-in email."
    return 0
  fi
  KNOWN_EMAIL="$candidate"
}

prepare_agent_first_signin() {
  local existing_email=""
  [ -n "$ONLY_STEP" ] && return 0
  section "Prepare the agent-first sign-in."
  if [ -f "$CREDENTIALS_FILE" ]; then
    existing_email="$(credentials_email)"
    remember_known_email "$existing_email" "existing Understudy credentials"
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
    elif [ -n "$existing_email" ]; then
      ok "Signed out the existing Understudy sign-in so the agent can run the sign-up from scratch."
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
    remember_known_email "$(git config --get user.email 2>/dev/null || true)" "git config user.email"
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
  local next_prompt
  if lower_my_ant_bill_enabled; then
    next_prompt="use the Understudy onboarding skill with the lower-Anthropic-bill path for this project. Set my primary goal to lowering my Anthropic/Claude API bill. After the local proof, run the lower-anthropic-bill skill against this repo: inventory Anthropic call sites, re-baseline token counts for Opus 4.7+ tokenizer changes, audit prompt-cache hit opportunities, build a savings ledger, and propose measured Anthropic, OpenAI, or local route candidates. Do not spend money, upload data, or call providers without my explicit approval and a cap."
  else
    next_prompt="use the Understudy onboarding skill for this project. Guide me through getting my first local Understudy, launch the ladder climb, then help me pick a real problem or find local data so we can try to make the Understudy beat the frontier on that task slice."
  fi
  if [ -n "$signup" ]; then
    INITIAL_CLAUDE_PROMPT="${signup}${next_prompt}"
  else
    INITIAL_CLAUDE_PROMPT="U${next_prompt#u}"
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
    # An explicit --no-claude is the user's own choice, not a missing adapter:
    # record it as "disabled" so it never trips the zero-adapter failure exit.
    if [ "$NO_CLAUDE" = "1" ]; then
      record_adapter "claude-code" "disabled" "disabled by --no-claude"
    else
      record_adapter "claude-code" "skipped" "not selected or not detected"
    fi
    return 0
  fi
  if ! need claude; then
    say "Claude Code CLI not found; skipping plugin install."
    say "Later, from a checkout, run: claude plugin marketplace add <repo> && claude plugin install understudy@understudy-skills"
    adapter_prereq_missing "claude-code" "the claude CLI is not on PATH"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".claude-plugin")"; then
    say "Could not find .claude-plugin/plugin.json; skipping Claude Code plugin install."
    adapter_prereq_missing "claude-code" ".claude-plugin/plugin.json was not found"
    return 0
  fi

  say "Installing the Understudy Claude Code plugin from $repo."
  if claude plugin list --json 2>/dev/null | grep -q 'understudy@understudy-skills'; then
    ok "Understudy plugin already appears installed."
    record_adapter "claude-code" "installed" "already installed"
  else
    run_logged "Register the plugin marketplace" claude plugin marketplace add "$repo"
    run_logged "Install the Understudy plugin" claude plugin install understudy@understudy-skills
    ok "Understudy plugin installed."
    record_adapter "claude-code" "installed" "plugin installed"
  fi
  say "In Claude Code, type /reload-plugins once to activate the skills."
  say "Then type /understudy:onboard so the agent can guide the first local Understudy."
}

install_cursor_plugin() {
  if ! should_install_cursor_adapter; then
    say "Cursor adapter not selected or not detected; skipping Cursor plugin install."
    record_adapter "cursor" "skipped" "not selected or not detected"
    return 0
  fi

  local repo dest
  if ! repo="$(resolve_plugin_repo ".cursor-plugin")"; then
    say "Could not find .cursor-plugin/plugin.json; skipping Cursor plugin install."
    adapter_prereq_missing "cursor" ".cursor-plugin/plugin.json was not found"
    return 0
  fi

  dest="$HOME/.cursor/plugins/local/understudy"
  say "Installing the Understudy Cursor plugin from $repo."
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ] && [ "$(readlink "$dest" 2>/dev/null || true)" = "$repo" ]; then
    ok "Understudy Cursor plugin already points at $repo."
    record_adapter "cursor" "installed" "already installed"
  elif [ -L "$dest" ]; then
    local current
    current="$(readlink "$dest" 2>/dev/null || true)"
    case "$current" in
      *understudy-agent-tools)
        rm -f "$dest"
        ln -s "$repo" "$dest"
        ok "Understudy Cursor plugin refreshed at $dest."
        record_adapter "cursor" "installed" "link refreshed"
        ;;
      *)
        warn "Cursor plugin path already exists at $dest; leaving it unchanged."
        say "Manual recovery: move that path aside, then rerun this installer."
        adapter_prereq_missing "cursor" "an existing non-Understudy path occupies $dest"
        return 0
        ;;
    esac
  elif [ -e "$dest" ]; then
    warn "Cursor plugin path already exists at $dest; leaving it unchanged."
    say "Manual recovery: move that path aside, then rerun this installer."
    adapter_prereq_missing "cursor" "an existing non-Understudy path occupies $dest"
    return 0
  else
    rm -rf "$dest"
    ln -s "$repo" "$dest"
    ok "Understudy Cursor plugin linked at $dest."
    record_adapter "cursor" "installed" "plugin linked"
  fi
  say "In Cursor, restart the app or run Developer: Reload Window."
  say "Then ask Cursor Agent: Use the Understudy onboarding skill for this project."
}

install_codex_plugin() {
  if ! should_install_codex_adapter; then
    say "Codex adapter not selected or not detected; skipping Codex marketplace registration."
    record_adapter "codex" "skipped" "not selected or not detected"
    return 0
  fi
  if ! need codex; then
    say "Codex CLI not found; skipping Codex marketplace registration."
    say "Later, from a checkout, run: codex plugin marketplace add <repo>"
    adapter_prereq_missing "codex" "the codex CLI is not on PATH"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".codex-plugin")"; then
    say "Could not find .codex-plugin/plugin.json; skipping Codex marketplace registration."
    adapter_prereq_missing "codex" ".codex-plugin/plugin.json was not found"
    return 0
  fi
  if [ ! -f "$repo/.agents/plugins/marketplace.json" ]; then
    say "Could not find .agents/plugins/marketplace.json; skipping Codex marketplace registration."
    adapter_prereq_missing "codex" ".agents/plugins/marketplace.json was not found"
    return 0
  fi

  # npm installs this package through a symlink into the durable source
  # checkout. Codex currently misclassifies that symlink as a Git marketplace
  # and injects a ref, which it then rejects for the local source. Hand Codex
  # the physical directory so local marketplace registration stays local.
  if ! repo="$(cd "$repo" && pwd -P)"; then
    say "Could not resolve the Codex marketplace source directory."
    adapter_prereq_missing "codex" "the marketplace source could not be resolved"
    return 0
  fi

  say "Registering the Understudy Codex marketplace from $repo."
  if codex plugin marketplace add "$repo" >>"$LOG_FILE" 2>&1; then
    ok "Understudy Codex marketplace registered."
    record_adapter "codex" "installed" "marketplace registered"
  else
    say "Codex marketplace add failed; trying marketplace refresh."
    log "RUN codex plugin marketplace upgrade understudy-skills"
    if codex plugin marketplace upgrade understudy-skills >>"$LOG_FILE" 2>&1; then
      ok "Understudy Codex marketplace refreshed."
      record_adapter "codex" "installed" "marketplace refreshed"
    else
      warn "Codex marketplace registration failed; continuing with the rest of the install."
      say "Manual recovery: run \`codex plugin marketplace remove understudy-skills\`, then \`codex plugin marketplace add $repo\`."
      say "Codex details are in the install log: $LOG_FILE"
      record_adapter_failure "codex" "marketplace registration failed"
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

install_opencode_adapter() {
  if ! should_install_opencode_adapter; then
    say "OpenCode adapter not selected or not detected; skipping OpenCode skill install."
    record_adapter "opencode" "skipped" "not selected or not detected"
    return 0
  fi

  local repo skill_root command_root skill skill_name linked skipped command_src command_dest
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping OpenCode skill install."
    adapter_prereq_missing "opencode" "skills/understudy/SKILL.md was not found"
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
  if [ "$linked" -gt 0 ]; then
    record_adapter "opencode" "installed" "linked $linked skills"
  else
    adapter_prereq_missing "opencode" "no skills were linked ($skipped existing path conflicts)"
  fi
  say "In OpenCode, restart the TUI or open a new session so skills and commands reload."
  say "Then run /understudy-onboard, or ask OpenCode: Use the Understudy onboarding skill for this project."
}

hermes_config_path() {
  printf '%s\n' "${HERMES_HOME:-$HOME/.hermes}/config.yaml"
}
# Locate a Python interpreter that can parse YAML, used to merge the skills
# path into an existing Hermes config without guessing its shape. macOS's
# /usr/bin/python3 only finds PyYAML via HOME-dependent user-site, so we also
# fall back to Hermes' own bundled venv interpreter, which always ships PyYAML
# and exists whenever the Hermes adapter is being installed.
hermes_yaml_python() {
  local cand hermes_home="${HERMES_HOME:-$HOME/.hermes}"
  for cand in \
    python3 \
    python \
    "$hermes_home/hermes-agent/venv/bin/python3" \
    "$hermes_home/hermes-agent/venv/bin/python"; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import yaml' >/dev/null 2>&1; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}
# A stable, install-location-independent path that Hermes can keep in its
# config even if the underlying checkout/package moves. We register this
# symlink (never a copy — the shared skills/ tree stays the single source of
# truth); a reinstall just re-points it.
hermes_stable_skills_link() {
  printf '%s\n' "$HOME/.understudy/skills"
}
# Resolve the path to register in skills.external_dirs: prefer the durable
# ~/.understudy/skills symlink, falling back to the resolved skills dir if a
# foreign file already occupies the link. Echoes the path to register.
hermes_register_dir() {
  local skills_dir="$1" stable_link current
  stable_link="$(hermes_stable_skills_link)"
  mkdir -p "$(dirname "$stable_link")"
  if [ -L "$stable_link" ]; then
    current="$(readlink "$stable_link" 2>/dev/null || true)"
    if [ "$current" = "$skills_dir" ]; then
      printf '%s\n' "$stable_link"; return 0
    fi
    case "$current" in
      *understudy-agent-tools/skills)
        rm -f "$stable_link"
        ln -s "$skills_dir" "$stable_link"
        printf '%s\n' "$stable_link"; return 0
        ;;
      *)
        warn "An unexpected symlink already exists at $stable_link; registering the resolved skills path instead." >&2
        printf '%s\n' "$skills_dir"; return 0
        ;;
    esac
  elif [ -e "$stable_link" ]; then
    warn "A non-symlink path already exists at $stable_link; registering the resolved skills path instead." >&2
    printf '%s\n' "$skills_dir"; return 0
  fi
  ln -s "$skills_dir" "$stable_link"
  printf '%s\n' "$stable_link"
}

install_hermes_adapter() {
  if ! should_install_hermes_adapter; then
    say "Hermes adapter not selected or not detected; skipping Hermes skill registration."
    record_adapter "hermes" "skipped" "not selected or not detected"
    return 0
  fi

  local repo skills_dir register_dir config py
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping Hermes skill registration."
    adapter_prereq_missing "hermes" "skills/understudy/SKILL.md was not found"
    return 0
  fi
  skills_dir="$repo/skills"
  register_dir="$(hermes_register_dir "$skills_dir")"
  config="$(hermes_config_path)"

  say "Registering the Understudy skills with Hermes via $register_dir."

  # Idempotent: Hermes reads skills.external_dirs and skips non-existent or
  # duplicate paths, so if our path is already present there is nothing to do.
  # A plain substring check avoids a YAML dependency on the fast path.
  if [ -f "$config" ] && grep -qF "$register_dir" "$config" 2>/dev/null; then
    ok "Understudy skills already registered in $config (skills.external_dirs)."
    record_adapter "hermes" "installed" "already registered"
  elif [ ! -f "$config" ]; then
    # Fresh Hermes: write a minimal user config. Hermes merges defaults at load
    # and `hermes config migrate` keeps our block, so this is non-destructive.
    mkdir -p "$(dirname "$config")"
    {
      printf 'skills:\n'
      printf '  external_dirs:\n'
      printf '    - %s\n' "$register_dir"
    } >"$config"
    ok "Created $config and registered Understudy skills in skills.external_dirs."
    record_adapter "hermes" "installed" "registered in new config"
  elif py="$(hermes_yaml_python)"; then
    cp "$config" "$config.understudy.bak-$(date -u +"%Y%m%dT%H%M%SZ")"
    if "$py" - "$config" "$register_dir" >>"$LOG_FILE" 2>&1 <<'PY'
import sys, os, yaml

cfg_path, skills_dir = sys.argv[1], sys.argv[2]
with open(cfg_path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}
if not isinstance(cfg, dict):
    cfg = {}
skills = cfg.get("skills")
if not isinstance(skills, dict):
    skills = {}
    cfg["skills"] = skills
dirs = skills.get("external_dirs")
if dirs is None:
    dirs = []
elif isinstance(dirs, str):
    dirs = [dirs]
elif not isinstance(dirs, list):
    dirs = []
if skills_dir not in dirs:
    dirs.append(skills_dir)
skills["external_dirs"] = dirs
with open(cfg_path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False)
PY
    then
      ok "Registered Understudy skills in $config (skills.external_dirs)."
      record_adapter "hermes" "installed" "registered"
    else
      warn "Could not update $config automatically; continuing with the rest of the install."
      say "Manual step: add \"$register_dir\" to skills.external_dirs in $config (or run: hermes config edit)."
      record_adapter_failure "hermes" "could not update $config automatically"
    fi
  else
    warn "No YAML-capable Python found to edit $config safely; leaving it unchanged."
    say "Manual step: add \"$register_dir\" to skills.external_dirs in $config (run: hermes config edit)."
    record_adapter_failure "hermes" "no YAML-capable Python to edit $config"
  fi

  say "In Hermes, run /reload-skills (or start a new session) so it rescans skills.external_dirs."
  say "Then run /onboard, or ask Hermes: Use the Understudy onboarding skill for this project."
}

install_devin_adapter() {
  if ! should_install_devin_adapter; then
    say "Devin adapter not selected or not detected; skipping Devin skill install."
    record_adapter "devin" "skipped" "not selected or not detected"
    return 0
  fi

  local repo
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping Devin skill install."
    adapter_prereq_missing "devin" "skills/understudy/SKILL.md was not found"
    return 0
  fi

  say "Installing the Understudy Devin adapter from $repo."
  # Devin is cloud-based: the CLI is the install surface (already handled in
  # step 1). The adapter just confirms the skills tree is accessible and the
  # .devin/adapter.json sentinel is present.
  if [ -f "$repo/.devin/adapter.json" ]; then
    ok "Understudy Devin adapter sentinel found at $repo/.devin/adapter.json."
    record_adapter "devin" "installed" "skills tree accessible; sentinel present"
  else
    warn "Could not find .devin/adapter.json; the Devin version sentinel is missing."
    say "This does not block skill access — Devin reads AGENTS.md and the skills/ tree directly."
    record_adapter "devin" "installed" "skills tree accessible; sentinel missing"
  fi
  say "In Devin, ask: Use the Understudy onboarding skill for this project."
  say "For persistent installs, add the npm install to the Devin environment blueprint."
}

install_agent_adapters() {
  ADAPTER_RESULTS=""
  EXPLICIT_ADAPTER_FAILED=0
  install_claude_plugin
  install_cursor_plugin
  install_codex_plugin
  install_opencode_adapter
  install_hermes_adapter
  install_devin_adapter
  summarize_agent_adapters
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
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi
  if ! need claude; then
    if adapter_installed "claude-code"; then
      say "Claude Code CLI not found; open Claude Code manually and run /reload-plugins then /understudy:onboard."
    else
      say "Claude Code CLI not found and the Understudy plugin is not installed; install Claude Code, rerun this installer (or the manual plugin commands above), then run /reload-plugins and /understudy:onboard."
    fi
    mark_step_done 3
    return 0
  fi
  if ! { : </dev/tty >/dev/tty; } 2>/dev/null; then
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

launch_opencode() {
  if ! should_install_opencode_adapter; then
    say "Skipping OpenCode launch because the OpenCode adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Open OpenCode"
  say "OpenCode skills and commands are installed."
  say "Open a fresh OpenCode TUI session in: $(pwd)"
  say "Then run /understudy-onboard."
  say "The installer does not auto-launch OpenCode because piped installers cannot reliably hand Bun/OpenCode a stable interactive TTY."
  mark_step_done 3
}

launch_hermes() {
  if ! should_install_hermes_adapter; then
    say "Skipping Hermes launch because the Hermes adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Open Hermes"
  say "The Understudy skills are registered in Hermes via skills.external_dirs."
  say "Start a fresh Hermes session in: $(pwd)"
  say "  hermes"
  say "In an already-open session, run /reload-skills to pick them up without restarting."
  say "Then run /onboard, or ask Hermes: Use the Understudy onboarding skill for this project."
  say "The installer does not auto-launch Hermes because piped installers cannot reliably hand it a stable interactive TTY."
  mark_step_done 3
}

launch_devin() {
  if ! should_install_devin_adapter; then
    say "Skipping Devin launch because the Devin adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Devin"
  say "The Understudy CLI and skills are installed."
  say "Devin is a cloud-based agent — it reads AGENTS.md and accesses the skills/ tree directly."
  say "Ask Devin: Use the Understudy onboarding skill for this project."
  say "For persistent installs, add the npm install to the Devin environment blueprint."
  mark_step_done 3
}

launch_selected_agent() {
  if [ "$NO_CLAUDE" != "0" ] && ! should_install_opencode_adapter && ! should_install_hermes_adapter && ! should_install_devin_adapter; then
    say "Skipping coding-agent launch because --no-claude is set and no other launchable adapter is available."
    mark_step_done 3
    return 0
  fi
  if should_install_claude_adapter; then
    launch_claude_code
  elif should_install_opencode_adapter; then
    launch_opencode
  elif should_install_hermes_adapter; then
    launch_hermes
  elif should_install_devin_adapter; then
    launch_devin
  else
    say "Skipping coding-agent launch because the selected adapter has no automatic launch path."
    mark_step_done 3
  fi
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
report_agent_selection
say "${B}Install plan${R}"
say "  ${G2}1.${R} Install the Understudy CLI."
if [ "$KEEP_LOGIN" = "1" ]; then
  say "  ${G3}·${R}  Keep the existing Understudy sign-in (--keep-login)."
else
  say "  ${G3}·${R}  Reset any existing sign-in so the agent-first sign-up starts fresh (backup kept; --keep-login skips)."
fi
say "  ${G4}2.${R} $(agent_plan_label)"
say "  ${G5}3.${R} Open a supported coding agent here when available — otherwise finish with reload instructions."
if lower_my_ant_bill_enabled; then
  say "  ${G6}·${R}  Focus onboarding on the lower Anthropic bill audit path."
fi
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
  # An incomplete adapter install must not be marked resumable-complete, or a
  # later --resume would start at step 3 and exit 0 with no plugin installed.
  if [ "$(adapter_exit_code)" = "0" ]; then
    mark_step_done 2
  else
    warn "Step 2 is not marked complete because adapter installation was incomplete; rerun with --resume to retry the adapters."
  fi
else
  say "Skipping step 2/3: install agent adapters."
fi

compose_initial_prompt

section "Where this goes next"
# Only promise per-agent next steps for adapters that actually installed;
# when the adapter step ran and installed nothing, hand out recovery
# instructions instead of claiming the skills are ready.
if [ "$ADAPTERS_ATTEMPTED" != "1" ]; then
  say "The installer is done. The next experience belongs inside your coding agent:"
  say "  Claude Code: run /reload-plugins and then /understudy:onboard."
  say "  Cursor: restart Cursor or run Developer: Reload Window, then ask Cursor Agent to use the Understudy onboarding skill."
  say "  Codex: run /plugins, install or enable understudy, then ask Codex to use the Understudy onboarding skill."
  say "  OpenCode: restart the TUI or open a new session, then run /understudy-onboard."
  say "  Hermes: run /reload-skills in an open session (or start a new hermes session), then run /onboard or ask Hermes to use the Understudy onboarding skill."
  say "  Devin: ask Devin to use the Understudy onboarding skill for this project. For persistent installs, add the npm install to the Devin environment blueprint."
elif [ "$ADAPTERS_INSTALLED_COUNT" -eq 0 ]; then
  if [ "$(normalize_agent_platform "$AGENT_PLATFORMS")" = "none" ]; then
    say "The installer is done. No coding-agent plugins were requested, so only the understudy CLI was installed."
    say "Rerun this installer with --agents claude-code (or another adapter) when you want the skills inside a coding agent."
  elif [ "${ADAPTERS_UNMET_COUNT:-0}" -eq 0 ]; then
    say "The installer is done. Every selected coding-agent adapter was disabled by a flag (e.g. --no-claude), so only the understudy CLI was installed."
    say "Rerun this installer without the disable flag (or with --agents <adapter>) when you want the skills inside a coding agent."
  else
    fail_line "The installer finished, but no coding-agent plugin was installed — the Understudy skills are NOT ready in any coding agent."
    say "Use the manual install commands above (or rerun this installer with --agents <adapter>), then run the platform's reload step before onboarding."
  fi
else
  say "The installer is done. The next experience belongs inside your coding agent:"
  if adapter_installed "claude-code"; then
    say "  Claude Code: run /reload-plugins and then /understudy:onboard."
  fi
  if adapter_installed "cursor"; then
    say "  Cursor: restart Cursor or run Developer: Reload Window, then ask Cursor Agent to use the Understudy onboarding skill."
  fi
  if adapter_installed "codex"; then
    say "  Codex: run /plugins, install or enable understudy, then ask Codex to use the Understudy onboarding skill."
  fi
  if adapter_installed "opencode"; then
    say "  OpenCode: restart the TUI or open a new session, then run /understudy-onboard."
  fi
  if adapter_installed "hermes"; then
    say "  Hermes: run /reload-skills in an open session (or start a new hermes session), then run /onboard or ask Hermes to use the Understudy onboarding skill."
  fi
  if adapter_installed "devin"; then
    say "  Devin: ask Devin to use the Understudy onboarding skill for this project. For persistent installs, add the npm install to the Devin environment blueprint."
  fi
fi
if lower_my_ant_bill_enabled; then
  say "Focused path: lower Anthropic bill. Ask the agent to use onboarding with the lower-Anthropic-bill path, then run the lower-anthropic-bill skill."
fi
if [ "$ADAPTERS_ATTEMPTED" != "1" ] || [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ]; then
  say "That lets the coding agent run the email-code sign-up itself, explain the first local Understudy, and open a terminal of the user's choice when needed."
fi
if should_run_step 3; then
  launch_selected_agent
else
  say "Skipping step 3/3: open coding agent."
fi

INSTALL_EXIT="$(adapter_exit_code)"
if [ "$INSTALL_EXIT" != "0" ]; then
  fail_line "Installer finished, but adapter installation was incomplete; exiting with status $INSTALL_EXIT."
  say "See the adapter summary above and the install log: $LOG_FILE"
  exit "$INSTALL_EXIT"
fi
