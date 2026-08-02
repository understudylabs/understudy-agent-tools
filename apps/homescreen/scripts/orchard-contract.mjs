import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../schemas/understudy-train/experiment-event.json", import.meta.url);
const manifestUrl = new URL("../schemas/understudy-train/manifest.json", import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
const eventSchema = JSON.parse(schemaBytes);
const contractManifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

export const eventSchemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
export const contractBundleSha256 = contractManifest.bundle_sha256;

if (contractManifest.schemas?.["experiment-event.json"] !== eventSchemaSha256) {
  throw new Error("vendored experiment event schema does not match the canonical manifest");
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", true);
export const validateCanonicalEvent = ajv.compile(eventSchema);
