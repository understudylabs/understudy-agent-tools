import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  configuredPrivateTerms,
  parsePrivateTerms,
  validatePublicPath,
  validatePublicText,
} from "../scripts/public-safety.mjs";

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "understudy-public-safety-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function writeFixture(t, relativePath, text) {
  const path = join(temporaryRoot(t), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test("private terms are parsed from private, newline-delimited input", () => {
  assert.deepEqual(
    parsePrivateTerms(" ExampleTenant\nexampletenant\r\nExample Partner\n\n"),
    ["ExampleTenant", "Example Partner"],
  );
  assert.deepEqual(
    configuredPrivateTerms({ UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS: "One\nTwo" }),
    ["One", "Two"],
  );
  assert.deepEqual(configuredPrivateTerms({}), []);
});

test("mixed-case private terms are detected in CSS without leaking the term", (t) => {
  const privateTerms = ["ExampleTenant"];
  const path = writeFixture(t, "theme.css", '.brand::after { content: "eXaMpLeTeNaNt"; }');
  const errors = validatePublicText(path, { privateTerms });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /contains private review term/);
  assert.doesNotMatch(errors[0], /exampletenant/i);
});

test("private terms are detected and redacted in tracked paths", () => {
  const privateTerms = ["ExampleTenant"];
  const errors = validatePublicPath("apps/EXAMPLETENANT/theme.css", { privateTerms });

  assert.deepEqual(errors, ["apps/[private-term]/theme.css: path contains private review term"]);
});

test("short private terms fail closed inside concatenated aliases", (t) => {
  const privateTerms = ["Acme"];
  const path = writeFixture(t, "notes.txt", "Use acmebot and getAcmeData.");

  assert.equal(validatePublicText(path, { privateTerms }).length, 1);
});

test("single-token terms catch concatenated aliases at identifier edges", () => {
  const privateTerms = ["ExampleTenant"];

  assert.equal(validatePublicPath("apps/exampletenantbot/page.tsx", { privateTerms }).length, 1);
  assert.equal(validatePublicPath("apps/myexampletenant/page.tsx", { privateTerms }).length, 1);
  assert.equal(validatePublicPath("apps/myexampletenantbot/page.tsx", { privateTerms }).length, 1);
  assert.equal(validatePublicPath("apps/getExampleTenantData.ts", { privateTerms }).length, 1);
  assert.equal(validatePublicPath("apps/myexaMpletenantbot.ts", { privateTerms }).length, 1);
  assert.equal(validatePublicPath("apps/myexampleTenantbot.ts", { privateTerms }).length, 1);
});

test("an explicit known-safe identifier can contain a private-term coincidence", () => {
  assert.deepEqual(validatePublicPath("apps/producedArtifact.ts", { privateTerms: ["Darti"] }), []);
  assert.equal(
    validatePublicPath("apps/producedArtifact.ts", { privateTerms: ["producedArtifact"] }).length,
    1,
  );
});

test("phrases and path fragments are matched literally and case-insensitively", (t) => {
  const privateTerms = ["Example Partner", "/private/example/"];
  const path = writeFixture(t, "notes.txt", "Notes for EXAMPLE PARTNER.");

  assert.equal(validatePublicText(path, { privateTerms }).length, 1);
  assert.equal(validatePublicPath("docs/PRIVATE/EXAMPLE/run.md", { privateTerms }).length, 1);
});

test("symlink text is scanned without following the target", (t) => {
  const privateTerms = ["ExampleTenant"];
  const root = temporaryRoot(t);
  const path = join(root, "fixture-link");
  symlinkSync("../ExampleTenant/private", path);

  assert.equal(validatePublicText(path, { privateTerms }).length, 1);
});

test("repository scanning handles newline-delimited tracked paths", (t) => {
  const root = temporaryRoot(t);
  const privateTerm = "ExampleTenant";
  const path = join(root, `line\n${privateTerm}.css`);
  writeFileSync(path, "synthetic fixture");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "--", path], { cwd: root }).status, 0);

  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "validate-public-skills.mjs"), "--repo", "--docs"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS: privateTerm },
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /path contains private review term/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /exampletenant/i);
});

test("built-in secret, raw-payload, and production URL checks remain active", (t) => {
  const marker = ["raw", "prompt"].join("_");
  const productionUrl = ["https://app", "understudylabs.com"].join(".");
  const secret = `sk-${"A".repeat(24)}`;
  const path = writeFixture(t, "unsafe.fixture", `${secret}\n${marker}\n${productionUrl}\n`);
  const errors = validatePublicText(path, { privateTerms: [] });

  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.includes("secret-shaped")));
  assert.ok(errors.some((error) => error.includes("raw payload")));
  assert.ok(errors.some((error) => error.includes("production/control-plane URL")));

  const readableSlug = writeFixture(t, "safe.fixture", "understudy-task-model-renamed-installs");
  assert.deepEqual(validatePublicText(readableSlug, { privateTerms: [] }), []);
});
