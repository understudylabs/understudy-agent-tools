/**
 * Shared output helpers for command actions.
 *
 * Every command supports `--json` (set at the program level via the
 * top-level option in `src/cli.ts`). Two failure modes need careful
 * separation:
 *
 *   - **Sync throws from a command's action.** Commander's exit-override
 *     in `cli.ts` catches these and renders. Most actions are async.
 *
 *   - **Async failures inside an action.** Commander does not catch a
 *     rejected promise returned from `.action(async ...)`. Each async
 *     action wraps its body in `runAction` so the error path is
 *     uniform: human-readable on stderr by default, JSON envelope on
 *     stderr under `--json`. Exit code is set on `process.exitCode`
 *     (never `process.exit()` — the library boundary needs to let the
 *     event loop drain naturally).
 */
import kleur from "kleur";
import type { Command } from "commander";

import { UnderstudyApiError } from "./http.js";

export function isJsonMode(cmd: Command): boolean {
  const opts = cmd.optsWithGlobals() as { json?: boolean };
  return Boolean(opts.json);
}

/**
 * Wrap a command action so failures render consistently. Pass the
 * Commander `Command` instance so we can read `--json` off the
 * inherited options.
 */
export async function runAction(
  cmd: Command,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    const json = isJsonMode(cmd);
    if (err instanceof UnderstudyApiError) {
      if (json) {
        process.stderr.write(
          `${JSON.stringify({
            ok: false,
            error: err.message,
            status: err.status,
            type: err.errorType,
            request_id: err.requestId,
          })}\n`,
        );
      } else {
        const suffix = err.requestId ? ` (request_id=${err.requestId})` : "";
        process.stderr.write(
          `${kleur.red("error")}: ${err.message}${suffix}\n`,
        );
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      if (json) {
        process.stderr.write(
          `${JSON.stringify({ ok: false, error: message })}\n`,
        );
      } else {
        process.stderr.write(`${kleur.red("error")}: ${message}\n`);
      }
    }
    process.exitCode = 1;
  }
}

/**
 * Emit either JSON or a human-readable line. Convenience for commands
 * that need to print a small fixed payload (e.g. `understudy logout` -> `{ ok }`).
 */
export function emitResult(
  cmd: Command,
  human: string,
  json: Record<string, unknown>,
): void {
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(json)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}
