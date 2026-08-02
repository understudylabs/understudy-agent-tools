import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGeneralizationManifest } from "../dist/generalization-registry.js";
import { deriveGeneralizationReport } from "../dist/generalization.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const artifactRoot = resolve(root, "experiments/nemotron-generalization-transfer/artifacts");
const groups = ["automationbench-simple-api", "event-categorizer", "synthetic-workflow-shapes"];
const parseArgs = () => {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    args[token.slice(2).replaceAll("-", "_")] = process.argv[index + 1] ?? true;
    if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) index += 1;
  }
  return args;
};
const args = parseArgs();
const splits = String(args.splits ?? "").split(",").map((split) => split.trim()).filter(Boolean);
if (!splits.length || splits.some((split) => !["train", "dev", "holdout"].includes(split))) {
  throw new Error("--splits must be a comma-separated list of train,dev,holdout");
}
const outDir = resolve(root, String(args.out_dir ?? resolve(artifactRoot, `reports/${splits.join("-")}`)));
const rowsDir = resolve(root, String(args.rows_dir ?? resolve(artifactRoot, "rows")));
const loadRows = (arm, group, split) => {
  const path = resolve(rowsDir, `${arm}-${group}-${split}.jsonl`);
  if (!existsSync(path)) throw new Error(`missing rows file: ${path}`);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
const rowsByArm = {
  "nemotron-transfer": {
    baseline: groups.flatMap((group) => splits.flatMap((split) => loadRows("base", group, split))),
    candidate: groups.flatMap((group) => splits.flatMap((split) => loadRows("tuned", group, split))),
  },
};
const manifest = buildGeneralizationManifest({
  eval_splits: splits,
  require_content_hashes: true,
  require_all_groups_scored: true,
  arms: [{
    arm_id: "nemotron-transfer",
    train_groups: ["automationbench-simple-api"],
    eval_splits: splits,
    baseline: { rows: "rows/base-{group}-{split}.jsonl", model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16" },
    candidate: {
      rows: "rows/tuned-{group}-{split}.jsonl",
      model: "tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020",
    },
  }],
});
const report = deriveGeneralizationReport(manifest, rowsByArm);
const arm = report.arms[0];
const matrixRows = arm.matrix.map((cell) =>
  `| ${cell.group_id} | ${cell.in_domain ? "yes" : "no"} | ${cell.n_tasks} | ${cell.baseline_mean ?? "—"} | ${cell.candidate_mean ?? "—"} | ${cell.delta ?? "—"} | ${cell.fixed} | ${cell.regressed} | ${cell.unchanged} | ${cell.status} |`,
);
const taskSections = groups.map((group) => {
  const deltas = arm.task_deltas.filter((task) => task.group_id === group);
  const lines = deltas.map((task) =>
    `| ${task.task_id} | ${task.baseline_mean ?? "—"} | ${task.candidate_mean ?? "—"} | ${task.delta ?? "—"} | ${task.outcome} |`,
  );
  return [
    `### ${group}`,
    "",
    "| Task | Base | Tuned | Delta | Outcome |",
    "|---|---:|---:|---:|---|",
    ...lines,
    "",
  ].join("\n");
}).join("\n");
const markdown = [
  `# Nemotron transfer report (${splits.join(", ")})`,
  "",
  `- In-domain gain: ${report.score.in_domain_gain ?? "—"}`,
  `- Transfer gain: ${report.score.transfer_gain ?? "—"}`,
  `- Transfer ratio: ${report.score.transfer_ratio ?? "—"}`,
  `- Forgetting: ${report.score.forgetting ?? "—"}`,
  `- Forgetting penalty: ${report.score.forgetting_penalty ?? "—"}`,
  `- Regressed groups: ${report.score.regressed_groups.join(", ") || "none"}`,
  `- Forgetting-penalized generalization score: ${report.score.generalization_score ?? "—"}`,
  "",
  "## Transfer matrix",
  "",
  "| Group | In domain | Tasks | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged | Status |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ...matrixRows,
  "",
  "## Per-task deltas",
  "",
  taskSections,
  "## Coverage",
  "",
  "```json",
  JSON.stringify(report.coverage, null, 2),
  "```",
  "",
].join("\n");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(outDir, "report.md"), markdown);
console.log(JSON.stringify({
  out_dir: outDir,
  splits,
  score: report.score,
  matrix: arm.matrix,
  coverage: report.coverage,
}, null, 2));
