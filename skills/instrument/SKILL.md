---
name: instrument
description: Use when a developer's LLM app is running but has NO traces yet and wants capture flowing in about a minute with no code changes — "instrument my app", "start capturing my LLM calls", "I have no traces, get me some", "turn on tracing for my agent". Detects the provider SDK, redirects it through the Understudy gateway (capture on by default) via env vars, verifies a capture actually landed, then hands off to ingest-traces.
metadata:
  understudy:
    mode: interactive
    safety: auth-gated
    cli_required: true
---

# Instrument

[`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md) and
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) assume traces
already exist. This worker is the on-ramp before that: a running app, zero
traces, and a developer who wants captures flowing **without editing app
code**. One redirect, one test call, one verified capture — then hand off.

**Say this up front:** "This takes about 5 minutes: ~1 minute to detect your
SDK, ~2 minutes to sign in if you haven't, ~1 minute to redirect and verify a
test call. No code changes, and nothing leaves your machine without your
approval."

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js instrument --check --json
```

## Safety Gates

- **No app-code edits on this path.** The whole point is env-var redirection.
  If a codebase hardcodes a base URL so env vars cannot work, say so and offer
  the code-patch recipes in `skills/onboard/` as an explicitly separate,
  approval-gated step — do not silently edit.
- **Redirecting traffic through the gateway is an external write of the
  developer's prompts and completions** (that is what capture *is*). State
  this plainly and get explicit approval before the first redirected call.
- Never print, commit, or write `sk_*` values. Use `understudy run -- <cmd>`
  to inject credentials into the child process only (see
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)).
- Set redirect env vars in the launch command or the developer's shell
  session, not in checked-in files. Only write to `.env` if the developer
  explicitly asks, and never commit it.
- Do not declare success until a capture is verified to exist (step 4).

## Step 1 — Detect what the app talks to (~1 min)

Inspect the project read-only. Look at `package.json` /
`requirements.txt` / `pyproject.toml` / lockfiles and grep call sites:

| Found | Provider path |
| --- | --- |
| `@anthropic-ai/sdk`, `anthropic` (py) | Anthropic-shape → `ANTHROPIC_BASE_URL` |
| `openai` (ts/py) | OpenAI-shape → `OPENAI_BASE_URL` |
| `langchain`, `langchain-openai`, `langchain-anthropic` | Wraps the SDKs above — same env vars apply |
| `ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` (Vercel AI SDK) | Usually needs a `baseURL` in the provider factory — check first; env redirect only works if the factory reads the env var |
| `litellm` | OpenAI-shape → `OPENAI_BASE_URL` or litellm's own base-url config |
| none of the above / hardcoded `baseURL` | Env redirect will not bite — see the honest fallbacks below |

Per-SDK env-var behavior, base-URL shapes (`/v1` or not), and hardcoded-URL
detection greps are in [`reference.md`](reference.md).

Also confirm the developer can actually trigger one call: an npm script, a
CLI invocation, a test, or a curl to their own app. If they cannot, stop —
there is nothing to capture yet.

## Step 2 — Sign in and pick the project (~2 min, skipped if done)

Reuse the login/key flow in
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
do not duplicate it here. In short: `understudy status --json`; if not signed
in, the two-phase `understudy login --email` / `--code` flow; then confirm
`understudy projects list --json`. Gateway capture is on by default for
gateway traffic, so no extra capture toggle is needed.

## Step 3 — Redirect with zero code changes

Preferred: run the app (or one test invocation) through the wrapper, which
injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` into the child
process only, and set the SDK base-URL env var inline:

```sh
# Anthropic SDK app (note: no trailing /v1 — the SDK appends it)
ANTHROPIC_BASE_URL="$UNDERSTUDY_GATEWAY_URL" understudy run -- <your app command>

# OpenAI SDK app (OpenAI-shape wants the /v1 suffix)
OPENAI_BASE_URL="${UNDERSTUDY_GATEWAY_URL:-https://api.understudylabs.com}/v1" \
  understudy run -- <your app command>
```

`understudy run` resolves the stored credentials, so inside the child process
`$UNDERSTUDY_GATEWAY_URL` is set; the SDK's own env var points it there. The
provider API key env var can stay as-is — the gateway authenticates with the
Understudy key that `understudy run` injects (see the gateway skill for
key-header details per shape).

## Step 4 — Verify a trace is actually flowing (do not skip)

Trigger exactly one real call through the app, then confirm the capture
landed before saying anything succeeded:

```sh
understudy captures list --json          # newest capture should match the test call
understudy instrument --check --json     # local sanity: env redirect + capture presence
```

If `captures list` shows nothing new: check `understudy doctor --hosted`,
re-grep for a hardcoded `baseURL` shadowing the env var, and confirm the app
process actually inherited the env (a daemon started earlier did not).

## Honest fallbacks when env redirect cannot work

- **No local capture proxy exists in this CLI today.** There is no
  `understudy`-served localhost endpoint that records calls and forwards to
  the provider; do not promise one. The zero-code path is the gateway
  redirect above.
- **Hardcoded base URL / unsupported SDK:** offer the code-patch recipes in
  `skills/onboard/` (`anthropic-typescript.md`, `openai-typescript.md`,
  `universal-typescript.md`) as an explicit, approved edit — outside this
  skill's no-code promise.
- **Developer cannot or will not route through the gateway:** use provider
  log exports (Anthropic/OpenAI console usage or logging exports, or the
  app's own request logs) and go straight to
  [`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md), which turns a
  JSONL/CSV export in `.understudy/captures/` into local redacted eval sets.

## Handoff

Once roughly 20–50 captures exist (enough for a first slice), route onward:

- Turn them into local redacted eval sets or profile the spend →
  [`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md).
- Build the measured baseline and frozen splits →
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).

Report to the developer: what was redirected, how many captures exist, and
which handoff you chose.
