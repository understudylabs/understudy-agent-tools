---
name: install-plugin
description: Use when a developer wants to install, enable, update, reinstall, or verify the Understudy skills as a Claude Code plugin — "install understudy", "add the understudy skills", "set up the plugin", "why can't you see the understudy skill". Runs the non-interactive `claude plugin` CLI (or shows the commands), then tells the developer the one activation step and whether a restart is needed.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Understudy plugin

This repo ships its skills as a Claude Code plugin. The manifests live in
`.claude-plugin/` (`plugin.json` + `marketplace.json`) and the skills live in
`skills/`. This skill installs/enables that plugin in the developer's Claude
Code so all nine skills (`understudy`, `capture-evidence`,
`use-understudy-gateway`, `run-local-model-lab`, `optimize-workload`,
`optimize-api-workflow`, `optimize-agentic-search`, `prepare-verifier-handoff`,
and this `install-plugin` skill) become invocable.

The whole flow is local: it adds a **local filesystem marketplace** pointing at
this repo and installs from it. Nothing uploads, authenticates, or spends.

## Key facts (don't get these wrong)

- **No app restart is required.** Plugin skills hot-load. After install, the
  developer runs `/reload-plugins` **once** in the current session and the
  skills appear. A full quit/relaunch is only a fallback if reload misbehaves.
- The CLI is non-interactive and safe to run from a background bash process:
  `claude plugin marketplace add`, `claude plugin install`, `claude plugin list`.
- The agent **cannot** run the activation step. `/reload-plugins` (and the
  interactive `/plugin …` commands) are user-typed slash commands — surface them
  for the developer; never claim you ran them.

## Procedure

### 1. Find the repo root

The marketplace source is the directory that contains `.claude-plugin/`. Resolve
it before running anything (it is the root of this `understudy-agent-tools`
checkout — do not hardcode another user's absolute path):

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
# Sanity check the manifests exist:
ls "$REPO/.claude-plugin/marketplace.json" "$REPO/.claude-plugin/plugin.json"
```

### 2. Check whether it's already installed

```bash
claude plugin list --json
```

Look for `understudy` from the `understudy-skills` marketplace. If it's already
enabled, stop — report installed and skip to step 4 only if the developer wants
to update (then `claude plugin marketplace update understudy-skills`).

### 3. Add the marketplace and install (background-safe)

Run these from bash. They are idempotent enough to re-run; if the marketplace
name already exists the add is a no-op/update.

```bash
claude plugin marketplace add "$REPO"
claude plugin install understudy@understudy-skills
```

Prefer running this as a background process and reporting the exit status rather
than blocking. If the developer would rather run it themselves, **show** the two
commands instead of executing them.

### 4. Activate in the current session

Tell the developer to type:

```
/reload-plugins
```

State plainly: **no restart needed** — `/reload-plugins` loads the skills into
this session. Only if the skills still don't appear afterward should they fully
restart Claude Code.

### 5. Verify

```bash
claude plugin list --json
```

Confirm `understudy@understudy-skills` is enabled, and confirm to the developer
that `/understudy` (and the other eight skills) are now available.

## Fallback: fully interactive path

If the `claude plugin` CLI is unavailable, give the developer the interactive
equivalents to type themselves:

```
/plugin marketplace add <repo-root-path>
/plugin install understudy@understudy-skills
/reload-plugins
```

## Safety Gates

Local-first and free: adding a local marketplace and installing from it makes no
provider calls, uploads, spend, or credential changes — do not require login,
auth, or keys for this skill. The `claude plugin` commands only register
repo-local skills.

- Confirm before running if the developer asked you only to *show* the commands;
  otherwise the install is low-risk and may run in the background.
- You **must not** claim you activated the plugin. `/reload-plugins` and the
  interactive `/plugin …` commands are user-typed — surface them and wait.
- Never edit `settings.json` / `settings.local.json` `enabledPlugins` by hand to
  force-enable; use the documented `claude plugin` CLI so the install is
  reversible with `claude plugin uninstall`.

## Output Standard

End with: whether the plugin was already installed / just installed / shown for
manual run; the exact activation step (`/reload-plugins`); an explicit
restart-or-not statement (not needed); and the verification result.
