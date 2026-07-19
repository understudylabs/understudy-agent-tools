// Validate experiments/benchmark-hub-demo/benchmark.json against the
// understudy.benchmark.v1 contract using the repo's own dist/benchmark.js.
// Usage: node experiments/benchmark-hub-demo/validate-manifest.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const { validateBenchmarkManifest } = await import(
  path.join(repoRoot, "dist", "benchmark.js")
);

const manifest = JSON.parse(readFileSync(path.join(here, "benchmark.json"), "utf8"));
const errors = validateBenchmarkManifest(manifest);
if (errors.length) {
  console.error("INVALID manifest:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log("benchmark.json is a valid understudy.benchmark.v1 manifest");
