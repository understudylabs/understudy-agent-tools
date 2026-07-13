# Security

This repository is public, MIT-licensed local tooling. The default threat model
is accidental disclosure: private artifacts, secrets, traces, prompts, or
customer data leaking into a public repo or a hosted provider call.

## Reporting

For security issues, use the repository's GitHub security reporting flow when
available. If that is unavailable, contact Understudy Labs through the public
contact channel listed on the organization profile.

## Secret Handling

- Do not ask users to paste API keys or tokens into chat.
- Do not print environment variable values.
- Use redacted presence checks only.
- Treat `.env*`, shell history, local credential files, and provider config as
  non-release material.
- If a secret appears in output or a committed file, stop and rotate it before
  continuing.

## Supply Chain

- Keep dependency installs deterministic.
- Do not add automatic dependency update bots without an explicit request.
- Do not vendor compatibility shims or mirrored source unless a future release
  explicitly reintroduces a reviewed vendoring spine with source and license
  metadata.
- Public release checks should inspect built packages for ignored docs, env
  files, private paths, and secret-shaped strings.

## Local Artifact Safety

`.understudy/` is local runtime output. It can contain workload metadata and may
eventually contain private payloads. Do not commit it unless a specific public
fixture is intentionally synthetic and reviewed.

Supervision correction exports are content-addressed local evidence. The CLI
writes them with owner-only permissions on Unix and refuses to replace an
existing path with different content. They contain raw prompts and outputs, so
they remain private artifacts even when their SHA-256 hashes are safe to share.

Remote supervision advisories use the same private-artifact posture. Consent is
bound to the exact provider/project/workload route; a route change disables the
feature until the user explicitly enables it again. The CLI rejects a response
whose served model does not exactly match the provider contract, persists the
mismatch as error evidence, and never treats that response as a recommendation.

Desktop image attachments live under private app data, outside `.understudy/`.
The app accepts only bounded PNG, JPEG, WebP, and GIF bytes with matching file
signatures. Filenames never select filesystem paths: session directories are
hashed and stored filenames are derived from verified SHA-256 content IDs.

## Agent Tool Execution

The conversation runtime does not enable Pi's built-in Bash tool. It accepts
only tool definitions supplied by the desktop and sends calls to an
authenticated loopback executor. If a future desktop surface supplies a
shell-shaped tool (`bash`, `shell`, `exec_command`, and the other recognized
aliases), the runtime applies a small app-owned command guard:

- a Pi `tool_call` extension blocks the call before execution;
- the Pi and Vercel executor adapters enforce the same policy again before any
  loopback request;
- blocked results include a stable rule ID and a human-readable reason;
- ordinary commands and inert searches or documentation examples remain
  allowed.

The guard covers high-confidence destructive filesystem, disk, process, Git,
database, infrastructure, cloud-delete, and remote-script-pipe patterns. It is
not a shell parser or a sandbox. Before arbitrary shell access becomes a public
feature, add an explicit consent flow bound to the exact command hash, a scoped
working directory, environment filtering, execution timeouts, and output caps.

We evaluated
[`destructive_command_guard`](https://github.com/Dicklesworthstone/destructive_command_guard)
as a possible source, but did not vendor or derive from it. Its
[canonical license](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/LICENSE)
adds a restricted-party rider that is incompatible with this repository's
normal MIT reuse expectations. The Understudy classifier is independently
implemented and intentionally much smaller.

## Public Claims

Do not claim quality, latency, cost savings, or route superiority unless the
artifact names the evidence level, sample size, split boundary, baseline route,
candidate route, cost basis, latency basis, and caveats.
