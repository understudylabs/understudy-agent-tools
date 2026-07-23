# Understudy Desktop

The Understudy desktop app — a local-first control surface for improving LLM
apps and agents. It bundles the Understudy runtime (served on `127.0.0.1`),
an in-app chat, the benchmark/experiment spine, local model serving and
training, and the org management panes (Summary, Analytics, Workloads, Models,
API keys, Billing).

Built with **Tauri 2** (Rust shell) + **Next.js** (static export) for the
webview. The Rust process owns the local server, the SQLite store, the sk\_
credential (it never reaches the webview), and the MLX model runtime; the
frontend talks to it over Tauri commands and the local HTTP/MCP API.

## Layout

| Path | What it is |
|------|------------|
| `app/` | Next.js frontend — panes in `app/components/`, framework-free logic in `app/lib/*.mjs` (unit-tested from the repo root) |
| `src-tauri/` | Rust shell — local server (`server.rs`), DB (`db.rs`), model runtime, admin/reporting bridges, Tauri command handlers |
| `public/` | Static assets served by the webview (brand, provider logos) |
| `out/` | Next static export consumed by Tauri (`frontendDist`) — build output, not source |

## Develop

```sh
cd apps/homescreen
bunx tauri dev
```

This runs `beforeDevCommand` (builds the bundled CLI, then `next dev` on
`:1420`) and launches the Tauri window against it. Frontend edits hot-reload;
Rust edits trigger a rebuild.

- **Frontend only** (no Rust shell, Tauri commands unavailable): `bun run dev`,
  then open `http://localhost:1420`. Useful for static markup/CSS work.
- The dev app uses the `com.homescreen.app` identifier and **shares the
  production database** — decisions you make in the dev window are real.

## Test & check

The frontend's logic lives in `app/lib/*.mjs` and is tested with `node --test`
from the **repo root** (`tests/*.test.mjs`), alongside the Rust `cargo test`
suite:

```sh
# from repo root
node --test tests/desktop-*.test.mjs tests/org-summary.test.mjs
cd apps/homescreen && npx tsc --noEmit          # frontend typecheck
cd apps/homescreen/src-tauri && cargo test      # Rust
```

`tests/desktop-ui-lineage.test.mjs` pins nav language and design tokens — update
it deliberately when renaming nav groups or panes.

## Release

Desktop releases go through the **Desktop Release** GitHub Actions workflow
(`validate` then `release` mode) from a clean `origin/main` commit. Version
sources are bumped in lockstep by `scripts/desktop-release-plan.mjs --apply`.
See [`docs/release-checklist.md`](../../docs/release-checklist.md).
