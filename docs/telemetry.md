# Telemetry

There is no telemetry in this repository today.

By default, Understudy Agent Tools do not send usage events, prompts,
completions, traces, source snippets, datasets, repo paths, provider keys, or
local model metadata to Understudy or any provider.

## Future Telemetry Rules

If telemetry is added later, it must be:

- opt-in;
- documented in this file before release;
- categorical by default;
- free of prompts, completions, traces, source snippets, secrets, private repo
  paths, and customer identifiers;
- easy to disable.

Any future telemetry schema should list every field, purpose, destination,
retention expectation, and whether it can contain user content.
