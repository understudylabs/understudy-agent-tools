---
name: install-cursor-plugin
description: Use when a developer wants to install, enable, update, reinstall, or verify the Understudy skills as a Cursor plugin - "install Understudy in Cursor", "add the Cursor plugin", "make Cursor see the Understudy skills". Creates or refreshes a local Cursor plugin symlink and tells the developer how to reload Cursor.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Cursor plugin

This repo ships the same public skills as a Cursor plugin. The manifest lives in
`.cursor-plugin/plugin.json`, and Cursor discovers the `skills/` directory from
the plugin root. The local install path is a symlink from this checkout into
`~/.cursor/plugins/local/understudy`.

The flow is local: it does not upload, authenticate, spend, download models, or
make provider calls.

## Key facts

- Cursor loads local plugins from `~/.cursor/plugins/local/<plugin-name>`.
- For fast iteration, symlink this repo instead of copying it.
- After install or update, the developer must restart Cursor or run
  **Developer: Reload Window**. The agent cannot reload the user's Cursor UI.
- The plugin reuses the repo's existing `skills/` tree. Do not fork or copy the
  skills into a Cursor-only directory unless Cursor's plugin format changes.

## Procedure

### 1. Find the repo root

Resolve the directory that contains `.cursor-plugin/plugin.json`:

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/.cursor-plugin/plugin.json" "$REPO/skills/understudy/SKILL.md"
```

### 2. Install or refresh the local Cursor plugin

```bash
mkdir -p "$HOME/.cursor/plugins/local"
rm -rf "$HOME/.cursor/plugins/local/understudy"
ln -s "$REPO" "$HOME/.cursor/plugins/local/understudy"
```

Use `rm -rf` only for the known local plugin path above. Do not remove any other
Cursor plugin directory.

### 3. Activate in Cursor

Tell the developer to restart Cursor or run:

```text
Developer: Reload Window
```

Then verify in Cursor Settings -> Rules that the Understudy skills appear in the
Agent Decides section.

### 4. Start onboarding

In Cursor Agent chat, ask for:

```text
Use the Understudy onboarding skill for this project.
```

The agent should route into `understudy` or `onboard`, profile the machine, and
guide any model download, ladder climb, or frontier comparison with explicit
consent.

## Uninstall

```bash
rm -f "$HOME/.cursor/plugins/local/understudy"
```

Then restart Cursor or run **Developer: Reload Window**.

## Safety Gates

Local-first and free: adding the symlink makes no provider calls, uploads,
spend, or credential changes. Do not require Understudy login, provider keys, or
hosted access for this skill.

- Confirm before overwriting anything except the exact
  `~/.cursor/plugins/local/understudy` symlink/directory.
- Do not edit Cursor's internal settings databases or user settings by hand.
- Do not copy private traces, keys, local `.understudy/` runtime state, or user
  data into the plugin directory.

## Resolve CLI

No Understudy CLI command is required. Use shell only to create the local plugin
symlink. If `git` is unavailable, use the current working directory only after
confirming it contains `.cursor-plugin/plugin.json`.

## Output Standard

End with whether the Cursor plugin was already present / just installed /
refreshed / shown for manual run; the reload step (`Developer: Reload Window` or
restart Cursor); the next onboarding prompt; and the uninstall command.
