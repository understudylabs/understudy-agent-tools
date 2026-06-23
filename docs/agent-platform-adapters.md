# Agent Platform Adapters

Understudy should not become separate products for Claude Code, Cursor, Codex,
OpenCode, and Hermes Agent. The product is the public skill tree in `skills/`.
Platform adapters only describe how each coding-agent surface discovers, installs,
reloads, and starts those skills.

## Contract

Each adapter answers the same questions:

- where the platform manifest or durable instruction file lives
- how the platform discovers `skills/`
- what local install command, if any, is safe to run
- what activation step the user must perform in that agent UI
- how to uninstall or reverse the local registration

The CLI registry is `src/agent-platforms.ts`; inspect it with:

```bash
understudy platforms
understudy --json platforms
understudy platforms --inspect cursor
understudy platforms --inspect opencode
understudy platforms --inspect hermes
```

## Supported Adapters

| Platform | Status | Manifest | Discovery |
| --- | --- | --- | --- |
| Claude Code | supported | `.claude-plugin/plugin.json` | Local marketplace plugin discovers `skills/`. |
| Cursor | supported | `.cursor-plugin/plugin.json` | Local Cursor plugin discovers `skills/` from the plugin root. |
| Codex | supported | `.codex-plugin/plugin.json` | Local marketplace plugin discovers `skills/`. |
| OpenCode | supported | `.opencode/adapter.json` | Native OpenCode skills and commands are linked from the shared `skills/` tree and `.opencode/commands/`. |
| Hermes Agent | supported | `.hermes/adapter.json` | The shared `skills/` tree is registered in `skills.external_dirs` (`~/.hermes/config.yaml`); Hermes discovers its `SKILL.md` files natively. |

## Design Rule

Do not copy skills per platform. If a platform needs different packaging, add a
thin adapter manifest or installer path that points back to the same `skills/`
directories. Forking skill content creates stale safety gates and inconsistent
onboarding during the sprint.

OpenCode calls JS/TS hook modules "plugins." Understudy's OpenCode surface is
not that kind of plugin; it is a native skills/commands adapter. The
`.opencode/adapter.json` file is only an Understudy version sentinel for
`understudy doctor` and release checks.

Hermes Agent has its own plugin system (`~/.hermes/plugins/` with `plugin.yaml`
and Python) and a Skills Hub, but Understudy's Hermes surface uses neither. It
registers the shared `skills/` tree in `skills.external_dirs` so Hermes scans the
same `SKILL.md` files the other adapters expose — no copies, no Python plugin.
To keep the config entry stable across checkout or package moves, the installer
registers a durable `~/.understudy/skills` symlink (a path indirection to the one
shared tree, not a fork) and edits `~/.hermes/config.yaml` idempotently with a
timestamped backup. Hermes rescans in-session via `/reload-skills`, and local
`~/.hermes/skills/` entries win on name conflicts. The `.hermes/adapter.json`
file is only an Understudy version sentinel, like the OpenCode one.
