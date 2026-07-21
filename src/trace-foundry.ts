import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type J = null | boolean | number | string | J[] | { [key: string]: J };
type Obj = Record<string, any>;

export type FoundryResult = {
  schema_version: "understudy.trace_foundry.v1";
  source: string;
  output_dir: string;
  freshness: { max_age_days: number; cutoff_utc: string; newest_capture_utc: string };
  counts: { source_files: number; captures: number; tasks: number; edges: number; stale_filtered: number; invalid_timestamp_filtered: number };
  artifacts: Record<string, string>;
  privacy: { local_only: true; contains_customer_payloads: true; upload_performed: false; provider_called: false };
};

const mutationPrefixes = ["add-", "apply-", "archive-", "cancel-", "create-", "delete-", "draft-", "mark-", "move-", "notify-", "promote-", "reassign-", "remove-", "save-", "send-", "set-", "share-", "update-", "write-"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asObject = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const jsonish = (value: unknown): unknown => {
  let current = value;
  for (let i = 0; i < 3 && typeof current === "string"; i += 1) {
    const text = current.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) break;
    try { current = JSON.parse(text); } catch { break; }
  }
  return current;
};
const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => asObject(b).text ?? "").join("") : "";
const iso = (value: unknown): string | null => {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
};

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`Capture source does not exist: ${root}`);
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && [".json", ".jsonl", ".ndjson"].some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  }).sort();
}

function envelopes(path: string): Obj[] {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(asObject);
    const object = asObject(parsed);
    const rows = object.captures ?? object.data;
    return Array.isArray(rows) ? rows.map(asObject) : [object];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => asObject(JSON.parse(line)));
}

function responseProjection(raw: unknown): Obj {
  let isJson = false;
  if (typeof raw === "string") {
    try { JSON.parse(raw.trim()); isJson = true; } catch { /* non-JSON transport */ }
  }
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : [];
  if (!isJson && lines.some((line) => line.trimStart().startsWith("data:"))) {
    const events = lines.filter((line) => line.trimStart().startsWith("data:") && !line.includes("[DONE]")).flatMap((line) => {
      try { return [asObject(JSON.parse(line.trimStart().slice(5).trim()))]; } catch { return []; }
    });
    const toolCalls: Obj[] = [];
    for (const event of events) {
      const block = asObject(event.content_block);
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      for (const choice of Array.isArray(event.choices) ? event.choices : []) {
        for (const call of asObject(choice).delta?.tool_calls ?? []) toolCalls.push(asObject(call));
      }
    }
    return { encoding: "sse", events, tool_calls: toolCalls, stop_reason: events.at(-1)?.delta?.stop_reason ?? null };
  }
  const parsed = jsonish(raw);
  const object = asObject(parsed);
  const calls: Obj[] = [];
  for (const block of Array.isArray(object.content) ? object.content : []) {
    const b = asObject(block);
    if (b.type === "tool_use") calls.push({ id: b.id, name: b.name, arguments: b.input ?? {} });
  }
  for (const call of Array.isArray(object.tool_calls) ? object.tool_calls : []) calls.push(asObject(call));
  return { encoding: "json", body: parsed as J, tool_calls: calls, stop_reason: object.stop_reason ?? object.stopReason ?? null };
}

