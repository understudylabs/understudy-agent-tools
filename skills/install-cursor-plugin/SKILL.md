---
name: install-cursor-plugin
description: Compatibility shim for Cursor installs. Use when a developer asks to install, update, enable, reinstall, remove, or verify the Understudy Cursor plugin - "install Understudy in Cursor", "add the Cursor plugin", "make Cursor see the skills". Route to install-agent-adapter with platform cursor.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Cursor plugin

This skill is a compatibility shim. The consolidated setup surface is
[`install-agent-adapter`](../install-agent-adapter/SKILL.md).

## Procedure

Load `install-agent-adapter` and run it with platform `cursor`.

Use its [`reference.md`](../install-agent-adapter/reference.md#cursor) for the
current symlink install:

```bash
mkdir -p "$HOME/.cursor/plugins/local"
rm -rf "$HOME/.cursor/plugins/local/understudy"
ln -s "$REPO" "$HOME/.cursor/plugins/local/understudy"
```

Activation:

```text
Developer: Reload Window
```

Then ask Cursor Agent:

```text
Use the Understudy onboarding skill for this project.
```

## Safety Gates

Local-first and free: installing the Cursor adapter only links local skills. It
must not authenticate, upload data, inspect secret values, download model
weights, start hosted jobs, or make provider calls.

- Only overwrite the exact `~/.cursor/plugins/local/understudy` path.
- Do not edit Cursor internal settings databases.
- Do not copy private traces, keys, or `.understudy/` state into the plugin.

## Resolve CLI

No Understudy CLI command is required. Use shell to create the local symlink after
confirming the repo contains `.cursor-plugin/plugin.json`.

## Output Standard

End with: that this routed through `install-agent-adapter`; whether the Cursor
plugin was installed/refreshed/shown for manual run; the reload step; the next
onboarding prompt; and the uninstall command.
