import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { traceFoundryViewer } from "./trace-foundry-viewer.js";
import { validateBenchmarkManifest } from "./benchmark.js";

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

export type TraceFoundryOptions = {
  workload?: string;
  batchSize?: number;
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
    const toolCalls: Obj[] = [], deltas = new Map<string, Obj>();
    for (const event of events) {
      const block = asObject(event.content_block);
      if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      for (const choice of Array.isArray(event.choices) ? event.choices : []) {
        for (const callValue of asObject(choice).delta?.tool_calls ?? []) {
          const call = asObject(callValue), fn = asObject(call.function), key = String(call.index ?? call.id ?? deltas.size);
          const prior = deltas.get(key) ?? { id: call.id ?? null, function: { name: "", arguments: "" } };
          const priorFn = asObject(prior.function);
          deltas.set(key, { id: call.id ?? prior.id, function: { name: String(priorFn.name ?? "") + String(fn.name ?? ""), arguments: String(priorFn.arguments ?? "") + String(fn.arguments ?? "") } });
        }
      }
    }
    toolCalls.push(...deltas.values());
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
  const upstreamRequestRaw = envelope.upstream_request_body ?? envelope.forwarded_request_body ?? null;
  const responseRaw = envelope.response_body ?? envelope.customer_response_body ?? envelope.response;
  const request = asObject(jsonish(requestRaw));
  const messages = Array.isArray(request.messages) ? request.messages.map(asObject) : [];
  const tools = Array.isArray(request.tools) ? request.tools.map(asObject) : [];
  const capturedAt = iso(envelope.ts ?? envelope.created_at ?? envelope.uploaded);
  if (capturedAt === null) return null;
  const captureId = String(envelope.request_id ?? envelope.id ?? hash(envelope).slice(0, 24));
  const captureKey = hash({ pointer, capture_id: captureId, source: hash(envelope) }).slice(0, 32);
  const warnings = [
    envelope.placement_id && !envelope.workload_id ? "legacy_placement_id" : null,
    envelope.customer_response_body && !envelope.response_body ? "legacy_customer_response_body" : null,
    upstreamRequestRaw === null ? "upstream_request_unavailable" : null,
  ].filter(Boolean);
  return {
    schema_version: "understudy.normalized_capture.v1", capture_id: captureId, capture_key: captureKey, captured_at: capturedAt,
    source: { pointer, sha256: hash(envelope) },
    scope: { org_id: envelope.workos_org_id ?? envelope.org_id ?? null, project_id: envelope.project_id ?? null, workload_id: envelope.workload_id ?? envelope.placement_id ?? null, workload_name: envelope.workload_name ?? null },
    routing: { provider: envelope.provider ?? null, requested_model: envelope.requested_model ?? request.model ?? null, upstream_model: envelope.upstream_model ?? null },
    transport: { endpoint: envelope.endpoint ?? null, status_code: envelope.status_code ?? null, latency_ms: envelope.latency_ms ?? null },
    request: { system: request.system ?? null, messages, tools, settings: Object.fromEntries(Object.entries(request).filter(([k]) => !["system", "messages", "tools"].includes(k))) },
    upstream_request: upstreamRequestRaw === null ? null : jsonish(upstreamRequestRaw),
    response: responseProjection(responseRaw), raw: { customer_request: requestRaw ?? null, upstream_request: upstreamRequestRaw, response: responseRaw ?? null },
    warnings,
    fingerprints: { group: hash({ org: envelope.workos_org_id ?? envelope.org_id ?? null, project: envelope.project_id ?? null, workload: envelope.workload_id ?? envelope.placement_id ?? envelope.workload_name ?? null, system: request.system ?? null, first_user: messages.find((m) => m.role === "user") ?? null }), messages: messages.map(hash), sequence: hash(messages), tools: tools.map(hash) },
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
      nodes.push({ id: capture.capture_key, capture_id: capture.capture_id, execution_group: groupId, captured_at: capture.captured_at, message_count: capture.request.messages.length, has_error: Number(capture.transport.status_code ?? 200) >= 400, warnings: capture.warnings, source: capture.source });
      if (index === 0) { roots.push(capture.capture_key); return; }
      const prior = captures.slice(0, index);
      const candidates = prior.map((parent) => ({ parent, prefix: commonPrefix(parent.fingerprints.messages, capture.fingerprints.messages) })).sort((a, b) => b.prefix - a.prefix || b.parent.captured_at.localeCompare(a.parent.captured_at));
      const best = candidates[0];
      if (!best) { roots.push(capture.capture_key); return; }
      const p = best.parent.fingerprints.messages as string[], c = capture.fingerprints.messages as string[];
      const sameBoundary = p.length === c.length && best.prefix === p.length;
      const priorError = Number(best.parent.transport.status_code ?? 200) >= 400 || (best.parent.response.tool_calls ?? []).length === 0;
      const summarized = c.some((fingerprint, i) => i < p.length && fingerprint !== p[i]) && capture.request.messages.some((m: Obj) => m.summary === true || m.metadata?.folded === true);
      const type = sameBoundary && priorError ? "retry" : sameBoundary ? "branch" : best.prefix === p.length ? "prefix_append" : summarized ? "folded_continuation" : p.length === c.length && best.prefix > 0 ? "same_depth_mutation" : best.prefix > 0 ? "branch" : "destructive_mutation";
      const tied = candidates.filter((candidate) => candidate.prefix === best.prefix).length > 1;
      edges.push({ from: best.parent.capture_key, to: capture.capture_key, type, execution_group: groupId, confidence: tied || type === "destructive_mutation" ? "low" : "deterministic", evidence: { common_prefix_messages: best.prefix, prior_error: priorError, ambiguous_parent: tied } });
    });
    groupRows.push({ id: groupId, capture_count: captures.length, edge_count: Math.max(0, captures.length - 1), roots });
  }
  const issues = edges.filter((edge) => edge.evidence.ambiguous_parent).map((edge) => ({ code: "ambiguous_parent", edge: { from: edge.from, to: edge.to } }));
  return { schema_version: "understudy.source_dag.v1", valid: issues.length === 0, issues, nodes, edges, groups: groupRows };
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
  const unique = [...new Map(events.map((event) => [hash(event), event])).values()];
  const calls = new Map(unique.filter((event) => event.kind === "call" && event.id).map((event) => [event.id, event]));
  return unique.map((event) => event.kind === "result" && calls.has(event.id) ? { ...event, tool: calls.get(event.id)?.name, arguments: calls.get(event.id)?.arguments } : event);
}

function capabilityFit(candidate: Obj, catalog: Obj[]): Obj {
  const tools = new Set<string>((candidate.tool_surface ?? []).map(String));
  const scored = catalog.map((prior) => {
    const priorTools = new Set<string>(prior.tool_surface ?? []);
    const overlap = [...tools].filter((tool) => priorTools.has(tool)).length;
    const union = new Set([...tools, ...priorTools]).size || 1;
    const sameTitle = String(prior.title ?? "").trim().toLowerCase() === String(candidate.title ?? "").trim().toLowerCase();
    return { prior, similarity: overlap / union, sameTitle };
  }).sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  if (!best || best.similarity === 0) return { classification: "new_capability", matched_task_id: null, similarity: 0 };
  if (best.similarity === 1 && best.sameTitle) {
    const priorContract = hash(best.prior.outcome_contract?.required ?? []), candidateContract = hash(candidate.outcome_contract?.required ?? []);
    return { classification: priorContract === candidateContract ? "new_instance" : "contradiction", matched_task_id: best.prior.task_id, similarity: 1, evidence: priorContract === candidateContract ? [] : ["same_intent_and_tools_but_different_required_state"] };
  }
  if (best.similarity === 1) return { classification: "task_variant", matched_task_id: best.prior.task_id, similarity: 1 };
  return { classification: "environment_extension", matched_task_id: best.prior.task_id, similarity: best.similarity };
}