function normalize(envelope: Obj, pointer: string): Obj | null {
  const version = Number(envelope.schema_version ?? 4);
  if (![2, 3, 4].includes(version)) throw new Error(`Unsupported capture schema_version ${version}`);
  const requestRaw = envelope.customer_request_body ?? envelope.request_body ?? envelope.request;
  const responseRaw = envelope.response_body ?? envelope.customer_response_body ?? envelope.response;
  const request = asObject(jsonish(requestRaw));
  const messages = Array.isArray(request.messages) ? request.messages.map(asObject) : [];
  const tools = Array.isArray(request.tools) ? request.tools.map(asObject) : [];
  const capturedAt = iso(envelope.ts ?? envelope.created_at ?? envelope.uploaded);
  if (capturedAt === null) return null;
  const captureId = String(envelope.request_id ?? envelope.id ?? hash(envelope).slice(0, 24));
  return {
    schema_version: "understudy.normalized_capture.v1", capture_id: captureId, captured_at: capturedAt,
    source: { pointer, sha256: hash(envelope) },
    scope: { org_id: envelope.workos_org_id ?? envelope.org_id ?? null, project_id: envelope.project_id ?? null, workload_id: envelope.workload_id ?? envelope.placement_id ?? null, workload_name: envelope.workload_name ?? null },
    routing: { provider: envelope.provider ?? null, requested_model: envelope.requested_model ?? request.model ?? null, upstream_model: envelope.upstream_model ?? null },
    transport: { endpoint: envelope.endpoint ?? null, status_code: envelope.status_code ?? null, latency_ms: envelope.latency_ms ?? null },
    request: { system: request.system ?? null, messages, tools, settings: Object.fromEntries(Object.entries(request).filter(([k]) => !["system", "messages", "tools"].includes(k))) },
    response: responseProjection(responseRaw), raw: { request: requestRaw ?? null, response: responseRaw ?? null },
    fingerprints: { group: hash({ system: request.system ?? null, first_user: messages.find((m) => m.role === "user") ?? null }), messages: messages.map(hash), sequence: hash(messages) },
  };
}

function commonPrefix(a: string[], b: string[]): number { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n += 1; return n; }
function buildDag(rows: Obj[]): Obj {
  const groups = new Map<string, Obj[]>();
  for (const row of rows) groups.set(row.fingerprints.group, [...(groups.get(row.fingerprints.group) ?? []), row]);
  const nodes: Obj[] = [], edges: Obj[] = [], groupRows: Obj[] = [];
  for (const [groupId, captures] of groups) {
    captures.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const roots: string[] = [];
    captures.forEach((capture, index) => {
      nodes.push({ id: capture.capture_id, execution_group: groupId, captured_at: capture.captured_at, message_count: capture.request.messages.length, has_error: Number(capture.transport.status_code ?? 200) >= 400, source: capture.source });
      if (index === 0) { roots.push(capture.capture_id); return; }
      const prior = captures.slice(0, index);
      const candidates = prior.map((parent) => ({ parent, prefix: commonPrefix(parent.fingerprints.messages, capture.fingerprints.messages) })).sort((a, b) => b.prefix - a.prefix || b.parent.captured_at.localeCompare(a.parent.captured_at));
      const best = candidates[0];
      if (!best) { roots.push(capture.capture_id); return; }
      const p = best.parent.fingerprints.messages as string[], c = capture.fingerprints.messages as string[];
      const type = p.length === c.length && best.prefix === p.length ? "retry" : best.prefix === p.length ? "prefix_append" : best.prefix > 0 ? "branch" : "destructive_mutation";
      edges.push({ from: best.parent.capture_id, to: capture.capture_id, type, execution_group: groupId, confidence: type === "destructive_mutation" ? "low" : "deterministic", evidence: { common_prefix_messages: best.prefix } });
    });
    groupRows.push({ id: groupId, capture_count: captures.length, edge_count: Math.max(0, captures.length - 1), roots });
  }
  return { schema_version: "understudy.source_dag.v1", valid: true, nodes, edges, groups: groupRows };
}

function toolEvents(captures: Obj[]): Obj[] {
  const events: Obj[] = [];
  for (const capture of captures) {
    for (const message of capture.request.messages) for (const blockValue of Array.isArray(message.content) ? message.content : []) {
      const block = asObject(blockValue);
      if (["tool_use", "tool_call"].includes(block.type)) events.push({ kind: "call", id: block.id, name: block.name, arguments: block.input ?? block.arguments ?? {} });
      if (["tool_result", "tool_response"].includes(block.type)) events.push({ kind: "result", id: block.tool_use_id ?? block.id, status: block.is_error ? "error" : "ok", content: block.content });
    }
    for (const callValue of capture.response.tool_calls ?? []) { const call = asObject(callValue), fn = asObject(call.function); events.push({ kind: "call", id: call.id, name: call.name ?? fn.name, arguments: call.arguments ?? fn.arguments ?? {} }); }
  }
  return [...new Map(events.map((event) => [hash(event), event])).values()];
}

