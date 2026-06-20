# Agent Adapter Install Reference

Use this reference from `install-agent-adapter`. Do not copy skill content into
platform-specific directories; all adapters point back to the same `skills/`
tree.

## Claude Code

Claude Code uses a local marketplace plugin declared in `.claude-plugin/`.

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/.claude-plugin/marketplace.json" "$REPO/.claude-plugin/plugin.json"
claude plugin marketplace add "$REPO"
claude plugin install understudy@understudy-skills
```

If it is already installed, check freshness:

```bash
claude plugin list --json
```

If the marketplace is stale, refresh with the available Claude command for the
installed CLI version, then reinstall `understudy@understudy-skills`.

Activation is user-typed:

```text
/reload-plugins
/understudy:onboard
```

No restart should be needed unless `/reload-plugins` fails.

Uninstall:

```bash
claude plugin uninstall understudy@understudy-skills
claude plugin marketplace remove understudy-skills
```

## Cursor

Cursor loads local plugins from `~/.cursor/plugins/local/<plugin-name>`.

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/.cursor-plugin/plugin.json" "$REPO/skills/understudy/SKILL.md"
mkdir -p "$HOME/.cursor/plugins/local"
rm -rf "$HOME/.cursor/plugins/local/understudy"
ln -s "$REPO" "$HOME/.cursor/plugins/local/understudy"
```

Use `rm -rf` only for the known local plugin path above. Do not edit Cursor's
internal settings databases.

Activation:

```text
Developer: Reload Window
```

Then ask Cursor Agent:

```text
Use the Understudy onboarding skill for this project.
```

Uninstall:

```bash
rm -f "$HOME/.cursor/plugins/local/understudy"
```

## Codex

Codex uses a local marketplace at `.agents/plugins/marketplace.json` and a plugin
manifest at `.codex-plugin/plugin.json`.

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/.codex-plugin/plugin.json" "$REPO/.agents/plugins/marketplace.json" "$REPO/skills/understudy/SKILL.md"
codex plugin marketplace add "$REPO"
```

If the marketplace already exists, refresh:

```bash
codex plugin marketplace upgrade understudy-skills
```

Activation is in the Codex UI:

```text
/plugins
```

Choose the `understudy-skills` marketplace, install or enable the `understudy`
plugin, then start a new thread if needed. Next ask:

```text
Use the Understudy onboarding skill for this project.
```

Uninstall: remove the plugin from `/plugins`, then remove the marketplace:

```bash
codex plugin marketplace remove understudy-skills
```

## OpenCode

OpenCode loads native `SKILL.md` definitions from project and global skill
directories. This repo also exposes `.opencode/skills` as a project-level symlink
to `../skills`.

This is a native OpenCode skills/commands adapter, not an OpenCode JS/TS plugin.
OpenCode plugins are hook modules for lifecycle events and custom behavior. For
Understudy, the documented and community-style pattern is simpler: keep one
durable checkout/package, symlink each `skills/<name>/` directory into
`~/.config/opencode/skills`, and link a small markdown command into
`~/.config/opencode/commands`.

The `.opencode/adapter.json` file is not consumed by OpenCode. It is an
Understudy-owned version/staleness sentinel used by `understudy doctor` and the
release checklist.

Global install:

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/skills/understudy/SKILL.md"
mkdir -p "$HOME/.config/opencode/skills" "$HOME/.config/opencode/commands"
for skill in "$REPO"/skills/*; do
  [ -f "$skill/SKILL.md" ] || continue
  name="$(basename "$skill")"
  dest="$HOME/.config/opencode/skills/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -L "$dest" ] && readlink "$dest" | grep -q 'understudy-agent-tools/skills/'; then
      rm -f "$dest"
    else
      echo "skip existing OpenCode skill: $dest"
      continue
    fi
  fi
  ln -s "$skill" "$dest"
done
command_dest="$HOME/.config/opencode/commands/understudy-onboard.md"
if [ -L "$command_dest" ] && readlink "$command_dest" | grep -q 'understudy-agent-tools/.opencode/commands/'; then
  rm -f "$command_dest"
fi
[ -e "$command_dest" ] || [ -L "$command_dest" ] || \
  ln -s "$REPO/.opencode/commands/understudy-onboard.md" "$command_dest"
```

Activation:

```text
Restart OpenCode or open a new TUI session.
/understudy-onboard
```

OpenCode may ask before reading symlink targets outside the current project.
That is expected; do not bypass the prompt by copying skill content into
OpenCode config.

Verify:

```bash
ls "$HOME/.config/opencode/skills/understudy/SKILL.md"
ls "$HOME/.config/opencode/commands/understudy-onboard.md"
```

Uninstall Understudy-owned symlinks:

```bash
find "$HOME/.config/opencode/skills" -type l -lname '*/understudy-agent-tools/skills/*' -delete
rm -f "$HOME/.config/opencode/commands/understudy-onboard.md"
```
