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

The normal production path is the **Desktop Release** GitHub Actions workflow.
Run its `validate` mode from `main` to check the remote certificate and Apple
credentials without building or publishing. After the version-bump PR is green,
run `release` mode. The serialized workflow
uses the protected `desktop-release` environment to build on Apple silicon,
import an ephemeral Developer ID identity, sign the Tauri updater, submit the
app and DMG to Apple, verify the downloaded draft assets byte-for-byte, and
publish only after every gate passes. No local Keychain or 1Password prompt is
required during a normal release.

Both modes require successful `gates` and `rust` checks for the exact `main`
commit. The release workflow reuses that evidence instead of rerunning the full
test suites on a fresh macOS runner; if main CI is still running, wait for it and
dispatch again.

The environment owns these secrets: `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, and
`TAURI_SIGNING_PRIVATE_KEY`. Rotate them deliberately; never copy them into
workflow inputs, logs, repository variables, or committed files.

The commands below remain the local break-glass path.

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
login Keychain, a `notarytool` Keychain profile, and the long-lived Tauri updater
private key stored as `Understudy Desktop Tauri Updater Private Key` in the
`Engineering - Prod` 1Password vault. Profile names, signing identities, and
private-key paths are machine configuration, not repository constants:

```sh
security find-identity -v -p codesigning
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example Company (TEAMID)'
export APPLE_NOTARY_KEYCHAIN_PROFILE='understudy'
xcrun notarytool history --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE"
updater_key_dir="$(mktemp -d)"
chmod 700 "$updater_key_dir"
trap 'rm -rf "$updater_key_dir"' EXIT
op document get "Understudy Desktop Tauri Updater Private Key" \
  --vault "Engineering - Prod" \
  --output "$updater_key_dir/understudy-desktop-updater.key"
chmod 600 "$updater_key_dir/understudy-desktop-updater.key"
export TAURI_SIGNING_PRIVATE_KEY="$updater_key_dir/understudy-desktop-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
```

Never pass an app-specific password on the command line or commit it to a file
in this repository. Create or repair the named Keychain profile separately with
`notarytool store-credentials`, which prompts without echoing the password.

Build the exact signed app, updater archive, updater signature, and DMG. Tauri's
updater signature is separate from Apple code signing and cannot be disabled:

```sh
cd apps/homescreen
bun install --frozen-lockfile
bun run tauri build --bundles app,dmg
cd ../..
```

The build inherits `APPLE_SIGNING_IDENTITY` and `TAURI_SIGNING_PRIVATE_KEY`.
Submit both the app and DMG to Apple. Staple the app before rebuilding and
re-signing the updater archive so an offline update contains the notarization
ticket; then generate the static `latest.json` contract:

```sh
version="$(node -p "require('./apps/homescreen/package.json').version")"
repo="$(pwd)"
dmg="$repo/apps/homescreen/src-tauri/target/release/bundle/dmg/Understudy_${version}_aarch64.dmg"
app="$repo/apps/homescreen/src-tauri/target/release/bundle/macos/Understudy.app"
updater="$repo/apps/homescreen/src-tauri/target/release/bundle/macos/Understudy.app.tar.gz"
app_zip="${TMPDIR:-/tmp}/Understudy-${version}.app.zip"
ditto -c -k --keepParent "$app" "$app_zip"
xcrun notarytool submit "$app_zip" \
  --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" \
  --wait --output-format json
xcrun stapler staple "$app"
rm -f "$updater" "${updater}.sig"
tar -czf "$updater" -C "$(dirname "$app")" "$(basename "$app")"
cd apps/homescreen
bun run tauri signer sign \
  --private-key-path "$TAURI_SIGNING_PRIVATE_KEY" \
  "$updater"
cd ../..
npm run desktop:updater-manifest
npm run desktop:release-check -- --stage signed
xcrun notarytool submit "$dmg" \
  --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" \
  --wait --output-format json
xcrun stapler staple "$dmg"
npm run desktop:release-check -- --stage notarized
```

Create a draft release targeted at the exact commit and upload the stapled DMG,
notarized updater archive, signature, and manifest. Download those assets into a
new temporary directory and compare their hashes before publishing. Validate
the downloaded DMG with `stapler` and `spctl`; the uploaded bytes, not the local
paths, are the public product.

```sh
tag="desktop-v${version}-mvp"
commit="$(git rev-parse HEAD)"
updater_sig="${updater}.sig"
updater_manifest="$(dirname "$updater")/latest.json"
gh release create "$tag" "$dmg" "$updater" "$updater_sig" "$updater_manifest" \
  --repo understudylabs/understudy-agent-tools \
  --target "$commit" --title "Understudy Desktop v${version}" \
  --generate-notes --draft

download_dir="$(mktemp -d)"
chmod 700 "$download_dir"
gh release download "$tag" \
  --repo understudylabs/understudy-agent-tools \
  --pattern "Understudy_${version}_aarch64.dmg" \
  --pattern "Understudy.app.tar.gz" \
  --pattern "Understudy.app.tar.gz.sig" \
  --pattern "latest.json" \
  --dir "$download_dir"
downloaded="$download_dir/Understudy_${version}_aarch64.dmg"
test "$(shasum -a 256 "$dmg" | awk '{print $1}')" = \
  "$(shasum -a 256 "$downloaded" | awk '{print $1}')"
test "$(shasum -a 256 "$updater" | awk '{print $1}')" = \
  "$(shasum -a 256 "$download_dir/Understudy.app.tar.gz" | awk '{print $1}')"
cmp "$updater_sig" "$download_dir/Understudy.app.tar.gz.sig"
cmp "$updater_manifest" "$download_dir/latest.json"
xcrun stapler validate "$downloaded"
spctl --assess --type open --context context:primary-signature --verbose=2 "$downloaded"
gh release edit "$tag" --repo understudylabs/understudy-agent-tools \
  --draft=false --latest
rm -rf "$updater_key_dir"
```

For a runtime migration release, regenerate the exact-version conformance and
readiness evidence from the installed notarized app after publication. Evidence
from an older version cannot qualify the new release cohort.

Write both reports to version-bound paths, for example
`desktop-runtime-conformance-0.3.17.json` and
`desktop-runtime-readiness-0.3.17.json`. `understudy desktop migration-status`
selects these exact-version defaults from the live app/runtime cohort; explicit
paths remain available for archived or isolated evidence roots.

The readiness probe is process-cold and refuses to overlap any active MLX/VLM
server, including one it does not own. Stop those workloads explicitly first;
the probe reports bounded process identity but never terminates an unowned
server, preventing a release check from colliding with another Metal workload.