function tasksFrom(dag: Obj, rows: Obj[]): Obj[] {
  const byId = new Map(rows.map((row) => [row.capture_id, row]));
  return dag.groups.map((group: Obj) => {
    const nodes = dag.nodes.filter((node: Obj) => node.execution_group === group.id).sort((a: Obj, b: Obj) => a.captured_at.localeCompare(b.captured_at));
    const captures = nodes.map((node: Obj) => byId.get(node.id)).filter(Boolean) as Obj[];
    const root = captures[0], first = root.request.messages.find((m: Obj) => m.role === "user") ?? {};
    const events = toolEvents(captures), calls = events.filter((e) => e.kind === "call" && e.name), mutations = calls.filter((e) => mutationPrefixes.some((prefix) => String(e.name).toLowerCase().startsWith(prefix)));
    const required = mutations.map((call) => ({ type: "state_effect", tool: call.name, observed_arguments: call.arguments, matching: "semantic_outcome_not_exact_trajectory", confidence: "medium" }));
    const confidence = required.length > 0 && !events.some((e) => e.status === "error") ? "high" : calls.length > 0 ? "medium" : "low";
    const bucket = Number.parseInt(hash(group.id).slice(0, 8), 16) % 100;
    return { schema_version: "understudy.benchmark_task.v1", task_id: `task-${group.id.slice(0, 16)}`, execution_group: group.id, title: contentText(first.content).trim().slice(0, 160) || `Trace group ${group.id.slice(0, 8)}`, status: confidence === "high" ? "machine_proposed" : "needs_review", split: bucket < 70 ? "construction" : bucket < 90 ? "fit" : "heldout", candidate_boundary: root.capture_id, machine_confidence: confidence, close_call: confidence !== "high", tool_surface: [...new Set(calls.map((e) => e.name))].sort(), source: { node_ids: nodes.map((n: Obj) => n.id), edges: dag.edges.filter((e: Obj) => e.execution_group === group.id), captures: nodes.map((n: Obj) => ({ capture_id: n.id, ...n.source })) }, world_model: { status: "machine_proposed", initial_state: { source: "observed_tool_results", materialized: false }, transitions: required }, outcome_contract: { status: "machine_proposed", required, preserved: [], forbidden: [], grading: "final_state_and_obligations" }, claims: [...calls.map((c) => ({ kind: "observed", claim: `tool ${c.name} was called`, source_call_id: c.id })), ...mutations.map((c) => ({ kind: "inferred", claim: `${c.name} appears to mutate state`, confidence: "medium" }))], sentinels: [], review: { decision: "pending_final_judgment" } };
  });
}