function tasksFrom(dag: Obj, rows: Obj[], catalog: Obj[] = []): Obj[] {
  const byId = new Map(rows.map((row) => [row.capture_key, row]));
  return dag.groups.map((group: Obj) => {
    const nodes = dag.nodes.filter((node: Obj) => node.execution_group === group.id).sort((a: Obj, b: Obj) => a.captured_at.localeCompare(b.captured_at));
    const captures = nodes.map((node: Obj) => byId.get(node.id)).filter(Boolean) as Obj[];
    const root = captures[0], first = root.request.messages.find((m: Obj) => m.role === "user") ?? {};
    const events = toolEvents(captures), calls = events.filter((e) => e.kind === "call" && e.name), mutations = calls.filter((e) => mutationPrefixes.some((prefix) => String(e.name).toLowerCase().startsWith(prefix)));
    const required = mutations.map((call) => ({ type: "state_effect", tool: call.name, observed_arguments: call.arguments, matching: "semantic_outcome_not_exact_trajectory", confidence: "medium" }));
    const confidence = required.length > 0 && !events.some((e) => e.status === "error") ? "high" : calls.length > 0 ? "medium" : "low";
    const bucket = Number.parseInt(hash(group.id).slice(0, 8), 16) % 100;
    const definitions = captures.flatMap((capture) => capture.request.tools ?? []).map(asObject);
    const observedResults = events.filter((event) => event.kind === "result" && event.tool);
    const task: Obj = { schema_version: "understudy.benchmark_task.v1", task_id: `task-${group.id.slice(0, 16)}`, execution_group: group.id, title: contentText(first.content).trim().slice(0, 160) || `Trace group ${group.id.slice(0, 8)}`, status: !dag.valid ? "blocked" : confidence === "high" ? "machine_proposed" : "needs_review", split: bucket < 70 ? "construction" : bucket < 90 ? "fit" : "heldout", candidate_boundary: root.capture_key, machine_confidence: confidence, close_call: confidence !== "high" || !dag.valid, tool_surface: [...new Set(calls.map((e) => e.name))].sort(), tool_definitions: [...new Map(definitions.map((definition) => [definition.name ?? definition.function?.name ?? hash(definition), definition])).values()], source: { node_ids: nodes.map((n: Obj) => n.id), edges: dag.edges.filter((e: Obj) => e.execution_group === group.id), captures: nodes.map((n: Obj) => ({ capture_key: n.id, capture_id: n.capture_id, ...n.source })) }, world_model: { status: "machine_proposed", initial_state: { source: "observed_tool_results", materialized: observedResults.length > 0, observations: observedResults }, transitions: required }, outcome_contract: { status: "machine_proposed", required, preserved: [], forbidden: [], grading: "final_state_and_obligations" }, claims: [...calls.map((c) => ({ kind: "observed", claim: `tool ${c.name} was called`, source_call_id: c.id })), ...mutations.map((c) => ({ kind: "inferred", claim: `${c.name} appears to mutate state`, confidence: "medium" }))], sentinels: ["noop", "wrong_value", "write_everything", "forbidden_write"], review: { decision: "pending_final_judgment" } };
    task.capability_fit = capabilityFit(task, catalog);
    task.task_hash = hash({ title: task.title, tools: task.tool_surface, contract: task.outcome_contract, source: task.source });
    return task;
  });
}

const viewerHtml = (payload: Obj) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Understudy · benchmark orchard</title><style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');:root{--ink:#e7e8ea;--bright:#f2f2f0;--dim:#9b9da3;--line:rgba(255,255,255,.09);--hover:#1c1e25;--mint:#9edbd3;--violet:#a78bfa;--cyan:#67e8f9;--good:#6ee7a0;--bad:#f85149;--mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif}*{box-sizing:border-box}body{margin:0;background:#000;color:var(--ink);font:13px var(--sans);overflow:hidden}header{height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:20px;padding:0 18px}header b,label,nav button{font:500 10px var(--mono);letter-spacing:.15em;text-transform:uppercase}.brand{color:var(--bright)}.brand:before{content:'';display:inline-block;width:7px;height:7px;border:1px solid var(--mint);border-radius:50%;margin-right:10px}.meta{color:var(--dim);flex:1}.grid{height:calc(100vh - 56px);display:grid;grid-template-columns:260px minmax(340px,.82fr) minmax(460px,1.18fr)}aside,section{min-width:0;border-right:1px solid var(--line);display:flex;flex-direction:column}.head{height:54px;border-bottom:1px solid var(--line);padding:0 14px;display:flex;align-items:center;justify-content:space-between;color:var(--dim)}.scroll{overflow:auto;min-height:0}.tasks{padding:7px}.task{width:100%;display:grid;grid-template-columns:30px 1fr;gap:8px;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);padding:11px 8px;cursor:pointer}.task:hover,.task.on{background:var(--hover)}.num,.sub{font:10px var(--mono);color:var(--dim)}.title{font-size:12px;line-height:1.45}.lineage{position:relative;padding:26px 20px}.lineage:before{content:'';position:absolute;left:40px;top:26px;bottom:30px;width:1px;background:linear-gradient(var(--violet),var(--cyan),transparent)}.node{position:relative;padding-left:40px;margin-bottom:9px}.node:before{content:'';position:absolute;left:14px;top:15px;width:11px;height:11px;border:1px solid var(--violet);border-radius:50%;background:#000;z-index:2}.node.on:before{background:var(--cyan);border-color:var(--cyan);box-shadow:0 0 16px #67e8f966}.node button{width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:10px;cursor:pointer}.node.on button{border-color:#67e8f977;background:#67e8f90b}.edge{display:block;margin-top:6px;color:var(--violet);font:9px var(--mono);text-transform:uppercase;letter-spacing:.08em}.inspect-head{padding:13px 17px 0;border-bottom:1px solid var(--line)}.eyebrow{color:var(--mint);font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em}h1{font:400 18px/1.35 var(--mono);margin:8px 0 12px;color:var(--bright)}nav{display:flex;gap:18px}nav button{border:0;border-bottom:1px solid transparent;background:none;color:var(--dim);padding:9px 0;cursor:pointer}nav button.on{color:var(--bright);border-color:var(--mint)}.body{padding:20px 20px 95px}.lede{font-size:14px;line-height:1.6;color:var(--bright)}.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;margin:18px 0}.fact{padding:12px;border-right:1px solid var(--line)}.fact:last-child{border:0}.fact b{display:block;margin-top:5px;font:13px var(--mono)}details{border-top:1px solid var(--line)}summary{padding:12px 0;cursor:pointer;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--dim)}pre{white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;background:#08090b;border:1px solid var(--line);border-radius:8px;padding:13px;font:11px/1.55 var(--mono)}.mode{display:flex;justify-content:flex-end;gap:5px}.mode button,.review button,header button{border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);padding:7px 9px;cursor:pointer}.mode button.on{background:var(--hover)}.review{position:sticky;bottom:0;margin-top:auto;padding:12px 16px;border-top:1px solid var(--line);background:#0e0f12ee;display:flex;justify-content:flex-end;gap:6px}.review .accept{color:var(--good);border-color:var(--good)}@media(max-width:850px){.grid{grid-template-columns:220px 300px 1fr}}</style></head><body><header><b class="brand">benchmark orchard</b><span class="meta" id="meta"></span><button onclick="exportReviews()">Export reviews</button></header><main class="grid"><aside><div class="head"><label>Task inbox</label><span id="tc"></span></div><div class="tasks scroll" id="tasks"></div></aside><section><div class="head"><label>Source lineage</label><span id="nc"></span></div><div class="lineage scroll" id="dag"></div></section><section><div class="inspect-head"><div class="eyebrow" id="eye"></div><h1 id="title"></h1><nav id="tabs"></nav></div><div class="body scroll" id="body"></div><div class="review"><button class="accept" onclick="judge('accept')">Accept</button><button onclick="judge('restrict')">Restrict</button><button onclick="judge('needs_more')">Needs more</button><button onclick="judge('reject')">Reject</button></div></section></main><script>const D=${JSON.stringify(payload).replaceAll("</", "<\\/")};let task=D.tasks[0],node=task.candidate_boundary,tab='task',mode='parsed';const cache={},reviews=JSON.parse(localStorage.getItem('understudy-reviews')||'{}'),e=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])),p=x=>e(JSON.stringify(x,null,2));async function load(){if(!cache[node])cache[node]=await fetch(D.captures[node].path).then(r=>r.json())}function render(){document.querySelector('#meta').textContent=D.tasks.length+' tasks · '+D.nodes.length+' captures · local evidence';document.querySelector('#tc').textContent=D.tasks.length+' tasks';document.querySelector('#tasks').innerHTML=D.tasks.map((t,i)=>'<button class="task '+(t.task_id===task.task_id?'on':'')+'" onclick="pickTask(\''+t.task_id+'\')"><span class="num">'+String(i+1).padStart(2,'0')+'</span><span><span class="title">'+e(t.title)+'</span><br><span class="sub">'+e(t.split)+' · '+e(reviews[t.task_id]?.decision||t.status)+'</span></span></button>').join('');const ids=new Set(task.source.node_ids),ns=D.nodes.filter(n=>ids.has(n.id)).sort((a,b)=>a.captured_at.localeCompare(b.captured_at));document.querySelector('#nc').textContent=ns.length+' rounds';document.querySelector('#dag').innerHTML=ns.map((n,i)=>{const x=task.source.edges.find(x=>x.to===n.id);return '<div class="node '+(n.id===node?'on':'')+'"><button onclick="pickNode(\''+n.id+'\')"><span class="sub">round '+String(i+1).padStart(2,'0')+' · '+n.id.slice(0,8)+'</span><br>'+n.message_count+' messages<span class="edge">'+e(x?.type||'root boundary')+'</span></button></div>'}).join('');document.querySelector('#eye').textContent=task.task_id+' · '+task.machine_confidence+' confidence';document.querySelector('#title').textContent=task.title;document.querySelector('#tabs').innerHTML=['task','request','response','contract'].map(x=>'<button class="'+(tab===x?'on':'')+'" onclick="setTab(\''+x+'\')">'+x+'</button>').join('');const c=cache[node]||{};if(tab==='task')document.querySelector('#body').innerHTML='<p class="lede">The machine assembled this task from '+task.source.node_ids.length+' captured rounds and proposed a stateful verifier. Human judgment controls final promotion.</p><div class="facts"><div class="fact"><label>Confidence</label><b>'+task.machine_confidence+'</b></div><div class="fact"><label>Split</label><b>'+task.split+'</b></div><div class="fact"><label>Tools</label><b>'+task.tool_surface.length+'</b></div></div><details open><summary>Machine claims</summary><pre>'+p(task.claims)+'</pre></details>';else if(tab==='contract')document.querySelector('#body').innerHTML='<p class="lede">Grade the resulting state—not an exact historical trajectory.</p><details open><summary>Outcome contract</summary><pre>'+p(task.outcome_contract)+'</pre></details><details><summary>World model</summary><pre>'+p(task.world_model)+'</pre></details>';else{const value=c[tab]||{},raw=c.raw?.[tab],rawText=typeof raw==='string'?raw:JSON.stringify(raw??value,null,2);document.querySelector('#body').innerHTML='<div class="mode"><button class="'+(mode==='parsed'?'on':'')+'" onclick="setMode(\'parsed\')">Parsed JSON</button><button class="'+(mode==='raw'?'on':'')+'" onclick="setMode(\'raw\')">Raw</button></div>'+(mode==='raw'?'<p class="sub">'+(raw!=null?'preserved source representation':'canonical serialization · original unavailable')+'</p><pre>'+e(rawText)+'</pre>':Object.entries(value).map(([k,v])=>'<details open><summary>'+e(k)+'</summary><pre>'+p(v)+'</pre></details>').join(''))}}async function pickTask(id){task=D.tasks.find(t=>t.task_id===id);node=task.candidate_boundary;tab='task';await load();render()}async function pickNode(id){node=id;tab='request';mode='parsed';await load();render()}function setTab(x){tab=x;mode='parsed';render()}function setMode(x){mode=x;render()}function judge(x){reviews[task.task_id]={decision:x,reviewed_at:new Date().toISOString()};localStorage.setItem('understudy-reviews',JSON.stringify(reviews));render()}function exportReviews(){const s=Object.entries(reviews).map(([task_id,r])=>JSON.stringify({task_id,...r})).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([s+'\n'],{type:'application/x-ndjson'}));a.download='benchmark-reviews.jsonl';a.click()}load().then(render)</script></body></html>`;

