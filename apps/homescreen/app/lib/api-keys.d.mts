export type KeyRow = {
  id: string;
  name: string;
  obfuscated_value: string;
  created_at: string;
  last_used_at: string | null;
};

export type CreateKeyResult = {
  value: string;
  metadata?: KeyRow;
};

export function formatDate(iso: string): string;
export function formatLastUsed(iso: string | null | undefined): string;
export function normalizeKeys(envelope: unknown): KeyRow[];
export function invokeErrorMessage(err: unknown, fallback: string): string;
