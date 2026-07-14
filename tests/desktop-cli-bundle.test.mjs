import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  EXPECTED_NODE_VERSION,
  desktopCliPaths,
  desktopTargetTriple,
  repositoryRoot,
} from "../scripts/build-desktop-cli.mjs";

test("Desktop CLI bundle uses Tauri target triples", () => {
  assert.equal(EXPECTED_NODE_VERSION, "v22.23.0");
  assert.equal(desktopTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(desktopTargetTriple("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(desktopTargetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(desktopTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => desktopTargetTriple("freebsd", "x64"), /unsupported/);
});

test("Desktop CLI bundle paths match Tauri externalBin and resource layout", () => {
  const paths = desktopCliPaths(repositoryRoot, "aarch64-apple-darwin");
  assert.equal(
    paths.nodeBinary,
    join(
      repositoryRoot,
      "apps/homescreen/src-tauri/binaries/understudy-node-aarch64-apple-darwin",
    ),
  );
  assert.equal(
    paths.entry,
    join(
      repositoryRoot,
      "apps/homescreen/src-tauri/resources/understudy-cli/bundle/understudy.js",
    ),
  );
  assert.equal(
    paths.resourceRoot,
    join(repositoryRoot, "apps/homescreen/src-tauri/resources/understudy-cli"),
  );

  const config = JSON.parse(
    readFileSync(join(repositoryRoot, "apps/homescreen/src-tauri/tauri.conf.json"), "utf8"),
  );
  const macConfig = JSON.parse(
    readFileSync(
      join(repositoryRoot, "apps/homescreen/src-tauri/tauri.macos.conf.json"),
      "utf8",
    ),
  );
  assert.deepEqual(macConfig.bundle.externalBin, ["binaries/understudy-node"]);
  assert.deepEqual(macConfig.bundle.resources, {
    "resources/understudy-cli/": "understudy-cli-resources/",
  });
  assert.match(config.build.beforeBuildCommand, /build-desktop-cli\.mjs/);
  assert.match(config.build.beforeDevCommand, /build-desktop-cli\.mjs/);
});
