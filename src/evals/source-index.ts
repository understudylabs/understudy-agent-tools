import { createHash } from "node:crypto";

export const EVAL_SOURCE_ROW_SCHEMA_VERSION = "understudy.eval-source-capture.v1" as const;
const SOURCE_INDEX_COMMITMENT_DOMAIN = "understudy:workload-corpus-commitment:v1\n";

export interface EvalSourceCommitmentRow {
  schema_version: typeof EVAL_SOURCE_ROW_SCHEMA_VERSION;
  request_id: string;
  capture_key: string;
  size_bytes: number;
  content_sha256: string;
}

export function sourceIndexCommitmentSha256(rows: Iterable<EvalSourceCommitmentRow>): string {
  let commitment = createHash("sha256").update(SOURCE_INDEX_COMMITMENT_DOMAIN, "utf8").digest();
  for (const row of rows) {
    const canonicalLine = `${JSON.stringify({
      schema_version: row.schema_version,
      request_id: row.request_id,
      capture_key: row.capture_key,
      size_bytes: row.size_bytes,
      content_sha256: row.content_sha256,
    })}\n`;
    commitment = createHash("sha256").update(commitment).update(canonicalLine, "utf8").digest();
  }
  return commitment.toString("hex");
}
