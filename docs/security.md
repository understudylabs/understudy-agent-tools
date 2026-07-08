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

## Public Claims

Do not claim quality, latency, cost savings, or route superiority unless the
artifact names the evidence level, sample size, split boundary, baseline route,
candidate route, cost basis, latency basis, and caveats.
