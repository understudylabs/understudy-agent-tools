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

## Hermes Agent

Hermes Agent (Nous Research) discovers native `SKILL.md` skills from
`~/.hermes/skills/` and from any directory listed in `skills.external_dirs` in
`~/.hermes/config.yaml`. The shared `skills/` tree already ships valid Hermes
skills (Hermes reads `name`/`description`; the extra `metadata.understudy.*` is
ignored), so the adapter just registers the directory — no copies and no Hermes
plugin. (It does register through a stable `~/.understudy/skills` symlink for
path durability, but that points at the one shared tree; it is not a fork.)

This is not a Hermes plugin (`~/.hermes/plugins/` with `plugin.yaml` + Python)
and not a Skills Hub install. The `.hermes/adapter.json` file is not consumed by
Hermes; it is an Understudy-owned version/staleness sentinel for
`understudy doctor` and the release checklist.

Register through a stable symlink, not the raw checkout path. The installer
points a durable `~/.understudy/skills` symlink at the resolved `skills/` tree
and registers that symlink, so the Hermes config entry survives checkout or
package moves (a reinstall just re-points the link — never a copy).
`skills.external_dirs` accepts a string or a list, expands `~` and `${VAR}`,
`.resolve()`s symlinks, and silently skips paths that do not exist. The edit is
idempotent and backs up the config first:

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
ls "$REPO/skills/understudy/SKILL.md"
LINK="$HOME/.understudy/skills"
mkdir -p "$HOME/.understudy"
[ -e "$LINK" ] || ln -s "$REPO/skills" "$LINK"
CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"
[ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.understudy.bak-$(date -u +%Y%m%dT%H%M%SZ)"
python3 - "$CONFIG" "$LINK" <<'PY'
import sys, os, yaml
cfg_path, skills_dir = sys.argv[1], sys.argv[2]
cfg = (yaml.safe_load(open(cfg_path)) or {}) if os.path.exists(cfg_path) else {}
cfg = cfg if isinstance(cfg, dict) else {}
skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
cfg["skills"] = skills
dirs = skills.get("external_dirs") or []
dirs = [dirs] if isinstance(dirs, str) else (dirs if isinstance(dirs, list) else [])
if skills_dir not in dirs:
    dirs.append(skills_dir)
skills["external_dirs"] = dirs
os.makedirs(os.path.dirname(cfg_path) or ".", exist_ok=True)
yaml.safe_dump(cfg, open(cfg_path, "w"), sort_keys=False)
PY
```

If no YAML-capable `python3` is available, edit `~/.hermes/config.yaml` by hand
(or run `hermes config edit`) and add `~/.understudy/skills` under
`skills.external_dirs`. Do not use `hermes config set skills.external_dirs <path>`
on a config that already has entries — it overwrites the list instead of
appending.

Activation — Hermes rescans `skills.external_dirs` in-session, no restart needed:

```text
/reload-skills
/onboard
```

Then, if you prefer natural language, ask Hermes:

```text
Use the Understudy onboarding skill for this project.
```

A few generically named skills (e.g. `onboard`, `review`) may be shadowed by
Hermes bundled skills of the same name, since local `~/.hermes/skills/` wins on
conflicts; the Understudy-specific skills are unique and unaffected.

Verify:

```bash
ls -l "$HOME/.understudy/skills"          # symlink -> the resolved skills/ tree
hermes config show | grep -A4 'external_dirs'
hermes skills list | grep -i understudy
```

Uninstall — remove the entry from `skills.external_dirs`, then drop the symlink:

```bash
CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"
LINK="$HOME/.understudy/skills"
python3 - "$CONFIG" "$LINK" <<'PY'
import sys, os, yaml
cfg_path, skills_dir = sys.argv[1], sys.argv[2]
cfg = (yaml.safe_load(open(cfg_path)) or {}) if os.path.exists(cfg_path) else {}
skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
dirs = skills.get("external_dirs") or []
dirs = [dirs] if isinstance(dirs, str) else (dirs if isinstance(dirs, list) else [])
skills["external_dirs"] = [x for x in dirs if x != skills_dir]
yaml.safe_dump(cfg, open(cfg_path, "w"), sort_keys=False)
PY
[ -L "$LINK" ] && rm -f "$LINK"
```

## Devin

Devin is a cloud-based coding agent. Each session boots from a snapshot, so
there is no persistent local plugin registration. The adapter surface is the
globally installed npm package, and skill discovery happens through `AGENTS.md`
(which Devin reads as an injected repository rule) and the shared `skills/`
tree in the cloned repo. `.devin/adapter.json` is an Understudy version/staleness
sentinel for `understudy doctor`, not a manifest consumed by Devin.

Install (typically done once in the Devin environment blueprint so every
session starts with the CLI on PATH):

```bash
npm install -g @understudylabs/understudy-agent-tools
```

Verify:

```bash
understudy platforms --inspect devin
ls "$(git rev-parse --show-toplevel)/.devin/adapter.json"
ls "$(git rev-parse --show-toplevel)/skills/understudy/SKILL.md"
```

Activation — no reload step needed; Devin reads `AGENTS.md` automatically:

```text
Use the Understudy onboarding skill for this project.
```

For persistent installs across sessions, add the `npm install -g` command to
the Devin environment blueprint (repository or organization level).

Uninstall:

```bash
npm uninstall -g @understudylabs/understudy-agent-tools
```
