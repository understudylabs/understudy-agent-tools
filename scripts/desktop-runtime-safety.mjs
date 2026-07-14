import { basename } from "node:path";

const MLX_SERVER_EXECUTABLES = new Set([
  "mlx-vlm-server",
  "mlx_vlm.server",
  "mlx_vlm.server.py",
]);

export function parseProcessTable(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    }));
}

function commandTokens(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

function flagValue(tokens, flag) {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] ?? null : null;
}

export function inspectMlxServerProcess(process) {
  const tokens = commandTokens(process.command);
  const launcher = basename(tokens[0] ?? "");
  const launchedByPython = /^python(?:\d+(?:\.\d+)*)?$/.test(launcher);
  const executableIndex = tokens.findIndex((token) =>
    MLX_SERVER_EXECUTABLES.has(basename(token)),
  );
  const moduleIndex = tokens.findIndex(
    (token, index) => token === "mlx_vlm.server" && tokens[index - 1] === "-m",
  );
  const directEntrypoint =
    executableIndex === 0 || (launchedByPython && executableIndex === 1);
  const pythonModule = launchedByPython && moduleIndex >= 2;
  if (!directEntrypoint && !pythonModule) return null;

  return {
    pid: process.pid,
    ppid: process.ppid,
    model: flagValue(tokens, "--model"),
    port: flagValue(tokens, "--port"),
  };
}

export function findActiveMlxServers(raw) {
  return parseProcessTable(raw)
    .map(inspectMlxServerProcess)
    .filter(Boolean);
}

export function modelDisplayName(model) {
  if (!model) return null;
  const cacheSegment = model
    .split(/[\\/]/)
    .find((segment) => segment.startsWith("models--"));
  if (cacheSegment) {
    return cacheSegment.slice("models--".length).replaceAll("--", "/");
  }
  return basename(model);
}

export function formatActiveMlxServers(servers) {
  return servers
    .map((server) => {
      const model = modelDisplayName(server.model);
      const details = [
        `pid ${server.pid}`,
        server.port ? `port ${server.port}` : null,
        model ? `model ${model}` : null,
      ].filter(Boolean);
      return details.join(", ");
    })
    .join("; ");
}