const viewerHtml = (payload: Obj) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Understudy · benchmark orchard</title><style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');:root{--ink:#e7e8ea;--bright:#f2f2f0;--dim:#9b9da3;--line:rgba(255,255,255,.09);--hover:#1c1e25;--mint:#9edbd3;--violet:#a78bfa;--cyan:#67e8f9;--good:#6ee7a0;--bad:#f85149;--mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif}*{box-sizing:border-box}body{margin:0;background:#000;color:var(--ink);font:13px var(--sans);overflow:hidden}header{height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:20px;padding:0 18px}header b,label,nav button{font:500 10px var(--mono);letter-spacing:.15em;text-transform:uppercase}.brand{color:var(--bright)}.brand:before{content:'';display:inline-block;width:7px;height:7px;border:1px solid var(--mint);border-radius:50%;margin-right:10px}.meta{color:var(--dim);flex:1}.grid{height:calc(100vh - 56px);display:grid;grid-template-columns:260px minmax(340px,.82fr) minmax(460px,1.18fr)}aside,section{min-width:0;border-right:1px solid var(--line);display:flex;flex-direction:column}.head{height:54px;border-bottom:1px solid var(--line);padding:0 14px;display:flex;align-items:center;justify-content:space-between;color:var(--dim)}.scroll{overflow:auto;min-height:0}.tasks{padding:7px}.task{width:100%;display:grid;grid-template-columns:30px 1fr;gap:8px;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);padding:11px 8px;cursor:pointer}.task:hover,.task.on{background:var(--hover)}.num,.sub{font:10px var(--mono);color:var(--dim)}.title{font-size:12px;line-height:1.45}.lineage{position:relative;padding:26px 20px}.lineage:before{content:'';position:absolute;left:40px;top:26px;bottom:30px;width:1px;background:linear-gradient(var(--violet),var(--cyan),transparent)}.node{position:relative;padding-left:40px;margin-bottom:9px}.node:before{content:'';position:absolute;left:14px;top:15px;width:11px;height:11px;border:1px solid var(--violet);border-radius:50%;background:#000;z-index:2}.node.on:before{background:var(--cyan);border-color:var(--cyan);box-shadow:0 0 16px #67e8f966}.node button{width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:10px;cursor:pointer}.node.on button{border-color:#67e8f977;background:#67e8f90b}.edge{display:block;margin-top:6px;color:var(--violet);font:9px var(--mono);text-transform:uppercase;letter-spacing:.08em}.inspect-head{padding:13px 17px 0;border-bottom:1px solid var(--line)}.eyebrow{color:var(--mint);font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em}h1{font:400 18px/1.35 var(--mono);margin:8px 0 12px;color:var(--bright)}nav{display:flex;gap:18px}nav button{border:0;border-bottom:1px solid transparent;background:none;color:var(--dim);padding:9px 0;cursor:pointer}nav button.on{color:var(--bright);border-color:var(--mint)}.body{padding:20px 20px 95px}.lede{font-size:14px;line-height:1.6;color:var(--bright)}.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;margin:18px 0}.fact{padding:12px;border-right:1px solid var(--line)}.fact:last-child{border:0}.fact b{display:block;margin-top:5px;font:13px var(--mono)}details{border-top:1px solid var(--line)}summary{padding:12px 0;cursor:pointer;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--dim)}pre{white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;background:#08090b;border:1px solid var(--line);border-radius:8px;padding:13px;font:11px/1.55 var(--mono)}.mode{display:flex;justify-content:flex-end;gap:5px}.mode button,.review button,header button{border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:7px 9px;cursor:pointer}.mode button.on{background:var(--hover)}.review{position:sticky;bottom:0;margin-top:auto;padding:12px 16px;border-top:1px solid var(--line);background:#0e0f12ee;display:flex;justify-content:flex-end;gap:6px}.review .accept{color:var(--good);border-color:var(--good)}@media(max-width:850px){.grid{grid-template-columns:220px 300px 1fr}}</style></head><body><header><b class="brand">benchmark orchard</b><span class="meta" id="meta"></span><button onclick="exportReviews()">Export reviews</button></header><main class="grid"><aside><div class="head"><label>Task inbox</label><span id="tc"></span></div><div class="tasks scroll" id="tasks"></div></aside><section><div class="head"><label>Source lineage</label><span id="nc"></span></div><div class="lineage scroll" id="dag"></div></section><section><div class="inspect-head"><div class="eyebrow" id="eye"></div><h1 id="title"></h1><nav id="tabs"></nav></div><div class="body scroll" id="body"></div><div class="review"><button class="accept" onclick="judge('accept')">Accept</button><button onclick="judge('restrict')">Restrict</button><button onclick="judge('needs_more')">Needs more</button><button onclick="judge('reject')">Reject</button></div></section></main><script>const D=${JSON.stringify(payload).replaceAll("</", "<\\/")};let task=D.tasks[0],node=task.candidate_boundary,tab='task',mode='parsed';const cache={},reviews=JSON.parse(localStorage.getItem('understudy-reviews')||'{}'),e=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])),p=x=>e(JSON.stringify(x,null,2));async function load(){if(!cache[node])cache[node]=await fetch(D.captures[node].path).then(r=>r.json())}function render(){document.querySelector('#meta').textContent=D.tasks.length+' tasks · '+D.nodes.length+' captures · local evidence';document.querySelector('#tc').textContent=D.tasks.length+' tasks';document.querySelector('#tasks').innerHTML=D.tasks.map((t,i)=>'<button class="task '+(t.task_id===task.task_id?'on':'')+'" onclick="pickTask(\''+t.task_id+'\')"><span class="num">'+String(i+1).padStart(2,'0')+'</span><span><span class="title">'+e(t.title)+'</span><br><span class="sub">'+e(t.split)+' · '+e(reviews[t.task_id]?.decision||t.status)+'</span></span></button>').join('');const ids=new Set(task.source.node_ids),ns=D.nodes.filter(n=>ids.has(n.id)).sort((a,b)=>a.captured_at.localeCompare(b.captured_at));document.querySelector('#nc').textContent=ns.length+' rounds';document.querySelector('#dag').innerHTML=ns.map((n,i)=>{const x=task.source.edges.find(x=>x.to===n.id);return '<div class="node '+(n.id===node?'on':'')+'"><button onclick="pickNode(\''+n.id+'\')"><span class="sub">round '+String(i+1).padStart(2,'0')+' · '+n.id.slice(0,8)+'</span><br>'+n.message_count+' messages<span class="edge">'+e(x?.type||'root boundary')+'</span></button></div>'}).join('');document.querySelector('#eye').textContent=task.task_id+' · '+task.machine_confidence+' confidence';document.querySelector('#title').textContent=task.title;document.querySelector('#tabs').innerHTML=['task','request','response','contract'].map(x=>'<button class="'+(tab===x?'on':'')+'" onclick="setTab(\''+x+'\')">'+x+'</button>').join('');const c=cache[node]||{};if(tab==='task')document.querySelector('#body').innerHTML='<p class="lede">The machine assembled this task from '+task.source.node_ids.length+' captured rounds and proposed a stateful verifier. Human judgment controls final promotion.</p><div class="facts"><div class="fact"><label>Confidence</label><b>'+task.machine_confidence+'</b></div><div class="fact"><label>Split</label><b>'+task.split+'</b></div><div class="fact"><label>Tools</label><b>'+task.tool_surface.length+'</b></div></div><details open><summary>Machine claims</summary><pre>'+p(task.claims)+'</pre></details>';else if(tab==='contract')document.querySelector('#body').innerHTML='<p class="lede">Grade the resulting state—not an exact historical trajectory.</p><details open><summary>Outcome contract</summary><pre>'+p(task.outcome_contract)+'</pre></details><details><summary>World model</summary><pre>'+p(task.world_model)+'</pre></details>';else{const value=c[tab]||{},raw=c.raw?.[tab],rawText=typeof raw==='string'?raw:JSON.stringify(raw??value,null,2);document.querySelector('#body').innerHTML='<div class="mode"><button class="'+(mode==='parsed'?'on':'')+'" onclick="setMode(\'parsed\')">Parsed JSON</button><button class="'+(mode==='raw'?'on':'')+'" onclick="setMode(\'raw\')">Raw</button></div>'+(mode==='raw'?'<p class="sub">'+(raw!=null?'preserved source representation':'canonical serialization · original unavailable')+'</p><pre>'+e(rawText)+'</pre>':Object.entries(value).map(([k,v])=>'<details open><summary>'+e(k)+'</summary><pre>'+p(v)+'</pre></details>').join(''))}}async function pickTask(id){task=D.tasks.find(t=>t.task_id===id);node=task.candidate_boundary;tab='task';await load();render()}async function pickNode(id){node=id;tab='request';mode='parsed';await load();render()}function setTab(x){tab=x;mode='parsed';render()}function setMode(x){mode=x;render()}function judge(x){reviews[task.task_id]={decision:x,reviewed_at:new Date().toISOString()};localStorage.setItem('understudy-reviews',JSON.stringify(reviews));render()}function exportReviews(){const s=Object.entries(reviews).map(([task_id,r])=>JSON.stringify({task_id,...r})).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([s+'\n'],{type:'application/x-ndjson'}));a.download='benchmark-reviews.jsonl';a.click()}load().then(render)</script></body></html>`;

