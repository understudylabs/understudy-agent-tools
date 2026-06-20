---
name: install-codex-plugin
description: Compatibility shim for Codex installs. Use when a developer asks to install, update, enable, reinstall, remove, or verify the Understudy Codex plugin - "install Understudy in Codex", "add the Codex plugin", "make Codex see the skills". Route to install-agent-adapter with platform codex.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Codex plugin

This skill is a compatibility shim. The consolidated setup surface is
[`install-agent-adapter`](../install-agent-adapter/SKILL.md).

## Procedure

Load `install-agent-adapter` and run it with platform `codex`.

Use its [`reference.md`](../install-agent-adapter/reference.md#codex) for the
current marketplace registration:

```bash
codex plugin marketplace add "$REPO"
```

Activation is in Codex:

```text
/plugins
```

Choose `understudy-skills`, install or enable `understudy`, then ask:

```text
Use the Understudy onboarding skill for this project.
```

## Safety Gates

Local-first and free: registering the Codex marketplace only makes local skills
available. It must not authenticate, upload data, inspect secret values, download
model weights, start hosted jobs, or make provider calls.

- Do not claim the plugin is installed when only the marketplace is registered.
- Do not edit `~/.codex/config.toml` by hand unless the user explicitly asks.
- Do not copy or fork skill content for Codex.

## Resolve CLI

No Understudy CLI command is required. Use `codex plugin marketplace add` when
available; otherwise show the manual `/plugins` activation path from
`install-agent-adapter/reference.md`.

## Output Standard

End with: that this routed through `install-agent-adapter`; whether the Codex
marketplace was registered/refreshed/shown for manual run; the `/plugins` step;
the next onboarding prompt; and the marketplace removal command.
