import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/desktop-release.yml", import.meta.url),
  "utf8",
);
const workflowRoot = new URL("../.github/workflows/", import.meta.url);

test("Desktop releases are main-only, serialized, and use pinned actions", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: validate/);
  assert.match(workflow, /- validate\n          - release/);
  assert.match(workflow, /github\.ref != 'refs\/heads\/main'/);
  assert.match(workflow, /group: desktop-production-release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /environment: desktop-release/);
  assert.match(workflow, /permissions:\n  checks: read\n  contents: write/);
  assert.doesNotMatch(workflow, /uses: [^\n]+@(v\d+|main|stable)\b/);
  const actionPins = [...workflow.matchAll(/uses: [^@\n]+@([0-9a-f]{40})/g)];
  assert.equal(actionPins.length, 4);
});

test("Every GitHub Action is pinned by a full commit SHA", () => {
  const files = readdirSync(workflowRoot).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const source = readFileSync(new URL(name, workflowRoot), "utf8");
    for (const match of source.matchAll(/uses: ([^\s#]+)/g)) {
      assert.match(match[1], /@[0-9a-f]{40}$/, `${name}: ${match[1]}`);
    }
  }
});

test("Desktop release automation keeps every trust gate before publication", () => {
  for (const secret of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "TAURI_SIGNING_PRIVATE_KEY",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.ok(workflow.indexOf("npm ci") < workflow.indexOf("secrets.APPLE_CERTIFICATE"));
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /bun install --cwd apps\/homescreen --frozen-lockfile/);
  assert.match(workflow, /commits\/\$GITHUB_SHA\/check-runs\?per_page=100/);
  assert.match(workflow, /for name in gates rust/);
  assert.match(workflow, /\.name == \$name and \.conclusion == "success"/);
  assert.match(workflow, /desktop:release-check -- --stage source/);
  assert.doesNotMatch(workflow, /npm run check/);
  assert.doesNotMatch(workflow, /cargo test/);
  assert.match(workflow, /notarytool history/);
  assert.match(workflow, /jq -e '\.history \| type == "array"'/);
  assert.equal([...workflow.matchAll(/if: inputs\.mode == 'release'/g)].length, 9);
  assert.match(workflow, /notarytool submit "\$app_zip"/);
  assert.match(workflow, /stapler staple "\$app"/);
  assert.match(
    workflow,
    /env -u TAURI_SIGNING_PRIVATE_KEY bun run tauri signer sign \\\n+              --private-key-path/,
  );
  assert.doesNotMatch(workflow, /tauri signer sign -- \\/);
  assert.match(workflow, /desktop:updater-manifest/);
  assert.match(workflow, /desktop:release-check -- --stage signed/);
  assert.match(workflow, /notarytool submit "\$dmg"/);
  assert.match(workflow, /hdiutil create/);
  assert.match(workflow, /-srcfolder "\$dmg_stage"/);
  assert.match(workflow, /stapler validate "\$dmg_stage\/Understudy\.app"/);
  assert.ok(
    workflow.indexOf('stapler staple "$app"') <
      workflow.indexOf('-srcfolder "$dmg_stage"'),
  );
  assert.match(workflow, /desktop:release-check -- --stage notarized/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /xcrun stapler validate "\$downloaded"/);
  assert.match(workflow, /xcrun stapler validate "\$mounted_dmg\/Understudy\.app"/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /spctl --assess/);
  assert.ok(workflow.indexOf("gh release download") < workflow.indexOf("gh release edit"));
});
