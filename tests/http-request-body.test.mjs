import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import { request } from "../dist/internal/http.js";

test("request preserves JSON transport and keeps raw FormData caller-owned", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-http-body-"));
  const previousKey = process.env.UNDERSTUDY_API_KEY;
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.UNDERSTUDY_API_KEY = "sk_synthetic";
    process.env.HOME = root;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const schema = z.object({ ok: z.literal(true) });
    await request({
      method: "POST",
      url: "https://api.example.test/json",
      orgId: "org_synthetic",
      body: { answer: 42 },
    }, schema);
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.body, JSON.stringify({ answer: 42 }));

    const form = new FormData();
    form.append("manifest", new Blob(["{}"], { type: "application/json" }), "manifest.json");
    await request({
      method: "POST",
      url: "https://api.example.test/form",
      orgId: "org_synthetic",
      rawBody: form,
    }, schema);
    assert.equal(calls[1].init.body, form);
    assert.equal(Object.keys(calls[1].init.headers).some((name) => name.toLowerCase() === "content-type"), false);

    await assert.rejects(() => request({
      method: "POST",
      url: "https://api.example.test/invalid",
      orgId: "org_synthetic",
      body: { answer: 42 },
      rawBody: form,
    }, schema), /mutually exclusive/i);
    assert.equal(calls.length, 2, "invalid mixed bodies must reject before fetch");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.UNDERSTUDY_API_KEY;
    else process.env.UNDERSTUDY_API_KEY = previousKey;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
