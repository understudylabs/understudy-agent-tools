// Type surface for captures.mjs (pure logic shared with the node --test suite).

export declare const PAGE_SIZE: number;
export declare const MAX_AUTO_HOPS: number;

export declare function formatTimestamp(iso: string): string;
export declare function formatBytes(bytes: number): string;
export declare function formatMaybeJson(value: unknown): string;
export declare function workloadIdOf(capture: unknown): string | null;

export interface CaptureListPageLike {
  captures?: unknown[];
  truncated?: boolean;
  cursor?: string;
  skipped_malformed?: number;
  scanned_through?: string;
}

export interface ScanState<T = unknown> {
  captures: T[];
  nextCursor: string | null;
  scannedThrough: string | null;
  skippedMalformed: number;
  autoHops: number;
  autoContinue: boolean;
  exhausted: boolean;
}

export declare function nextCursorOf(result: CaptureListPageLike | null): string | null;
export declare function initialScanState<T = unknown>(): ScanState<T>;
export declare function reducePage<T = unknown>(
  state: ScanState<T>,
  page: CaptureListPageLike,
): ScanState<T>;

export declare function captureMetaRows(
  capture: Record<string, unknown>,
  workloadName: string,
): { label: string; value: string }[];
