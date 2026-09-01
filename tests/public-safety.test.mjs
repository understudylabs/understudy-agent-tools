import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  configuredPrivateTermPolicy,
  configuredPrivateTerms,
  parsePrivateTermPolicy,
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

function environmentWithoutPrivateTermPolicy() {
  const environment = { ...process.env };
  delete environment.UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS;
  return environment;
}

test("private term policy is parsed from private, newline-delimited input", () => {
  const configuredValue = [
    " ExamplePrivateTerm\tSyntheticExamplePrivateTermContainer\tSYNTHETICEXAMPLEPRIVATETERMCONTAINER",
    "exampleprivateterm\tAnotherExamplePrivateTermContainer",
    "PlainPrivateTerm",
    "",
  ].join("\r\n");

  assert.deepEqual(
    parsePrivateTermPolicy(configuredValue),
    [
      {
        term: "ExamplePrivateTerm",
        safeEnclosingTokens: [
          "SyntheticExamplePrivateTermContainer",
          "AnotherExamplePrivateTermContainer",
        ],
      },
      { term: "PlainPrivateTerm", safeEnclosingTokens: [] },
    ],
  );
  assert.deepEqual(
    configuredPrivateTermPolicy({ UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS: configuredValue }),
    parsePrivateTermPolicy(configuredValue),
  );
  assert.deepEqual(parsePrivateTerms(configuredValue), ["ExamplePrivateTerm", "PlainPrivateTerm"]);
  assert.deepEqual(
    configuredPrivateTerms({ UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS: "One\nTwo" }),
    ["One", "Two"],
  );
  assert.deepEqual(configuredPrivateTermPolicy({}), []);
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

test("configured safe enclosing tokens are literal, case-insensitive, strict substrings", () => {
  const privateTermPolicy = parsePrivateTermPolicy(
    "ExamplePrivateTerm\tSyntheticExamplePrivateTermContainer\tExamplePrivateTerm",
  );

  assert.deepEqual(
    validatePublicPath("apps/SYNTHETICEXAMPLEPRIVATETERMCONTAINER.ts", { privateTermPolicy }),
    [],
  );
  assert.equal(
    validatePublicPath("apps/ExamplePrivateTerm.ts", { privateTermPolicy }).length,
    1,
  );
  assert.equal(
    validatePublicPath("apps/UnlistedExamplePrivateTermContainer.ts", {
      privateTermPolicy,
    }).length,
    1,
  );
  assert.deepEqual(
    validatePublicPath("apps/PrefixSyntheticExamplePrivateTermContainerSuffix.ts", {
      privateTermPolicy,
    }),
    [],
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
  const safeToken = `Synthetic${privateTerm}Container`;
  const safePath = join(root, `${safeToken}.css`);
  writeFileSync(path, "synthetic fixture");
  writeFileSync(safePath, "synthetic fixture");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "--", path, safePath], { cwd: root }).status, 0);

  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "validate-public-skills.mjs"), "--repo", "--docs"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS: `${privateTerm}\t${safeToken}`,
      },
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /path contains private review term/);
  assert.equal(result.stdout.match(/path contains private review term/g)?.length, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /exampletenant/i);
});

test("release-mode scanners fail closed without a private term policy", (t) => {
  const root = temporaryRoot(t);
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const environment = environmentWithoutPrivateTermPolicy();

  for (const script of ["validate-public-skills.mjs", "package-smoke.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", script), "--release"],
      { cwd: root, encoding: "utf8", env: environment },
    );

    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /--release requires UNDERSTUDY_PUBLIC_SAFETY_PRIVATE_TERMS to contain at least one private term/,
    );
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /npm pack|not a git repository|ENOENT/i);
  }
});

test("ordinary scanners keep the informational skip without a private term policy", (t) => {
  const root = temporaryRoot(t);
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const environment = environmentWithoutPrivateTermPolicy();
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);

  const validator = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "validate-public-skills.mjs"), "--repo", "--docs"],
    { cwd: root, encoding: "utf8", env: environment },
  );
  assert.equal(validator.status, 0, validator.stderr);
  assert.match(validator.stdout, /private-term checks were skipped/);
  assert.match(validator.stdout, /ok 0 public skill\(s\)/);

  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  const packageFiles = [
    { path: "dist/bin.js", mode: 0o755 },
    { path: ".agents/plugins/marketplace.json" },
    { path: ".codex-plugin/plugin.json" },
    { path: ".cursor-plugin/plugin.json" },
    { path: ".opencode/adapter.json" },
    { path: ".opencode/commands/understudy-onboard.md" },
    { path: ".hermes/adapter.json" },
    { path: "skills/install-agent-adapter/SKILL.md" },
    { path: "skills/install-agent-adapter/reference.md" },
    { path: "skills/local-distillation-lab/SKILL.md" },
    { path: "skills/local-distillation-lab/references/pedagogical-arm.md" },
    { path: "skills/recursive-language-model/SKILL.md" },
    { path: "skills/recursive-language-model/references/pedagogical-training.md" },
  ];
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify([{ files: packageFiles }]))});\n`,
  );
  chmodSync(fakeNpm, 0o755);

  const packageSmoke = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "package-smoke.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...environment,
        PATH: `${fakeBin}${pathDelimiter}${environment.PATH ?? ""}`,
      },
    },
  );
  assert.equal(packageSmoke.status, 0, packageSmoke.stderr);
  assert.match(packageSmoke.stdout, /private-term checks were skipped/);
  assert.match(packageSmoke.stdout, /ok npm package dry-run/);
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
