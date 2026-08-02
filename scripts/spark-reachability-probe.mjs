#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_NODES = [
  { name: "understudy-alpha", ip: "100.109.118.78" },
  { name: "understudy-bravo", ip: "100.100.181.10" },
];

function valueAfter(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parseArgs(args) {
  const nodes = [
    { name: "understudy-alpha", ip: process.env.SPARK_ALPHA_IP || DEFAULT_NODES[0].ip },
    { name: "understudy-bravo", ip: process.env.SPARK_BRAVO_IP || DEFAULT_NODES[1].ip },
  ];
  const nodeArgs = args.filter((arg) => arg.startsWith("--node=")).map((arg) => arg.slice("--node=".length));
  if (nodeArgs.length > 0) {
    nodes.splice(0, nodes.length, ...nodeArgs.map((value) => {
      const [name, ip] = value.split("=", 2);
      return { name: name || ip, ip: ip || name };
    }));
  }
  return {
    socket: valueAfter(args, "--socket", process.env.TAILSCALE_SOCKET || `${process.env.HOME}/.tailscale/tailscaled.sock`),
    port: Number(valueAfter(args, "--port", process.env.SPARK_SERVING_PORT || "5153")),
    timeoutMs: Number(valueAfter(args, "--timeout-ms", process.env.SPARK_PROBE_TIMEOUT_MS || "1500")),
    nodes,
  };
}

function commandJson(command, args, timeoutMs) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function peerFor(status, ip) {
  const peers = Object.values(status?.Peer ?? {});
  return peers.find((peer) => peer.TailscaleIPs?.includes(ip) || peer.HostName === ip || peer.DNSName?.startsWith(`${ip}.`)) ?? null;
}

function tcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function httpProbe(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      models: Array.isArray(payload?.data) ? payload.data.map((model) => model.id).filter(Boolean) : [],
      adapters: Array.isArray(payload?.adapters) ? payload.adapters : [],
    };
  } catch (error) {
    return { ok: false, status: null, models: [], adapters: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function probe(options = parseArgs(process.argv.slice(2))) {
  const status = commandJson("tailscale", ["--socket", options.socket, "status", "--json"], options.timeoutMs);
  const result = {
    schema_version: "understudy.spark_reachability_probe.v1",
    state: status ? (status.BackendState ?? "unknown").toLowerCase() : "not_enrolled",
    socket: options.socket,
    nodes: [],
  };
  for (const node of options.nodes) {
    const peer = peerFor(status, node.ip);
    const tcp22 = await tcpReachable(node.ip, 22, options.timeoutMs);
    const serving = await httpProbe(`http://${node.ip}:${options.port}/v1/models`, options.timeoutMs);
    result.nodes.push({
      name: node.name,
      ip: node.ip,
      peer: {
        present: Boolean(peer),
        online: peer?.Online === true,
        hostname: peer?.HostName ?? null,
      },
      tcp_22: tcp22,
      serving,
    });
  }
  result.ok = result.state === "running" && result.nodes.every((node) =>
    node.peer.present && node.peer.online && node.tcp_22 && node.serving.ok);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(
    `spark probe: state=${result.state} ${result.nodes.map((node) =>
      `${node.name} peer=${node.peer.online ? "online" : "offline"} ssh=${node.tcp_22 ? "ok" : "fail"} serving=${node.serving.ok ? "ok" : "fail"}`).join(" ")}\n`,
  );
  process.exitCode = result.ok ? 0 : 1;
}
