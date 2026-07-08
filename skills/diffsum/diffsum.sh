#!/usr/bin/env bash
#
# diffsum — summarize a patch diff as a single sentence, using Qwen3.5-0.8B
# (GGUF) running locally via llama.cpp.
#
# Adapted from Eric Tramel's gist:
# https://gist.github.com/eric-tramel/2f61e38f2892311e9cfd257b05bc3705
#
# Usage:
#   git show HEAD | diffsum          # read a patch diff from STDIN
#   diffsum <git-sha>                # summarize a commit in the current repo
#   diffsum                          # in a git repo: summarize uncommitted
#                                    # changes to tracked files
#   diffsum -f [<git-sha>]           # one summary line per edited file
#   diffsum -h | --help
#
# When stdout is a terminal, summaries stream token-by-token, typewriter
# style: new tokens are appended at the cursor and wrap naturally, and the
# finished sentence is rewritten once into its cleaned form. In -f mode the
# display follows file order; files summarized concurrently in the
# background catch up instantly when their turn comes. Piped output is
# plain lines.
#
# Prerequisites:
#   - llama.cpp, for the llama-completion and llama-server binaries:
#     brew install llama.cpp
#   - curl and jq, for -f mode (talks to a local llama-server over HTTP)
#   - Network access on first run: the Qwen3.5-0.8B GGUF model (~810 MB) is
#     downloaded from Hugging Face automatically and cached under
#     ~/.cache/huggingface/hub; later runs use the cache.
#   - git, when summarizing a SHA or uncommitted changes (not needed for
#     the STDIN mode).
#
# Environment:
#   DIFFSUM_MODEL   HF repo/quant passed to llama-completion/llama-server -hf
#                   (default: unsloth/Qwen3.5-0.8B-GGUF:Q8_0)
#   DIFFSUM_CTX     context size in tokens per summary (default: 8192)
#   DIFFSUM_SLOTS   parallel summaries in -f mode (default: 4)
#   DIFFSUM_STREAM  1 forces the live streaming view on, 0 forces it off
#                   (default: on when stdout is a terminal)
#   DIFFSUM_PROGRESS  1 forces the stderr spinner on, 0 forces it off
#                     (default: on when stderr is a terminal; only used
#                     when the live view is off)

set -euo pipefail

MODEL="${DIFFSUM_MODEL:-unsloth/Qwen3.5-0.8B-GGUF:Q8_0}"
CTX="${DIFFSUM_CTX:-8192}"
SLOTS="${DIFFSUM_SLOTS:-4}"
# Leave headroom in the context window for the chat template, the
# instruction, and the generated sentence. ~3 chars/token is a safe
# lower bound for diff text.
MAX_DIFF_CHARS=$(( (CTX - 512) * 3 ))

usage() {
  # Print this file's header comment block, sans the '# ' prefixes.
  awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
}

die() {
  echo "diffsum: $*" >&2
  exit 1
}

files_mode=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -f|--files) files_mode=1; shift ;;
    -*) die "unknown option '$1' (see --help)" ;;
    *) break ;;
  esac
done

if [ "$files_mode" = 0 ]; then
  command -v llama-completion >/dev/null 2>&1 \
    || die "llama-completion not found (install with: brew install llama.cpp)"
else
  command -v llama-server >/dev/null 2>&1 \
    || die "llama-server not found (install with: brew install llama.cpp)"
  command -v curl >/dev/null 2>&1 || die "curl not found (needed for -f mode)"
  command -v jq >/dev/null 2>&1 \
    || die "jq not found (install with: brew install jq; needed for -f mode)"
fi

show_spinner=0
[ -t 2 ] && show_spinner=1
case "${DIFFSUM_PROGRESS:-}" in
  1) show_spinner=1 ;;
  0) show_spinner=0 ;;
esac
spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

# Live streaming view: rows repainted in place as tokens arrive. Needs
# stdout to be a terminal (the paints are the output); piped stdout gets
# the plain line-per-summary behavior instead.
live_view=0
[ -t 1 ] && live_view=1
case "${DIFFSUM_STREAM:-}" in
  1) live_view=1 ;;
  0) live_view=0 ;;
