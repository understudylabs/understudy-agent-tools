import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  trackRunCompleted,
  trackSetupCompleted,
  trackStatusChecked,
} from "../dist/internal/telemetry.js";

let root;

describe("CLI telemetry", () => {
  let previousHome;
  let previousUserProfile;
  let previousTelemetry;
  let previousFetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-telemetry-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousTelemetry = process.env.UNDERSTUDY_TELEMETRY;
    previousFetch = globalThis.fetch;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.UNDERSTUDY_TELEMETRY;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousTelemetry === undefined) delete process.env.UNDERSTUDY_TELEMETRY;
    else process.env.UNDERSTUDY_TELEMETRY = previousTelemetry;
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("sends authenticated CLI events to the platform endpoint without secret properties", async () => {
    writeCredentials({
      api_key: "sk_test_telemetry",
      gateway_url: "https://api.understudylabs.test",
      user_id: "user_01TEST",
      signup_intent_id: "si_123",
      orgs: {},
    });

    const requests = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: init.headers,
        body: JSON.parse(String(init.body)),
      });
      return new Response(null, { status: 204 });
    };

    await trackRunCompleted({
      apiKey: "sk_test_telemetry",
      gatewayUrl: "https://api.understudylabs.test",
      commandKind: "sk_should_not_send",
      orgId: null,
      projectSlug: null,
      authSource: "stored",
      exitCode: 0,
      durationMs: 123,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.understudylabs.test/v1/agent/events");
    assert.equal(requests[0].headers.authorization, "Bearer sk_test_telemetry");
    assert.equal(requests[0].body.event_name, "cli_run_completed");
    assert.equal(requests[0].body.event_version, 1);
    assert.equal(requests[0].body.properties.app, "understudy_cli");
    assert.equal(requests[0].body.properties.user_id, "user_01TEST");
    assert.equal(requests[0].body.properties.signup_intent_id, "si_123");
    assert.equal(requests[0].body.properties.exit_code, 0);
    assert.equal(requests[0].body.properties.duration_ms, 123);
    assert.ok(!JSON.stringify(requests[0].body.properties).includes("sk_should_not_send"));
  });

  it("uses growth-oriented event names for status checks", async () => {
    writeCredentials({
      api_key: "sk_test_telemetry",
      gateway_url: "https://api.understudylabs.test",
      orgs: {},
    });

    const events = [];
    globalThis.fetch = async (_input, init) => {
      events.push(JSON.parse(String(init.body)).event_name);
      return new Response(null, { status: 204 });
    };

    trackStatusChecked({ configured: true, signedIn: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(events, ["cli_activation_status_checked"]);
  });

  it("does nothing when telemetry is disabled", async () => {
    process.env.UNDERSTUDY_TELEMETRY = "0";
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response(null, { status: 204 });
    };

    await trackSetupCompleted({
      skill: "understudy-onboard",
      global: false,
      referenceCount: 4,
    });

    assert.equal(called, false);
  });
});

function writeCredentials(credentials) {
  const dir = join(root, ".understudy");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "credentials.json");
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`);
  chmodSync(path, 0o600);
}
