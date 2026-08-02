import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveRepairAliases, filterRepairCapturesToWindow, readRepairCaptureBatch, readRepairRateCard, rankRepairTargets, repairRateCardTemplate, writeRepairAliasMap, writeRepairOutputs } from "../repair-roi.js";

export function registerRepairTargetsCommand(program: Command): void {
  const command = program.command("repair-targets").description("Rank locally staged workloads by repair ROI.");
  command.command("rate-card-template")
    .description("Write a reviewed model rate-card template.")
    .option("--out <path>", "Rate-card path.", ".understudy/repair-targets/rate-card.json")
    .action((options: { out: string }) => console.log(JSON.stringify({ rate_card: repairRateCardTemplate(options.out) }, null, 2)));
  command.command("rank")
    .description("Rank capture workloads into an aggregate-only repair queue.")
    .requiredOption("--captures <path>", "Capture file or directory.")
    .requiredOption("--rate-card <path>", "Reviewed repair rate-card JSON.")
    .option("--out <dir>", "Output directory.", ".understudy/repair-targets")
    .option("--window-days <n>", "Lookback window.", "30")
    .option("--population-scale <n>", "Extrapolate population quantities by this sample scale.", "1")
    .option("--min-cluster-size <n>", "Minimum repeated-task cluster size.", "20")
    .option("--headroom-brevity-weight <n>", "Headroom prior weight for output brevity.", "0.35")
    .option("--headroom-structured-weight <n>", "Headroom prior weight for structured output.", "0.35")
    .option("--headroom-context-weight <n>", "Headroom prior weight for input context size.", "0.2")
    .option("--headroom-errors-weight <n>", "Headroom prior weight for HTTP errors.", "0.1")
    .option("--anonymize", "Use stable workload aliases (default).", true)
    .option("--no-anonymize", "Write workload names in local output.")
    .option("--json", "Print the complete queue JSON.")
    .action((options: { captures: string; rateCard: string; out: string; windowDays: string; populationScale: string; minClusterSize: string; headroomBrevityWeight: string; headroomStructuredWeight: string; headroomContextWeight: string; headroomErrorsWeight: string; anonymize: boolean; json?: boolean }) => {
      const batch = readRepairCaptureBatch(options.captures);
      const now = new Date();
      const rankedCaptures = filterRepairCapturesToWindow(batch.captures, now, Number(options.windowDays));
      const aliases = deriveRepairAliases(rankedCaptures);
      const queue = rankRepairTargets(batch.captures, readRepairRateCard(options.rateCard), {
        windowDays: Number(options.windowDays),
        populationScale: Number(options.populationScale),
        samplingMethod: Number(options.populationScale) > 1 ? "uniform random sample stratified by day; fixed seed" : "none",
        minClusterSize: Number(options.minClusterSize),
        anonymize: options.anonymize,
        now,
        aliases,
        captureStats: batch,
        headroomWeights: {
          brevity: Number(options.headroomBrevityWeight),
          structured: Number(options.headroomStructuredWeight),
          context: Number(options.headroomContextWeight),
          errors: Number(options.headroomErrorsWeight),
        },
      });
      const outputs = writeRepairOutputs(queue, options.out);
      const aliasMap = options.anonymize ? writeRepairAliasMap(rankedCaptures, join(resolve(options.out), "local"), aliases) : null;
      if (!options.anonymize) {
        mkdirSync(resolve(options.out), { recursive: true, mode: 0o700 });
        writeFileSync(join(resolve(options.out), "WARNING-local-names.txt"), "This output contains local workload names; do not commit it.\n", { mode: 0o600 });
      }
      if (options.json) {
        console.log(JSON.stringify({ ...queue, outputs: { ...outputs, alias_map: aliasMap } }, null, 2));
      } else {
        const topRows = queue.workloads.slice(0, 5).map((row, index) => ({
          rank: index + 1,
          workload: row.workload.alias,
          roi_score: row.roi_score,
          conservative_savings_usd: row.projected_savings_usd.conservative,
          optimistic_savings_usd: row.projected_savings_usd.optimistic,
        }));
        console.log(JSON.stringify({ outputs: { ...outputs, alias_map: aliasMap }, top_rows: topRows }, null, 2));
      }
    });
}