esac
# Terminal geometry for the live view. Do NOT use $(tput cols) here: inside
# a command substitution tput's stdout is a pipe, it cannot ioctl the
# terminal, and it silently reports the terminfo default of 80 — on a wider
# terminal that inflates the erase row math until it eats earlier lines.
# stty asks the terminal directly: the controlling one (/dev/tty) if there
# is one, else the tty on stdout (fd 3 dups it OUTSIDE the substitution,
# whose own fd 1 is the capture pipe).
term_rows=24 term_cols=80
# (2>/dev/null must come FIRST: redirections apply left to right, and a
# failed /dev/tty open is reported by the shell before a later 2> lands.)
size=$(stty size 2>/dev/null </dev/tty) || size=''
if [ -z "$size" ] && [ -t 1 ]; then
  exec 3<&1
  size=$(stty size 2>/dev/null <&3) || size=''
  exec 3<&-
fi
if [ -n "$size" ]; then
  term_rows=${size%% *}
  term_cols=${size##* }
fi
[ "$term_cols" -gt 0 ] 2>/dev/null || term_cols=80
[ "$term_rows" -gt 0 ] 2>/dev/null || term_rows=24

# Colors: file names yellow, finished summaries uncolored (the terminal's
# default foreground), in-progress (drafting) text dark grey, spinner dim
# yellow. The drafting grey uses the fixed 256-color cube (240 = #585858)
# rather than a named ANSI color, which terminal themes repaint. stdout
# colors only when stdout is a terminal, status colors only when stderr
# is; NO_COLOR (https://no-color.org) disables all.
c_file='' c_sum='' c_status='' c_reset='' c_status_reset=''
if [ -z "${NO_COLOR:-}" ]; then
  if [ -t 1 ]; then
    c_file=$'\033[1;33m'
    c_reset=$'\033[0m'
  fi
  if [ -t 2 ]; then
    c_status=$'\033[2;33m'
    c_status_reset=$'\033[0m'
  fi
fi
# The live view paints in-progress tokens on stdout in dark grey (NO_COLOR
# still wins).
c_live='' c_live_reset=''
if [ -z "${NO_COLOR:-}" ] && [ "$live_view" = 1 ]; then
  c_live=$'\033[38;5;240m'
  c_live_reset=$'\033[0m'
fi

workdir=$(mktemp -d)
server_pid=''
trap 'if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null; fi; rm -rf "$workdir"' EXIT
diff_file="$workdir/diff"

# --- Gather the diff ---------------------------------------------------------
# The diff is staged in a temp file, never a big bash variable: on macOS's
# bash 3.2, parameter expansions over large multibyte strings are quadratic
# (minutes-long hangs), and piping a variable into early-exiting readers
# like grep -q or head -c gets the writer SIGPIPE-killed under pipefail.
# File-based grep/head/wc have neither problem.
empty_msg="empty diff"
if [ $# -ge 1 ]; then
  # An explicit SHA argument wins over whatever is on STDIN.
  sha="$1"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not inside a git repository (needed to resolve '$sha')"
  git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null \
    || die "'$sha' is not a commit in this repository"
  git show --no-color --format='' "$sha" >"$diff_file"
elif [ ! -t 0 ]; then
  # STDIN is piped/redirected: assume it is a patch diff.
  cat >"$diff_file"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # No arguments, no piped input, but we are in a git repo: summarize
  # uncommitted changes (staged + unstaged) to tracked files.
  git diff HEAD --no-color >"$diff_file" 2>/dev/null \
    || git diff --no-color >"$diff_file"
  empty_msg="no uncommitted changes to tracked files"
else
  usage >&2
  exit 1
fi

grep -q '[^[:space:]]' "$diff_file" || die "$empty_msg"

# Drop anything before the first "diff --git" boundary (commit header and
# message from `git show`, format-patch mail headers, ...): fed the commit
# message, the model just parrots it back instead of reading the diff.
# Input without git boundaries (e.g. plain `diff -u`) passes through as-is.
if grep -q '^diff --git ' "$diff_file"; then
  sed -n '/^diff --git /,$p' "$diff_file" >"$workdir/diff.stripped"
  diff_file="$workdir/diff.stripped"
fi

# --- Summarization -----------------------------------------------------------
system_prompt='You are a commit summarizer. The user gives you a patch diff. Reply with exactly one concise sentence describing what the change does. The sentence must begin with a present-tense verb. Never begin with "The patch", "This change", or similar. No preamble, no lists, no markdown, no code - just the single sentence.'

# build_prompt <diff-chunk-file> <out-file>
# Stage the raw-mode prompt for one chunk in a file (never a big bash
# variable; see the staging note above). The hand-built Qwen3.5 ChatML
# prompt pre-fills the assistant turn with a closed, empty <think> block:
# Qwen3.5 dropped Qwen3's /no_think soft switch entirely, but the model
# cannot re-open a think block that is already closed.
build_prompt() {
  local chunk="$1" out="$2" truncation_note=''

  if [ "$(wc -c <"$chunk")" -gt "$MAX_DIFF_CHARS" ]; then
    truncation_note='
[... diff truncated ...]'
  fi

  {
    printf '<|im_start|>system\n%s<|im_end|>\n<|im_start|>user\nSummarize this patch diff in one sentence starting with a verb.\n\n' \
      "$system_prompt"
    head -c "$MAX_DIFF_CHARS" "$chunk"
    printf '%s<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n' \
      "$truncation_note"
  } >"$out"
}

# render_summary <raw-output-file>
# Flatten to one line, then drop the empty <think> block the prefill
# leaves behind, any end-of-text marker, and surplus whitespace.
# Despite the prompt, the model still sometimes opens with "The
# patch ..."; the awk strips that subject so the sentence starts at its
# verb ("The patch changes X" -> "Changes X").
render_summary() {
  tr '\n' ' ' <"$1" \
    | sed -e 's/<\/*think>//g' -e 's/\[end of text\]//g' \
          -e 's/[[:space:]]\{2,\}/ /g' -e 's/^ *//' -e 's/ *$//' \
    | awk '{
        sub(/^(The|This) (patch|diff|change|commit)( diff)? /, "")
        print toupper(substr($0, 1, 1)) substr($0, 2)
      }'
}

# clean_partial <raw-output-file> -> $partial
# Cheap in-progress version of render_summary for the live view: runs at
# 10Hz per row, so it must not fork (builtin read + expansions only).
clean_partial() {
  partial=''
  [ -f "$1" ] || return 0
  IFS= read -r -d '' partial <"$1" || true
  partial=${partial//$'\n'/ }
  partial=${partial//'<think>'/}
  partial=${partial//'</think>'/}
  partial=${partial//'[end of text]'/}
  # Strip leading whitespace so the row starts at the first token.
  partial="${partial#"${partial%%[![:space:]]*}"}"
}

# stream_append <raw-output-file> <pid> <already-printed-count>
# Typewriter core: append newly arrived sanitized text at the cursor (the
# terminal wraps it naturally) until <pid> exits. Appends never move the
# cursor or clear anything, so the stream cannot flicker. Sets $printed to
# the total character count appended (plus the inherited start count).
stream_append() {
  local raw="$1" pid="$2" alive
  printed="$3"
  while :; do
    alive=1
    kill -0 "$pid" 2>/dev/null || alive=0
    clean_partial "$raw"
    if [ ${#partial} -gt "$printed" ]; then
      printf '%s%s%s' "$c_live" "${partial:$printed}" "$c_live_reset"
      printed=${#partial}
    fi
    [ "$alive" = 0 ] && break
    sleep 0.1
  done
}

# erase_streamed <chars-on-line>
# Erase a just-streamed line region (cursor sits at its end) so the final
# rendered sentence can replace it. Row count follows from the plain
# character count; a region taller than the screen cannot be walked back
# (the top is in scrollback), so leave it and start a fresh line instead.
erase_streamed() {
  local rows
  [ "$1" -gt 0 ] || { printf '\r\033[K'; return 0; }
  rows=$(( ($1 - 1) / term_cols + 1 ))
  if [ "$rows" -gt "$term_rows" ]; then
    printf '\n'
    return 0
  fi
  if [ $(( rows - 1 )) -gt 0 ]; then
    printf '\033[%dA' $(( rows - 1 ))
  fi
  printf '\r\033[J'
}

# spin_while <pid> <label>
# Plain-path spinner on stderr while <pid> runs.
spin_while() {
  local pid="$1" msg="$2" i=0
  if [ "$show_spinner" = 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r\033[K%s%s %s…%s' "$c_status" "${spin:$(( i % 10 )):1}" "$msg" "$c_status_reset" >&2
      i=$(( i + 1 ))
      sleep 0.1
    done
    printf '\r\033[K' >&2
  fi
}

# --- Single-summary mode -----------------------------------------------------
# One diff, one llama-completion process: a server would not amortize
# anything here, so raw mode keeps it dependency-light. Sampling params
# stay at Qwen3's non-thinking-mode recommendations rather than the
# Qwen3.5 card's (temp 1.0, presence-penalty 2.0): the card settings
# produced typos and tense drift on this task; these benchmarked cleaner.
if [ "$files_mode" = 0 ]; then
  build_prompt "$diff_file" "$workdir/prompt"

  # Truncate the log up front: the spinner greps it for the phase switch.
  : >"$workdir/err"
  : >"$workdir/out"
  llama-completion \
    -hf "$MODEL" \
    --ctx-size "$CTX" \
    -no-cnv \
    --temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 \
    -n 96 \
    --no-display-prompt \
    --simple-io \
    --file "$workdir/prompt" \
    </dev/null >"$workdir/out" 2>"$workdir/err" &
  pid=$!

  if [ "$live_view" = 1 ]; then
    # Typewriter view: llama-completion flushes each token to
    # $workdir/out, so append new text at the cursor as it arrives; one
    # rewrite at the end swaps the raw stream for the cleaned sentence.
    # A spinner covers the model-load silence before the first token.
    i=0
    while kill -0 "$pid" 2>/dev/null \
        && ! grep -q '[^[:space:]]' "$workdir/out" 2>/dev/null; do
      printf '\r\033[K%s%s loading model…%s' "$c_live" "${spin:$(( i % 10 )):1}" "$c_live_reset"
      i=$(( i + 1 ))
      sleep 0.1
    done
    printf '\r\033[K'
    stream_append "$workdir/out" "$pid" 0
    erase_streamed "$printed"
    wait "$pid" || {
      tail -5 "$workdir/err" >&2
      die "llama-completion failed"
    }
    printf '%s%s%s\n' "$c_sum" "$(render_summary "$workdir/out")" "$c_reset"
    exit 0
  fi

  if [ "$show_spinner" = 1 ]; then
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      if grep -q 'generate:' "$workdir/err" 2>/dev/null; then
        msg="summarizing diff"
      else
        msg="loading model"
      fi
      printf '\r\033[K%s%s %s…%s' "$c_status" "${spin:$(( i % 10 )):1}" "$msg" "$c_status_reset" >&2
      i=$(( i + 1 ))
      sleep 0.1
    done
    printf '\r\033[K' >&2
  fi

  wait "$pid" || {
    tail -5 "$workdir/err" >&2
    die "llama-completion failed"
  }

  printf '%s%s%s\n' "$c_sum" "$(render_summary "$workdir/out")" "$c_reset"
  exit 0
fi

# --- Per-file mode (-f/--files) ----------------------------------------------
# Split the diff into one chunk per file on "diff --git" boundaries and
# summarize each chunk separately. Anything before the first boundary
# (e.g. the commit message header) is dropped.
chunk_dir="$workdir/chunks"
mkdir "$chunk_dir"
awk -v dir="$chunk_dir" '
  /^diff --git / { if (out) close(out); out = sprintf("%s/%05d", dir, ++n) }
  out { print > out }
' "$diff_file"

[ -n "$(ls "$chunk_dir")" ] || die "no 'diff --git' file boundaries found in input"

# One ephemeral llama-server child serves every per-file summary: one
# model load instead of one per file, and SLOTS parallel slots overlap
# prefill and decode across files. It listens on a random localhost port
# (retried on clashes) and dies with this script via the EXIT trap.
# --ctx-size is the TOTAL across slots, hence the multiply.
server_log="$workdir/server.log"
base_url=''
for attempt in 1 2 3 4 5; do
  port=$(( (RANDOM % 40000) + 20000 ))
  llama-server \
    -hf "$MODEL" \
    --ctx-size $(( CTX * SLOTS )) \
    --parallel "$SLOTS" \
    --host 127.0.0.1 --port "$port" \
    --no-webui \
    </dev/null >>"$server_log" 2>&1 &
  server_pid=$!
  i=0
  while kill -0 "$server_pid" 2>/dev/null; do
    if curl -sf -m 2 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"ok"'; then
      base_url="http://127.0.0.1:$port"
      break
    fi
    if [ "$show_spinner" = 1 ]; then
      printf '\r\033[K%s%s loading model…%s' "$c_status" "${spin:$(( i % 10 )):1}" "$c_status_reset" >&2
      i=$(( i + 1 ))
    fi
    sleep 0.1
  done
  [ -n "$base_url" ] && break
  server_pid=''
done
[ "$show_spinner" = 1 ] && printf '\r\033[K' >&2
if [ -z "$base_url" ]; then
  tail -5 "$server_log" >&2
  die "llama-server failed to start"
fi

# Fire every chunk at the server up front; SLOTS run at a time and the
# server queues the rest. Sampling params match single-summary mode.
# stream:true makes the server emit one SSE "data: {...}" line per token;
# the jq stage reassembles the raw text incrementally into $req.raw, which
# the live view repaints from as it grows. Request scratch files live
# outside chunk_dir so its glob stays clean.
idx=0
for chunk in "$chunk_dir"/*; do
  req="$workdir/$(basename "$chunk")"
  # File path = the b/ side of the "diff --git a/... b/..." line, which
  # also names the post-rename file.
  paths[$idx]=$(awk 'NR == 1 { sub(/^diff --git a\/.* b\//, ""); print; exit }' "$chunk")
  build_prompt "$chunk" "$req.prompt"
  jq -Rs '{prompt: ., n_predict: 96, temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, cache_prompt: true, stream: true}' \
      <"$req.prompt" \
    | curl -sfN -X POST "$base_url/completion" --data-binary @- \
    | jq -R --unbuffered -rj 'ltrimstr("data: ") | fromjson? | .content // empty' \
    >"$req.raw" &
  pids[$idx]=$!
  raws[$idx]="$req.raw"
  idx=$(( idx + 1 ))
done
nfiles=$idx

# --- Typewriter view: the display walks the files in order; the current
# file's summary types out at the cursor as its tokens arrive (wrapping
# naturally, never repainted), then one rewrite swaps it for the cleaned
# sentence and the next file begins. Files summarized concurrently by the
# other server slots accumulate in their raw files meanwhile and catch up
# instantly when their turn comes — display order is presentation only,
# the requests all run in parallel. Appends scroll like normal output, so
# any file count works on any terminal size.
if [ "$live_view" = 1 ]; then
  idx=0
  for chunk in "$chunk_dir"/*; do
    path=${paths[$idx]}
    raw=${raws[$idx]}
    printf '%s%s%s: ' "$c_file" "$path" "$c_reset"
    stream_append "$raw" "${pids[$idx]}" 0
    wait "${pids[$idx]}" 2>/dev/null || true
    grep -q '[^[:space:]]' "$raw" 2>/dev/null || {
      printf '\n'
      tail -5 "$server_log" >&2
      die "summary request failed for $path"
    }
    erase_streamed $(( ${#path} + 2 + printed ))
    printf '%s%s%s: %s%s%s\n' "$c_file" "$path" "$c_reset" "$c_sum" "$(render_summary "$raw")" "$c_reset"
    idx=$(( idx + 1 ))
  done
  exit 0
fi

# --- Plain path: print in file order, each summary as soon as its request
# completes.
idx=0
for chunk in "$chunk_dir"/*; do
  path=${paths[$idx]}
  raw="$workdir/$(basename "$chunk").raw"
  spin_while "${pids[$idx]}" "summarizing $path"
  wait "${pids[$idx]}" 2>/dev/null || true
  grep -q '[^[:space:]]' "$raw" 2>/dev/null || {
    tail -5 "$server_log" >&2
    die "summary request failed for $path"
  }
  printf '%s%s%s: %s%s%s\n' "$c_file" "$path" "$c_reset" "$c_sum" "$(render_summary "$raw")" "$c_reset"
  idx=$(( idx + 1 ))
done
