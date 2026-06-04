# Release Checklist

Run this before tagging or publishing a package.

## Required Checks

```sh
python3 scripts/validate_public_skills.py --repo
python3 scripts/doctor.py
uv run --with pytest python -m pytest
git ls-files
```

## Inspect

- no `.understudy/` runtime artifacts;
- no `.env*`, credentials, tokens, or secret-shaped strings;
- no private planning docs;
- no private repo paths or local usernames;
- no raw prompts, completions, trace payloads, customer names, or domains;
- examples are synthetic or clearly public;
- vendored files are covered by `vendor/MANIFEST.md`;
- README links to privacy, security, telemetry, and OSS boundary docs.

## Package Smoke

Before publishing a package, build the archive and inspect its contents for
ignored files, local artifacts, private paths, and secret-shaped strings.
