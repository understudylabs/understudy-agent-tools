#!/usr/bin/env node

import {
  contractBundleSha256,
  eventSchemaSha256,
  validateCanonicalEvent,
} from "./orchard-contract.mjs";

if (typeof validateCanonicalEvent !== "function") {
  throw new Error("canonical event schema did not compile");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    contract_bundle_sha256: contractBundleSha256,
    event_schema_sha256: eventSchemaSha256,
  })}\n`,
);
