import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  BENCHMARK_REVIEW_SCHEMA,
  EVAL_RESULT_SCHEMA,
  RUN_EVENT_SCHEMA,
  appendJournalEntry,
  captureBodyPath,
  captureBodyRelPath,
  captureFileId,
  fromPortablePath,
  isBenchmarkReview,
  journalCalls,
  latestReviewByTask,
  makeBenchmarkReview,
  parseJournalText,
  parseJsonlText,
  readJsonlFile,
  readReviews,
  readRunEvents,
  serializeJournalEntry,
  serializeJsonlLine,
  serializeReviewLine,
  serializeRunEvent,
  toPortablePath,
} from "../dist/benchmark-artifacts.js";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-contracts-"));
  tmpDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* Minimal JSON-Schema-subset validator (type/required/enum/const/     */
/* properties/items) — enough for the understudy.* schemas we check.   */
/* ------------------------------------------------------------------ */
function schemaErrors(schema, value, at = "$") {
  const errors = [];
  if ("const" in schema && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) errors.push(`${at}: expected type ${types.join("|")}, got ${actual}`);
  }
  if (schema.type === "object" || schema.properties || schema.required) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${at}.${key}: required`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value) errors.push(...schemaErrors(sub, value[key], `${at}.${key}`));
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => errors.push(...schemaErrors(schema.items, item, `${at}[${i}]`)));
  }
  return errors;
}
function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.resolve("schemas", name), "utf8"));
}

describe("JSONL codec round-trip (the newline invariant)", () => {
  it("write→read→write is byte-identical, including in-string newlines", () => {
    const rows = [
      { a: 1, text: "line one\nline two\r\nwindows" },
      { schema_version: EVAL_RESULT_SCHEMA, run_id: "r", task_id: "t", split: "dev", score: 0.5, status: "ok" },
      { nested: { deep: ["x", "y\n z"] } },
    ];
    const text = rows.map((row) => serializeJsonlLine(row)).join("");
    // One physical line per row: JSON.stringify escapes raw newlines.
    assert.equal(text.trimEnd().split("\n").length, rows.length);
    const parsed = parseJsonlText(text);
    assert.equal(parsed.skipped, 0);
    assert.deepEqual(parsed.items, rows);
    const rewritten = parsed.items.map((row) => serializeJsonlLine(row)).join("");
    assert.equal(rewritten, text);
  });

  it("is tolerant of blank lines, CRLF, and malformed lines (counted, never fatal)", () => {
    const text = '\r\n{"ok":1}\r\n\nnot json\n{"ok":2}\n';
    const parsed = parseJsonlText(text);
    assert.deepEqual(parsed.items, [{ ok: 1 }, { ok: 2 }]);
    assert.equal(parsed.skipped, 1);
  });

  it("readJsonlFile treats a missing file as empty", () => {
    assert.deepEqual(readJsonlFile(path.join(tmpDir(), "nope.jsonl")), { items: [], skipped: 0 });
  });
});

describe("live journal contract (writer = executor/world.py, reader = hub live route)", () => {
  const entries = [
    { at: 1, kind: "call", tool: "update_ticket", write: true, status: "ok", arguments: JSON.stringify({ id: "T-1", note: "multi\nline" }) },
    { at: 2, kind: "result", tool: "update_ticket", status: "ok", content: '{"ok": true}' },
    { at: 3, kind: "call", tool: "send_email", arguments: { to: "x@y.z" }, status: "error" },
  ];

  it("append→parse→serialize is byte-identical", () => {
    const file = path.join(tmpDir(), "journal.jsonl");
    for (const entry of entries) appendJournalEntry(file, entry);
    const text = fs.readFileSync(file, "utf8");
    const { lines, total } = parseJournalText(text);
    assert.equal(total, entries.length);
    assert.deepEqual(lines, entries);
    assert.equal(lines.map((line) => serializeJournalEntry(line)).join(""), text);
  });

  it("torn tail line is left uncounted for the next poll", () => {
    const text = entries.map((entry) => serializeJournalEntry(entry)).join("") + '{"at": 4, "kind": "ca';
    const { lines, total } = parseJournalText(text);
    assert.equal(lines.length, entries.length);
    assert.equal(total, entries.length);
  });

  it("journalCalls extracts calls with legacy string-arguments tolerance", () => {
    const calls = journalCalls(entries);
    assert.deepEqual(calls, [
      { name: "update_ticket", arguments: { id: "T-1", note: "multi\nline" } },
      { name: "send_email", arguments: { to: "x@y.z" }, status: "error" },
    ]);
    // Unparseable summary strings stay raw (the 800-char cap case).
    assert.deepEqual(journalCalls([{ kind: "call", tool: "t", arguments: '{"truncat' }]), [{ name: "t", arguments: '{"truncat' }]);
  });

  it("appendJournalEntry is best-effort (null path and unwritable path are no-ops)", () => {
    appendJournalEntry(null, entries[0]);
    appendJournalEntry(path.join(tmpDir(), "missing-dir", "journal.jsonl"), entries[0]);
  });
});

describe("reviews.jsonl contract (writer = hub API, readers = hub loader + promote)", () => {
  it("make→serialize→read→serialize is byte-identical and schema-valid", () => {
    const dir = tmpDir();
    const file = path.join(dir, "reviews.jsonl");
    const reviews = [
      makeBenchmarkReview({ benchmark_id: "trace-abc", task_id: "task-1", decision: "accept", created_at: "2026-07-22T00:00:00.000Z" }),
      makeBenchmarkReview({ benchmark_id: "trace-abc", task_id: "task-1", decision: "reject", note: "flaky\ngold", created_at: "2026-07-22T01:00:00.000Z" }),
    ];
    const text = reviews.map((review) => serializeReviewLine(review)).join("");
    fs.writeFileSync(file, text);
    const read = readReviews(file);
    assert.equal(read.skipped, 0);
    assert.deepEqual(read.reviews, reviews);
    assert.equal(read.reviews.map((review) => serializeReviewLine(review)).join(""), text);
    const schema = loadSchema("understudy.benchmark_review.v1.schema.json");
    for (const review of reviews) assert.deepEqual(schemaErrors(schema, review), []);
    // Superseding: newest line per task wins.
    assert.equal(latestReviewByTask(read.reviews)["task-1"].decision, "reject");
  });

  it("drops invalid rows but tolerates producer extras (consumers ignore unknown fields)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "reviews.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ schema_version: "understudy.benchmark_review.v2", task_id: "t", decision: "accept" }),
        JSON.stringify({ schema_version: BENCHMARK_REVIEW_SCHEMA, task_id: "t", decision: "maybe" }),
        JSON.stringify({ schema_version: BENCHMARK_REVIEW_SCHEMA, benchmark_id: "b", task_id: "t", decision: "restrict", note: "", created_at: "x", extra_field: 1 }),
      ].join("\n") + "\n",
    );
    const read = readReviews(file);
    assert.equal(read.reviews.length, 1);
    assert.equal(read.reviews[0].extra_field, 1);
    assert.ok(isBenchmarkReview(read.reviews[0]));
  });
});

describe("run events contract", () => {
  it("serialize→read round-trips and keeps only v1-stamped rows", () => {
    const dir = tmpDir();
    const file = path.join(dir, "events.jsonl");
    const events = [
      { schema_version: RUN_EVENT_SCHEMA, ts: "2026-07-22T00:00:00.000Z", run_id: "run-1", type: "run_started", progress: { completed: 0, total: 2 } },
      { schema_version: RUN_EVENT_SCHEMA, ts: "2026-07-22T00:00:01.000Z", run_id: "run-1", type: "rollout", model: "m", task_id: "t", rollout: 1, score: 1, status: "ok" },
    ];
    fs.writeFileSync(file, events.map((event) => serializeRunEvent(event)).join("") + JSON.stringify({ schema_version: "other" }) + "\n");
    const read = readRunEvents(file);
    assert.deepEqual(read.events, events);
  });
});

describe("capture body naming (foundry writer = hub reader derivation)", () => {
  it("file id, relative path, and absolute path agree", () => {
    const ref = { capture_id: "cap-1", sha256: "ab".repeat(32) };
    const id = captureFileId(ref);
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.equal(captureBodyRelPath(ref), `viewer/data/captures/${id}.json`);
    assert.equal(captureBodyPath("/bench/dir", ref), path.join("/bench/dir", "viewer", "data", "captures", `${id}.json`));
  });
});

describe("portable recorded paths", () => {
  it("round-trips inside the benchmark dir with POSIX separators", () => {
    const base = tmpDir();
    const target = path.join(base, "viewer", "index.html");
    const recorded = toPortablePath(base, target);
    assert.equal(recorded, "viewer/index.html");
    assert.equal(fromPortablePath(base, recorded), target);
    assert.equal(toPortablePath(base, base), ".");
  });

  it("keeps escaping targets absolute and passes legacy absolute paths through", () => {
    const base = tmpDir();
    const outside = path.resolve(base, "..", "elsewhere.json");
    assert.equal(toPortablePath(base, outside), outside);
    assert.equal(fromPortablePath(base, "/legacy/absolute/path.json"), "/legacy/absolute/path.json");
  });
});

describe("schema drift: current writer output validates against schemas/", () => {
  it("run-executor eval rows match understudy.eval_result.v1", () => {
    // The exact row shape executeRunRequest appends (extension fields allowed).
    const row = {
      schema_version: EVAL_RESULT_SCHEMA,
      run_id: "run-1",
      task_id: "task-1",
      split: "dev",
      score: 1,
      subscores: { final_state_partial_credit: 1 },
      status: "ok",
      model: "oracle",
      route: null,
      latency_ms: 12,
      cost: null,
      created_at: "2026-07-22T00:00:00.000Z",
      benchmark_id: "bench-1",
      category_id: null,
      rollout: 1,
      writes: [],
    };
    assert.deepEqual(schemaErrors(loadSchema("understudy.eval_result.v1.schema.json"), row), []);
  });

  it("hub review writer output matches understudy.benchmark_review.v1", () => {
    const review = makeBenchmarkReview({ benchmark_id: "trace-abc", task_id: "t", decision: "needs_more", note: null });
    assert.deepEqual(schemaErrors(loadSchema("understudy.benchmark_review.v1.schema.json"), review), []);
  });

  it("flag shape the hub writes matches understudy.benchmark_flag.v1", () => {
    const flag = {
      schema_version: "understudy.benchmark_flag.v1",
      benchmark_id: "bench-1",
      task_id: null,
      reason: "bad-gold",
      note: "",
      created_at: "2026-07-22T00:00:00.000Z",
      status: "open",
    };
    assert.deepEqual(schemaErrors(loadSchema("understudy.benchmark_flag.v1.schema.json"), flag), []);
  });
});
