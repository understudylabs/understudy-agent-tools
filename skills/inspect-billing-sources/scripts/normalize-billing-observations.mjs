#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { from: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") {
      args.from = argv[++index];
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  node skills/inspect-billing-sources/scripts/normalize-billing-observations.mjs \\
    --from .understudy/billing-sources/observations.json \\
    --out .understudy/billing-sources/hotspots.json
`;
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asString(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function addMetric(target, key, value) {
  const number = asNumber(value);
  if (number !== null) target[key] = (target[key] ?? 0) + number;
}

function confidenceFor(row) {
  if (row.usage_usd !== null && row.model !== "unknown" && row.label !== "unattributed") {
    return "high";
  }
  if (row.usage_usd !== null || row.request_count !== null) return "medium";
  return "unknown";
}

function cacheFlag(row) {
  const cacheRead = row.cache_read_input_tokens;
  const input = row.input_tokens;
  if (cacheRead === 0 && input && input > 10000) return "cache-read-zero";
  if (cacheRead === null && input && input > 10000) return "cache-fields-missing";
  return null;
}

function normalize(input) {
  if (input?.schema_version !== "understudy.billing_observations.v1") {
    throw new Error("Expected schema_version understudy.billing_observations.v1");
  }
  const groups = new Map();
  const sourceSummary = [];

  for (const source of input.sources ?? []) {
    const provider = asString(source.provider, "unknown").toLowerCase();
    const period = asString(source.period, "unknown");
    const sourceType = asString(source.source, "manual");
    const rows = Array.isArray(source.rows) ? source.rows : [];
    sourceSummary.push({
      source: sourceType,
      provider,
      period,
      invoice_total_usd: asNumber(source.invoice_total_usd),
      rows: rows.length,
    });

    for (const row of rows) {
      const label = asString(row.label ?? row.route ?? row.owner, "unattributed");
      const model = asString(row.model, "unknown").toLowerCase();
      const key = `${provider}\t${period}\t${model}\t${label}`;
      const current =
        groups.get(key) ?? {
          provider,
          period,
          model,
          label,
          usage_usd: 0,
          request_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          sources: new Set(),
        };

      addMetric(current, "usage_usd", row.usage_usd);
      addMetric(current, "request_count", row.request_count);
      addMetric(current, "input_tokens", row.input_tokens);
      addMetric(current, "output_tokens", row.output_tokens);

      const cacheRead = asNumber(row.cache_read_input_tokens);
      if (cacheRead !== null) {
        current.cache_read_input_tokens = (current.cache_read_input_tokens ?? 0) + cacheRead;
      }
      const cacheCreation = asNumber(row.cache_creation_input_tokens);
      if (cacheCreation !== null) {
        current.cache_creation_input_tokens =
          (current.cache_creation_input_tokens ?? 0) + cacheCreation;
      }
      current.sources.add(sourceType);
      groups.set(key, current);
    }
  }

  const hotspots = [...groups.values()]
    .map((row) => {
      const normalized = {
        provider: row.provider,
        period: row.period,
        model: row.model,
        label: row.label,
        usage_usd: row.usage_usd || null,
        request_count: row.request_count || null,
        input_tokens: row.input_tokens || null,
        output_tokens: row.output_tokens || null,
        cache_read_input_tokens: row.cache_read_input_tokens,
        cache_creation_input_tokens: row.cache_creation_input_tokens,
        sources: [...row.sources].sort(),
      };
      const flags = [];
      if (/opus/.test(normalized.model)) flags.push("premium-model");
      const cache = cacheFlag(normalized);
      if (cache) flags.push(cache);
      if (normalized.label === "unattributed") flags.push("unattributed");
      return {
        ...normalized,
        flags,
        confidence: confidenceFor(normalized),
      };
    })
    .sort((a, b) => (b.usage_usd ?? 0) - (a.usage_usd ?? 0));

  return {
    schema_version: "understudy.billing_hotspots.v1",
    generated_at: new Date().toISOString(),
    source_summary: sourceSummary,
    totals: {
      usage_usd: hotspots.reduce((sum, row) => sum + (row.usage_usd ?? 0), 0),
      request_count: hotspots.reduce((sum, row) => sum + (row.request_count ?? 0), 0),
      input_tokens: hotspots.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
      output_tokens: hotspots.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    },
    hotspots,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.from) {
    throw new Error(`Missing --from\n${usage()}`);
  }

  const input = JSON.parse(await readFile(args.from, "utf8"));
  const output = normalize(input);
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, text, "utf8");
  } else {
    process.stdout.write(text);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
