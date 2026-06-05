# Release Checklist

Run this before tagging or publishing a package.

## Required Checks

```sh
npm run check
git ls-files
```

## Inspect

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
