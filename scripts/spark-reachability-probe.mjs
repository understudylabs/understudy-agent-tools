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
    socks5Host: valueAfter(args, "--socks5-host", process.env.TAILSCALE_SOCKS5_HOST || "127.0.0.1"),
    socks5Port: Number(valueAfter(args, "--socks5-port", process.env.TAILSCALE_SOCKS5_PORT || "1055")),
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

function readExact(socket, size, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= size) {
        cleanup();
        resolve(buffer.subarray(0, size));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("SOCKS5 read timeout"));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onClose = () => onError(new Error("SOCKS5 socket closed"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function readSocks5ConnectReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected = null;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === null && buffer.length >= 4) {
        const addressLength = buffer[3] === 0x01 ? 4 : buffer[3] === 0x04 ? 16 : buffer[4] + 1;
        expected = 4 + addressLength + 2;
      }
      if (expected !== null && buffer.length >= expected) {
        cleanup();
        resolve(buffer.subarray(0, expected));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("SOCKS5 read timeout"));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onClose = () => onError(new Error("SOCKS5 socket closed"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  const socket = net.createConnection({ host: proxyHost, port: proxyPort });
  socket.setTimeout(timeoutMs);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("SOCKS5 proxy connect timeout")));
  });
  socket.setTimeout(0);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExact(socket, 2, timeoutMs);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
    throw new Error("SOCKS5 no-auth negotiation failed");
  }
  const host = Buffer.from(targetHost);
  if (host.length > 255) throw new Error("target host is too long");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
  ]));
  const reply = await readSocks5ConnectReply(socket, timeoutMs);
  const header = reply.subarray(0, 4);
  if (header[0] !== 0x05 || header[1] !== 0x00) {
    throw new Error(`SOCKS5 target connection failed (code ${header[1]})`);
  }
  return socket;
}

async function tcpReachable(proxyHost, proxyPort, host, port, timeoutMs) {
  try {
    const socket = await socks5Connect(proxyHost, proxyPort, host, port, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function httpProbe(proxyHost, proxyPort, host, port, timeoutMs) {
  let socket;
  try {
    socket = await socks5Connect(proxyHost, proxyPort, host, port, timeoutMs);
    socket.write(`GET /v1/models HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP response timeout")), timeoutMs);
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const responseText = Buffer.concat(chunks).toString("utf8");
    const separator = responseText.indexOf("\r\n\r\n");
    const headers = separator >= 0 ? responseText.slice(0, separator) : responseText;
    const body = separator >= 0 ? responseText.slice(separator + 4) : "";
    const statusMatch = headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
    const payload = (() => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })();
    return {
      ok: statusMatch ? Number(statusMatch[1]) >= 200 && Number(statusMatch[1]) < 300 : false,
      status: statusMatch ? Number(statusMatch[1]) : null,
      models: Array.isArray(payload?.data) ? payload.data.map((model) => model.id).filter(Boolean) : [],
      adapters: Array.isArray(payload?.adapters) ? payload.adapters : [],
    };
  } catch (error) {
    return { ok: false, status: null, models: [], adapters: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    socket?.destroy();
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
    const tcp22 = await tcpReachable(options.socks5Host, options.socks5Port, node.ip, 22, options.timeoutMs);
    const serving = await httpProbe(options.socks5Host, options.socks5Port, node.ip, options.port, options.timeoutMs);
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
