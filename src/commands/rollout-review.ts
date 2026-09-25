import { Command } from "commander";
import { join, resolve } from "node:path";
import { runAction } from "../internal/output.js";
import { acquireRolloutSources, loadReviewSpec, readRolloutSources } from "../rollout-review-source.js";
import { buildRolloutReview } from "../rollout-review.js";
import { renderRolloutReview } from "../rollout-review-viewer.js";

interface ReviewOptions {
  spec: string;
  out: string;
  download?: boolean;
  includePayload?: boolean;
  yes?: boolean;
}

export function registerRolloutReviewCommand(traces: Command): void {
  traces.command("review-rollout")
    .description("Build a private, reproducible before/after task review from a frozen workload spec")
    .requiredOption("--spec <path>", "Private review spec with exact scope, UTC windows and identity selectors")
    .requiredOption("--out <directory>", "Private source and review artifact directory; reuse only with the same spec")
    .option("--download", "Acquire the complete indexed capture inventory for the spec; otherwise rebuild offline")
    .option("--include-payload", "Allow private capture-body download; requires --download --yes")
    .option("--yes", "Confirm the requested full payload download")
    .action(async function (this: Command, options: ReviewOptions) {
      await runAction(this, async () => {
        if (options.download && (!options.includePayload || !options.yes)) {
          throw new Error("Downloading full captures requires --download --include-payload --yes. Files may contain prompts, completions and tool data.");
        }
        if (!options.download && (options.includePayload || options.yes)) {
          throw new Error("--include-payload and --yes apply only with --download; omit them for an offline rebuild.");
        }
        const spec = loadReviewSpec(resolve(options.spec));
        const output = resolve(options.out);
        if (options.download) {
          console.error("Downloading private capture bodies for the explicit review windows; no inference or traffic changes.");
          await acquireRolloutSources(spec, output);
        }
        // The exact same integrity gate protects both first builds and offline rebuilds.
        const input = readRolloutSources(spec, output);
        const report = buildRolloutReview(input);
        const result = renderRolloutReview(report, join(output, "viewer"));
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        console.error(`viewer: ${result.artifacts.viewer}`);
      });
    });
}
