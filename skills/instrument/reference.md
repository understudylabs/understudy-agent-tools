# Instrument — reference

Details behind [`SKILL.md`](SKILL.md): per-SDK env-var behavior, base-URL
shapes, hardcoded-URL detection, and the verification recipe.

## Per-SDK env-var redirect support

The redirect works only when the SDK constructor's base URL defaults to an
environment variable. Verify against the installed SDK version — do not
assume.

| SDK | Env var it reads | Base-URL shape |
| --- | --- | --- |
| `@anthropic-ai/sdk` (TS) | `ANTHROPIC_BASE_URL` | gateway root, **no** trailing `/v1` (SDK appends `/v1/messages`) |
| `anthropic` (Python) | `ANTHROPIC_BASE_URL` | same as above |
| `openai` (TS) | `OPENAI_BASE_URL` | gateway root **plus** `/v1` |
| `openai` (Python) | `OPENAI_BASE_URL` | gateway root plus `/v1` |
| `langchain-openai` / `langchain-anthropic` | Delegates to the underlying SDK — the same env vars apply unless the integration passes an explicit `base_url` | as per underlying SDK |
| Vercel AI SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`) | Provider factories accept `baseURL`; default-instance env-var pickup varies by version — check `node_modules/@ai-sdk/*/dist` or docs before promising a zero-code redirect | as per shape |
| `litellm` | `OPENAI_BASE_URL` for OpenAI-shape routes; also `litellm.api_base` / per-call `api_base` | gateway root plus `/v1` |

If the SDK version in the lockfile does not read the env var, this is a
code-path case: route to the `skills/onboard/` recipes with explicit approval
instead of claiming zero-code.

## Detecting hardcoded base URLs

An env var loses to an explicit constructor argument. Before redirecting,
grep the app:

```sh
grep -rnE 'baseURL|base_url|api\.openai\.com|api\.anthropic\.com|openrouter|api_base' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' \
  --exclude-dir=node_modules --exclude-dir=.venv .
```

- A constructor with `baseURL:`/`base_url=` pointing anywhere means the env
  var is ignored for that client — fallbacks apply.
- Frameworks that already run behind a router (OpenRouter, Together, a
  company proxy) need a decision from the developer about which hop to
  replace; do not stack proxies silently.

## Verification recipe

1. Trigger exactly one call you can recognize (a distinctive prompt string
   helps).
2. `understudy captures list --json` — the newest capture's timestamp/model
   should match the test call. `understudy captures get <request-id>` shows
   the redacted summary.
3. `understudy instrument --check --json` — local, no network: reports which
   redirect env vars are set, whether credentials exist, and whether any
   local captures are present under `.understudy/captures`.
4. Only after 2 (or a local file for the log-export path) confirms the trace,
   tell the developer instrumentation is live.

Common failure modes:

- **Daemonized app started before the env change** — restart it under the
  redirected env.
- **Env var set but hardcoded `baseURL` wins** — see the grep above.
- **Non-streaming request through the gateway times out at the edge** — the
  gateway requires `stream: true`; see "Always stream gateway inference" in
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

## Provider log-export fallback shapes

When the developer will not route traffic, acceptable inputs for
[`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md) include:

- Provider console usage/logging exports (JSONL/CSV of historical calls).
- The app's own request/response logs, if they include prompt + completion
  (or at least token counts for cost profiling).

Stage files under `.understudy/captures/` (gitignored) and hand off; that
skill owns redaction and normalization.