function writeJson(path: string, value: unknown): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function writeJsonl(path: string, rows: Obj[]): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); }

export function compileTraceFoundry(sourceInput: string, outputInput: string, maxAgeDays = 3, now = new Date()): FoundryResult {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) throw new Error("--max-age-days must be a positive integer");
  const source = resolve(sourceInput), output = resolve(outputInput), files = sourceFiles(source), cutoff = new Date(now.valueOf() - maxAgeDays * 86_400_000);
  const all: Obj[] = [];
  let invalidTimestampFiltered = 0;
  for (const file of files) for (const [index, envelope] of envelopes(file).entries()) {
    const row = normalize(envelope, `${relative(source, file) || file}#L${index + 1}`);
    if (row === null) invalidTimestampFiltered += 1;
    else all.push(row);
  }
  const rows = all.filter((row) => new Date(row.captured_at) >= cutoff);
  if (rows.length === 0) throw new Error(`No captures satisfy --max-age-days ${maxAgeDays}; cutoff ${cutoff.toISOString()}. Refusing to compile a stale benchmark.`);
  const dag = buildDag(rows), tasks = tasksFrom(dag, rows), viewer = join(output, "viewer"), capturesDir = join(viewer, "data", "captures");
  mkdirSync(capturesDir, { recursive: true });
  const captureIndex: Obj = {};
  for (const row of rows) {
    const fileId = hash({ capture_id: row.capture_id, source_sha256: row.source.sha256 }).slice(0, 40);
    const path = join(capturesDir, `${fileId}.json`);
    writeJson(path, row);
    captureIndex[row.capture_id] = { path: `data/captures/${fileId}.json`, source: row.source };
  }
  writeJsonl(join(output, "normalized-captures.jsonl"), rows); writeJson(join(output, "source-dag.json"), dag); writeJsonl(join(output, "tasks.jsonl"), tasks);
  writeJson(join(output, "benchmark.json"), { schema_version: "understudy.benchmark.v1", status: "machine_compiled_review_pending", executable: false, promotion_blockers: ["human_final_judgment", "sentinel_tests"], tasks: tasks.map((task) => ({ task_id: task.task_id, split: task.split, status: task.status })) });
  writeFileSync(join(viewer, "index.html"), viewerHtml({ tasks, nodes: dag.nodes, captures: captureIndex }), { mode: 0o600 });
  const result: FoundryResult = { schema_version: "understudy.trace_foundry.v1", source, output_dir: output, freshness: { max_age_days: maxAgeDays, cutoff_utc: cutoff.toISOString(), newest_capture_utc: rows.map((row) => row.captured_at).sort().at(-1) }, counts: { source_files: files.length, captures: rows.length, tasks: tasks.length, edges: dag.edges.length, stale_filtered: all.length - rows.length, invalid_timestamp_filtered: invalidTimestampFiltered }, artifacts: { normalized: join(output, "normalized-captures.jsonl"), dag: join(output, "source-dag.json"), tasks: join(output, "tasks.jsonl"), benchmark: join(output, "benchmark.json"), viewer: join(viewer, "index.html") }, privacy: { local_only: true, contains_customer_payloads: true, upload_performed: false, provider_called: false } };
  writeJson(join(output, "manifest.json"), result); return result;
}
