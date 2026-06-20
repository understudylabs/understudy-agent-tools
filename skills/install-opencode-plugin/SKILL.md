---
name: install-opencode-plugin
description: Use when a developer wants to install, enable, update, reinstall, or verify the Understudy skills in OpenCode - "install Understudy in OpenCode", "add the OpenCode skills", "make OpenCode see the Understudy skills". Links the shared skills into OpenCode's native global skill directory and surfaces the reload step.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy OpenCode skills

This repo ships the same public skills to OpenCode through its native `SKILL.md`
loader. OpenCode discovers skills from `.opencode/skills/` in a project and from
`~/.config/opencode/skills/` globally. Do not copy or fork the skill content; use
symlinks back to the repo's `skills/` tree.

## What this does

- Links each `skills/<name>/` directory into `~/.config/opencode/skills/<name>`.
- Links `.opencode/commands/understudy-onboard.md` into
  `~/.config/opencode/commands/understudy-onboard.md`.
- Does not authenticate, upload data, download model weights, start jobs, or make
  provider calls.

## Install or refresh

Resolve the repo directory that contains `skills/understudy/SKILL.md`:

```bash
REPO="$(git rev-parse --show-toplevel)"
ls "$REPO/skills/understudy/SKILL.md"
```

Link the skills and onboarding command:

```bash
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

## Activate

Restart OpenCode or open a new TUI session so it reloads global skills and
commands. Then run:

```text
/understudy-onboard
```

Or ask:

```text
Use the Understudy onboarding skill for this project.
```

## Verify

```bash
ls "$HOME/.config/opencode/skills/understudy/SKILL.md"
ls "$HOME/.config/opencode/commands/understudy-onboard.md"
```

If the `opencode` CLI is available, you can also inspect:

```bash
opencode agent list
```

## Uninstall

Remove Understudy-owned symlinks only:

```bash
find "$HOME/.config/opencode/skills" -type l -lname '*/understudy-agent-tools/skills/*' -delete
rm -f "$HOME/.config/opencode/commands/understudy-onboard.md"
```

Then restart OpenCode or open a new TUI session.

## Safety Gates

Local-first and free: linking the skills makes no provider calls, uploads,
spend, credential changes, model downloads, or hosted jobs. Do not require
Understudy login, provider keys, or hosted access for this skill.

- Do not overwrite existing non-Understudy OpenCode skills or commands.
- Do not copy private traces, keys, local `.understudy/` runtime state, or user
  data into `~/.config/opencode/`.
- Use symlinks back to this repo so future skill fixes apply everywhere.

## Resolve CLI

No Understudy CLI command is required. Use shell only to create the local
OpenCode skill and command symlinks. If `git` is unavailable, use the current
working directory only after confirming it contains `skills/understudy/SKILL.md`.

## Output Standard

End with whether the OpenCode skills were already present / just linked /
skipped due to conflicts; the reload step; the next onboarding command; and the
uninstall command.
