import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Command } from "commander";

import { registerLoginCommand } from "../dist/commands/login.js";

let root;

describe("login command telemetry", () => {
  let previousHome;
  let previousUserProfile;
  let previousTelemetry;
  let previousApiKey;
  let previousGatewayUrl;
  let previousFetch;
  let previousStdoutWrite;
  let previousExitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-login-command-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousTelemetry = process.env.UNDERSTUDY_TELEMETRY;
    previousApiKey = process.env.UNDERSTUDY_API_KEY;
    previousGatewayUrl = process.env.UNDERSTUDY_GATEWAY_URL;
    previousFetch = globalThis.fetch;
    previousStdoutWrite = process.stdout.write;
    previousExitCode = process.exitCode;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.UNDERSTUDY_TELEMETRY;
    // Ambient credentials (a developer's shell, a CI secret) change which
    // telemetry the login path emits — keep the test hermetic.
    delete process.env.UNDERSTUDY_API_KEY;
    delete process.env.UNDERSTUDY_GATEWAY_URL;
    process.exitCode = undefined;
    process.stdout.write = () => true;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousTelemetry === undefined) delete process.env.UNDERSTUDY_TELEMETRY;
    else process.env.UNDERSTUDY_TELEMETRY = previousTelemetry;
    if (previousApiKey === undefined) delete process.env.UNDERSTUDY_API_KEY;
    else process.env.UNDERSTUDY_API_KEY = previousApiKey;
    if (previousGatewayUrl === undefined) delete process.env.UNDERSTUDY_GATEWAY_URL;
    else process.env.UNDERSTUDY_GATEWAY_URL = previousGatewayUrl;
    globalThis.fetch = previousFetch;
    process.stdout.write = previousStdoutWrite;
    process.exitCode = previousExitCode;
    rmSync(root, { recursive: true, force: true });
  });

  it("emits login completion from the manual login command path", async () => {
    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init.body)),
      });
      return new Response(null, { status: 204 });
    };

    const program = new Command();
    registerLoginCommand(program);

    await program.parseAsync(
      [
        "login",
        "--api-key",
        "sk_new_login_key",
        "--org",
        "org_TEST",
        "--project",
        "default",
        "--gateway-url",
        "https://api.understudylabs.test",
        "--signup-intent-id",
        "si_login",
      ],
      { from: "user" },
    );

    assert.equal(process.exitCode, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.understudylabs.test/v1/agent/events");
    assert.equal(requests[0].body.event_name, "cli_login_completed");
    assert.equal(requests[0].body.properties.mode, "manual");
    assert.equal(requests[0].body.properties.org_id, "org_TEST");
    assert.equal(requests[0].body.properties.signup_intent_id, "si_login");
  });
});
