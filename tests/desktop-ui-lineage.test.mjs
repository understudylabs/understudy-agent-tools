import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../apps/homescreen/app/globals.css", import.meta.url);
const chatPath = new URL("../apps/homescreen/app/components/ChatPane.tsx", import.meta.url);
const sidebarPath = new URL("../apps/homescreen/app/components/Sidebar.tsx", import.meta.url);

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