function writeJson(path: string, value: unknown): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function writeJsonl(path: string, rows: Obj[]): void { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); }
function readJsonl(path: string): Obj[] { return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => asObject(JSON.parse(line))) : []; }
function appendJsonl(path: string, rows: Obj[]): void { if (rows.length === 0) return; mkdirSync(resolve(path, ".."), { recursive: true }); appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); }
const pyName = (value: string): string => { const clean = value.replace(/[^A-Za-z0-9_]/g, "_"); return /^[A-Za-z_]/.test(clean) ? clean : `tool_${clean}`; };

/**
 * Semantic-outcome matching (the contract's advertised
 * "semantic_outcome_not_exact_trajectory"): argument values are compared
 * token-normalized against the canonicalized actual arguments, never as raw
 * substrings — {"app":"PipeSim"} satisfies an observed {"app":"pipesim"}.
 */
const contentTokens = (value: unknown): string[] => {
  const text = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return text.toLowerCase().split(/[^a-z0-9#]+/).filter((token) => token.length > 2 || /^[0-9]+$/.test(token));
};
export function semanticArgumentsMatch(observed: Obj, actual: Obj): boolean {
  const canonical = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const hay = JSON.stringify(canonical(actual ?? {})).toLowerCase();
  return Object.values(observed ?? {}).every((value) => contentTokens(value).every((token) => hay.includes(token)));
}

export function scoreState(task: Obj, writes: Obj[]): Obj {
  const required = task.outcome_contract?.required ?? [];
  const matched = required.filter((rule: Obj) => writes.some((write) => write.tool === rule.tool && semanticArgumentsMatch(asObject(rule.observed_arguments), asObject(write.arguments)))).length;
  const recall = required.length === 0 ? 1 : matched / required.length;
  const precision = writes.length === 0 ? (required.length === 0 ? 1 : 0) : matched / writes.length;
  const forbidden = writes.some((write) => task.outcome_contract?.forbidden?.some((rule: Obj) => rule.tool === write.tool)) ? 0 : 1;
  // Forbidden-effect violations zero the strict score outright.
  const strict = forbidden === 0 ? 0 : required.length > 0 && matched === required.length ? 1 : 0;
  return { recall, precision, policy: forbidden, strict, score: forbidden === 0 ? 0 : (recall + precision + forbidden) / 3 };
}

function writeVerifiersEnvironment(output: string, tasks: Obj[], sourceContext: Map<string, Obj>, auditedCommit: string): Obj {
  const root = join(output, "environment"), pkg = join(root, "understudy_trace_env"), servers = join(pkg, "servers");
  mkdirSync(servers, { recursive: true });
  const toolNames = [...new Set<string>(tasks.flatMap((task) => (task.tool_surface ?? []).map(String)))].sort();
  const observedByTool = new Map<string, Obj>();
  for (const task of tasks) for (const rule of task.outcome_contract?.required ?? []) if (!observedByTool.has(rule.tool)) observedByTool.set(rule.tool, asObject(rule.observed_arguments));
  const schemaByTool = new Map<string, Obj>();
  for (const task of tasks) for (const definitionValue of task.tool_definitions ?? []) { const definition = asObject(definitionValue), fn = asObject(definition.function), name = String(definition.name ?? fn.name ?? ""); if (name && !schemaByTool.has(name)) schemaByTool.set(name, asObject(definition.input_schema ?? fn.parameters)); }
  const pyType = (value: unknown): string => typeof value === "boolean" ? "bool" : typeof value === "number" ? "float" : Array.isArray(value) ? "list" : value && typeof value === "object" ? "dict" : "str";
  const schemaType = (schema: Obj, fallback: unknown): string => schema.type === "boolean" ? "bool" : ["number", "integer"].includes(schema.type) ? "float" : schema.type === "array" ? "list" : schema.type === "object" ? "dict" : schema.type === "string" ? "str" : pyType(fallback);
  const methods = toolNames.map((name) => {
    const observed = observedByTool.get(name) ?? {}, properties = asObject(schemaByTool.get(name)?.properties);
    const keys = [...new Set([...Object.keys(properties), ...Object.keys(observed)])];
    const parameters = keys.map((key) => `${pyName(key)}: ${schemaType(asObject(properties[key]), observed[key])} | None = None`).join(", ");
    const args = keys.map((key) => `${JSON.stringify(key)}: ${pyName(key)}`).join(", ");
    const mutating = mutationPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix));
    return `    @vf.tool(name=${JSON.stringify(name)})\n    async def ${pyName(name)}(self${parameters ? `, ${parameters}` : ""}) -> str:\n        \"\"\"Execute the trace-derived ${name} transition against per-rollout state.\"\"\"\n        event = {\"tool\": ${JSON.stringify(name)}, \"arguments\": {${args}}}\n        self.state.events.append(event)\n${mutating ? "        self.state.writes.append(event)\n" : ""}        return json.dumps({\"ok\": True, **event})`;
  }).join("\n\n");
  const fixtures = tasks.flatMap((task) => task.world_model?.initial_state?.observations ?? []).map((result: Obj) => ({ tool: result.tool, arguments: result.arguments ?? {}, status: result.status, content: result.content }));
  // Stateful per-rollout world: fixtures are matched token-normalized (not
  // byte-exact) and consumed in captured order, so a transient captured error
  // is transient here too instead of being returned forever.
  const fixtureReply = `    def _fixture_reply(self, event: dict) -> str:\n        matches = [(index, fixture) for index, fixture in enumerate(self.FIXTURES) if fixture.get("tool") == event["tool"] and _arguments_match(fixture.get("arguments") or {}, event["arguments"])]\n        pick = next(((index, fixture) for index, fixture in matches if index not in self.state.used_fixtures), matches[-1] if matches else None)\n        if pick is None:\n            return json.dumps({"ok": True, **event})\n        index, fixture = pick\n        self.state.used_fixtures.append(index)\n        content = fixture.get("content")\n        body = content if isinstance(content, str) else json.dumps(content)\n        return f"ERROR: {body}" if fixture.get("status") == "error" else body`;
  const worldMethods = `    FIXTURES = ${JSON.stringify(fixtures)}\n\n${fixtureReply}\n\n${methods.replaceAll('        return json.dumps({"ok": True, **event})', "        return self._fixture_reply(event)")}`;
  const taskRows = tasks.map((task) => ({ task_id: task.task_id, prompt: task.title, system_prompt: sourceContext.get(task.task_id)?.system ?? null, source_messages: sourceContext.get(task.task_id)?.messages ?? [], split: task.split === "construction" ? "train" : task.split === "fit" ? "dev" : "holdout", outcome_contract: task.outcome_contract, tool_surface: task.tool_surface }));
  writeJson(join(pkg, "tasks.json"), taskRows);
  writeFileSync(join(pkg, "servers", "world.py"), `import json\nimport re\nfrom pydantic import Field\nimport verifiers.v1 as vf\n\n\ndef _tokens(value):\n    text = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)\n    return [token for token in re.split(r"[^a-z0-9#]+", text.lower()) if len(token) > 2 or token.isdigit()]\n\n\ndef _arguments_match(observed: dict, actual: dict) -> bool:\n    \"\"\"Semantic compare: every content token of each observed value appears in the canonicalized actual arguments.\"\"\"\n    hay = json.dumps(actual or {}, sort_keys=True).lower()\n    return all(token in hay for value in (observed or {}).values() for token in _tokens(value))\n\n\nclass WorldState(vf.State):\n    events: list[dict] = Field(default_factory=list)\n    writes: list[dict] = Field(default_factory=list)\n    used_fixtures: list[int] = Field(default_factory=list)\n\nclass WorldToolset(vf.Toolset[vf.ToolsetConfig, WorldState]):\n    TOOL_PREFIX = \"\"\n\n${worldMethods || "    pass"}\n\nif __name__ == \"__main__\":\n    WorldToolset.run()\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "taskset.py"), `import json\nfrom pathlib import Path\nimport verifiers.v1 as vf\nfrom understudy_trace_env.servers.world import WorldState, WorldToolset, _arguments_match\n\nROWS = json.loads((Path(__file__).parent / \"tasks.json\").read_text())\n\nclass TraceData(vf.TaskData):\n    task_id: str\n    outcome_contract: dict\n    split: str\n\nclass TraceTask(vf.Task[TraceData, WorldState]):\n    @vf.stop\n    async def bounded(self, trace: vf.Trace) -> bool:\n        return trace.num_turns >= 24\n\n    def _effects(self, trace: vf.Trace) -> tuple[int, int, bool]:\n        \"\"\"Final-state comparison over the per-rollout world state: each required\n        state-effect is satisfied when its tool was called with semantically\n        matching (token-normalized) arguments — never a raw substring of the\n        trajectory. Forbidden effects are violations.\"\"\"\n        writes = list(getattr(trace.state, \"writes\", None) or [])\n        contract = self.data.outcome_contract\n        required = contract.get(\"required\", [])\n        satisfied = sum(1 for rule in required if any(write.get(\"tool\") == rule.get(\"tool\") and _arguments_match(rule.get(\"observed_arguments\") or {}, write.get(\"arguments\") or {}) for write in writes))\n        violated = any(write.get(\"tool\") == rule.get(\"tool\") for rule in contract.get(\"forbidden\", []) for write in writes)\n        return satisfied, len(required), violated\n\n    @vf.reward(weight=1.0)\n    async def final_state(self, trace: vf.Trace) -> float:\n        satisfied, total, violated = self._effects(trace)\n        if violated:\n            return 0.0\n        return float(total > 0 and satisfied == total)\n\n    @vf.metric\n    async def final_state_partial_credit(self, trace: vf.Trace) -> float:\n        satisfied, total, violated = self._effects(trace)\n        return 0.0 if violated else satisfied / max(total, 1)\n\n    async def validate(self, runtime: vf.Runtime) -> bool:\n        required = self.data.outcome_contract.get(\"required\", [])\n        return bool(required) and all(isinstance(r.get(\"tool\"), str) and isinstance(r.get(\"observed_arguments\"), dict) for r in required)\n\nclass TraceConfig(vf.TasksetConfig):\n    split: str = \"train\"\n    context_variant: str = \"authentic_history\"\n    tools: vf.ToolsetConfig = vf.ToolsetConfig()\n\nclass TraceTaskset(vf.Taskset[TraceTask, TraceConfig]):\n    tools = (WorldToolset,)\n    def load(self) -> list[TraceTask]:\n        return [TraceTask(TraceData(idx=i, task_id=r[\"task_id\"], prompt=r[\"prompt\"], system_prompt=r.get(\"system_prompt\"), outcome_contract=r[\"outcome_contract\"], split=r[\"split\"]), self.config.task) for i, r in enumerate(ROWS) if r[\"split\"] == self.config.split]\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "environment.py"), `import verifiers.v1 as vf\nfrom understudy_trace_env.taskset import TraceConfig, TraceTaskset\n\nclass TraceHarnessConfig(vf.HarnessConfig):\n    max_turns: int = 24\n\nclass TraceHarness(vf.Harness[TraceHarnessConfig]):\n    pass\n\ndef load_taskset(config: TraceConfig) -> TraceTaskset:\n    return TraceTaskset(config=config)\n\ndef load_harness(config: TraceHarnessConfig) -> TraceHarness:\n    return TraceHarness(config=config)\n\ndef load_environment(config: vf.EnvConfig) -> vf.Env:\n    return vf.Env(taskset=vf.load_taskset(config.taskset), harness=vf.load_harness(config.harness))\n`, { mode: 0o600 });
  writeFileSync(join(pkg, "__init__.py"), "from understudy_trace_env.environment import load_environment, load_harness, load_taskset\nfrom understudy_trace_env.taskset import TraceTaskset\n\n__all__ = [\"TraceTaskset\", \"load_environment\", \"load_harness\", \"load_taskset\"]\n", { mode: 0o600 });
  writeFileSync(join(servers, "__init__.py"), "", { mode: 0o600 });
  writeFileSync(join(root, "pyproject.toml"), `[project]\nname = "understudy-trace-env"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.14"\ndependencies = ["verifiers @ git+https://github.com/PrimeIntellect-ai/verifiers.git@${auditedCommit}"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.metadata]\nallow-direct-references = true\n\n[tool.hatch.build.targets.wheel]\npackages = ["understudy_trace_env"]\n`, { mode: 0o600 });
  const validation = tasks.map((task) => {
    const oracleWrites = (task.outcome_contract?.required ?? []).map((rule: Obj) => ({ tool: rule.tool, arguments: rule.observed_arguments }));
    return { task_id: task.task_id, oracle: scoreState(task, oracleWrites), sentinels: { noop: scoreState(task, []), wrong_value: scoreState(task, oracleWrites.map((write: Obj) => ({ ...write, arguments: { __wrong__: true } }))), write_everything: scoreState(task, [...oracleWrites, { tool: "forbidden-extra-write", arguments: {} }]) } };
  });
  writeJson(join(root, "offline-validation.json"), { schema_version: "understudy.verifier_validation.v1", verifiers: { api: "v1", audited_commit: auditedCommit }, tasks: validation });
  const packageFiles = [join(root, "pyproject.toml"), join(pkg, "__init__.py"), join(pkg, "environment.py"), join(pkg, "taskset.py"), join(pkg, "servers", "world.py"), join(pkg, "tasks.json")];
  return { path: root, package_sha256: hash(packageFiles.map((path) => readFileSync(path, "utf8"))), verifiers_api: "v1", audited_commit: auditedCommit, oracle_pass: validation.every((row) => row.oracle.score === 1), sentinel_pass: validation.every((row) => row.sentinels.noop.score < 1 && row.sentinels.wrong_value.score < 1 && row.sentinels.write_everything.score < 1) };
}

type ManifestOptions = { schemaVersion: string; benchmarkId: string; name: string; description: string; createdAt: string; sourceRefs: string[]; packageSha256: string | null; auditedCommit: string; heldoutNovel: boolean; status: string; executable: boolean; promotionBlockers: string[] };

/** Shared benchmark-manifest projection: taxonomy/splits/tasks are always recomputed over exactly the tasks passed in. */
function benchmarkManifestFrom(tasks: Obj[], options: ManifestOptions): Obj {
  const categoryByTask = new Map(tasks.map((task) => [task.task_id, `cap-${hash(task.tool_surface).slice(0, 12)}`]));
  const taxonomy = [...new Map(tasks.map((task) => [categoryByTask.get(task.task_id), { category_id: categoryByTask.get(task.task_id), name: task.tool_surface.join(" + ") || "tool-free task", description: task.title, difficulty: task.close_call ? "hard" : "medium", derived_from: { tool_signature: task.tool_surface, intent_summary: task.title, source_trace_ids: task.source.node_ids } }])).values()];
  return { schema_version: options.schemaVersion, benchmark_id: options.benchmarkId, name: options.name, description: options.description, created_at: options.createdAt, provenance: { origin: "derived-from-traces", source_refs: options.sourceRefs }, taxonomy, tasks: tasks.map((task) => ({ task_id: task.task_id, category_id: categoryByTask.get(task.task_id), seed: Number.parseInt(task.task_hash.slice(0, 8), 16), genesis: "replayed", split: task.split === "construction" ? "train" : task.split === "fit" ? "dev" : "holdout", gold: task.split === "heldout" && options.heldoutNovel ? null : { kind: "final-state", ref: `tasks.jsonl#${task.task_id}` }, status: task.status, task_hash: task.task_hash, capability_fit: task.capability_fit })), environment: { format: "verifiers.v1", package_ref: "environment", package_sha256: options.packageSha256, tool_surface: [...new Set(tasks.flatMap((task) => task.tool_surface))].sort(), runtime: "subprocess", verifiers_version_pin: options.auditedCommit }, verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit", replayable: true }, splits: { boundary: "stable task hash: train 70 / dev 20 / holdout 10", splits_sha256: hash(tasks.map((task) => [task.task_id, task.split])), contamination: options.heldoutNovel ? "unknown" : "clean" }, linked_eval: null, results_contract: { row_schema: "understudy.eval_result.v1", trace_artifact: "traces.jsonl", branch_projection: "one_eval_row_per_root_to_leaf_branch" }, status: options.status, executable: options.executable, promotion_blockers: options.promotionBlockers };
}

const ACCEPTING_DECISIONS = ["accept", "restrict"];
const REVIEW_DECISION_VALUES = ["accept", "restrict", "needs_more", "reject"];

/**
 * `understudy traces promote` — the reviewed-proposal → promoted-benchmark
 * verb. Consumes the hub's reviews.jsonl (understudy.benchmark_review.v1,
 * append-only, newest line per task wins) and/or the import-reviews output
 * (review-decisions.jsonl). Rejected/needs_more tasks are EXCLUDED, never
 * blockers. Gates recomputed over the accepted subset; DAG issues need either
 * evidenced-retry evidence or an explicit --waive-dag reason, both recorded in
 * promotion-record.json. Only then is the executable understudy.benchmark.v1
 * written — and it must validate against validateBenchmarkManifest.
 */
export function promoteTraceBenchmark(outputInput: string, options: { waiveDagReason?: string; promotedBy?: string; now?: Date } = {}): Obj {
  const output = resolve(outputInput), now = options.now ?? new Date();
  const tasks = readJsonl(join(output, "tasks.jsonl"));
  if (tasks.length === 0) throw new Error(`No tasks.jsonl found in ${output}; run build-benchmark first.`);
  // Newest decision per task wins; hub reviews.jsonl supersedes import-reviews output.
  const decisions = new Map<string, Obj>();
  for (const row of readJsonl(join(output, "review-decisions.jsonl"))) {
    if (typeof row.task_id === "string" && REVIEW_DECISION_VALUES.includes(row.decision)) decisions.set(row.task_id, { decision: row.decision, note: row.note ?? null, reviewed_at: row.reviewed_at ?? row.created_at ?? null, source: "review-decisions.jsonl" });
  }
  for (const row of readJsonl(join(output, "reviews.jsonl"))) {
    if (row.schema_version !== "understudy.benchmark_review.v1" || typeof row.task_id !== "string" || !REVIEW_DECISION_VALUES.includes(row.decision)) continue;
    decisions.set(row.task_id, { decision: row.decision, note: row.note ?? null, reviewed_at: row.created_at ?? null, source: "reviews.jsonl" });
  }
  if (decisions.size === 0) throw new Error("Refusing to promote an unreviewed benchmark: no decisions found in reviews.jsonl or review-decisions.jsonl. Review the tasks in the Benchmark Hub (or run `understudy traces import-reviews`) first.");
  const accepted = tasks.filter((task) => ACCEPTING_DECISIONS.includes(decisions.get(task.task_id)?.decision));
  const excluded = tasks.filter((task) => !ACCEPTING_DECISIONS.includes(decisions.get(task.task_id)?.decision)).map((task) => ({ task_id: task.task_id, decision: decisions.get(task.task_id)?.decision ?? "unreviewed" }));
  if (accepted.length === 0) throw new Error("No task was accepted by review; nothing to promote.");
  const acceptedIds = new Set(accepted.map((task) => task.task_id));

  // Gate 1 — oracle + sentinels, recomputed over the accepted subset only.
  const validationPath = join(output, "environment", "offline-validation.json");
  if (!existsSync(validationPath)) throw new Error(`Missing ${validationPath}; rebuild the environment before promoting.`);
  const validation = asObject(JSON.parse(readFileSync(validationPath, "utf8")));
  const sentinelRows = (Array.isArray(validation.tasks) ? validation.tasks : []).map(asObject).filter((row) => acceptedIds.has(row.task_id));
  const sentinelFailures = sentinelRows.filter((row) => asObject(row.oracle).score !== 1 || Object.values(asObject(row.sentinels)).some((sentinel) => asObject(sentinel).score >= 1)).map((row) => row.task_id);
  if (sentinelFailures.length > 0) throw new Error(`Sentinel/oracle gate fails on the accepted subset (${sentinelFailures.join(", ")}); refusing to promote.`);

  // Gate 2 — source DAG: issues are promotable only with recorded waivers.
  const dagPath = join(output, "source-dag.json");
  const dag = existsSync(dagPath) ? asObject(JSON.parse(readFileSync(dagPath, "utf8"))) : { valid: true, issues: [], edges: [] };
  const edges = (Array.isArray(dag.edges) ? dag.edges : []).map(asObject);
  const edgeByPair = new Map(edges.map((edge) => [`${edge.from}->${edge.to}`, edge]));
  const waivers: Obj[] = [], unwaived: Obj[] = [];
  for (const issueValue of Array.isArray(dag.issues) ? dag.issues : []) {
    const issue = asObject(issueValue), edge = issue.edge ? edgeByPair.get(`${asObject(issue.edge).from}->${asObject(issue.edge).to}`) : undefined;
    const evidencedRetry = issue.code === "ambiguous_parent" && edges.some((candidate) => candidate.execution_group === edge?.execution_group && candidate.type === "retry" && asObject(candidate.evidence).prior_error === true);
    if (evidencedRetry) waivers.push({ issue, rationale: "ambiguous_parent tie caused by an evidenced retry (prior_error=true) followed by continuation — a normal production pattern", evidence: { edge: edge ?? null, evidenced_retry: true } });
    else if (options.waiveDagReason) waivers.push({ issue, rationale: options.waiveDagReason, evidence: { edge: edge ?? null, waived_by: "--waive-dag" } });
    else unwaived.push(issue);
  }
  if (unwaived.length > 0) throw new Error(`Source DAG issues without evidence or waiver: ${JSON.stringify(unwaived)}. Re-run with --waive-dag <reason> to waive them with a recorded rationale.`);

  // Promoted manifest: splits/taxonomy recomputed over the accepted subset.
  const proposalPath = join(output, "benchmark.json");
  const proposal = existsSync(proposalPath) ? asObject(JSON.parse(readFileSync(proposalPath, "utf8"))) : {};
  const heldoutNovel = accepted.some((task) => task.split === "heldout" && ["new_capability", "environment_extension"].includes(asObject(task.capability_fit).classification));
  const benchmark = benchmarkManifestFrom(accepted, {
    schemaVersion: "understudy.benchmark.v1",
    benchmarkId: String(proposal.benchmark_id ?? `trace-${hash({ output }).slice(0, 16)}`),
    name: String(proposal.name ?? "Trace-derived benchmark"),
    description: `${String(proposal.description ?? "Machine-compiled from a source-history DAG.")} Promoted after human review: rejected/needs_more tasks are excluded, not blockers.`,
    createdAt: String(proposal.created_at ?? now.toISOString()),
    sourceRefs: ["capture-ledger.jsonl", "source-dag.json", "review-decisions.jsonl", "promotion-record.json"],
    packageSha256: (asObject(proposal.environment).package_sha256 as string | null) ?? null,
    auditedCommit: String(asObject(proposal.environment).verifiers_version_pin ?? "cb9c84969186f8a0954b1027320f225e6b6b0afb"),
    heldoutNovel,
    status: "promoted",
    executable: true,
    promotionBlockers: [],
  });
  const errors = validateBenchmarkManifest(benchmark);
  if (errors.length > 0) throw new Error(`Promoted benchmark manifest is invalid; refusing to write benchmark.json:\n${errors.join("\n")}`);

  // Record first (who/when/waivers/counts/blockers-cleared), THEN the manifest.
  if (Object.keys(proposal).length > 0 && proposal.status !== "promoted") writeJson(join(output, "benchmark-proposal.json"), proposal);
  const record = {
    schema_version: "understudy.promotion_record.v1",
    benchmark_id: benchmark.benchmark_id,
    promoted_at: now.toISOString(),
    promoted_by: options.promotedBy ?? process.env.USER ?? "unknown",
    counts: { proposed: tasks.length, accepted: accepted.length, excluded: excluded.length },
    accepted_tasks: [...acceptedIds],
    excluded_tasks: excluded,
    decisions: Object.fromEntries([...decisions.entries()]),
    blockers_cleared: {
      human_final_judgment: "every promoted task individually accepted (accept/restrict); rejected/needs_more tasks excluded rather than blocking",
      sentinel_tests: { recomputed_over_accepted_subset: true, pass: true, tasks_checked: sentinelRows.length },
      source_dag_invalid: waivers.length > 0 ? "waived with recorded evidence" : "no issues",
    },
    waivers,
  };
  writeJson(join(output, "promotion-record.json"), record);
  writeJson(proposalPath, benchmark);
  return { schema_version: "understudy.promotion_result.v1", benchmark_id: benchmark.benchmark_id, promoted: accepted.length, excluded: excluded.length, total: tasks.length, waivers: waivers.length, benchmark: proposalPath, promotion_record: join(output, "promotion-record.json") };
}

export function importTraceReviews(outputInput: string, reviewsInput: string): Obj {
  const output = resolve(outputInput), tasksPath = join(output, "tasks.jsonl"), tasks = readJsonl(tasksPath), reviews = readJsonl(resolve(reviewsInput));
  const byTask = new Map(tasks.map((task) => [task.task_id, task]));
  for (const review of reviews) {
    if (!byTask.has(review.task_id)) throw new Error(`Unknown reviewed task: ${review.task_id}`);
    if (!["accept", "restrict", "needs_more", "reject"].includes(review.decision)) throw new Error(`Invalid review decision: ${review.decision}`);
    if (review.task_hash && review.task_hash !== byTask.get(review.task_id)?.task_hash) throw new Error(`Stale review for changed task: ${review.task_id}`);
    review.decision_hash = hash({ task_id: review.task_id, decision: review.decision, restrictions: review.restrictions ?? [], task_hash: byTask.get(review.task_id)?.task_hash });
  }
  writeJsonl(join(output, "review-decisions.jsonl"), reviews);
  const decisions = new Map(reviews.map((review) => [review.task_id, review]));
  for (const task of tasks) if (decisions.has(task.task_id)) task.review = decisions.get(task.task_id);
  writeJsonl(tasksPath, tasks);
  const accepted = tasks.filter((task) => ACCEPTING_DECISIONS.includes(task.review?.decision)).length;
  const reviewed = tasks.filter((task) => REVIEW_DECISION_VALUES.includes(task.review?.decision)).length;
  // No unanimity: rejected/needs_more tasks are excluded at promotion time, not
  // blockers. Human judgment is complete once every task has a decision and at
  // least one task survived it.
  const humanApproved = reviewed === tasks.length && accepted > 0;
  const benchmark = asObject(JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8")));
  const blockers = (benchmark.promotion_blockers ?? []).filter((blocker: string) => blocker !== "human_final_judgment");
  if (!humanApproved) blockers.unshift("human_final_judgment");
  const promotion = humanApproved && blockers.length === 0 ? "human_approved" : "review_pending";
  benchmark.status = promotion; benchmark.promotion_blockers = blockers;
  writeJson(join(output, "benchmark.json"), benchmark);
  return { schema_version: "understudy.review_import.v1", reviewed: reviews.length, accepted, total: tasks.length, status: promotion };
}

export function createTraceReplayPlan(outputInput: string, models: string[]): Obj {
  if (models.length === 0) throw new Error("At least one --model is required");
  const output = resolve(outputInput), tasks = readJsonl(join(output, "tasks.jsonl"));
  const plan = { schema_version: "understudy.replay_plan.v1", benchmark: join(output, "benchmark.json"), environment: join(output, "environment"), models, variants: ["minimal_context", "authentic_history", "long_history", "distractors", "errors_and_retries", "saturation"], metrics: ["final_state", "preservation", "forbidden_effects", "failures", "retries", "context_tokens", "cost", "latency"], tasks: tasks.map((task) => task.task_id), execution: { approved: false, provider_calls_performed: false }, optimization_ladder: ["baseline", "GEPA_on_train_and_dev", "single_sealed_holdout_eval", "context_policy", "SFT_or_RLM", "RL"] };
  writeJson(join(output, "replay-plan.json"), plan); writeJson(join(output, "gepa-plan.json"), { schema_version: "understudy.gepa_plan.v1", requires: ["completed_baseline", "trusted_rewards", "sealed_holdout"], optimize_splits: ["train", "dev"], selection_split: "dev", final_split: "holdout", execute: false }); return plan;
}

/**
 * Replay subprocess hygiene (privacy): the pinned verifiers eval pushes every
 * finished run to the Prime Intellect platform BY DEFAULT (`EvalConfig.push:
 * bool = True`, uploaded by verifiers/v1/push.py using `$PRIME_API_KEY` or
 * ~/.prime/config.json). We therefore (a) never inherit the full parent env —
 * only an explicit allowlist plus explicitly-passed model credentials — and
 * (b) always pass the pinned commit's `--no-push` switch unless the caller
 * opts in with `--push`.
 */
const REPLAY_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TERM", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "XDG_CACHE_HOME", "XDG_DATA_HOME", "PYTHONUNBUFFERED"];
const REPLAY_ENV_ALLOWLIST_PREFIXES = ["UV_"];
const REPLAY_KEY_VAR = "UNDERSTUDY_REPLAY_API_KEY";

export type ReplayInvocation = { args: string[]; env: Record<string, string> };

export function buildReplayInvocation(environment: string, model: string, variant: string, maxExamples: number, push: boolean, parentEnv: NodeJS.ProcessEnv = process.env): ReplayInvocation {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (REPLAY_ENV_ALLOWLIST.includes(key) || REPLAY_ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  const args = ["run", "--project", environment, "eval", "understudy-trace-env", "-m", model, "-n", String(maxExamples), "--env.taskset.context-variant", variant, "--env.taskset.tools.runtime.type", "subprocess"];
  // Model credentials are wired explicitly, never inherited wholesale; without
  // them the pinned client would default to Prime inference + PRIME_API_KEY.
  const baseUrl = parentEnv.UNDERSTUDY_GATEWAY_URL ?? parentEnv.OPENAI_BASE_URL ?? null;
  const apiKey = parentEnv.UNDERSTUDY_API_KEY ?? parentEnv.OPENAI_API_KEY ?? null;
  if (apiKey !== null) { env[REPLAY_KEY_VAR] = apiKey; args.push("--client.api-key-var", REPLAY_KEY_VAR); }
  if (baseUrl !== null) args.push("--client.base-url", baseUrl);
  if (push) { for (const key of ["PRIME_API_KEY", "PRIME_TEAM_ID", "PRIME_INFERENCE_URL"]) { const value = parentEnv[key]; if (value !== undefined) env[key] = value; } }
  else args.push("--no-push");
  return { args, env };
}

export function runTraceReplays(outputInput: string, models: string[], variants: string[], maxExamples: number, confirmed: boolean, push = false): Obj {
  if (!confirmed) throw new Error("Replay execution can call paid model providers; pass --yes to approve the requested models and examples.");
  if (!Number.isInteger(maxExamples) || maxExamples <= 0) throw new Error("--max-examples must be a positive integer");
  const output = resolve(outputInput), environment = join(output, "environment"), allowed = new Set(["minimal_context", "authentic_history", "long_history", "distractors", "errors_and_retries", "saturation"]);
  for (const variant of variants) if (!allowed.has(variant)) throw new Error(`Unknown context variant: ${variant}`);
  const runs: Obj[] = [], runRoot = join(output, "replays"), taskRowsPath = join(environment, "understudy_trace_env", "tasks.json"), sourceTaskRows = JSON.parse(readFileSync(taskRowsPath, "utf8")) as Obj[]; mkdirSync(runRoot, { recursive: true });
  const promptFor = (row: Obj, variant: string): unknown => {
    const messages = row.source_messages ?? [], history = JSON.stringify(messages);
    if (variant === "minimal_context") return row.prompt;
    if (["authentic_history", "errors_and_retries"].includes(variant)) return messages.length ? messages : row.prompt;
    if (variant === "distractors") return `Unrelated archived note: ignore record 999.\n\nCaptured history:\n${history}`;
    if (variant === "long_history") return `Captured history repeated for retention testing:\n${history}\n${history}`;
    return `${history}\n`.repeat(8);
  };
  for (const model of models) for (const variant of variants) {
    const started = new Date(), invocation = buildReplayInvocation(environment, model, variant, maxExamples, push);
    writeJson(taskRowsPath, sourceTaskRows.map((row) => ({ ...row, prompt: promptFor(row, variant) })));
    let child: ReturnType<typeof spawnSync>;
    try { child = spawnSync("uv", invocation.args, { cwd: output, encoding: "utf8", env: invocation.env, maxBuffer: 16 * 1024 * 1024 }); }
    finally { writeJson(taskRowsPath, sourceTaskRows); }
    const run = { model, variant, started_at: started.toISOString(), finished_at: new Date().toISOString(), status: child.status === 0 ? "completed" : "error", exit_code: child.status, args: invocation.args, env_keys: Object.keys(invocation.env).sort(), stdout: child.stdout, stderr: child.stderr };
    writeJson(join(runRoot, `${hash({ model, variant }).slice(0, 16)}.json`), run); runs.push(run);
    if (child.error) throw new Error(`Could not start uv/verifiers replay: ${child.error.message}`);
  }
  const report = { schema_version: "understudy.replay_run.v1", provider_calls_performed: true, max_examples: maxExamples, push_requested: push, upload_performed: push, runs };
  writeJson(join(output, "replay-results.json"), report);
  // Keep the manifest's privacy fields honest when the caller opted into reporting.
  const manifestPath = join(output, "manifest.json");
  if (push && existsSync(manifestPath)) {
    const manifest = asObject(JSON.parse(readFileSync(manifestPath, "utf8")));
    manifest.privacy = { ...asObject(manifest.privacy), local_only: false, upload_performed: true, upload_destination: "app.primeintellect.ai" };
    writeJson(manifestPath, manifest);
  }
  return report;
}

/**
 * One compile invocation must exhaust the source: batching (--batch-size)
 * exists so the capability-fit catalog grows incrementally, so batches are
 * iterated INTERNALLY until no fresh capture is left queued. Stopping early
 * used to hide the remainder in goal-state.json while stdout reported success.
 */
export function compileTraceFoundry(sourceInput: string, outputInput: string, maxAgeDays = 3, now = new Date(), options: TraceFoundryOptions = {}): FoundryResult {
  let result = compileTraceFoundryBatch(sourceInput, outputInput, maxAgeDays, now, options);
  // Each pass ingests at most batchSize new captures; total/batchSize passes always suffice.
  for (let pass = 0; result.queued > 0 && pass < 10_000; pass += 1) result = compileTraceFoundryBatch(sourceInput, outputInput, maxAgeDays, now, options);
  if (result.queued > 0) {
    const compiled = result.result.counts.captures, total = compiled + result.queued;
    throw new Error(`${compiled} of ${total} captures compiled before the batch loop stopped; resume with: understudy traces build-benchmark --source ${resolve(sourceInput)} --output ${resolve(outputInput)}`);
  }
  return result.result;
}

function compileTraceFoundryBatch(sourceInput: string, outputInput: string, maxAgeDays = 3, now = new Date(), options: TraceFoundryOptions = {}): { result: FoundryResult; queued: number } {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) throw new Error("--max-age-days must be a positive integer");
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("--batch-size must be a positive integer");
  const source = resolve(sourceInput), output = resolve(outputInput), files = sourceFiles(source), cutoff = new Date(now.valueOf() - maxAgeDays * 86_400_000);
  const priorCatalog = readJsonl(join(output, "tasks.jsonl"));
  const priorLedger = readJsonl(join(output, "capture-ledger.jsonl"));
  const knownHashes = new Set(priorLedger.map((entry) => entry.source_sha256));
  const all: Obj[] = [];
  let invalidTimestampFiltered = 0;
  for (const file of files) for (const [index, envelope] of envelopes(file).entries()) {
    const row = normalize(envelope, `${relative(source, file) || file}#L${index + 1}`);
    if (row === null) invalidTimestampFiltered += 1;
    else if (!options.workload || [row.scope.workload_id, row.scope.workload_name].some((value) => String(value ?? "").toLowerCase() === options.workload?.toLowerCase())) all.push(row);
  }
  const fresh = all.filter((row) => new Date(row.captured_at) >= cutoff);
  const knownRows = fresh.filter((row) => knownHashes.has(row.source.sha256));
  const queuedRows = fresh.filter((row) => !knownHashes.has(row.source.sha256));
  const rows = [...knownRows, ...queuedRows.slice(0, batchSize)];
  if (rows.length === 0) throw new Error(`No captures satisfy --max-age-days ${maxAgeDays}; cutoff ${cutoff.toISOString()}. Refusing to compile a stale benchmark.`);
  const dag = buildDag(rows), tasks = tasksFrom(dag, rows, priorCatalog), viewer = join(output, "viewer"), capturesDir = join(viewer, "data", "captures");
  mkdirSync(capturesDir, { recursive: true });
  const captureIndex: Obj = {};
  for (const row of rows) {
    const fileId = hash({ capture_id: row.capture_id, source_sha256: row.source.sha256 }).slice(0, 40);
    const path = join(capturesDir, `${fileId}.json`);
    writeJson(path, row);
    captureIndex[row.capture_id] = { path: `data/captures/${fileId}.json`, source: row.source };
  }
  const newLedger = rows.filter((row) => !knownHashes.has(row.source.sha256)).map((row) => ({ source_sha256: row.source.sha256, source_pointer: row.source.pointer, capture_key: row.capture_key, ingested_at: now.toISOString() }));
  appendJsonl(join(output, "capture-ledger.jsonl"), newLedger);
  writeJsonl(join(output, "normalized-captures.jsonl"), rows); writeJson(join(output, "source-dag.json"), dag); writeJsonl(join(output, "tasks.jsonl"), tasks);
  const environment = writeVerifiersEnvironment(output, tasks, new Map(tasks.map((task) => { const row = rows.find((candidate) => candidate.capture_key === task.candidate_boundary); return [task.task_id, { system: row?.request.system ?? null, messages: row?.request.messages ?? [] }]; })), "cb9c84969186f8a0954b1027320f225e6b6b0afb");
  const heldoutNovel = tasks.some((task) => task.split === "heldout" && ["new_capability", "environment_extension"].includes(task.capability_fit.classification));
  const promotionBlockers = ["human_final_judgment", ...(!dag.valid ? ["source_dag_invalid"] : []), ...(!environment.oracle_pass ? ["oracle_failed"] : []), ...(!environment.sentinel_pass ? ["sentinel_tests"] : []), ...(heldoutNovel ? ["heldout_novel_semantics"] : [])];
  const benchmark = benchmarkManifestFrom(tasks, { schemaVersion: "understudy.benchmark.v1", benchmarkId: `trace-${hash({ source, workload: options.workload ?? null }).slice(0, 16)}`, name: options.workload ? `${options.workload} trace benchmark` : "Trace-derived benchmark", description: "Machine-compiled from a source-history DAG with human final judgment.", createdAt: now.toISOString(), sourceRefs: [relative(output, join(output, "capture-ledger.jsonl")), relative(output, join(output, "source-dag.json"))], packageSha256: environment.package_sha256, auditedCommit: environment.audited_commit, heldoutNovel, status: "machine_compiled_review_pending", executable: true, promotionBlockers });
  const manifestErrors = validateBenchmarkManifest({ ...benchmark, schema_version: "understudy.benchmark.v1" });
  if (manifestErrors.length > 0) throw new Error(`Generated benchmark manifest is invalid: ${manifestErrors.join("; ")}`);
  writeJson(join(output, "benchmark.json"), benchmark);
  writeFileSync(join(viewer, "index.html"), traceFoundryViewer({ tasks, nodes: dag.nodes, issues: dag.issues, captures: captureIndex, benchmark: { splits: benchmark.splits, promotion_blockers: benchmark.promotion_blockers, environment: benchmark.environment } }), { mode: 0o600 });
  const classifications = tasks.reduce((counts: Obj, task) => { const key = task.capability_fit.classification; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
  const reuse = ((classifications.new_instance ?? 0) + (classifications.task_variant ?? 0)) / Math.max(tasks.length, 1);
  const priorGoal = existsSync(join(output, "goal-state.json")) ? asObject(JSON.parse(readFileSync(join(output, "goal-state.json"), "utf8"))) : {};
  const batch = { index: Number(priorGoal.batch_index ?? 0) + 1, size: newLedger.length, new_captures: newLedger.length, queued_captures: Math.max(0, queuedRows.length - newLedger.length), classifications, clean_reuse_rate: reuse, new_semantic_rate: (classifications.new_capability ?? 0) / Math.max(tasks.length, 1), unresolved_high_impact_contradictions: classifications.contradiction ?? 0 };
  const recent = [...(priorGoal.recent_batches ?? []), batch].slice(-2), diminishing = recent.length === 2 && recent.every((item: Obj) => item.clean_reuse_rate >= 0.9 && item.new_semantic_rate < 0.05 && item.unresolved_high_impact_contradictions === 0);
  const goalState = { schema_version: "understudy.environment_goal.v1", status: batch.queued_captures > 0 ? "constructing" : diminishing ? "maintenance" : "reviewing", batch_index: batch.index, batch_size: batchSize, recent_batches: recent, next_action: batch.queued_captures > 0 ? "compile_next_batch" : promotionBlockers.length ? "review_close_calls_and_resolve_blockers" : "prepare_replays", input_hash: hash(rows.map((row) => row.source.sha256)), updated_at: now.toISOString() };
  writeJson(join(output, "goal-state.json"), goalState); appendJsonl(join(output, "goal-events.jsonl"), [{ at: now.toISOString(), action: "compile", input_hash: goalState.input_hash, batch, validation: { dag_valid: dag.valid, oracle_pass: environment.oracle_pass, sentinel_pass: environment.sentinel_pass }, next_action: goalState.next_action }]);
  const result: FoundryResult = { schema_version: "understudy.trace_foundry.v1", source, output_dir: output, freshness: { max_age_days: maxAgeDays, cutoff_utc: cutoff.toISOString(), newest_capture_utc: rows.map((row) => row.captured_at).sort().at(-1) }, counts: { source_files: files.length, captures: rows.length, tasks: tasks.length, edges: dag.edges.length, stale_filtered: all.length - fresh.length, invalid_timestamp_filtered: invalidTimestampFiltered }, artifacts: { normalized: join(output, "normalized-captures.jsonl"), dag: join(output, "source-dag.json"), tasks: join(output, "tasks.jsonl"), benchmark: join(output, "benchmark.json"), environment: environment.path, ledger: join(output, "capture-ledger.jsonl"), goal: join(output, "goal-state.json"), viewer: join(viewer, "index.html") }, privacy: { local_only: true, contains_customer_payloads: true, upload_performed: false, provider_called: false } };
  writeJson(join(output, "manifest.json"), result); return { result, queued: batch.queued_captures };
}
