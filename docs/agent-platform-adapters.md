# Agent Platform Adapters

Understudy should not become separate products for Claude Code, Cursor, Codex,
and OpenCode. The product is the public skill tree in `skills/`. Platform adapters
only describe how each coding-agent surface discovers, installs, reloads, and
starts those skills.

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
```

## Supported Adapters

| Platform | Status | Manifest | Discovery |
| --- | --- | --- | --- |
| Claude Code | supported | `.claude-plugin/plugin.json` | Local marketplace plugin discovers `skills/`. |
| Cursor | supported | `.cursor-plugin/plugin.json` | Local Cursor plugin discovers `skills/` from the plugin root. |
| Codex | supported | `.codex-plugin/plugin.json` | Local marketplace plugin discovers `skills/`. |
| OpenCode | supported | `.opencode/skills` | Native OpenCode skills are linked from the shared `skills/` tree. |

## Design Rule

Do not copy skills per platform. If a platform needs different packaging, add a
thin adapter manifest or installer path that points back to the same `skills/`
directories. Forking skill content creates stale safety gates and inconsistent
onboarding during the sprint.
