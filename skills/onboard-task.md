# Understudy Onboarding (Agent Instructions)

You are helping an authenticated Understudy user try Understudy in their
current codebase. Most requests convert existing model traffic to the
Understudy gateway. Some requests use the user's authenticated Understudy API
key in a small cookbook, such as a DSPy-style GEPA prompt optimizer. Your job
is to make the smallest set of changes that proves Understudy works in this
repo without leaking secrets into committed files.

The patch you produce uses **BYO mode**: the user's existing provider key
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) stays exactly where it is, and the
SDK forwards it to the gateway on the `x-understudy-upstream-key` header.
The gateway swaps it into the outbound call. The user's primary auth header
becomes their Understudy `sk_*` key. Do not delete the existing provider
env var — the patch *depends* on it.

## Hard Rules

<<EXECUTION_MODE>>

- **The CLI owns auth.** The skill does not register users, mint keys, or read
  `~/.understudy/credentials.json` directly. Use `understudy-tools status --json` to decide
  whether the user is signed in. If not signed in, stop and print exactly:
  `Run 'understudy-tools login' once, then re-run me.`
- **Secrets are transient.** If a script needs an Understudy key, load it via
  the authenticated CLI/runtime path or require `UNDERSTUDY_API_KEY` in the
  process environment. Do not paste the `sk_*` into source, `.env.example`,
  docs, test fixtures, or chat output.
- **Only add Understudy code.** Do not refactor, rename, or "clean up"
  unrelated code in the same run. If the user asks for a refactor, treat it
  as a separate task.
- **One SDK, one language per run.** If the repo has both Anthropic and
  OpenAI calls, ask the user which one to convert first and stop until they
  answer. Do not convert both in the same run.
- **Use the `understudy-tools` CLI for every stateful operation.** Auth, org/project
  binding, key access, and code patching all go through `understudy-tools`. Do not write
  to `.understudy/config.json` or `~/.understudy/credentials.json` by hand,
  and do not call the gateway API directly to mint keys.
- **Make project binding automatic.** After auth, use the project already
  written by `understudy-tools login`. If the repo is not bound yet, reuse the user's first
  existing project from `understudy-tools projects list --json`; if there are no projects,
  create and switch to `rehearsal`. Do not interrupt the user for project
  choice in the MVP flow.
- **Project identity lives in `.understudy/config.json`, not env vars.**
  `understudy-tools login` writes this file when the platform returns a default project;
  `understudy-tools projects switch <slug>` updates it later. Do not introduce
  `UNDERSTUDY_PROJECT_ID` as a required env var when the config file already
  carries the value.
- **The app must still run when `UNDERSTUDY_API_KEY` is unset.** Fail soft
  with a clear error from the SDK, not from your patched init code. The user
  will set the key later.
- **Abort if the user is not authenticated.** `understudy-tools login` starts
  email-code auth and may require a human/code handoff unless an approved native
  email connector is available. If `understudy-tools status --json` reports not logged in, stop and
  print exactly: `Run 'understudy-tools login' once, then re-run me.` Do not try to script
  around it.
- **Don't guess CLI flags.** Run `understudy-tools --help` or `understudy-tools <subcommand> --help` if
  you're unsure. The CLI is the source of truth, not your prior knowledge.
- **Don't add evals, scorers, or extra instrumentation** unless the user
  explicitly asked for them. This task is "route traffic through the
  gateway," not "build an observability platform."
- **If the project is already onboarded, don't duplicate work.** If
  `.understudy/config.json` exists and `understudy-tools status --json` reports a project
  bound and a key present, jump to the verification step.

## Execution Requirements

Before you touch any file:

1. Convert the steps below into a checklist you can tick off as you go.
2. Execute the steps in order.
3. Do not skip a step. If a step doesn't apply, write down why and continue.

---

## Steps

### 1. Verify CLI presence and authentication

Confirm the `understudy-tools` CLI is on PATH:

```bash
command -v understudy-tools >/dev/null 2>&1 && understudy-tools --version || echo "understudy-tools CLI not installed"
```

