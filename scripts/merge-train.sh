#!/usr/bin/env bash
# merge-train.sh — merge a sequence of PRs safely, in order, with an audit trail.
#
# Usage:
#   scripts/merge-train.sh [--dry-run] <pr> [<pr>...]
#
# For each PR, in order:
#   1. Wait out GitHub's UNKNOWN mergeability recompute.
#   2. Stop immediately on CONFLICTING with a reconcile instruction.
#   3. `gh pr checks --watch` until checks settle.
#   4. Gate STRICTLY on check *conclusions*: every completed check must have
#      conclusion SUCCESS / NEUTRAL / SKIPPED. Any FAILURE, CANCELLED,
#      TIMED_OUT, ACTION_REQUIRED, or STARTUP_FAILURE stops the train with the
#      failing check named. We never merge on mergeability alone — MERGEABLE
#      only means "no conflicts", not "checks passed".
#   5. Post a review comment with a verification summary (checks table +
#      merge rationale) BEFORE merging, so an audit artifact lives on GitHub.
#   6. `gh pr merge --merge --admin`.
#
# --dry-run performs steps 1-4 read-only and prints what steps 5-6 would do.
#
# Requirements: gh (authenticated), jq.

set -euo pipefail

DRY_RUN=0
PRS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) PRS+=("$arg") ;;
  esac
done

if [ "${#PRS[@]}" -eq 0 ]; then
  echo "usage: scripts/merge-train.sh [--dry-run] <pr> [<pr>...]" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "error: gh not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "error: jq not found" >&2; exit 2; }

MERGEABLE_TIMEOUT="${MERGE_TRAIN_MERGEABLE_TIMEOUT:-120}"   # seconds
MERGEABLE_POLL="${MERGE_TRAIN_MERGEABLE_POLL:-5}"           # seconds

log() { printf '[merge-train] %s\n' "$*"; }
fail() { printf '[merge-train] STOP: %s\n' "$*" >&2; exit 1; }

# Wait until mergeable state is no longer UNKNOWN. GitHub recomputes
# mergeability asynchronously after every base-branch update, so right after
# a previous merge the next PR often reports UNKNOWN for a while.
wait_mergeable() {
  local pr="$1" elapsed=0 state
  while :; do
    state="$(gh pr view "$pr" --json mergeable --jq '.mergeable')"
    if [ "$state" != "UNKNOWN" ]; then
      printf '%s' "$state"
      return 0
    fi
    if [ "$elapsed" -ge "$MERGEABLE_TIMEOUT" ]; then
      printf 'UNKNOWN'
      return 0
    fi
    log "PR #$pr mergeability UNKNOWN — waiting for GitHub to recompute (${elapsed}s/${MERGEABLE_TIMEOUT}s)…" >&2
    sleep "$MERGEABLE_POLL"
    elapsed=$((elapsed + MERGEABLE_POLL))
  done
}

# Returns the statusCheckRollup as JSON.
get_checks() {
  gh pr view "$1" --json statusCheckRollup --jq '.statusCheckRollup // []'
}

for pr in "${PRS[@]}"; do
  log "=== PR #$pr ==="

  meta="$(gh pr view "$pr" --json number,title,state,url,headRefName,baseRefName)"
  state="$(jq -r '.state' <<<"$meta")"
  title="$(jq -r '.title' <<<"$meta")"
  url="$(jq -r '.url' <<<"$meta")"
  log "#$pr \"$title\" [$state] $url"

  if [ "$state" != "OPEN" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "PR #$pr is $state (not OPEN) — dry-run continues read-only."
    else
      fail "PR #$pr is $state, not OPEN. Refusing to continue the train."
    fi
  fi

  # 1. Mergeability (conflicts only — never a merge gate by itself).
  # GitHub never recomputes mergeability for closed/merged PRs, so skip the
  # wait in that case (only reachable in dry-run).
  if [ "$state" != "OPEN" ]; then
    mergeable="N/A (PR $state)"
  else
    mergeable="$(wait_mergeable "$pr")"
  fi
  log "PR #$pr mergeable=$mergeable"
  if [ "$mergeable" = "CONFLICTING" ]; then
    fail "PR #$pr CONFLICTS with its base. Reconcile before resuming: check out the branch, merge the base branch into it, resolve as a semantic union of both sides (do not blindly take either side — see docs/merge-train.md), push, then re-run: scripts/merge-train.sh $pr <remaining PRs>"
  fi
  if [ "$mergeable" = "UNKNOWN" ]; then
    fail "PR #$pr mergeability still UNKNOWN after ${MERGEABLE_TIMEOUT}s. GitHub has not finished recomputing; retry shortly."
  fi

  # 2. Wait for checks to settle. `gh pr checks --watch` exits nonzero on
  # failing checks; we do our own strict gating below, so tolerate that.
  log "PR #$pr watching checks…"
  gh pr checks "$pr" --watch || true

  # 3. Strict gate on check CONCLUSIONS.
  checks="$(get_checks "$pr")"
  count="$(jq 'length' <<<"$checks")"
  if [ "$count" -eq 0 ]; then
    log "PR #$pr has no checks reported — treating as pass (repo has no required checks)."
  fi

  pending="$(jq -r '[.[] | select(.status? and .status != "COMPLETED")] | length' <<<"$checks")"
  if [ "$pending" -ne 0 ]; then
    fail "PR #$pr still has $pending check(s) not COMPLETED after watch. Refusing to merge."
  fi

  bad="$(jq -r '[.[] | select((.conclusion // "SUCCESS") as $c | ($c != "SUCCESS" and $c != "NEUTRAL" and $c != "SKIPPED"))] | map("\(.name // .context): \(.conclusion)") | join(", ")' <<<"$checks")"
  if [ -n "$bad" ]; then
    fail "PR #$pr has failing check(s): $bad. Never merge on mergeability alone — fix the checks first."
  fi

  # 4. Build the audit comment: checks table + merge rationale.
  table="$(jq -r '
    if length == 0 then "_no checks reported_"
    else
      "| check | conclusion |\n|---|---|\n" +
      (map("| \(.name // .context) | \(.conclusion // .state) |") | join("\n"))
    end' <<<"$checks")"

  body="$(printf '%s\n\n%s\n\n%s\n' \
    "**Merge-train verification** (scripts/merge-train.sh)" \
    "$table" \
    "Rationale: mergeable=$mergeable; all $count check(s) completed with passing conclusions (SUCCESS/NEUTRAL/SKIPPED). Merging via \`gh pr merge --merge --admin\` per the merge-train convention (docs/merge-train.md).")"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "PR #$pr DRY RUN — would post review comment:"
    printf '%s\n' "$body" | sed 's/^/    /'
    log "PR #$pr DRY RUN — would run: gh pr merge $pr --merge --admin"
    continue
  fi

  # 5. Audit artifact first, then merge.
  log "PR #$pr posting verification comment…"
  gh pr comment "$pr" --body "$body"

  log "PR #$pr merging…"
  gh pr merge "$pr" --merge --admin
  log "PR #$pr merged."
done

log "Train complete."
