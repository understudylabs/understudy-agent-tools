import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopUpdaterManifest } from "../scripts/desktop-updater-manifest.mjs";

test("desktop updater manifest binds one signed macOS artifact to one release", () => {
  const manifest = buildDesktopUpdaterManifest({
    version: "1.2.3",
    signature: "signed-artifact\n",
    pubDate: "2026-07-14T20:00:00.000Z",
    notes: "Understudy Desktop 1.2.3",
    url: "https://github.com/understudylabs/understudy-agent-tools/releases/download/desktop-v1.2.3-mvp/Understudy.app.tar.gz",
  });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "signed-artifact");
  assert.match(manifest.platforms["darwin-aarch64"].url, /desktop-v1\.2\.3-mvp/);
});

test("desktop updater manifest rejects unsigned or insecure updates", () => {
  assert.throws(
    () =>
      buildDesktopUpdaterManifest({
        version: "1.2.3",
        signature: "",
        pubDate: "2026-07-14T20:00:00.000Z",
        notes: "test",
        url: "https://example.com/update.tar.gz",
      }),
    /signature is empty/,
  );
  assert.throws(
    () =>
      buildDesktopUpdaterManifest({
        version: "1.2.3",
        signature: "signed",
        pubDate: "2026-07-14T20:00:00.000Z",
        notes: "test",
        url: "http://example.com/update.tar.gz",
      }),
    /must use HTTPS/,
  );
});
