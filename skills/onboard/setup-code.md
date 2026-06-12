# Setup Code

Use this recipe when `understudy setup-code` routes here or when the developer
asks an agent to convert application code to Understudy gateway inference.

The CLI no longer rewrites source files directly. The coding agent owns the
patch using the repo's language, framework, tests, and style.

## Flow

1. Run `understudy status --json`.
2. If not authenticated, stop with:
   `Run 'understudy login' once, then re-run me.`
3. Inspect the target file if one was provided by `setup-code --file`.
4. Otherwise search for SDK construction and explicit provider base URLs:
   `OpenAI`, `Anthropic`, `baseURL`, `base_url`, `api.openai.com`,
   `api.anthropic.com`, `@ai-sdk/openai`, `@ai-sdk/anthropic`.
5. Load the matching recipe:
   - `openai-typescript.md`
   - `anthropic-typescript.md`
   - `mastra-typescript.md`
   - `universal-typescript.md`
6. Patch the smallest source region that routes calls through
   `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL`.
7. Preserve the developer's existing upstream provider key variable. Do not
   delete or rename it.
8. Make every call site that now routes through the gateway stream
   (`stream: true` or the client's streaming call form), aggregating locally
   where the caller needs one final object. Each recipe has an "After the
   patch — make gateway calls stream" / "Gateway calls must stream" section
   with the why and the per-client pattern.
9. Run the narrowest local test or typecheck that proves the patched code still
   loads.

## Output

End with:

- files changed;
- command used to verify;
- whether auth is configured;
- exact command the developer or agent should run through `understudy run`.
