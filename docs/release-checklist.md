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
  `.opencode/adapter.json`, `.hermes/adapter.json`, and `.devin/adapter.json` on
  any release that changes the skill catalog or CLI surface — installed
  adapters have no other staleness signal; `understudy doctor --json` fails if
  they drift;
- the CLI package and every adapter manifest advance on every ConversationRuntime
  release, even when no command surface changed: the CLI distributes the canonical
  sidecar, and Desktop must raise `MIN_UNDERSTUDY_CLI_VERSION` to that exact package
  version;
- adapter install and onboarding parity checked across Claude Code, Cursor,
  Codex, OpenCode, and Hermes Agent: `install.sh --agents ...`, `understudy
  platforms`, and `skills/install-agent-adapter/reference.md` describe the same
  supported surfaces, reload steps, and uninstall paths;
- no `.understudy/` runtime artifacts;
- no `.env*`, credentials, tokens, or secret-shaped strings;
- no private planning docs;
- no private repo paths or local usernames;
- no raw prompts, completions, trace payloads, customer names, or domains;
- no vendored compatibility shims or mirrored source;
- README links to privacy, security, telemetry, and OSS boundary docs.

## Package Smoke

Before publishing a package, run:

```sh
npm run package:smoke
```

It runs `npm pack --dry-run --json` and inspects the included files for local
artifacts, private paths, raw payload markers, production/control-plane URLs,
and secret-shaped strings.

## Desktop release

Desktop releases must come from the exact merged `origin/main` commit. The
release check fails closed if the worktree is dirty, `HEAD` differs from the
locally fetched `origin/main`, any of the six desktop/runtime version sources
drift, the Desktop CLI floor differs from the distributed package, or a runtime
version advances without a newer CLI package. Fetch first, then run the source gate:

```sh
git fetch origin
npm run check
npm run desktop:release-check -- --stage source
```

On macOS, select a Developer ID Application identity already present in the
login Keychain and a `notarytool` Keychain profile. Profile names and signing
identities are machine configuration, not repository constants:

```sh
security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example Company (TEAMID)'
export APPLE_NOTARY_KEYCHAIN_PROFILE='understudy'
xcrun notarytool history --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE"
```

Never pass an app-specific password on the command line or commit it to a file
in this repository. Create or repair the named Keychain profile separately with
`notarytool store-credentials`, which prompts without echoing the password.

Build the exact signed app and DMG, then verify the signature, embedded version,
disk image, and SHA-256 locally:

```sh
cd apps/homescreen
bun install --frozen-lockfile
bun run tauri build --bundles app,dmg
cd ../..
npm run desktop:release-check -- --stage signed
```

The build inherits `APPLE_SIGNING_IDENTITY`. Submit the DMG, staple the accepted
ticket, and run the stronger notarized gate:

```sh
version="$(node -p "require('./apps/homescreen/package.json').version")"
dmg="apps/homescreen/src-tauri/target/release/bundle/dmg/Understudy_${version}_aarch64.dmg"
xcrun notarytool submit "$dmg" \
  --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" \
  --wait --output-format json
xcrun stapler staple "$dmg"
npm run desktop:release-check -- --stage notarized
```

Create a draft release targeted at the exact commit, upload the stapled DMG,
download that asset into a new temporary directory, and compare its SHA-256 to
the local artifact before publishing. Validate the downloaded copy with
`xcrun stapler validate` and `spctl` as well; the uploaded bytes, not the local
path, are the public product.

```sh
tag="desktop-v${version}-mvp"
commit="$(git rev-parse HEAD)"
gh release create "$tag" "$dmg" \
  --repo understudylabs/understudy-agent-tools \
  --target "$commit" --title "Understudy Desktop v${version}" \
  --generate-notes --draft

download_dir="$(mktemp -d)"
chmod 700 "$download_dir"
gh release download "$tag" \
  --repo understudylabs/understudy-agent-tools \
  --pattern "Understudy_${version}_aarch64.dmg" --dir "$download_dir"
downloaded="$download_dir/Understudy_${version}_aarch64.dmg"
test "$(shasum -a 256 "$dmg" | awk '{print $1}')" = \
  "$(shasum -a 256 "$downloaded" | awk '{print $1}')"
xcrun stapler validate "$downloaded"
spctl --assess --type open --context context:primary-signature --verbose=2 "$downloaded"
gh release edit "$tag" --repo understudylabs/understudy-agent-tools \
  --draft=false --latest
```

For a runtime migration release, regenerate the exact-version conformance and
readiness evidence from the installed notarized app after publication. Evidence
from an older version cannot qualify the new release cohort.

Write both reports to version-bound paths, for example
`desktop-runtime-conformance-0.3.14.json` and
`desktop-runtime-readiness-0.3.14.json`. `understudy desktop migration-status`
selects these exact-version defaults from the live app/runtime cohort; explicit
paths remain available for archived or isolated evidence roots.

The readiness probe is process-cold and refuses to overlap any active MLX/VLM
server, including one it does not own. Stop those workloads explicitly first;
the probe reports bounded process identity but never terminates an unowned
server, preventing a release check from colliding with another Metal workload.
