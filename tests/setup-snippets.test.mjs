import assert from "node:assert/strict";
import test from "node:test";

import {
  BYOK_PROVIDERS,
  DEFAULT_GATEWAY_URL,
  buildByokCurlSnippet,
  buildByokEnvSnippet,
  buildByokSdkSnippet,
  buildManagedCurlSnippet,
  buildManagedEnvSnippet,
  buildManagedSdkSnippet,
  maskSecret,
  pickDefaultProjectSlug,
} from "../apps/homescreen/app/lib/setup-snippets.mjs";

test("byok curl carries auth, upstream key, scope headers and version", () => {
  const curl = buildByokCurlSnippet({
    provider: "anthropic",
    projectSlug: "acme",
    workloadName: "checkout",
  });
  assert.ok(curl.startsWith(`curl ${DEFAULT_GATEWAY_URL}/v1/messages \\`));
  assert.match(curl, /x-api-key: \$UNDERSTUDY_API_KEY/);
  assert.match(curl, /x-understudy-upstream-key: \$ANTHROPIC_API_KEY/);
  assert.match(curl, /x-understudy-project: acme/);
  assert.match(curl, /x-understudy-workload: checkout/);
  assert.match(curl, /anthropic-version: 2023-06-01/);

  const openai = buildByokCurlSnippet({ provider: "openai" });
  assert.match(openai, /Authorization: Bearer \$UNDERSTUDY_API_KEY/);
  assert.doesNotMatch(openai, /anthropic-version/);
  // No project selected: header omitted, workload falls back to `main`.
  assert.doesNotMatch(openai, /x-understudy-project/);
  assert.match(openai, /x-understudy-workload: main/);
});

test("managed snippets need only the sk_* key and target the catalog surface", () => {
  const curl = buildManagedCurlSnippet({
    modelId: "gemma-4-e2b",
    projectSlug: "acme",
  });
  assert.match(curl, /\/v1\/chat\/completions/);
  assert.match(curl, /"model":"gemma-4-e2b"/);
  assert.doesNotMatch(curl, /upstream-key/);

  const sdk = buildManagedSdkSnippet({ modelId: "gemma-4-e2b" });
  assert.match(sdk, /baseURL: "https:\/\/api\.understudylabs\.com\/v1"/);
  assert.match(sdk, /"x-understudy-workload": "main"/);
});

test("gateway base URL is parameterized and trailing slashes normalized", () => {
  const curl = buildManagedCurlSnippet({
    modelId: "m",
    baseUrl: "https://gw.example/",
  });
  assert.ok(curl.startsWith("curl https://gw.example/v1/chat/completions"));
  const sdk = buildByokSdkSnippet({
    provider: "anthropic",
    baseUrl: "https://gw.example",
  });
  assert.match(sdk, /baseURL: "https:\/\/gw\.example"/);
  const openaiSdk = buildByokSdkSnippet({
    provider: "openai",
    baseUrl: "https://gw.example",
  });
  assert.match(openaiSdk, /baseURL: "https:\/\/gw\.example\/v1"/);
});

test("env snippets interpolate a pasted key verbatim, else a placeholder", () => {
  assert.match(
    buildByokEnvSnippet("anthropic"),
    /UNDERSTUDY_API_KEY="sk_live_\.\.\."/,
  );
  assert.match(
    buildByokEnvSnippet("openai", "sk_real_key"),
    /UNDERSTUDY_API_KEY="sk_real_key"/,
  );
  assert.match(buildByokEnvSnippet("openai"), /OPENAI_API_KEY="sk-proj-\.\.\."/);
  assert.equal(
    buildManagedEnvSnippet("  "),
    'export UNDERSTUDY_API_KEY="sk_live_..."',
  );
});

test("byok sdk snippet includes project header only when scoped", () => {
  const scoped = buildByokSdkSnippet({ provider: "openai", projectSlug: "p1" });
  assert.match(scoped, /"x-understudy-project": "p1"/);
  const unscoped = buildByokSdkSnippet({ provider: "openai" });
  assert.doesNotMatch(unscoped, /x-understudy-project/);
});

test("maskSecret shows only the last four characters", () => {
  assert.equal(maskSecret("sk_live_abcdef"), "•••• cdef");
  assert.equal(maskSecret("   "), "");
});

test("pickDefaultProjectSlug prefers rehearsal, then legacy main, then first", () => {
  const projects = [{ slug: "z" }, { slug: "main" }, { slug: "rehearsal" }];
  assert.equal(pickDefaultProjectSlug(projects, null), "rehearsal");
  assert.equal(
    pickDefaultProjectSlug([{ slug: "z" }, { slug: "main" }], null),
    "main",
  );
  assert.equal(pickDefaultProjectSlug([{ slug: "z" }], null), "z");
  assert.equal(pickDefaultProjectSlug(projects, "z"), "z");
  assert.equal(pickDefaultProjectSlug([], "ghost"), "");
});

test("provider registry stays two-provider and label-stable", () => {
  assert.deepEqual(Object.keys(BYOK_PROVIDERS), ["anthropic", "openai"]);
  assert.equal(BYOK_PROVIDERS.anthropic.label, "Anthropic");
  assert.equal(BYOK_PROVIDERS.openai.label, "OpenAI");
});
