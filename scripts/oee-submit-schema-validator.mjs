const IMPLEMENTED_KEYWORDS = new Set([
  "$id",
  "$schema",
  "additionalProperties",
  "const",
  "enum",
  "maximum",
  "maxLength",
  "minimum",
  "minLength",
  "pattern",
  "properties",
  "required",
  "type",
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function assertSchemaKeywords(schema, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail(path, "schema node must be an object");
  for (const keyword of Object.keys(schema)) {
    if (!IMPLEMENTED_KEYWORDS.has(keyword)) fail(path, `unsupported schema keyword ${keyword}`);
  }
  for (const metadata of ["$id", "$schema"]) {
    if (metadata in schema && typeof schema[metadata] !== "string") fail(path, `${metadata} must be a string`);
  }
}

function matchesType(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  fail("$schema", `unsupported schema type ${type}`);
}

export function validateAgainstSchema(value, schema, path = "$") {
  assertSchemaKeywords(schema, path);
  if ("type" in schema && !matchesType(value, schema.type)) fail(path, `expected ${schema.type}`);
  if ("const" in schema && canonicalJson(value) !== canonicalJson(schema.const)) fail(path, "does not match const");
  if ("enum" in schema) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((entry) => canonicalJson(value) === canonicalJson(entry))) fail(path, "does not match enum");
  }
  if (typeof value === "string") {
    if ("minLength" in schema && (!Number.isInteger(schema.minLength) || value.length < schema.minLength)) fail(path, "is shorter than minLength");
    if ("maxLength" in schema && (!Number.isInteger(schema.maxLength) || value.length > schema.maxLength)) fail(path, "is longer than maxLength");
    if ("pattern" in schema) {
      if (typeof schema.pattern !== "string") fail(path, "pattern must be a string");
      if (!new RegExp(schema.pattern).test(value)) fail(path, "does not match pattern");
    }
  }
  if (typeof value === "number") {
    if ("minimum" in schema && (typeof schema.minimum !== "number" || value < schema.minimum)) fail(path, "is below minimum");
    if ("maximum" in schema && (typeof schema.maximum !== "number" || value > schema.maximum)) fail(path, "is above maximum");
  }
  if (schema.type === "object") {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) fail(path, "object schema must define properties");
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) fail(path, "object schema must define required string keys");
    if (schema.additionalProperties !== false) fail(path, "only additionalProperties:false is supported");
    for (const key of schema.required) {
      if (!(key in value)) fail(path, `missing required property ${key}`);
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) fail(`${path}.${key}`, "additional property");
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in value) validateAgainstSchema(value[key], childSchema, `${path}.${key}`);
    }
  }
  return true;
}