If `understudy-tools` is missing, instruct the user to install it
(`npm install -g @understudylabs/understudy-agent-tools`) and stop.

Then check auth state via the machine-readable status:

```bash
understudy-tools status --json
```

If the JSON reports `signed_in: false` (or the equivalent error), print
the exact line `Run 'understudy-tools login' once, then re-run me.` and stop. Do not retry
in a loop.

If the user asks you to complete login and you have an approved native email
connector, you may run `understudy-tools login --email <developer-email>`, wait
for the one-time-code prompt, search only for the fresh Understudy sign-in
email, enter the code, and continue with `understudy-tools status --json`.
Do not print the code or save it anywhere.

If the user's request is a cookbook task rather than a gateway conversion,
dispatch now:

| User intent | Recipe to apply |
|---|---|
| "add GEPA", "run GEPA", "optimize this prompt", "improve this eval", "build a DSPy-style optimizer" | `skills/onboard/gepa-typescript.md` |

Cookbook tasks still rely on the authenticated CLI state from this step, but
they do not require binding every model call in the app. Apply the cookbook
recipe and skip the remaining gateway-conversion steps unless the recipe tells
you otherwise.

### 2. Detect the target SDK and language

The gateway speaks two wire shapes — Anthropic on `/v1/messages`, OpenAI
on `/v1/chat/completions`. **Anything that targets one of those shapes
can be siphoned through Understudy**, regardless of which library or
framework the code uses to do it. Your job in this step is to find
where in the user's code model traffic originates, identify which shape
it speaks, and pick the right recipe.

Read `package.json` (or the language equivalent) at the repo root and
apply this dispatch table, in order. The first match wins:

| Detected dependency | Recipe to apply |
|---|---|
| `@mastra/core` (with or without `mastra` devDep) | `skills/onboard/mastra-typescript.md` |
| `@anthropic-ai/sdk` (alone) | `skills/onboard/anthropic-typescript.md` |
| `openai` (alone, not just `@ai-sdk/openai`) | `skills/onboard/openai-typescript.md` |
| Anything else that touches model traffic — `@ai-sdk/openai`, `@ai-sdk/anthropic`, `langchain`, `@langchain/openai`, `@langchain/anthropic`, `llamaindex`, `ai`, `dspy`, raw `fetch` to `api.openai.com` / `api.anthropic.com`, or a custom wrapper | `skills/onboard/universal-typescript.md` |

Framework-aware recipes (Mastra etc.) win over the direct-SDK and
universal recipes because frameworks pull the direct SDKs in as
transitive deps — patching `new Anthropic(...)` in a Mastra project
would have no effect on Mastra agents.

The universal recipe is the **fallback that handles everything not
named explicitly above**. Use it when you see any of: a wrapper we
don't recognize, a thin `fetch` directly to a provider, an in-house
SDK, or a framework that hasn't earned a dedicated recipe yet. It
gives you the rule for finding where any HTTP client targets a model
provider and rewriting it.

Cross-check `package.json` against actual source imports. If
`package.json` lists `openai` but no `.ts` file imports it, treat it
as not-in-use and skip to the next candidate.

Confirm the target with the user in one short message before continuing,
naming the file you'll patch and the recipe you'll follow. If the repo
has more than one *distinct* candidate that isn't resolved by the table
above (e.g. one app uses `@anthropic-ai/sdk` and another uses Mastra in
the same monorepo), name both and ask which to convert first.

Stop and ask only if:

- The project is **Python, Go, or another language**. TypeScript-only
  recipes exist today; Python is coming. The universal recipe assumes
  TypeScript/JavaScript imports and constructor patterns.
- You **cannot identify any place where model traffic originates**.
  That's unusual — most projects have a clear entry point — but if
  you've grepped the source and found nothing matching the providers'
  hostnames or any SDK constructor, ask the user where the model calls
  live before guessing.

### 3. Bind the repo to a project

If `.understudy/config.json` already exists at the repo root and
`understudy-tools status --json` reports a project, skip to step 4. The repo is already
bound.

Otherwise, list the projects available in the user's active org:

```bash
understudy-tools projects list --json
```

