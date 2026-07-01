import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  findProjectRoot,
  isGlobalProjectConfigPath,
  projectConfigPath,
} from "../dist/config/paths.js";
import { readProjectConfig, writeProjectConfig } from "../dist/config/index.js";

// These tests re-point $HOME at a temp dir. `os.homedir()` reads the env
// var on POSIX, so an in-process swap is enough; node:test runs the cases
// in this file sequentially, so the swap cannot race another test.
describe("findProjectRoot and the global config dir", () => {
  let home;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "understudy-paths-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // The global config dir exists, exactly like a signed-in machine.
    mkdirSync(join(home, ".understudy"), { recursive: true });
    assert.equal(homedir(), home);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("finds the nearest ancestor with a .understudy marker", () => {
    const project = join(home, "code", "my-app");
    mkdirSync(join(project, ".understudy"), { recursive: true });
    const nested = join(project, "src", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), project);
    assert.equal(
      projectConfigPath(nested),
      join(project, ".understudy", "config.json"),
    );
  });

  it("never treats $HOME as a project root even though ~/.understudy exists", () => {
    const stray = join(home, "Documents", "notes");
    mkdirSync(stray, { recursive: true });
    // Pre-guard behavior: the walk hit $HOME, matched ~/.understudy, and
    // per-repo config landed in the global dir. Now the walk falls back
    // to the start dir instead.
    assert.equal(findProjectRoot(stray), stray);
    assert.equal(findProjectRoot(home), home);
  });

  it("ignores a stale ~/.understudy/config.json instead of claiming a project", () => {
    writeFileSync(
      join(home, ".understudy", "config.json"),
      `${JSON.stringify({ org_id: "org_stale", project_slug: "rehearsal" })}\n`,
    );
    // From $HOME itself the fallback root is $HOME, but the global
    // config.json must read as "no project".
    assert.equal(readProjectConfig(home), null);
    // From a dir under $HOME with no marker, the walk no longer reaches
    // the stale file at all.
    const stray = join(home, "Documents");
    mkdirSync(stray, { recursive: true });
    assert.equal(readProjectConfig(stray), null);
  });

  it("refuses to write project config into the global config dir", () => {
    const globalPath = join(home, ".understudy", "config.json");
    assert.ok(isGlobalProjectConfigPath(globalPath));
    assert.throws(
      () =>
        writeProjectConfig(globalPath, {
          org_id: "org_x",
          project_slug: "some-project",
        }),
      /global Understudy config dir/,
    );
    assert.ok(!existsSync(globalPath));

    // A real project path is untouched by the guard.
    const project = join(home, "code", "my-app");
    mkdirSync(project, { recursive: true });
    const projectPath = join(project, ".understudy", "config.json");
    assert.ok(!isGlobalProjectConfigPath(projectPath));
    writeProjectConfig(projectPath, {
      org_id: "org_x",
      project_slug: "some-project",
    });
    const written = JSON.parse(readFileSync(projectPath, "utf8"));
    assert.equal(written.project_slug, "some-project");
    assert.deepEqual(readProjectConfig(project), {
      org_id: "org_x",
      project_slug: "some-project",
    });
  });
});
