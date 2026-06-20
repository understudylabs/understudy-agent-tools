---
name: install-plugin
description: Compatibility shim for Claude Code installs. Use when a developer asks to install, update, enable, reinstall, remove, or verify the Understudy Claude Code plugin - "install Understudy in Claude", "add the Understudy skills", "why can't Claude see the skill". Route to install-agent-adapter with platform claude-code.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Claude Code plugin

This skill is a compatibility shim. The consolidated setup surface is
[`install-agent-adapter`](../install-agent-adapter/SKILL.md).

## Procedure

Load `install-agent-adapter` and run it with platform `claude-code`.

Use its [`reference.md`](../install-agent-adapter/reference.md#claude-code) for
the current commands:

```bash
claude plugin marketplace add "$REPO"
claude plugin install understudy@understudy-skills
```

Activation is user-typed:

```text
/reload-plugins
/understudy:onboard
```

## Safety Gates

Local-first and free: installing the Claude Code adapter only registers local
skills. It must not authenticate, upload data, inspect secret values, download
model weights, start hosted jobs, or make provider calls.

- Do not claim you ran `/reload-plugins`; the developer must type it.
- Do not edit Claude settings files by hand to force-enable the plugin.
- Do not copy or fork skill content outside the plugin/marketplace path.

## Resolve CLI

No Understudy CLI command is required. Prefer the `claude plugin` CLI when
available; otherwise show the interactive `/plugin ...` commands from
`install-agent-adapter/reference.md`.

## Output Standard

End with: that this routed through `install-agent-adapter`; whether the Claude
plugin was installed/refreshed/shown for manual run; `/reload-plugins`; the next
command `/understudy:onboard`; and the uninstall commands.
