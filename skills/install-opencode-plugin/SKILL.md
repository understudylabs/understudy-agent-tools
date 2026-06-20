---
name: install-opencode-plugin
description: Compatibility shim for OpenCode installs. Use when a developer asks to install, update, enable, reinstall, remove, or verify Understudy in OpenCode - "install Understudy in OpenCode", "add the OpenCode skills", "make OpenCode see the skills". Route to install-agent-adapter with platform opencode.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy OpenCode skills

This skill is a compatibility shim. The consolidated setup surface is
[`install-agent-adapter`](../install-agent-adapter/SKILL.md).

## Procedure

Load `install-agent-adapter` and run it with platform `opencode`.

Use its [`reference.md`](../install-agent-adapter/reference.md#opencode) for the
current native skill symlink install:

```bash
mkdir -p "$HOME/.config/opencode/skills" "$HOME/.config/opencode/commands"
```

The reference links each `skills/<name>/` directory into OpenCode's global skill
directory and links `.opencode/commands/understudy-onboard.md`.

Activation:

```text
Restart OpenCode or open a new TUI session.
/understudy-onboard
```

## Safety Gates

Local-first and free: installing the OpenCode adapter only links local skills. It
must not authenticate, upload data, inspect secret values, download model
weights, start hosted jobs, or make provider calls.

- Do not overwrite existing non-Understudy OpenCode skills or commands.
- Do not copy private traces, keys, or `.understudy/` state into OpenCode config.
- Use symlinks back to this repo's shared `skills/` tree.

## Resolve CLI

No Understudy CLI command is required. Use shell to create symlinks after
confirming the repo contains `skills/understudy/SKILL.md`.

## Output Standard

End with: that this routed through `install-agent-adapter`; whether OpenCode
skills were linked/refreshed/skipped due to conflicts; the restart/new-session
step; `/understudy-onboard`; and the uninstall command.
