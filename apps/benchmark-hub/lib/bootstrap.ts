/**
 * Percentile-bootstrap confidence intervals — the implementation LIVES in the
 * CLI package (src/bootstrap-ci.ts) and is imported from the compiled dist so
 * the hub charts and the CLI's partner report can never drift on the CI math
 * (same pattern as types.ts / artifacts-core.ts). Pure module, safe for
 * client components. Named re-exports so the tests' CommonJS .build output
 * keeps statically analyzable named exports.
 */
export { bootstrapCI, fnv1a, mulberry32, perTaskMeans } from "../../../dist/bootstrap-ci.js";
export type { BootstrapCI, BootstrapOptions } from "../../../dist/bootstrap-ci.js";
