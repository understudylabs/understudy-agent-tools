import { readFileSync } from "node:fs";

/**
 * Load a system-prompt override from disk with ZERO transformation.
 *
 * Byte-for-byte fidelity is the whole point: the GEPA ContractAdapter and the
 * canonical rollout must feed the student the identical system prompt, so this
 * returns the raw UTF-8 contents with no trim, no newline normalization, and no
 * trailing-newline stripping. Any such massaging would silently desync the two
 * serving paths and invalidate a parity calibration.
 */
export function loadSystemPrompt(path) {
  return readFileSync(path, "utf8");
}
