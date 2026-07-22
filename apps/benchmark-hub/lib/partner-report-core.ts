/**
 * Hub-side view of the partner report (the honest client-facing
 * benchmark-and-savings deliverable). The derivation and rendering LIVE in
 * the CLI package (src/partner-report.ts) and are imported from the compiled
 * dist — never forked — so the CLI's partner-report.md/.json and the hub's
 * Report page physically cannot disagree on a single number. Same pattern as
 * runs-core.ts / artifacts-core.ts.
 */
export { PARTNER_REPORT_SCHEMA, derivePartnerReport, renderPartnerReport, scrubText, slugNameTokens } from "../../../dist/partner-report.js";
export type { PartnerArm, PartnerFloor, PartnerReport, ProjectedSavings } from "../../../dist/partner-report.js";
