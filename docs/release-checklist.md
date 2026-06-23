# Release Checklist

Run this before tagging or publishing a package.

## Required Checks

```sh
npm run check
git ls-files
```

## Inspect

- versions bumped **together** in `package.json`, `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`,
  `.opencode/adapter.json`, and `.hermes/adapter.json` on any release that changes
  the skill catalog or CLI surface — installed adapters have no other staleness
  signal; `understudy doctor --json` fails if they drift;
- adapter install and onboarding parity checked across Claude Code, Cursor,
  Codex, OpenCode, and Hermes Agent: `install.sh --agents ...`, `understudy
  platforms`, and `skills/install-agent-adapter/reference.md` describe the same
  supported surfaces, reload steps, and uninstall paths;
- no `.understudy/` runtime artifacts;
- no `.env*`, credentials, tokens, or secret-shaped strings;
- no private planning docs;
- no private repo paths or local usernames;
- no raw prompts, completions, trace payloads, customer names, or domains;
- vendored files are covered by `vendor/MANIFEST.md`;
- README links to privacy, security, telemetry, and OSS boundary docs.

## Package Smoke

Before publishing a package, run:

```sh
npm run package:smoke
```

It runs `npm pack --dry-run --json` and inspects the included files for local
artifacts, private paths, raw payload markers, production/control-plane URLs,
and secret-shaped strings.
