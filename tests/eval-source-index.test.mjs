import assert from "node:assert/strict";
import test from "node:test";

import { SourceIndexCommitment, sourceIndexCommitmentSha256 } from "../dist/evals/source-index.js";

const first = {
  schema_version: "understudy.eval-source-capture.v1",
  request_id: "req-1",
  capture_key: "org/proj/apk/2026/08/23/req-1.jsonl",
  captured_at: "2026-08-23T00:00:00.000Z",
  size_bytes: 12,
  content_sha256: "a".repeat(64),
};
const second = {
  schema_version: "understudy.eval-source-capture.v1",
  request_id: "req-2",
  capture_key: "org/proj/apk/2026/08/24/req-2.jsonl",
  captured_at: "2026-08-24T00:00:00.000Z",
  size_bytes: 34,
  content_sha256: "b".repeat(64),
};

test("source index commitment matches the cross-repository rolling digest", () => {
  assert.equal(
    sourceIndexCommitmentSha256([]),
    "4da6e1855a6868d3caa47455d7b802a3e9d737e9d157434cff60e26d9a8345b0",
  );
  assert.equal(
    sourceIndexCommitmentSha256([first]),
    "0358aac87d6193bd56af2df07aaa02fbc0214d7640993d0e596a89cdd4879913",
  );
  assert.equal(
    sourceIndexCommitmentSha256([first, second]),
    "acf3bd481cc77dfa3fd39cef65f613929350f72df8b9f56f154114ec5ec84075",
  );
  assert.notEqual(
    sourceIndexCommitmentSha256([second, first]),
    sourceIndexCommitmentSha256([first, second]),
  );
});

test("source index commitment binds captured_at and matches incremental updates", () => {
  const incremental = new SourceIndexCommitment();
  incremental.update(first);
  incremental.update(second);
  assert.equal(incremental.digest(), sourceIndexCommitmentSha256([first, second]));
  assert.notEqual(
    sourceIndexCommitmentSha256([{ ...first, captured_at: "2026-08-23T00:00:01.000Z" }, second]),
    sourceIndexCommitmentSha256([first, second]),
  );
});
