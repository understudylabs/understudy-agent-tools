import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  readDesktopCapability,
  runDesktopE2EHarness,
} from "../scripts/desktop-e2e-harness.mjs";
import { repositoryRoot } from "../scripts/desktop-release-plan.mjs";

function writeExpenseCsv(path) {
  const categories = ["meals", "travel", "office_supplies"];
  const rows = ["merchant,description,amount,category"];
  for (let index = 0; index < 75; index += 1) {
    const category = categories[index % categories.length];
    const groupIndex = Math.floor(index / categories.length);
    const merchantSuffix = `${String.fromCharCode(97 + Math.floor(groupIndex / 26))}${String.fromCharCode(97 + (groupIndex % 26))}`;
    rows.push(`${category}-merchant-${merchantSuffix},synthetic expense ${index},${10 + index}.25,${category}`);
  }
  writeFileSync(path, `${rows.join("\n")}\n`);
}

test("Desktop E2E help is zero-exit and states its real native-UI coverage limits", () => {
  const result = spawnSync(process.execPath, ["scripts/desktop-e2e-harness.mjs", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--mode fake\s+Default\. Use a local Desktop API test double/);
  assert.match(result.stdout, /--mode real\s+Connect to or launch the real Desktop API/);
  assert.match(result.stdout, /does not synthesize native Tauri/);
  assert.match(result.stdout, /drag\/drop events or assert Rive animation\/rendered pixels/);
  assert.equal(result.stderr, "");
});

test("Desktop E2E harness prepares identical private splits through fake and launched API modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-desktop-e2e-"));
  const csv = join(root, "expenses.csv");
  writeExpenseCsv(csv);
  try {
    const fake = await runDesktopE2EHarness({
      mode: "fake",
      csvPath: csv,
      outputRoot: join(root, "fake-run"),
      labelColumn: "category",
      groupColumn: "merchant",
      inputColumns: ["merchant", "description", "amount"],
    });
    assert.equal(fake.ok, true, fake.errors.join("\n"));
    assert.equal(fake.terminal_state, "ready");
    assert.equal(fake.validation_level, "desktop-api-test-double");
    assert.equal(fake.coverage.production_cli_dataset_preparation, true);
    assert.equal(fake.coverage.native_drag_event, false);
    assert.equal(fake.source.raw_rows_embedded_in_report, false);
    assert.equal(fake.cleanup.capability_removed, true);
    assert.equal(existsSync(join(root, "fake-run", "home", ".understudy", "desktop-api.json")), false);

    const launched = await runDesktopE2EHarness({
      mode: "real",
      csvPath: csv,
      outputRoot: join(root, "launched-run"),
      appCommand: [process.execPath, resolve("tests/fixtures/desktop-api-test-app.mjs")],
      labelColumn: "category",
      groupColumn: "merchant",
      inputColumns: ["merchant", "description", "amount"],
    });
    assert.equal(launched.ok, true, launched.errors.join("\n"));
    assert.equal(launched.validation_level, "real-desktop-api");
    assert.equal(launched.desktop_api.app_version, "fixture-app");
    assert.equal(launched.cleanup.launched_process_stopped, true);
    assert.equal(launched.cleanup.capability_removed, true);

    assert.equal(fake.dataset.dataset_id, launched.dataset.dataset_id);
    assert.equal(fake.dataset.mapping_sha256, launched.dataset.mapping_sha256);
    for (const split of ["train", "dev", "holdout"]) {
      assert.equal(fake.dataset.splits[split].sha256, launched.dataset.splits[split].sha256);
      assert.ok(fake.dataset.splits[split].row_count > 0);
    }
    assert.deepEqual(
      fake.states.map((state) => state.state),
      ["idle", "launching", "connected", "validating", "compiling", "inspecting", "preparing", "ready"],
    );
    const persisted = JSON.parse(readFileSync(join(root, "fake-run", "report.json"), "utf8"));
    assert.equal(persisted.dataset.dataset_id, fake.dataset.dataset_id);
    assert.doesNotMatch(JSON.stringify(persisted), /desktop-api-test-token|authorization|bearer/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop E2E harness accepts the extensionless tabular shape used by public UCI datasets", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-desktop-e2e-tabular-"));
  const source = join(root, "SMSSpamCollection");
  const rows = Array.from({ length: 48 }, (_, index) => {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    return `${index % 2 === 0 ? "ham" : "spam"}\tmessage token ${first}${second} for local classification`;
  });
  writeFileSync(source, `${rows.join("\n")}\n`);
  try {
    const report = await runDesktopE2EHarness({
      mode: "fake",
      csvPath: source,
      outputRoot: join(root, "run"),
      acceptRecommendedMapping: true,
    });
    assert.equal(report.ok, true, report.errors.join("\n"));
    assert.equal(report.terminal_state, "ready");
    assert.deepEqual(report.dataset.mapping, {
      input_columns: ["text"],
      label_column: "label",
      group_column: "text",
      text_template: "named-fields-v1",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop E2E harness stops honestly when the CSV has too little repeated signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-desktop-e2e-small-"));
  try {
    const report = await runDesktopE2EHarness({
      mode: "fake",
      csvPath: resolve("tests/fixtures/expense-categories.csv"),
      outputRoot: root,
      labelColumn: "category",
      groupColumn: "merchant",
      inputColumns: ["merchant", "description"],
    });
    assert.equal(report.ok, false);
    assert.equal(report.terminal_state, "blocked");
    assert.equal(report.dataset, null);
    assert.match(report.errors.join("\n"), /smallest class|collect at least/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop E2E harness rejects a stale capability before calling its API", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-desktop-e2e-stale-capability-"));
  const capability = join(root, "desktop-api.json");
  try {
    writeFileSync(capability, `${JSON.stringify({
      schema_version: "understudy.desktop_api.v2",
      base_url: "http://127.0.0.1:17790",
      pid: 2_147_483_647,
      app_version: "fixture",
      token: "a".repeat(64),
    })}\n`, { mode: 0o600 });
    assert.throws(() => readDesktopCapability(capability), /capability is stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
