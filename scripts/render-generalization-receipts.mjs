import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve("experiments/generalization-transfer-matrix");
const docs = resolve("docs/benchmark-generalization.md");
const report = resolve(root, "report.md");

const models = [
  {
    label: "Fireworks gpt-oss-20b",
    rows: "gpt-oss-20b-rows.jsonl",
    receipts: "gpt-oss-20b-receipts.jsonl",
    assumption: "$0.10 input / $0.40 output per 1M tokens",
  },
  {
    label: "Anthropic Haiku 4.5",
    rows: "haiku-4-5-rows.jsonl",
    receipts: "haiku-4-5-receipts.jsonl",
    assumption: "$1 input / $5 output per 1M tokens",
  },
];

const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const formatUsd = (value) => `$${value.toFixed(6)}`;
const formatRate = (value) => `${(value * 100).toFixed(1)}%`;

const summaries = models.map((model) => {
  const rows = readJsonl(resolve(root, model.rows));
  const receipts = readJsonl(resolve(root, model.receipts)).filter((entry) => entry.type !== "run_summary");
  const promptTokens = receipts.reduce((sum, entry) => sum + Number(entry.tokens?.prompt ?? 0), 0);
  const completionTokens = receipts.reduce((sum, entry) => sum + Number(entry.tokens?.completion ?? 0), 0);
  const usd = receipts.reduce((sum, entry) => sum + Number(entry.usd ?? 0), 0);
  const errors = rows.filter((row) => row.status === "error").length;
  const byGroup = new Map();
  for (const row of rows) {
    const group = row.benchmark_id;
    const summary = byGroup.get(group) ?? { rows: 0, parse: 0 };
    summary.rows += 1;
    summary.parse += Number(row.subscores?.parse_failures ?? 0) > 0 ? 1 : 0;
    byGroup.set(group, summary);
  }
  return { ...model, calls: receipts.length, promptTokens, completionTokens, usd, errors, rows: rows.length, byGroup };
});

const lines = [
  "## Run receipts",
  "",
  "The following accounting is generated from the checked-in receipts and rows. USD values are estimates, not bills, using the stated price assumptions.",
  "",
  "| Model | Calls | Prompt tokens | Completion tokens | Estimated USD | Transport-error rate | Price assumption |",
  "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ...summaries.map((summary) =>
    `| ${summary.label} | ${summary.calls} | ${summary.promptTokens.toLocaleString()} | ${summary.completionTokens.toLocaleString()} | ${formatUsd(summary.usd)} | ${formatRate(summary.errors / summary.rows)} | ${summary.assumption} |`,
  ),
  "",
  "Share of rows with at least one parse failure:",
  "",
  "| Model | Group | Rows with parse failure | Total rows | Share |",
  "| --- | --- | ---: | ---: | ---: |",
  ...summaries.flatMap((summary) => [...summary.byGroup.entries()].map(([group, counts]) =>
    `| ${summary.label} | ${group} | ${counts.parse} | ${counts.rows} | ${formatRate(counts.parse / counts.rows)} |`,
  )),
  "",
];

const section = lines.join("\n");
const replaceSection = (content) => content.replace(
  /<!-- GENERATED RECEIPTS START -->[\s\S]*?<!-- GENERATED RECEIPTS END -->/,
  `<!-- GENERATED RECEIPTS START -->\n${section}\n<!-- GENERATED RECEIPTS END -->`,
);
writeFileSync(report, replaceSection(readFileSync(report, "utf8")));
writeFileSync(docs, replaceSection(readFileSync(docs, "utf8")));
