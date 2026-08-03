import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadSystemPrompt } from "../experiments/domain-identification-repair/prompt-loader.mjs";

/**
 * The loader must return the file's exact bytes so the GEPA adapter and the
 * canonical rollout feed the student a byte-identical system prompt. Any trim
 * or newline normalization would desync the two paths and void a parity run.
 */
function writeTemp(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "di-prompt-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("loadSystemPrompt exact-bytes fidelity", () => {
  it("preserves leading and trailing whitespace verbatim", () => {
    const raw = "   leading and trailing spaces \t  ";
    assert.equal(loadSystemPrompt(writeTemp("ws.txt", raw)), raw);
  });

  it("preserves a final trailing newline (no stripping)", () => {
    const raw = "line one\nline two\n";
    const out = loadSystemPrompt(writeTemp("nl.txt", raw));
    assert.equal(out, raw);
    assert.ok(out.endsWith("\n"), "trailing newline must survive");
  });

  it("does NOT normalize CRLF to LF", () => {
    const raw = "windows\r\nline\r\nendings\r\n";
    const out = loadSystemPrompt(writeTemp("crlf.txt", raw));
    assert.equal(out, raw);
    assert.ok(out.includes("\r\n"), "CRLF must be preserved, not folded to LF");
  });

  it("preserves Unicode content byte-for-byte", () => {
    const raw = "policy — café ☕ 日本語 \u00a0 zero\u200bwidth";
    assert.equal(loadSystemPrompt(writeTemp("unicode.txt", raw)), raw);
  });

  it("returns an empty string for an empty file (no synthesized content)", () => {
    assert.equal(loadSystemPrompt(writeTemp("empty.txt", "")), "");
  });
});
