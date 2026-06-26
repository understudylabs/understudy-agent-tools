---
name: install-agent-adapter
description: Use when a developer wants to install, enable, update, reinstall, remove, or verify Understudy in a coding agent - "install Understudy", "add the Understudy skills", "make Claude/Cursor/Codex/OpenCode/Hermes/Devin see the skills". Chooses the requested agent platform and routes to the local install, reload, onboarding, and uninstall steps.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy Agent Adapter

Understudy is agent-platform-neutral at the skill layer. The product is the
shared `skills/` tree; Claude Code, Cursor, Codex, OpenCode, Hermes Agent, and
Devin only differ in how they discover and reload those skills.

Use this skill for setup, refresh, verification, uninstall, or "why can't my
agent see Understudy?" requests. Keep the workflow local-first and pick the
smallest adapter path that matches the developer's agent.

## Choose Platform

If the developer named a platform, use it. Otherwise prefer the active agent
surface you are running inside. If that is unclear, inspect available CLIs and
local app state:

```bash
command -v claude || true
command -v cursor || true
command -v codex || true
command -v opencode || true
command -v hermes || true
test -n "$DEVIN" && echo devin-session
test -d "$HOME/.cursor" && echo cursor-config
test -d "$HOME/.config/opencode" && echo opencode-config
test -d "$HOME/.local/share/opencode" && echo opencode-data
test -d "$HOME/.hermes" && echo hermes-config
```

Platform details live in [`reference.md`](reference.md):

- Claude Code: local marketplace plugin, then user runs `/reload-plugins`.
- Cursor: symlink this repo into `~/.cursor/plugins/local/understudy`, then
  reload the window.
- Codex: register the local marketplace, then user installs/enables from
  `/plugins`.
- OpenCode: link the shared skills into `~/.config/opencode/skills`, then restart
  or open a new TUI session.
- Hermes Agent: register a stable `~/.understudy/skills` symlink in
  `skills.external_dirs` (`~/.hermes/config.yaml`), then run `/reload-skills`.
- Devin: the CLI is installed globally via npm; Devin reads `AGENTS.md` and
  accesses the shared `skills/` tree directly from the cloned repo.

## Procedure

1. Resolve the repo root:

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/skills/understudy/SKILL.md"
```

2. Open [`reference.md`](reference.md), jump to the chosen platform, and run or
   show the documented commands.
3. Report the activation step the developer must do in their agent UI.
4. Hand off to onboarding:

```text
Use the Understudy onboarding skill for this project.
```

For Claude Code specifically, after `/reload-plugins` the next command is:

```text
/understudy:onboard
```

For OpenCode, the convenience command is:

```text
/understudy-onboard
```

For Hermes, rescan in-session and start onboarding:

```text
/reload-skills
/onboard
```

## Safety Gates

Local-first and free: adapter install only makes local skills visible to a coding
agent. It must not authenticate, upload data, inspect secret values, download
model weights, start hosted jobs, or make provider calls.

- Do not copy or fork skill content per platform. Use manifests or symlinks back
  to this repo's `skills/` tree.
- Do not overwrite unrelated existing agent configuration. Only replace known
  Understudy-owned symlinks, plugin registrations, or marketplace entries.
- Do not claim UI activation is complete when the platform requires a user-typed
  reload, plugin browser step, app restart, or new TUI session.

## Resolve CLI

No Understudy CLI command is required. The platform registry is inspectable with:

```bash
understudy platforms
understudy platforms --inspect claude-code
understudy platforms --inspect cursor
understudy platforms --inspect codex
understudy platforms --inspect opencode
understudy platforms --inspect devin
```

Use platform CLIs only when available (`claude`, `codex`, `opencode`). Cursor and
OpenCode symlink installs are plain shell operations.

## Output Standard

End with: chosen platform; whether it was already installed / just installed /
refreshed / shown for manual run / skipped due to conflict; the exact activation
step; the next onboarding prompt; and the uninstall command.
