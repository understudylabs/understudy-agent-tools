import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../apps/homescreen/app/globals.css", import.meta.url);
const chatPath = new URL("../apps/homescreen/app/components/ChatPane.tsx", import.meta.url);
const sidebarPath = new URL("../apps/homescreen/app/components/Sidebar.tsx", import.meta.url);
const pagePath = new URL("../apps/homescreen/app/page.tsx", import.meta.url);
const runtimeRepairPromptPath = new URL(
  "../apps/homescreen/app/components/RuntimeRepairPrompt.tsx",
  import.meta.url,
);
const runtimeRepairLibPath = new URL(
  "../apps/homescreen/app/lib/runtime-repair.ts",
  import.meta.url,
);
const parityPath = new URL("../docs/desktop-product-parity.json", import.meta.url);

test("public desktop preserves the reviewed Train interaction language", async () => {
  const [css, chat, sidebar] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(chatPath, "utf8"),
    readFile(sidebarPath, "utf8"),
  ]);

  assert.match(css, /understudy-agent@3f025022/);
  assert.match(css, /--mb-cyan:\s*#67e8f9/);
  assert.match(css, /--mb-mint:\s*#9edbd3/);
  assert.match(css, /\.composer-row\s*\{/);
  assert.match(css, /\.persona-halo\.supervised/);
  assert.match(chat, /className="composer-row"/);
  assert.match(
    chat,
    /Tried to hand off to a larger cloud model, but it is unavailable\. Continuing with the local model\./,
  );
  assert.match(chat, /msg\.stage === "cloud_fallback_local"/);

  const serving = sidebar.match(
    /const SERVING_NAV:[\s\S]*?= \[([\s\S]*?)\n\];/,
  )?.[1];
  assert.ok(serving, "SERVING_NAV remains statically auditable");
  assert.match(serving, /label: "Chat"/);
  assert.match(serving, /label: "Status"/);
  assert.match(serving, /label: "Models"/);
  assert.match(serving, /label: "Experiments"/);
  assert.doesNotMatch(serving, /label: "Capture"/);
  assert.doesNotMatch(serving, /label: "Traces"/);
  assert.doesNotMatch(serving, /label: "Usage"/);
});

test("desktop has one managed runtime repair surface", async () => {
  const [page, prompt, repair] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(runtimeRepairPromptPath, "utf8"),
    readFile(runtimeRepairLibPath, "utf8"),
  ]);

  assert.match(page, /<RuntimeRepairPrompt\s*\/>/);
  assert.match(prompt, /invoke<DesktopHealth>\("desktop_health"\)/);
  assert.match(prompt, /listen<RuntimeRepairRequest>\("runtime-repair-needed"/);
  assert.match(prompt, /"install_understudy_agent_tools"/);
  assert.match(prompt, /"install_mlx_runtime"/);
  assert.match(prompt, /"conversation_runtime_repair"/);
  assert.match(repair, /understudy models runtime repair/);
  assert.match(repair, /understudy runtime repair/);
  assert.match(repair, /install\.sh \| bash -s -- --yes/);
  assert.doesNotMatch(repair, /understudy update/);
});

test("desktop migration claims stay tied to explicit product parity", async () => {
  const parity = JSON.parse(await readFile(parityPath, "utf8"));
  assert.equal(parity.release_authority, "apps/homescreen");
  assert.equal(parity.legacy_desktop_policy, "extraction_only");
  const ids = parity.features.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, "parity feature ids must remain unique");
  for (const required of [
    "offline-supervisor-fallback",
    "runtime-repair-experience",
    "supervision-review-desk",
    "correction-pair-export-and-metrics",
    "unified-experiment-hub",
    "native-runtime-deletion",
  ]) {
    assert.ok(ids.includes(required), `parity manifest is missing ${required}`);
  }
  assert.equal(
    parity.features.find((feature) => feature.id === "runtime-repair-experience")?.status,
    "shipped",
  );
  for (const feature of parity.features) {
    assert.ok(parity.status_values.includes(feature.status), `${feature.id} has an unknown status`);
    assert.ok(feature.evidence.length > 20, `${feature.id} needs concrete evidence`);
  }
  const actuallyComplete = parity.features.every((feature) =>
    ["shipped", "retired"].includes(feature.status),
  );
  assert.equal(parity.migration_complete, actuallyComplete);
});
