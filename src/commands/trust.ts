/**
 * `understudy trust` — the one-time autonomy posture (~/.understudy/trust.json).
 *
 * Smart defaults instead of per-action approval dialogs: set the posture
 * once, and every spend/upload/traffic gate consults it instead of
 * prompting. Visible (`trust show`) and reversible (`trust set`).
 */
import type { Command } from "commander";

import {
  TRUST_LEVELS,
  readTrustPosture,
  resolveTrustBoundaries,
  trustPosturePath,
  writeTrustPosture,
  type TrustLevel,
} from "../config/trust.js";

export function registerTrustCommand(program: Command): void {
  const trust = program
    .command("trust")
    .description(
      "One-time autonomy posture (trust.json): smart defaults instead of per-action approval dialogs. " +
        `Levels: ${TRUST_LEVELS.join(" < ")}. Visible and reversible — set it once, change it any time.`,
    );

  trust
    .command("show")
    .description("Print the posture in force plus the resolved boundaries (defaults apply when the file is absent)")
    .action(() => {
      const posture = readTrustPosture();
      console.log(
        JSON.stringify(
          { file: trustPosturePath(), posture, resolved: resolveTrustBoundaries(posture) },
          null,
          2,
        ),
      );
    });

  trust
    .command("set <level>")
    .description(
      "Set the posture level (local_sandbox | bounded_experiments | hosted_ops) and optional per-boundary overrides. " +
        "There is NO default spend cap at any level; --spend-stop-loss opts into a generous per-run stop-loss (warn at 1x, never mid-run hard-kill below 2x).",
    )
    .option("--spend-stop-loss <usd>", "Opt-in generous per-run spend stop-loss in USD (omit for unlimited)")
    .option("--clear-spend-stop-loss", "Remove the spend stop-loss (back to unlimited)")
    .option("--allow-provider-upload", "Override: allow data uploads to providers regardless of level")
    .option("--forbid-provider-upload", "Override: forbid provider uploads regardless of level")
    .option("--allow-traffic-changes", "Override: allow live traffic changes regardless of level")
    .option("--forbid-traffic-changes", "Override: forbid live traffic changes regardless of level")
    .action(
      (
        level: string,
        options: {
          spendStopLoss?: string;
          clearSpendStopLoss?: boolean;
          allowProviderUpload?: boolean;
          forbidProviderUpload?: boolean;
          allowTrafficChanges?: boolean;
          forbidTrafficChanges?: boolean;
        },
      ) => {
        if (!(TRUST_LEVELS as readonly string[]).includes(level)) {
          console.error(`trust set: unknown level "${level}" (expected one of: ${TRUST_LEVELS.join(", ")})`);
          process.exitCode = 1;
          return;
        }
        const overrides: Record<string, boolean | number | null> = {};
        if (options.clearSpendStopLoss) overrides.allow_spend_usd_per_run = null;
        else if (options.spendStopLoss !== undefined) {
          const usd = Number(options.spendStopLoss);
          if (!Number.isFinite(usd) || usd <= 0) {
            console.error("trust set: --spend-stop-loss must be a positive USD number");
            process.exitCode = 1;
            return;
          }
          overrides.allow_spend_usd_per_run = usd;
        }
        if (options.allowProviderUpload) overrides.allow_provider_upload = true;
        if (options.forbidProviderUpload) overrides.allow_provider_upload = false;
        if (options.allowTrafficChanges) overrides.allow_traffic_changes = true;
        if (options.forbidTrafficChanges) overrides.allow_traffic_changes = false;
        const posture = writeTrustPosture({ level: level as TrustLevel, overrides });
        console.error(`trust: posture set to ${posture.level} (${trustPosturePath()})`);
        console.log(JSON.stringify({ posture, resolved: resolveTrustBoundaries(posture) }, null, 2));
      },
    );
}
