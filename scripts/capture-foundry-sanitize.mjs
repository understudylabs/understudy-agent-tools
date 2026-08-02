#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rawDir = process.env.CAPTURE_RAW_DIR;
const outDir = process.env.CAPTURE_FIXTURE_DIR ?? 'fixtures/workloads';
if (!rawDir) throw new Error('CAPTURE_RAW_DIR is required');
const files = fs.readdirSync(rawDir).filter((name) => name.endsWith('.jsonl'));
const sampleKeysPath = process.env.CAPTURE_SAMPLE_KEYS;
const populationKeysPath = process.env.CAPTURE_POPULATION_KEYS;
const keyGroup = (key) => {
  const parts = key.split('/');
  const prefix = key.includes('/api_key_') ? 'api_key' : 'project';
  const date = parts.length >= 4 ? parts.slice(-4, -1).join('/') : 'unknown';
  return `${prefix}:${date}`;
};
const keyForFile = new Map();
const sampleGroups = new Map();
if (sampleKeysPath) {
  for (const key of fs.readFileSync(sampleKeysPath, 'utf8').split('\n').filter(Boolean)) {
    const group = keyGroup(key);
    sampleGroups.set(group, (sampleGroups.get(group) ?? 0) + 1);
    keyForFile.set(crypto.createHash('sha256').update(key).digest('hex') + '.jsonl', group);
  }
}
const populationGroups = new Map();
if (populationKeysPath) {
  for (const key of fs.readFileSync(populationKeysPath, 'utf8').split('\n').filter(Boolean)) {
    const group = keyGroup(key);
    populationGroups.set(group, (populationGroups.get(group) ?? 0) + 1);
  }
}
const stats = new Map();
const observedWorkloads = new Set();
let totalRequests = 0;
for (const file of files) {
  for (const line of fs.readFileSync(path.join(rawDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    let body = row.customer_request_body ?? {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { continue; }
    }
    const workload = typeof row.workload_name === 'string' ? row.workload_name : 'unknown';
    observedWorkloads.add(workload);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const clusterId = crypto.createHash('sha256').update(JSON.stringify({
      message_roles: messages.map((message) => message?.role ?? typeof message),
      tool_count: tools.length,
      tool_choice_type: typeof body?.tool_choice,
      response_format_type: typeof body?.response_format,
    })).digest('hex').slice(0, 12);
    const key = `${workload}:${clusterId}`;
    if (!stats.has(key)) stats.set(key, {
      workload,
      cluster_id: clusterId,
      requests: 0,
      tokens: 0,
      shape: { tool_count: tools.length, message_roles: messages.map((message) => message?.role ?? 'unknown') },
    });
    const item = stats.get(key);
    const group = keyForFile.get(file);
    const weight = group && sampleGroups.get(group) ? (populationGroups.get(group) ?? 1) / sampleGroups.get(group) : 1;
    item.requests += weight;
    item.tokens += Number(body?.usage?.total_tokens ?? body?.max_tokens ?? Math.ceil(JSON.stringify(body).length / 4));
    totalRequests += weight;
  }
}
fs.mkdirSync(outDir, { recursive: true });
const workloadMap = new Map([...observedWorkloads].sort().map((name, index) => [name, `workload-${String(index).padStart(3, '0')}`]));
const ranking = [...stats.values()].map((value) => ({
  workload: workloadMap.get(value.workload),
  cluster_id: `${workloadMap.get(value.workload)}-${value.cluster_id}`,
  requests: value.requests,
  share: totalRequests ? value.requests / totalRequests : 0,
  tokens: value.tokens,
  tool_count: value.shape.tool_count,
  message_turns: value.shape.message_roles.length,
  description: `synthetic decision task with ${value.shape.tool_count} tool slots and ${value.shape.message_roles.length} message turns`,
})).sort((a, b) => b.requests - a.requests);
fs.writeFileSync('docs/synthetic-workload-repair-targets.md', '# Synthetic workload repair targets\n\n| Workload | Cluster | Requests | Share | Token volume | Shape |\n|---|---:|---:|---:|---:|---|\n' + ranking.map((r) => `| ${r.workload} | ${r.cluster_id} | ${r.requests} | ${r.share.toFixed(6)} | ${r.tokens} | ${r.description} |`).join('\n') + '\n');
for (const workload of [...new Set(ranking.map((row) => row.workload))]) {
  const observedShape = ranking.find((row) => row.workload === workload);
  const dir = path.join(outDir, workload); fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    schema: 'understudy.synthetic_workflow.fixture.v1',
    task_id: `${workload}-${String(i + 1).padStart(3, '0')}`,
    workload,
    split: i < 8 ? 'train' : i < 10 ? 'dev' : 'holdout',
    prompt: `Synthetic ${workload} task ${i + 1}: select the correct structured action.`,
    message_turns: observedShape?.message_turns ?? 0,
    tool_slots: Array.from({ length: observedShape?.tool_count ?? 0 }, (_, index) => `tool-${index}`),
    expected: { tool: 'finish', arguments: {} },
  }));
  const groups = { train: rows.slice(0, 8), dev: rows.slice(8, 10), holdout: rows.slice(10) };
  const hashes = {};
  for (const [split, values] of Object.entries(groups)) {
    const content = values.map((v) => JSON.stringify(v)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${split}.jsonl`), content);
    hashes[split] = crypto.createHash('sha256').update(content).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 'understudy.synthetic_workflow.fixture_manifest.v1',
    workload,
    counts: { train: 8, dev: 2, holdout: 2 },
    file_sha256: {
      'train.jsonl': hashes.train,
      'dev.jsonl': hashes.dev,
      'holdout.jsonl': hashes.holdout,
    },
    sealed_holdout_sha256: hashes.holdout,
    run_params: {
      source_sample_objects: files.length,
      synthetic_rows_per_split: { train: 8, dev: 2, holdout: 2 },
    },
  }, null, 2) + '\n');
}
fs.writeFileSync(path.join(outDir, 'ranking.json'), JSON.stringify({
  schema: 'understudy.synthetic_workflow.repair_targets.v1',
  ranking,
  source: 'local numeric aggregates only',
  sampling: {
    method: 'date-and-prefix stratified sample with inverse-probability weighting',
    sample_keys: sampleKeysPath ? fs.readFileSync(sampleKeysPath, 'utf8').split('\n').filter(Boolean).length : null,
    population_keys: populationKeysPath ? fs.readFileSync(populationKeysPath, 'utf8').split('\n').filter(Boolean).length : null,
  },
}, null, 2) + '\n');
