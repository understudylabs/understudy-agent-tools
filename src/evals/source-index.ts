import { createHash } from "node:crypto";

export const EVAL_SOURCE_ROW_SCHEMA_VERSION = "understudy.eval-source-capture.v1" as const;
const SOURCE_INDEX_COMMITMENT_DOMAIN = "understudy:workload-corpus-commitment:v1\n";

export interface EvalSourceCommitmentRow {
  schema_version: typeof EVAL_SOURCE_ROW_SCHEMA_VERSION;
  request_id: string;
  capture_key: string;
  captured_at: string;
  size_bytes: number;
  content_sha256: string;
}

export class SourceIndexCommitment {
  #commitment = createHash("sha256").update(SOURCE_INDEX_COMMITMENT_DOMAIN, "utf8").digest();

  update(row: EvalSourceCommitmentRow): void {
    const canonicalLine = `${JSON.stringify({
      schema_version: row.schema_version,
      request_id: row.request_id,
      capture_key: row.capture_key,
      captured_at: row.captured_at,
      size_bytes: row.size_bytes,
      content_sha256: row.content_sha256,
    })}\n`;
    this.#commitment = createHash("sha256").update(this.#commitment).update(canonicalLine, "utf8").digest();
  }

  digest(): string {
    return this.#commitment.toString("hex");
  }
}

export function sourceIndexCommitmentSha256(rows: Iterable<EvalSourceCommitmentRow>): string {
  const commitment = new SourceIndexCommitment();
  for (const row of rows) {
    commitment.update(row);
  }
  return commitment.digest();
}
