/**
 * Minimal JSON Schema checker for the subset of draft 2020-12 used by
 * `understudy.executor-submit.v1`.
 *
 * The repo has no JSON Schema validator of its own, and a bake-off arm is not
 * the place to add a dependency for one file. `assertSupported` fails loudly if
 * the vendored contract ever grows a keyword this checker does not implement,
 * so a schema update can never silently weaken the test.
 */
const SUPPORTED = new Set([
  "$schema", "$id", "title", "description",
  "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum",
]);

export function assertSupported(schema, path = "#") {
  if (!schema || typeof schema !== "object") return;
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`${path}: unsupported schema keyword ${keyword}`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupported(child, `${path}/${name}`);
  if (schema.items) assertSupported(schema.items, `${path}/items`);
  if (typeof schema.additionalProperties === "object") assertSupported(schema.additionalProperties, `${path}/additionalProperties`);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function check(schema, value, path, errors) {
  if (schema.type) {
    const actual = typeOf(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((type) => (type === "number" ? actual === "number" || actual === "integer" : type === actual));
    if (!ok) {
      errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (typeOf(value) === "array" && schema.items) {
    value.forEach((entry, index) => check(schema.items, entry, `${path}/${index}`, errors));
  }
  if (typeOf(value) === "object") {
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${path}: missing required property ${name}`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in (schema.properties ?? {}))) errors.push(`${path}: unexpected property ${name}`);
      }
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in value) check(child, value[name], `${path}/${name}`, errors);
    }
  }
}

export function validate(schema, value) {
  assertSupported(schema);
  const errors = [];
  check(schema, value, "#", errors);
  return { valid: errors.length === 0, errors };
}
