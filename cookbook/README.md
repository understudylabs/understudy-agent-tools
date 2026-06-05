# Understudy Cookbook

These examples are small, synthetic application workload fixtures that agents
can copy, inspect, and run through the bundled skills and CLI.

Cookbooks are intentionally boring:

- no customer data;
- no real provider calls by default;
- no secrets or `.env` files;
- no generated `.understudy/` artifacts checked in;
- each example has a smoke path covered by `npm run cookbook:validate`.

## Examples

- [`capture-evidence-node`](capture-evidence-node/README.md) — a tiny Node
  workload with a local test and synthetic eval fixture. Use it to exercise the
  `capture-evidence` capability.
- [`optimize-eval-input-gepa`](optimize-eval-input-gepa/README.md) — a local
  eval-input manifest for the `eval-input-gepa` uv adapter. It runs upstream
  GEPA without provider calls.
- [`gateway-openai-typescript`](gateway-openai-typescript/README.md) — a
  TypeScript client-config pattern for routing an OpenAI-shaped SDK through the
  Understudy gateway after CLI auth.
