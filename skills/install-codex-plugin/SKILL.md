---
name: install-codex-plugin
description: Use when a developer wants to install, enable, update, reinstall, or verify the Understudy skills as a Codex plugin - "install Understudy in Codex", "add the Codex plugin", "make Codex see the Understudy skills". Registers the local Codex marketplace and tells the developer how to install or enable it from Codex.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Codex plugin

This repo ships the public skills as a Codex plugin. The plugin manifest lives in
`.codex-plugin/plugin.json`, and the repo marketplace lives in
`.agents/plugins/marketplace.json`. The plugin points at the existing `skills/`
tree; do not copy or fork the skills for Codex.

The local flow registers this repo as a Codex marketplace. Codex's plugin
browser owns the final install/enable step.

## Key facts

- `codex plugin marketplace add <repo-root>` registers the local marketplace.
- The plugin browser is where the developer installs or toggles the plugin.
- Codex should be restarted after marketplace or plugin changes if the plugin
  does not appear immediately.
- The plugin reuses the same `skills/` tree as Claude Code and Cursor.

## Procedure

### 1. Find the repo root

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/.codex-plugin/plugin.json" "$REPO/.agents/plugins/marketplace.json" "$REPO/skills/understudy/SKILL.md"
```

### 2. Register the local marketplace

```bash
codex plugin marketplace add "$REPO"
```

If the marketplace is already registered, refresh it:

```bash
codex plugin marketplace upgrade understudy-skills
```

### 3. Install or enable in Codex

Open Codex and run:

```text
/plugins
```

Choose the `understudy-skills` marketplace, open the `understudy` plugin, and
install or enable it. Start a new Codex thread if the new skills do not appear.

### 4. Start onboarding

In Codex, ask:

```text
Use the Understudy onboarding skill for this project.
```

The agent should route into `understudy` or `onboard`, profile the machine, and
guide any model download, ladder climb, or frontier comparison with explicit
consent.

## Uninstall

From Codex, open `/plugins` and uninstall the `understudy` plugin. To remove the
local marketplace registration:

```bash
codex plugin marketplace remove understudy-skills
```

## Safety Gates

Local-first and free: registering the marketplace makes no provider calls,
uploads, spend, or credential changes. Do not require Understudy login, provider
keys, or hosted access for this skill.

- Do not edit `~/.codex/config.toml` by hand unless the `codex plugin`
  marketplace command is unavailable and the user explicitly asks for manual
  setup.
- Do not copy private traces, keys, local `.understudy/` runtime state, or user
  data into the plugin directory.
- Do not claim the plugin was installed if only the marketplace was registered.

## Resolve CLI

Use `codex plugin marketplace add` when the `codex` CLI is available. If the CLI
is missing, show the manual marketplace path and the `/plugins` activation step.

## Output Standard

End with whether the Codex marketplace was already present / just registered /
refreshed / shown for manual run; the `/plugins` install step; the next
onboarding prompt; and the marketplace removal command.
