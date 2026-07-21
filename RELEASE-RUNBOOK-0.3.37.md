# Release Runbook — Understudy Desktop 0.3.37 (CLI 0.6.34)

Everything from "PR #302 merged" to "users receive the update".

> **Why 0.3.37, not 0.3.36:** `desktop-v0.3.36-mvp` was already published from
> main on 2026-07-21 (PR #301, CLI 0.6.32, marked Latest). This branch carries
> the next bump: Desktop/runtime **0.3.37**, CLI **0.6.34**. All canonical
> version sources on this branch were advanced with
> `node scripts/desktop-release-plan.mjs --desktop-version 0.3.37 --cli-version 0.6.34 --apply`.

## How releases actually ship (read once)

The **Desktop Release** GitHub Actions workflow
(`.github/workflows/desktop-release.yml`) does everything — including creating
the git tag. It is **manually triggered** (`workflow_dispatch`) with a `mode`
input (`validate` or `release`), refuses to run off `main`, and runs in the
`desktop-release` environment, which must hold these secrets:

- `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` — base64 Developer ID
  Application `.p12` and its password (imported into a throwaway keychain).
- `APPLE_SIGNING_IDENTITY` — the codesign identity string.
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` — Apple ID + app-specific
  password + team for `xcrun notarytool` notarization.
- `TAURI_SIGNING_PRIVATE_KEY` — the Tauri updater minisign private key
  (pairs with the `pubkey` embedded in `tauri.conf.json`; without it users'
  auto-updaters will reject the artifact).

In `release` mode it: requires green `gates` and `rust` CI checks on the exact
commit → `desktop:release-check --stage source` → `bun run tauri build
--bundles app,dmg` (signed; `beforeBuildCommand` bundles the self-contained
CLI + pinned Node via `scripts/build-desktop-cli.mjs`) → notarizes and staples
the .app (`notarytool submit --wait`, `stapler staple`) → rebuilds and signs
`Understudy.app.tar.gz` with the updater key (`tauri signer sign`) → generates
`latest.json` (`npm run desktop:updater-manifest`) → `release-check --stage
signed` → rebuilds the DMG from the stapled app, codesigns, notarizes, staples
→ `release-check --stage notarized` → creates a **draft** GitHub release
tagged `desktop-v0.3.37-mvp` with the DMG, `Understudy.app.tar.gz`, its
`.sig`, and `latest.json`, re-downloads the public bytes and verifies
checksums, staple, and Gatekeeper → publishes the release as **latest**.

Distribution: installed apps poll
`https://github.com/understudylabs/understudy-agent-tools/releases/latest/download/latest.json`
at launch and every 15 minutes (plus **Check for Updates…** in the app/tray
menu), verify the minisign signature against the embedded pubkey, and update
in place. Publishing the GitHub release as latest **is** the rollout.

## The five minutes

```bash
# 0. PR #302 is merged. Work from a clean checkout of main.
git checkout main && git pull --ff-only

# 1. Confirm the release commit is what you think it is and CI is green
#    ("gates" and "rust" checks must be successful on this exact SHA —
#    the workflow enforces this too).
git log -1 --oneline
gh run list --branch main --limit 5

# 2. Source-stage sanity check locally (must print "ok desktop 0.3.37 ..."):
npm ci && npm run build
npm run desktop:release-check
node scripts/desktop-release-plan.mjs --verify   # errors: []

# 3. Dry-run the credentials (no build, no publish):
gh workflow run "Desktop Release" --ref main -f mode=validate
gh run watch   # must succeed; fixes here cost nothing

# 4. The real thing (builds, signs, notarizes, publishes — ~30-60 min,
#    notarization wait dominates):
gh workflow run "Desktop Release" --ref main -f mode=release
gh run watch
```

Do **not** create the `desktop-v0.3.37-mvp` tag by hand — `gh release create`
inside the workflow creates it at the release commit.

## Verify users actually receive it

```bash
# 1. The updater endpoint now serves 0.3.37:
curl -sL https://github.com/understudylabs/understudy-agent-tools/releases/latest/download/latest.json | jq .version
# expect "0.3.37", platforms["darwin-aarch64"].url pointing at
# .../desktop-v0.3.37-mvp/Understudy.app.tar.gz, and a non-empty signature.

# 2. Fresh install: download the DMG from the release page, open it,
#    drag Understudy to /Applications, launch. Gatekeeper must not warn
#    (the workflow already asserted stapler + spctl on the public bytes).
gh release download desktop-v0.3.37-mvp -p 'Understudy_0.3.37_aarch64.dmg' -D /tmp

# 3. In-place update: on a machine still running 0.3.36, open Understudy,
#    menu bar → Check for Updates…  It should offer 0.3.37, download,
#    verify, install, and relaunch. (Or just wait ≤15 min for the
#    automatic check.)

# 4. The bundled CLI moved in lockstep: in the updated app the runtime
#    health check should report CLI 0.6.34 / conversation runtime 0.3.37.
```

## If something fails

- **validate mode fails** → a `desktop-release` environment secret is missing
  or expired (Apple app-specific passwords and Developer ID certs expire).
- **notarytool rejects** → check the JSON log URL it prints; usually an
  entitlement or unsigned nested binary.
- **release-check `--stage signed/notarized` fails inside CI** → the run stops
  before anything is public; nothing to roll back.
- **Bad release already published** → do not delete history blindly: publish a
  fixed 0.3.37; the `latest.json` endpoint always tracks the release marked
  latest, so shipping the next version is the rollback.
