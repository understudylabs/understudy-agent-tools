import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

const MAX_MODULE_FILES = 256;
const MAX_MODULE_FILE_BYTES = 256 * 1024;
const MAX_MODULE_TREE_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_RESULT_BYTES = 2 * 1024 * 1024;
const CHILD_HEAP_MIB = 96;
const MAX_CHILD_STDERR_BYTES = 8_192;

export interface ModuleSnapshotFile {
  path: string;
  source: string;
  content_sha256: string;
}

export interface ModuleTreeSnapshot {
  entrypoint: string;
  files: ModuleSnapshotFile[];
  sha256: string;
}

interface ChildCheckResult {
  nonce?: string;
  ok?: boolean;
  error?: string;
  replay?: unknown;
  verification?: unknown;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readStableModule(path: string, label: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} must contain only regular module files.`);
    if (before.size > BigInt(MAX_MODULE_FILE_BYTES)) {
      throw new Error(`${label} module exceeds the ${MAX_MODULE_FILE_BYTES}-byte limit.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} module changed while its immutable snapshot was being read.`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`Module entrypoint must be inside its dedicated module tree.`);
  }
  return value.split(sep).join("/");
}

export function snapshotModuleTree(root: string, entrypoint: string, label: string): ModuleTreeSnapshot {
  if (!lstatSync(root).isDirectory()) throw new Error(`${label} must be a directory.`);
  const entrypointRelative = portableRelative(root, entrypoint);
  const files: ModuleSnapshotFile[] = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links.`);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`${label} can contain only regular JavaScript modules and directories.`);
      if (![".js", ".mjs"].includes(extname(entry.name))) {
        throw new Error(`${label} can contain only .js and .mjs modules.`);
      }
      if (files.length >= MAX_MODULE_FILES) throw new Error(`${label} exceeds the ${MAX_MODULE_FILES}-file limit.`);
      const bytes = readStableModule(path, `${label} module ${entry.name}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_MODULE_TREE_BYTES) throw new Error(`${label} exceeds the ${MAX_MODULE_TREE_BYTES}-byte limit.`);
      files.push({
        path: portableRelative(root, path),
        source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        content_sha256: sha256(bytes),
      });
    }
  };
  visit(root);
  if (files.length === 0) throw new Error(`${label} is empty.`);
  if (!files.some((file) => file.path === entrypointRelative)) {
    throw new Error(`${label} does not contain its declared entrypoint.`);
  }
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.path).update("\0").update(file.content_sha256).update("\n");
  return { entrypoint: entrypointRelative, files, sha256: digest.digest("hex") };
}

const SANDBOX_INIT_SOURCE = String.raw`
(() => {
  "use strict";
  for (const name of [
    "process", "fetch", "WebSocket", "EventSource", "XMLHttpRequest",
    "require", "module", "Buffer", "console", "setTimeout", "setInterval",
    "setImmediate", "queueMicrotask", "Worker", "SharedWorker",
    "MessageChannel", "BroadcastChannel", "performance", "crypto", "navigator",
  ]) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const encode = (value) => stringify(value);
  const decode = (value) => parse(value);
  const clone = (value) => decode(encode(value));
  Object.defineProperty(globalThis, "structuredClone", {
    value: clone,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  const NativeDate = Date;
  class DeterministicDate extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [0] : args)); }
    static now() { return 0; }
  }
  Object.defineProperty(globalThis, "Date", {
    value: DeterministicDate,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(Math, "random", {
    value: () => 0.5,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.freeze(Math);
  Object.defineProperty(globalThis, "__understudyRuntime", {
    value: Object.freeze({ encode, decode }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
`;

const SANDBOX_RUNNER_SOURCE = String.raw`
const { encode, decode } = globalThis.__understudyRuntime;
const entrypoint = globalThis.__understudyEntrypoint;
const exportName = globalThis.__understudyExportName;
const label = globalThis.__understudyLabel;
export default (async () => {
  try {
    if (typeof entrypoint[exportName] !== "function") throw new Error(label + " must export " + exportName + ".");
    const input = decode(globalThis.__understudyInputJson);
    const value = await entrypoint[exportName](input);
    return encode({ ok: true, value });
  } catch (error) {
    let detail = "Sandbox module failed.";
    try { detail = error instanceof Error ? error.message : String(error); } catch {}
    return encode({ ok: false, error: detail });
  }
})();
`;

const CHECK_CHILD_SOURCE = String.raw`
import vm from "node:vm";
import path from "node:path/posix";
import { createHash } from "node:crypto";

const MAX_REQUEST_BYTES = ${MAX_CHILD_REQUEST_BYTES};
const MAX_INPUT_BYTES = ${MAX_CHILD_INPUT_BYTES};
const MAX_RESULT_BYTES = ${MAX_CHILD_RESULT_BYTES};
const MAX_MODULE_FILES = ${MAX_MODULE_FILES};
const MAX_MODULE_FILE_BYTES = ${MAX_MODULE_FILE_BYTES};
const MAX_MODULE_TREE_BYTES = ${MAX_MODULE_TREE_BYTES};
let requestText = "";
for await (const chunk of process.stdin) {
  requestText += chunk;
  if (Buffer.byteLength(requestText) > MAX_REQUEST_BYTES) {
    process.send({ ok: false, error: "Sandbox request exceeds its byte limit." }, undefined, undefined, () => process.exit(1));
    await new Promise(() => {});
  }
}

const request = JSON.parse(requestText);
const respond = (message, status) => {
  let body;
  try {
    body = JSON.stringify({ nonce: request.nonce, ...message });
  } catch {
    body = JSON.stringify({ nonce: request.nonce, ok: false, error: "Sandbox result is not JSON-serializable." });
    status = 1;
  }
  if (Buffer.byteLength(body) > MAX_RESULT_BYTES) {
    body = JSON.stringify({ nonce: request.nonce, ok: false, error: "Sandbox result exceeds its byte limit." });
    status = 1;
  }
  process.send(JSON.parse(body), undefined, undefined, () => process.exit(status));
};

const INIT_SOURCE = ${JSON.stringify(SANDBOX_INIT_SOURCE)};
const RUNNER_SOURCE = ${JSON.stringify(SANDBOX_RUNNER_SOURCE)};

function validateTree(tree, label) {
  if (!tree || typeof tree.entrypoint !== "string" || !Array.isArray(tree.files) || tree.files.length === 0) {
    throw new Error(label + " snapshot is invalid.");
  }
  const files = new Map();
  let totalBytes = 0;
  for (const file of tree.files) {
    if (!file || typeof file.path !== "string" || typeof file.source !== "string") throw new Error(label + " snapshot is invalid.");
    if (file.path.startsWith("/") || file.path.includes("\\\\") || file.path.split("/").includes("..")) {
      throw new Error(label + " snapshot contains an unsafe module path.");
    }
    if (!file.path.endsWith(".js") && !file.path.endsWith(".mjs")) throw new Error(label + " snapshot contains a non-JavaScript module.");
    if (files.has(file.path)) throw new Error(label + " snapshot contains duplicate module paths.");
    if (files.size >= MAX_MODULE_FILES) throw new Error(label + " snapshot exceeds its file limit.");
    const sourceBytes = Buffer.byteLength(file.source);
    if (sourceBytes > MAX_MODULE_FILE_BYTES) throw new Error(label + " snapshot contains an oversized module.");
    totalBytes += sourceBytes;
    if (totalBytes > MAX_MODULE_TREE_BYTES) throw new Error(label + " snapshot exceeds its byte limit.");
    const digest = createHash("sha256").update(file.source).digest("hex");
    if (digest !== file.content_sha256) throw new Error(label + " snapshot module digest is invalid.");
    files.set(file.path, file.source);
  }
  if (!files.has(tree.entrypoint)) throw new Error(label + " snapshot is missing its entrypoint.");
  const treeDigest = createHash("sha256");
  for (const [modulePath, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    treeDigest.update(modulePath).update("\0").update(createHash("sha256").update(source).digest("hex")).update("\n");
  }
  if (treeDigest.digest("hex") !== tree.sha256) throw new Error(label + " snapshot tree digest is invalid.");
  return files;
}

async function runModuleTree(tree, label, exportName, inputJson) {
  const sources = validateTree(tree, label);
  const context = vm.createContext(undefined, {
    name: "understudy-eval-" + label,
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(INIT_SOURCE, { filename: "understudy:sandbox-init" }).runInContext(context);
  const modules = new Map();
  const load = (modulePath) => {
    if (modules.has(modulePath)) return modules.get(modulePath);
    const source = sources.get(modulePath);
    if (source === undefined) throw new Error(label + " imports an undeclared module " + modulePath + ".");
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: label + ":" + modulePath,
    });
    modules.set(modulePath, module);
    return module;
  };
  const linker = async (specifier, referencingModule, attributes) => {
    if (attributes && Object.keys(attributes.attributes || {}).length > 0) {
      throw new Error(label + " import attributes are not allowed.");
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new Error(label + " imports are limited to relative modules; rejected " + specifier + ".");
    }
    if (specifier.includes("\\\\") || specifier.includes("?") || specifier.includes("#")) {
      throw new Error(label + " contains an unsafe relative import " + specifier + ".");
    }
    const prefix = label + ":";
    if (!referencingModule.identifier.startsWith(prefix)) throw new Error(label + " import origin is invalid.");
    const from = referencingModule.identifier.slice(prefix.length);
    const target = path.normalize(path.join(path.dirname(from), specifier));
    if (target === ".." || target.startsWith("../") || target.startsWith("/")) {
      throw new Error(label + " import escapes its module tree.");
    }
    return load(target);
  };
  const entrypoint = load(tree.entrypoint);
  await entrypoint.link(linker);
  await entrypoint.evaluate();
  if (Buffer.byteLength(inputJson) > MAX_INPUT_BYTES) throw new Error(label + " input exceeds its byte limit.");
  Object.defineProperty(context, "__understudyInputJson", {
    value: inputJson,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(context, "__understudyEntrypoint", {
    value: entrypoint.namespace,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(context, "__understudyExportName", { value: exportName, configurable: false, enumerable: false, writable: false });
  Object.defineProperty(context, "__understudyLabel", { value: label, configurable: false, enumerable: false, writable: false });
  const runner = new vm.SourceTextModule(RUNNER_SOURCE, { context, identifier: label + ":understudy-runner.mjs" });
  await runner.link(() => { throw new Error("Trusted sandbox runner cannot import modules."); });
  await runner.evaluate();
  const encoded = await runner.namespace.default;
  if (typeof encoded !== "string") throw new Error(label + " returned an invalid sandbox result.");
  const result = JSON.parse(encoded);
  if (!result.ok) throw new Error(String(result.error || label + " failed."));
  return result.value;
}

try {
  const inputJson = JSON.stringify(request.input);
  const replay = await runModuleTree(request.environment, "environment", "replay", inputJson);
  const verification = await runModuleTree(request.verifier, "verifier", "verify", JSON.stringify({
    task: request.input.task,
    replay,
  }));
  respond({ ok: true, replay, verification }, 0);
} catch (error) {
  respond({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
}
`;

export async function runInProviderFreeSandbox(
  environment: ModuleTreeSnapshot,
  verifier: ModuleTreeSnapshot,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ replay: unknown; verification: unknown }> {
  const nonce = randomUUID();
  const request = JSON.stringify({ nonce, environment, verifier, input });
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_CHILD_INPUT_BYTES) {
    throw new Error(`Local check input exceeds the ${MAX_CHILD_INPUT_BYTES}-byte sandbox input limit.`);
  }
  if (Buffer.byteLength(request) > MAX_CHILD_REQUEST_BYTES) {
    throw new Error(`Local check input exceeds the ${MAX_CHILD_REQUEST_BYTES}-byte sandbox limit.`);
  }

  return await new Promise<{ replay: unknown; verification: unknown }>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${CHILD_HEAP_MIB}`,
      "--permission",
      "--disallow-code-generation-from-strings",
      "--experimental-vm-modules",
      "--input-type=module",
      "--eval",
      CHECK_CHILD_SOURCE,
    ], {
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      stdio: ["pipe", "ignore", "pipe", "ipc"],
    });
    let response: ChildCheckResult | undefined;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else if (!response) rejectPromise(new Error(`Local check child exited without a result${stderr ? `: ${stderr.trim()}` : "."}`));
      else if (response.nonce !== nonce) rejectPromise(new Error("Local check child returned an unauthenticated result."));
      else if (!response.ok) rejectPromise(new Error(`Local check child failed: ${response.error ?? "unknown failure"}`));
      else resolvePromise({ replay: response.replay, verification: response.verification });
    };
    let terminationError: Error | undefined;
    const timer = setTimeout(() => {
      terminationError = new Error(`Local check child exceeded ${timeoutMs}ms and was terminated.`);
      if (!child.kill("SIGKILL")) finish(terminationError);
    }, timeoutMs);
    timer.unref();
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < MAX_CHILD_STDERR_BYTES) stderr += String(chunk).slice(0, MAX_CHILD_STDERR_BYTES - stderr.length);
    });
    child.on("message", (message) => {
      if (response !== undefined) {
        finish(new Error("Local check child returned more than one result."));
        return;
      }
      response = message as ChildCheckResult;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(terminationError));
    child.stdin!.end(request);
  });
}