If the response contains one or more non-deleted projects, take the first
project's `slug` and run:

```bash
understudy-tools projects switch <slug> --json
```

If the response contains no projects, create the default onboarding project
and bind the repo to it:

```bash
understudy-tools projects create rehearsal --name "Rehearsal" --json
understudy-tools projects switch rehearsal --json
```

If multiple orgs are available and no `--org` is set, `understudy-tools projects list`,
`understudy-tools projects create`, or `understudy-tools projects switch` will exit with a clear error
listing org IDs. Surface that error verbatim and ask which org to use before
retrying with `--org <id>`.

### 4. Convert the SDK init

The recipe below tells you exactly which lines to add or change in the
user's SDK init. It produces a BYO-mode patch: primary auth becomes the
Understudy `sk_*`, the existing provider key flows on
`x-understudy-upstream-key`, and `baseURL` points at
`$UNDERSTUDY_GATEWAY_URL`. The user's existing provider env var
stays untouched.

<<CONVERT_TARGET>>

After patching, show the user the diff (`git diff -- <patched-file>`) before
moving on. They should see exactly which lines you changed.

### 5. Configure environment variables

After patching, the runtime needs two env vars:

- `UNDERSTUDY_API_KEY` — the `sk_*` key that `understudy-tools login` stored. The patched
  client sends this as its primary auth header.
- The user's existing upstream provider env var (`ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY`) — **stays as-is**. The patched client reads it and
  forwards it to the gateway on `x-understudy-upstream-key`. Do not rename,
  delete, or replace it.

Add `UNDERSTUDY_API_KEY=` to `.env.example` (or extend the existing one)
with an empty value. Do **not** write the real key value into any file the
user might commit. If `.env` already exists, append the line only if it's
missing.

If the project has a checked-in process manager config (`Procfile`, systemd
unit, Dockerfile, `package.json` start script, etc.), `UNDERSTUDY_API_KEY`
must survive into that launch path. A shell-local `export` from your
verification step doesn't count — the next developer or CI run won't have
it. Update the persisted launch path or tell the user exactly which file
they need to edit.

### 6. Verify end-to-end

Run the project's normal entry point — `npm start`, `pnpm dev`, `python
main.py`, whatever the existing convention is. If you can't tell, ask the
user before running anything.

Confirm:

- Exit code 0
- A model response came back (text printed, no SDK error)
- No new errors that didn't exist before the patch

If the gateway returns `400 "no upstream configured"` or `401`, stop and
diagnose in this order:

- Is the user's existing provider env var (`ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`) actually set in the shell the app runs in? The patched
  code reads it and forwards it as `x-understudy-upstream-key`. Empty value
  → gateway has no upstream to call → 400.
- Is `UNDERSTUDY_API_KEY` set, and does it match `understudy-tools status --json`? A
  stale or missing `sk_*` returns 401.
- Is `baseURL` correct for the SDK? The Anthropic SDK expects
  `$UNDERSTUDY_GATEWAY_URL` (no trailing `/v1` — the SDK appends
  `/v1/messages` itself). The OpenAI SDK expects
  `$UNDERSTUDY_GATEWAY_URL/v1` (the SDK appends `/chat/completions`
  to that prefix). If they're swapped, both SDKs hit the gateway's
  wrong-path 404 helper, whose JSON envelope explains the fix verbatim —
  read it and apply.

### 7. Report

Summarize in one short message:

- Which file you patched (with line range)
- Which env vars the user must have set when they run the app
  (`UNDERSTUDY_API_KEY` plus whichever provider env var they already use)
- The exact command they can run to make their first traced call

<<NEXT_STEPS>>

### 8. Final guidance

Tell the user, in plain prose:

- Re-run the same entry point. Traffic now flows through
  `UNDERSTUDY_GATEWAY_URL`; the response is byte-faithful with their direct
  upstream call.
- App-level instrumentation (function-level spans, custom metadata) beyond
  what the gateway sees on the wire is future work. Do **not** install any
  client-side SDK as part of this run.
- For anything else, point them at `understudy-tools --help` and `understudy-tools <subcommand>
  --help`. The CLI is the source of truth.
