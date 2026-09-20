import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readCredentials, writeCredentials } from "../dist/config/credentials.js";

describe("credentials management", () => {
  let home;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "understudy-credentials-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".understudy"), { recursive: true });
    assert.equal(homedir(), home);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when credentials.json does not exist", () => {
    assert.equal(readCredentials(), null);
  });

  it("writes and reads credentials cleanly without stderr warnings", () => {
    let stderrOutput = "";
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk.toString();
      return true;
    };

    try {
      const creds = {
        api_key: "sk-test-12345",
        gateway_url: "https://api.understudy.ai",
        orgs: {
          org_default: {
            api_key: "sk-test-12345",
            gateway_url: "https://api.understudy.ai",
          },
        },
      };

      writeCredentials(creds);
      const read = readCredentials();

      assert.deepEqual(read, creds);
      assert.equal(stderrOutput, "");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });
});
