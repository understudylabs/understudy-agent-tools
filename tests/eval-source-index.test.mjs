import assert from "node:assert/strict";
import test from "node:test";

import { sourceIndexCommitmentSha256 } from "../dist/evals/source-index.js";

const first = {
  schema_version: "understudy.eval-source-capture.v1",
  request_id: "req-1",
  capture_key: "org/proj/apk/2026/08/23/req-1.jsonl",
  size_bytes: 12,
  content_sha256: "a".repeat(64),
};
const second = {
  schema_version: "understudy.eval-source-capture.v1",
  request_id: "req-2",
  capture_key: "org/proj/apk/2026/08/24/req-2.jsonl",
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
    "fc24fc7e56f59b721914d84b9e6b333ad8b19fa1dd7789b83c72a68269d1a832",
  );
  assert.equal(
    sourceIndexCommitmentSha256([first, second]),
    "fcf0ab494f9878bf18ce9a2ebfe762c0c5621237351d9e079a25cfc7c0741998",
  );
  assert.notEqual(
    sourceIndexCommitmentSha256([second, first]),
    sourceIndexCommitmentSha256([first, second]),
  );
});
