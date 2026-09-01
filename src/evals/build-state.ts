import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createPrivateDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Private path must be a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export function replacePrivateJson(path: string, value: unknown): void {
  replacePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function replacePrivateText(path: string, body: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function ensureUnderstudyGitExcluded(output: string): void {
  const absoluteOutput = resolve(output);
  let existing = resolve(output);
  while (!pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return;
    existing = parent;
  }
  const canonicalExisting = realpathSync(existing);
  const canonicalOutput = resolve(canonicalExisting, relative(existing, absoluteOutput));
  const rootResult = spawnSync("git", ["-C", canonicalExisting, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (rootResult.status !== 0) return;
  const root = rootResult.stdout.trim();
  const relativeOutput = relative(root, canonicalOutput);
  if (relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) return;
  if (relativeOutput === ".understudy") {
    throw new Error(`Eval build destination must be a child directory under ${join(root, ".understudy")}; the root itself is reserved.`);
  }
  if (relativeOutput !== ".understudy" && !relativeOutput.startsWith(`.understudy${sep}`)) {
    throw new Error(`Eval builds inside a Git repository must use a destination under ${join(root, ".understudy")}.`);
  }

  const excludeResult = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (excludeResult.status !== 0) return;
  const rawExcludePath = excludeResult.stdout.trim();
  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(root, rawExcludePath);
  mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  const current = pathExists(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (current.split(/\r?\n/).includes("/.understudy/")) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(excludePath, `${current}${separator}/.understudy/\n`, { encoding: "utf8", mode: 0o600 });
}

interface LeaseOwner {
  token: string;
  pid: number;
  process_instance_id?: string;
  created_at: string;
}

function processInstanceId(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (!bootId || commandEnd === -1) return null;
      const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTimeTicks = fieldsAfterCommand[19];
      if (!/^\d+$/.test(startTimeTicks ?? "")) return null;
      return `linux-proc-v1:${pid}:${bootId}:${startTimeTicks}`;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", LANG: "C" },
      timeout: 1_000,
      maxBuffer: 1_024,
    });
    const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    return startedAt ? `darwin-ps-v1:${pid}:${startedAt}` : null;
  }

  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireEvalBuildLease(output: string): () => void {
  const leasePath = join(dirname(output), `.${basename(output)}.eval-build.lock`);
  mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(leasePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: LeaseOwner | null = null;
    try {
      owner = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as LeaseOwner;
    } catch {
      throw new Error(`Another eval build owns ${output}; lock metadata is incomplete at ${leasePath}.`);
    }
    if (Number.isInteger(owner.pid) && processIsAlive(owner.pid)) {
      const observedProcessInstanceId = processInstanceId(owner.pid);
      if (
        typeof owner.process_instance_id !== "string" ||
        observedProcessInstanceId === null ||
        owner.process_instance_id === observedProcessInstanceId
      ) {
        throw new Error(`Another eval build (pid ${owner.pid}) already owns ${output}.`);
      }
    }
    throw new Error(`A stale eval build lock remains at ${leasePath} (owner pid ${owner.pid}). Remove that exact lock directory, then rerun to resume.`);
  }
  const instanceId = processInstanceId(process.pid);
  const owner: LeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    ...(instanceId === null ? {} : { process_instance_id: instanceId }),
    created_at: new Date().toISOString(),
  };
  try {
    writePrivateJson(join(leasePath, "owner.json"), owner);
  } catch (error) {
    rmSync(leasePath, { recursive: true, force: true });
    throw error;
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as LeaseOwner;
      if (current.token === owner.token) rmSync(leasePath, { recursive: true, force: true });
    } catch {
      // A missing lock is already released; a replaced lock belongs to another process.
    }
  };
}
