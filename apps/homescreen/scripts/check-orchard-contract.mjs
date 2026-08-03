#!/usr/bin/env node

import {
  contractBundleSha256,
  eventSchemaSha256,
  validateCanonicalEvent,
} from "./orchard-contract.mjs";
import { validateEventPage, viewerAuthorized } from "./orchard-live-policy.mjs";

if (typeof validateCanonicalEvent !== "function") {
  throw new Error("canonical event schema did not compile");
}

if (viewerAuthorized(undefined, "viewer") || viewerAuthorized("Bearer wrong", "viewer")) {
  throw new Error("viewer capability check failed closed incorrectly");
}
if (!viewerAuthorized("Bearer viewer", "viewer")) {
  throw new Error("viewer capability check rejected an exact token");
}

const canonical = (sequence) => ({ sequence });
const pageOptions = {
  experimentId: "exp-test",
  requestedAfter: 1,
  isCanonicalEvent: (event) => Number.isInteger(event?.sequence),
};
if (!validateEventPage({
  experiment_id: "exp-test", events: [canonical(2), canonical(3)], next_after: 3, has_more: false,
}, pageOptions)) throw new Error("valid event page was rejected");
for (const invalid of [
  { experiment_id: "exp-test", events: [canonical(2), canonical(2)], next_after: 2, has_more: false },
  { experiment_id: "exp-test", events: [canonical(3), canonical(2)], next_after: 2, has_more: false },
  { experiment_id: "exp-test", events: [canonical(2)], next_after: 9, has_more: false },
  { experiment_id: "exp-test", events: [], next_after: 1, has_more: true },
]) {
  if (validateEventPage(invalid, pageOptions)) throw new Error("invalid event page was accepted");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    contract_bundle_sha256: contractBundleSha256,
    event_schema_sha256: eventSchemaSha256,
  })}\n`,
);
