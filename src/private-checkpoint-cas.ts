import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PrivateCheckpointRecord = {
  checkpointId: string;
  restorePath: string;
  step: number;
  metadata?: Record<string, string | number | boolean>;
};

export type PublicCheckpointReceipt = {
  checkpointId: string;
  restorePathSha256: string;
  step: number;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privatePath(root: string, checkpointId: string): string {
  return join(root, `${checkpointId}.json`);
}

export function writePrivateCheckpoint(
  root: string,
  record: PrivateCheckpointRecord,
): PublicCheckpointReceipt {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const payload = JSON.stringify(record);
  const path = privatePath(root, record.checkpointId);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, payload, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return {
    checkpointId: record.checkpointId,
    restorePathSha256: digest(record.restorePath),
    step: record.step,
  };
}

export function readPrivateCheckpoint(
  root: string,
  receipt: PublicCheckpointReceipt,
): PrivateCheckpointRecord {
  const record = JSON.parse(readFileSync(privatePath(root, receipt.checkpointId), "utf8")) as PrivateCheckpointRecord;
  if (record.checkpointId !== receipt.checkpointId || record.step !== receipt.step) {
    throw new Error("private checkpoint identity mismatch");
  }
  if (digest(record.restorePath) !== receipt.restorePathSha256) {
    throw new Error("private checkpoint restore-path hash mismatch");
  }
  return record;
}

export function orderCheckpointReceipts(
  receipts: readonly PublicCheckpointReceipt[],
): PublicCheckpointReceipt[] {
  return [...receipts].sort((left, right) => left.step - right.step);
}
