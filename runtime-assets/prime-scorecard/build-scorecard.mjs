import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: build-scorecard.mjs <understudy.prime_scorecard.v1 config.json>");
const resolvedConfigPath = resolve(configPath);
const config = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
if (!["understudy.prime_scorecard.v1", "understudy.prime_benchmark_import.v1"].includes(config.schema_version)) {
  throw new Error("config.schema_version must be understudy.prime_scorecard.v1 or understudy.prime_benchmark_import.v1");
}
if (config.anonymized !== true) {
  throw new Error("config.anonymized must be true before building a durable scorecard");
}
const configDir = dirname(resolvedConfigPath);
const fromConfig = (value) => isAbsolute(value) ? value : resolve(configDir, value);
const primeRuns = fromConfig(config.source_dir);
const benchmark = fromConfig(config.scorecard_output_dir ?? config.output_dir);
const modelIds = readdirSync(primeRuns)
  .filter((name) => {
    const path = `${primeRuns}/${name}`;
    return statSync(path).isDirectory() &&
      readFileSync(`${path}/traces.jsonl`, "utf8").trim().length > 0;
  })
  .sort();
const primeTraces = modelIds.flatMap((model) =>
  readFileSync(`${primeRuns}/${model}/traces.jsonl`, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse),
);
if (
  primeTraces.length === 0 ||
  primeTraces.some(
    (trace) =>
      trace.verifiers?.version !== config.verifier_version ||
      !trace.is_completed ||
      trace.stop_condition !== "agent_completed" ||
      (trace.errors?.length ?? 0) > 0,
  )
) {
  throw new Error(`Refusing to build: every discovered trace must be a completed, error-free Prime Verifiers ${config.verifier_version} run`);
}
const pricing = config.pricing;
const contentText = (content) => (Array.isArray(content)
  ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
  : String(content ?? ""));
const matchLine = (text, pattern) => pattern.exec(text)?.[1]?.trim();
const normalizedTool = (name = "") =>
  name.replace(/^mcp__world_toolset__/, "").replaceAll("_", "-");
const parsedArguments = (value) => {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value ?? "{}"); } catch { return {}; }
};
const expectedToolPath = (trace) =>
  trace.task.data.outcome_contract.required.map((rule) =>
    rule.tool === "run-subagent"
      ? rule.arguments_semantic?.subagentPath?.replace("@subagents/", "") ?? rule.tool
      : rule.tool,
  );
const taskDetails = (trace) => {
  const configured = config.tasks?.[trace.task.data.task_id];
  if (!configured) throw new Error(`Missing task metadata for ${trace.task.data.task_id}`);
  if (configured.label) {
    return {
      label: configured.label,
      summary: configured.summary?.length
        ? configured.summary
        : [
          `Scenario: ${configured.label}.`,
          `Expected behavior: follow the verifier contract through ${expectedToolPath(trace).join(" → ")}.`,
          "Measures: production-equivalent tool routing and terminal behavior.",
        ],
    };
  }
  const text = trace.task.data.prompt;
  const meeting = matchLine(text, /Meeting:\s*([^\n]+)/i);
  const participants = matchLine(text, /Participants:\s*([^\n]+)/i)
    ?.replaceAll("<", "")
    .replaceAll(">", "");
  const company = matchLine(text, /\*\*Primary company:\*\*\s*([^\n]+)/i);
  const subject = meeting ?? company ?? `Meeting task ${trace.task.data.task_id.slice(-6)}`;
  const context = [company && company !== subject ? company : null, participants]
    .filter(Boolean)
    .join("; ");
  const expected = expectedToolPath(trace);
  return {
    label: [subject, company && company !== subject ? company : null]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 180),
    summary: [
      `Scenario: ${subject}${context ? ` — ${context}` : ""}.`,
      `Expected behavior: follow the captured playbook through ${expected.join(" → ")}.`,
      "Measures: exact production-equivalent tools and routing IDs on every turn, followed by the same terminal behavior.",
    ],
  };
};
const isHarnessTitleCall = (call) => Boolean(call.sampling?.output_config);
const conversation = (trace) => {
  const nodes = trace.nodes;
  const start = nodes.findIndex(
    (node) =>
      node.message?.role === "system" &&
      contentText(node.message.content).includes("<role>"),
  );
  return nodes.slice(Math.max(start, 0)).map((node) => {
    const message = node.message ?? {};
    const blocks = [];
    if (message.content) {
      if (Array.isArray(message.content)) blocks.push(...message.content);
      else blocks.push({ type: "text", text: String(message.content) });
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        name: normalizedTool(call.name),
        input: parsedArguments(call.arguments),
      });
    }
    if (message.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", content: contentText(message.content) }] };
    }
    return { role: message.role, content: blocks };
  });
};
const rollouts = primeTraces.map((prime) => {
    const model = prime.agent.model;
    const taskId = prime.task.data.task_id;
    const calls = prime.calls.filter((call) => !isHarnessTitleCall(call));
    const usage = calls.map((call) => call.usage ?? {});
    const rate = pricing[model];
    if (!rate) throw new Error(`Missing Understudy customer rate card for ${model}`);
    const cost = usage.reduce(
      (sum, row) =>
        sum +
        ((row.prompt_tokens ?? 0) * rate.input +
          (row.cached_input_tokens ?? 0) * rate.cache_read +
          ((row.completion_tokens ?? 0) + (row.reasoning_tokens ?? 0)) * rate.output) /
          1_000_000,
      0,
    );
    const toolUses = conversation(prime)
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "tool_use");
    const observed = toolUses.map((block) =>
      block.name === "run-subagent" && block.input?.subagentPath
        ? block.input.subagentPath.replace("@subagents/", "")
        : block.name,
    );
    const expected = expectedToolPath(prime);
    const started = Math.min(...calls.map((call) => call.time.start));
    const ended = Math.max(...calls.map((call) => call.time.end));
    return {
      id: prime.id,
      model,
      task_id: taskId,
      prompt: taskDetails(prime).label,
      task_summary: taskDetails(prime).summary,
      strict_pass: prime.rewards.final_state === 1,
      reward: prime.rewards.final_state,
      partial_credit: prime.metrics.final_state_partial_credit,
      turns: calls.length,
      latency_ms: Math.round((ended - started) * 1000),
      tokens: usage.reduce((sum, row) => sum + (row.prompt_tokens ?? 0) + (row.cached_input_tokens ?? 0) + (row.completion_tokens ?? 0), 0),
      cost_usd: cost,
      terminal_reason: prime.stop_condition,
      grading_method: `Prime Verifiers ${config.verifier_version} deterministic final-state contract (no LLM judge or regex)`,
      tool_path: observed,
      expected_tool_path: expected,
      misses: [],
      trace: conversation(prime),
      verifier_version: prime.verifiers.version,
      harness: `${prime.agent.harness.id} ${prime.agent.harness.version ?? "2.1.214"}`,
      run_id: prime.run.id,
      cost_note: `${rate.source}; highest currently effective published customer USD/M rate applied to Prime-native fresh input, cached input, completion, and reasoning usage. Future-dated rates are excluded.`,
    };
  });
const data = JSON.stringify({
  workload: config.benchmark_id,
  provider: config.provider_label ?? "mixed",
  created_at: new Date().toISOString(),
  benchmark_id: config.benchmark_id,
  name: config.name,
  incumbent_model: config.incumbent_model,
  verifier_version: config.verifier_version,
  source: `Prime Verifiers ${config.verifier_version} native traces only`,
  rollouts,
}).replaceAll("</", "<\\/");

const html = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${String(config.name).replaceAll("<","&lt;")} · verifier trace scorecard</title><style>
:root{--bg:#030303;--panel:#090909;--ink:#e8e8e6;--muted:#777;--line:#252525;--green:#4de49a;--red:#ff5b4d;--amber:#e9a83b;--cyan:#52d7df;--violet:#a884ff}*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.layout{height:calc(100vh - 28px);display:grid;grid-template-columns:280px minmax(560px,1fr) 270px;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:14px}.pane{min-width:0;min-height:0;border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}.pane:last-child{border-right:0}.head{height:56px;flex:0 0 56px;display:flex;align-items:center;padding:0 18px;border-bottom:1px solid var(--line);font-weight:600}.head .sub{margin-left:auto}.scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}.sub{color:var(--muted);font-size:11px}.summary-button{width:100%;border:0;border-bottom:1px solid var(--line);background:#07100d;color:var(--green);text-align:left;padding:14px 16px;cursor:pointer;font:600 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.summary-button:hover,.summary-button.on{background:#102019}.summary-button span{float:right}.model-group{border-bottom:1px solid var(--line)}.model-group-title{display:block;cursor:pointer;list-style:none;background:#080808;border-bottom:1px solid var(--line);padding:11px 16px;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.model-group-title::-webkit-details-marker{display:none}.model-group-title:before{content:"▸";display:inline-block;width:15px;color:#555}.model-group[open]>.model-group-title:before{content:"▾"}.model-group-title span{float:right;color:var(--muted)}.rollout{width:100%;border:0;background:none;color:inherit;text-align:left;padding:13px 16px;cursor:pointer;font:inherit}.rollout:hover,.rollout.on{background:#111}.rowtop{display:flex}.reward{margin-left:auto}.green{color:var(--green)}.red{color:var(--red)}.amber{color:var(--amber)}.prompt{color:#aaa;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.history{padding:18px}.task-summary,.verifier-card{border:1px solid #29413a;border-radius:12px;background:#09100e;margin-bottom:16px;padding:15px 18px}.task-summary-title,.verifier-title{color:var(--green);font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px}.task-summary ul{margin:0;padding-left:20px}.task-summary li{margin:5px 0;color:#c8cecb}.verifier-card{margin:16px 0 0;background:#090909;border-color:var(--line)}.verifier-result{font-size:20px;margin:4px 0 14px}.verifier-row{display:grid;grid-template-columns:145px minmax(0,1fr);gap:12px;padding:8px 0;border-top:1px solid var(--line)}.verifier-row span:first-child{color:var(--muted)}.message{min-width:0;border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}.message summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:90px minmax(0,1fr) 16px;gap:12px;align-items:center;padding:13px 18px}.message summary::-webkit-details-marker{display:none}.message summary::after{content:"▸";color:var(--muted);text-align:right}.message[open] summary::after{content:"▾"}.message[open] summary{border-bottom:1px solid var(--line)}.message-body{padding:16px 18px}.role{font-size:11px;color:var(--muted)}.role.user{color:#80d7c4}.role.assistant{color:var(--violet)}.role.system{color:#777}.preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#888;font-size:12px}.text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.tool{min-width:0;border:1px solid #1b3939;border-radius:9px;margin:8px 0;padding:10px 12px;color:var(--cyan);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:12px;align-items:start}.tool.out{border-color:#173622;color:#79b88f}.args{min-width:0;color:#999;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.overview{padding:20px}.big{font-size:20px;margin-bottom:24px}.metric{display:flex;border-bottom:1px solid var(--line);padding:13px 0;color:#999}.metric b{margin-left:auto;color:var(--ink);font-weight:500}.label{color:#555;font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin:24px 0 8px}.failure{color:var(--red);font-size:12px;margin-top:10px}.path{color:var(--cyan);font-size:12px;word-break:break-word}.summary-stack{display:grid;gap:16px}.summary-card{border:1px solid var(--line);border-radius:12px;padding:16px;background:#080808;min-width:0}.summary-card h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#aaa;margin:0 0 16px}.pareto{display:block;width:100%;height:auto;max-height:330px;overflow:visible}.pareto text{fill:#777;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.pareto .point-label{fill:#bbb;font-size:10px}.pareto .axis-title{fill:#666;font-size:10px;text-transform:uppercase}.chart-note{display:flex;justify-content:space-between;gap:14px;margin-top:6px;color:#666;font-size:10px}.dot.frontier{background:var(--green)}.empty-chart{padding:70px 0;text-align:center;color:#666}.table-scroll{overflow-x:auto}.leaderboard-table,.matrix-table{width:100%;border-collapse:collapse}.leaderboard-table{min-width:700px}.leaderboard-table th,.leaderboard-table td,.matrix-table th,.matrix-table td{text-align:right;padding:10px 9px;border-bottom:1px solid var(--line);white-space:nowrap}.leaderboard-table th:first-child,.leaderboard-table td:first-child,.leaderboard-table th:nth-child(2),.leaderboard-table td:nth-child(2),.matrix-table th:first-child,.matrix-table td:first-child{text-align:left}.leaderboard-table th,.matrix-table th{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:500}.sort-button{all:unset;display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:inherit}.sort-button:hover,.sort-button.active{color:#bbb}.sort-button span{color:#555;font-size:9px}.sort-button.active span{color:var(--green)}.rank{color:#555;width:28px}.status-pill{display:inline-block;margin-left:9px;padding:2px 6px;border:1px solid var(--line);border-radius:999px;font-size:9px;font-weight:400}.status-pill.pass{color:var(--green);border-color:#1f553b}.status-pill.fail{color:var(--red);border-color:#53241f}.status-pill.mixed{color:var(--amber);border-color:#56421f}.task-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}.task-card{min-width:0;border:1px solid var(--line);border-radius:9px;overflow:hidden}.task-card-head{display:flex;justify-content:space-between;gap:12px;padding:12px;background:#0c0c0c;color:#777;font-size:10px}.task-card-head div{min-width:0}.task-card-head b{display:block;margin-top:4px;color:#bbb;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.matrix-table{font-size:11px}.winner{border:1px solid var(--line);border-radius:9px;margin:8px 0;padding:11px}.winner span,.winner small{display:block;color:#666;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.winner b{display:block;margin:4px 0;color:var(--ink);font-size:13px}.summary-note{margin-top:20px;line-height:1.6}@media(max-width:1050px){.layout{grid-template-columns:240px minmax(540px,1fr)}.overviewPane{display:none}}@media(max-width:760px){html,body{overflow:auto}.layout{display:block;height:auto;min-height:100vh;margin:0;border-radius:0}.pane{height:auto;border-right:0}.pane:first-child{max-height:38vh}.pane:nth-child(2){min-height:62vh}.task-grid{grid-template-columns:1fr}}
</style><style>
.delta{display:block;margin-top:3px;color:#666;font-size:9px;font-weight:400}.delta.better{color:var(--green)}.delta.worse{color:var(--red)}
.layout.summary-mode{grid-template-columns:minmax(0,1fr)}
.layout.summary-mode>aside{display:none}
.summary-highlights{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.summary-highlights .winner{margin:0;padding:12px 14px}
.model-toggle{all:unset;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.model-toggle:before{content:"▸";color:#666;font-size:10px}
.model-toggle.open:before{content:"▾";color:var(--green)}
.rollout-detail td{padding:0!important;background:#060606}
.nested-rollouts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}
.nested-rollout{border:0;background:#090909;color:inherit;text-align:left;padding:12px 14px;cursor:pointer;font:inherit}
.nested-rollout:hover{background:#111}
.nested-rollout .sub{display:block;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:760px){.summary-highlights,.nested-rollouts{grid-template-columns:1fr}}
</style></head><body>
<main class="layout"><aside class="pane"><div class="head">Rollouts <span class="sub" id="count"></span></div><div class="scroll" id="list"></div></aside>
<section class="pane"><div class="head" id="center-title">Conversation history</div><div class="scroll history" id="history"></div></section>
<aside class="pane overviewPane"><div class="head">Overview <span class="reward" id="reward"></span></div><div class="scroll overview" id="overview"></div></aside></main>
<script>
const D=${data};
let selected=D.rollouts[0];
let viewMode="summary";
let leaderSort={key:"score",dir:"desc"};
let expandedModel=null;
const esc=x=>String(x??'').replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ms=n=>n>=1000?(n/1000).toFixed(1)+"s":n+"ms";
const tok=n=>n>=1000?(n/1000).toFixed(1)+"k":String(n);
const usd=n=>Number.isFinite(n)?"$"+n.toFixed(4):"—";
function blocks(message){
  const content=Array.isArray(message.content)?message.content:[{type:"text",text:String(message.content??"")}];
  return content.map(block=>{
    if(block.type==="text")return '<div class="text">'+esc(block.text)+'</div>';
    if(block.type==="tool_use")return '<div class="tool"><b>'+esc(block.name)+'</b><span class="args">'+esc(JSON.stringify(block.input??{}))+'</span></div>';
    if(block.type==="tool_result")return '<div class="tool out"><b>tool output</b><span class="args">'+esc(typeof block.content==="string"?block.content:JSON.stringify(block.content))+'</span></div>';
    return "";
  }).join("");
}
function preview(message){
  const content=Array.isArray(message.content)?message.content:[{type:"text",text:String(message.content??"")}];
  const block=content.find(x=>x.type==="text")||content.find(x=>x.type==="tool_use")||content.find(x=>x.type==="tool_result");
  if(!block)return "empty message";
  if(block.type==="tool_use")return block.name+" "+JSON.stringify(block.input??{});
  if(block.type==="tool_result")return "tool output "+(typeof block.content==="string"?block.content:JSON.stringify(block.content));
  return block.text;
}
const avg=rows=>rows.length?rows.reduce((sum,value)=>sum+value,0)/rows.length:0;
const shortModel=model=>model.replace("claude-","");
function modelRows(model){return D.rollouts.filter(row=>row.model===model)}
function histogram(models){
  const bins=[0,.25,.5,.75,1];
  const counts=models.map(model=>bins.map(bin=>modelRows(model).filter(row=>Math.round(row.partial_credit*4)/4===bin).length));
  const maximum=Math.max(1,...counts.flat());
  return '<div class="legend">'+models.map((model,index)=>'<span><i class="dot" style="background:'+(index?"var(--violet)":"var(--cyan)")+'"></i>'+esc(shortModel(model))+'</span>').join("")+'</div><div class="histogram">'+bins.map((bin,binIndex)=>'<div class="hist-group">'+models.map((model,modelIndex)=>'<div class="hist-bar" title="'+esc(shortModel(model))+': '+counts[modelIndex][binIndex]+'" style="height:'+((counts[modelIndex][binIndex]/maximum)*100)+'%;background:'+(modelIndex?"var(--violet)":"var(--cyan)")+'"></div>').join("")+'<span class="hist-label">'+bin.toFixed(2)+'</span></div>').join("")+'</div>';
}
function capabilityScores(model){
  const rows=modelRows(model);
  const scoreFor=tool=>{const applicable=rows.filter(row=>row.expected_tool_path.includes(tool));return avg(applicable.map(row=>row.strict_pass?1:row.partial_credit))};
  return [scoreFor("crm-updater"),scoreFor("sales-post-meeting"),scoreFor("next-steps"),scoreFor("hiring-post-meeting"),avg(rows.map(row=>row.strict_pass?1:0))];
}
function radar(models){
  const labels=["CRM routing","Sales follow-up","Next steps","Hiring routing","Completion"],cx=160,cy=132,radius=88;
  const point=(index,value=1)=>{const angle=-Math.PI/2+index*Math.PI*2/labels.length;return [cx+Math.cos(angle)*radius*value,cy+Math.sin(angle)*radius*value]};
  const polygon=values=>values.map((value,index)=>point(index,value).join(",")).join(" ");
  const grids=[.25,.5,.75,1].map(level=>'<polygon points="'+polygon(labels.map(()=>level))+'" fill="none" stroke="#252525"/>').join("");
  const axes=labels.map((label,index)=>{const edge=point(index,1),text=point(index,1.23);return '<line x1="'+cx+'" y1="'+cy+'" x2="'+edge[0]+'" y2="'+edge[1]+'" stroke="#252525"/><text x="'+text[0]+'" y="'+text[1]+'" text-anchor="middle">'+esc(label)+'</text>'}).join("");
  const series=models.map((model,index)=>'<polygon points="'+polygon(capabilityScores(model))+'" fill="'+(index?"rgba(168,132,255,.16)":"rgba(82,215,223,.14)")+'" stroke="'+(index?"#a884ff":"#52d7df")+'" stroke-width="2"/>').join("");
  return '<div class="legend">'+models.map((model,index)=>'<span><i class="dot" style="background:'+(index?"var(--violet)":"var(--cyan)")+'"></i>'+esc(shortModel(model))+'</span>').join("")+'</div><svg class="radar" viewBox="0 0 320 285" role="img" aria-label="Verifier-backed capability radar">'+grids+axes+series+'</svg>';
}
function modelStats(models){
  return models.map(model=>{const rows=modelRows(model),costs=rows.map(row=>row.cost_usd).filter(Number.isFinite);return {model,rows,score:avg(rows.map(row=>row.partial_credit)),pass:avg(rows.map(row=>row.strict_pass?1:0)),time:avg(rows.map(row=>row.latency_ms)),cost:costs.length===rows.length?avg(costs):null,calls:avg(rows.map(row=>row.turns))}}).sort((a,b)=>b.score-a.score||b.pass-a.pass||(Number.isFinite(a.cost)?a.cost:Infinity)-(Number.isFinite(b.cost)?b.cost:Infinity)||a.time-b.time);
}
function sortedStats(stats){
  const direction=leaderSort.dir==="asc"?1:-1;
  return [...stats].sort((left,right)=>{
    const a=left[leaderSort.key],b=right[leaderSort.key];
    const primary=typeof a==="string"?a.localeCompare(b):(a??Infinity)-(b??Infinity);
    return primary*direction||right.score-left.score||left.cost-right.cost;
  });
}
function sortHead(key,label){
  const active=leaderSort.key===key,arrow=active?(leaderSort.dir==="asc"?"↑":"↓"):"↕";
  return '<th aria-sort="'+(active?(leaderSort.dir==="asc"?"ascending":"descending"):"none")+'"><button class="sort-button '+(active?"active":"")+'" data-sort="'+key+'">'+label+' <span>'+arrow+'</span></button></th>';
}
function statusPill(stat){return '<span class="status-pill '+(stat.pass===1?"pass":stat.pass===0?"fail":"mixed")+'">'+Math.round(stat.pass*100)+'% pass</span>'}
function paretoPlot(stats){
  const rows=stats.filter(stat=>Number.isFinite(stat.cost));
  if(!rows.length)return '<div class="empty-chart">No reviewed cost data available.</div>';
  const width=760,height=320,pad={left:58,right:24,top:66,bottom:50};
  const sorted=[...rows].sort((a,b)=>a.cost-b.cost);
  const gaps=sorted.slice(0,-1).map((row,index)=>({index,ratio:sorted[index+1].cost/Math.max(row.cost,.000001)})).filter(gap=>gap.index>=2);
  const largestGap=gaps.sort((a,b)=>b.ratio-a.ratio)[0];
  const useBreak=Boolean(largestGap&&largestGap.ratio>=1.8&&sorted.length-largestGap.index-1<=Math.max(4,Math.ceil(sorted.length*.35)));
  const dense=useBreak?sorted.slice(0,largestGap.index+1):sorted;
  const outliers=useBreak?sorted.slice(largestGap.index+1):[];
  const plotStart=pad.left,plotEnd=width-pad.right,totalWidth=plotEnd-plotStart,breakGap=28;
  const denseEnd=useBreak?plotStart+totalWidth*.76:plotEnd;
  const outlierStart=denseEnd+breakGap;
  const denseMax=Math.max(...dense.map(row=>row.cost))*1.08||1;
  const outlierMin=useBreak?Math.min(...outliers.map(row=>row.cost))*.96:0;
  const outlierMax=useBreak?Math.max(...outliers.map(row=>row.cost))*1.04:0;
  const minScore=Math.max(0,Math.min(...rows.map(row=>row.score))-.08);
  const x=value=>!useBreak||value<=denseMax
    ?plotStart+(value/denseMax)*(denseEnd-plotStart)
    :outlierStart+((value-outlierMin)/Math.max(outlierMax-outlierMin,.000001))*(plotEnd-outlierStart);
  const y=value=>pad.top+(1-(value-minScore)/(1-minScore))*(height-pad.top-pad.bottom);
  const frontier=rows.filter(candidate=>!rows.some(other=>other!==candidate&&other.cost<=candidate.cost&&other.score>=candidate.score&&(other.cost<candidate.cost||other.score>candidate.score))).sort((a,b)=>a.cost-b.cost);
  const grid=[0,.25,.5,.75,1].map(ratio=>{const score=minScore+(1-minScore)*ratio;return '<line x1="'+pad.left+'" y1="'+y(score)+'" x2="'+(width-pad.right)+'" y2="'+y(score)+'" stroke="#1d1d1d"/><text x="'+(pad.left-10)+'" y="'+(y(score)+4)+'" text-anchor="end">'+score.toFixed(2)+'</text>'}).join("");
  const denseTicks=[0,.25,.5,.75,1].map(ratio=>denseMax*ratio);
  const outlierTicks=useBreak?[outlierMin,outlierMax]:[];
  const costTicks=[...denseTicks,...outlierTicks].map(cost=>'<line x1="'+x(cost)+'" y1="'+pad.top+'" x2="'+x(cost)+'" y2="'+(height-pad.bottom)+'" stroke="#141414"/><text x="'+x(cost)+'" y="'+(height-pad.bottom+22)+'" text-anchor="middle">$'+cost.toFixed(2)+'</text>').join("");
  const frontierPath=points=>points.map((row,index)=>(index?"L":"M")+x(row.cost)+" "+y(row.score)).join(" ");
  const paths=(useBreak?[frontier.filter(row=>row.cost<=denseMax),frontier.filter(row=>row.cost>denseMax)]:[frontier]).filter(points=>points.length).map(points=>'<path d="'+frontierPath(points)+'" fill="none" stroke="var(--green)" stroke-width="2" stroke-dasharray="5 5"/>').join("");
  const placedLabels=[];
  const labelPositions=new Map();
  [...rows].sort((a,b)=>y(a.score)-y(b.score)||x(a.cost)-x(b.cost)).forEach((row,rowIndex)=>{
    const px=x(row.cost),py=y(row.score),name=shortModel(row.model),labelWidth=Math.max(44,name.length*6.2);
    const topBand=py<=pad.top+18;
    const candidates=topBand
      ?[13,27,41,55].map(labelY=>({x:px,y:labelY,anchor:"middle"}))
      :[
        {x:px+9,y:py-9,anchor:"start"},{x:px-9,y:py-9,anchor:"end"},
        {x:px+9,y:py+18,anchor:"start"},{x:px-9,y:py+18,anchor:"end"},
        {x:px,y:py-22,anchor:"middle"},{x:px,y:py+31,anchor:"middle"}
      ];
    const withBox=candidate=>{
      const left=candidate.anchor==="start"?candidate.x:candidate.anchor==="end"?candidate.x-labelWidth:candidate.x-labelWidth/2;
      return {...candidate,box:{left,right:left+labelWidth,top:candidate.y-10,bottom:candidate.y+3}};
    };
    const available=candidates.map(withBox).find(candidate=>
      candidate.box.left>=plotStart-2&&candidate.box.right<=plotEnd+2&&candidate.box.top>=2&&candidate.box.bottom<=height-pad.bottom-2&&
      placedLabels.every(box=>candidate.box.right<box.left-5||candidate.box.left>box.right+5||candidate.box.bottom<box.top-3||candidate.box.top>box.bottom+3)
    )||withBox(candidates[rowIndex%candidates.length]);
    placedLabels.push(available.box);
    labelPositions.set(row,{x:available.x,y:available.y,anchor:available.anchor,line:topBand||Math.abs(available.y-(py-9))>2});
  });
  const dots=rows.map(row=>{
    const onFrontier=frontier.includes(row),px=x(row.cost),py=y(row.score),label=labelPositions.get(row);
    const leader=label.line?'<line x1="'+px+'" y1="'+(py-6)+'" x2="'+label.x+'" y2="'+(label.y+3)+'" stroke="#484848" stroke-width="1" stroke-dasharray="2 2"/>':'';
    return '<g>'+leader+'<circle cx="'+px+'" cy="'+py+'" r="'+(onFrontier?7:5)+'" fill="'+(onFrontier?"var(--green)":"var(--violet)")+'" stroke="#050505" stroke-width="2"/><text class="point-label" text-anchor="'+label.anchor+'" x="'+label.x+'" y="'+label.y+'">'+esc(shortModel(row.model))+'</text><title>'+esc(shortModel(row.model))+': score '+row.score.toFixed(3)+', '+usd(row.cost)+'/task</title></g>';
  }).join("");
  const axisBreak=useBreak?'<path d="M '+(denseEnd+7)+' '+(height-pad.bottom-6)+' l 7 12 l 7 -12 l 7 12" fill="none" stroke="#777" stroke-width="2"/><text class="break-label" x="'+(denseEnd+breakGap/2)+'" y="'+(pad.top+10)+'" text-anchor="middle">cost jump</text>':'';
  const zoomNote=useBreak?'<span>Auto-zoom: '+dense.length+' models ≤ '+usd(Math.max(...dense.map(row=>row.cost)))+' · jump to '+outliers.map(row=>shortModel(row.model)+" "+usd(row.cost)).join(", ")+'</span>':'<span>Continuous cost scale</span>';
  return '<svg class="pareto" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Verifier score versus cost per task Pareto plot with automatic outlier axis break">'+grid+costTicks+paths+axisBreak+dots+'<text class="axis-title" x="'+(width/2)+'" y="'+(height-8)+'" text-anchor="middle">Cost per task → lower is better</text><text class="axis-title" transform="translate(14 '+(height/2)+') rotate(-90)" text-anchor="middle">Verifier score → higher is better</text></svg><div class="chart-note"><span><i class="dot frontier"></i>Pareto frontier</span>'+zoomNote+'</div>';
}
function summaryView(models){
  const stats=sortedStats(modelStats(models));
  const incumbent=stats.find(stat=>stat.model===D.incumbent_model);
  const delta=(value,base,lowerIsBetter=false)=>{
    if(!Number.isFinite(value)||!Number.isFinite(base)||base===0)return "";
    const pct=(value-base)/Math.abs(base)*100;
    const better=lowerIsBetter?pct<0:pct>0;
    return '<span class="delta '+(Math.abs(pct)<.05?"":better?"better":"worse")+'">'+(pct>=0?"+":"")+pct.toFixed(1)+'% vs incumbent</span>';
  };
  const tasks=[...new Map(D.rollouts.map(row=>[row.task_id,row])).values()];
  const qualified=stats.filter(stat=>stat.pass===1);
  const best=[...stats].sort((a,b)=>b.score-a.score||a.cost-b.cost)[0];
  const fastest=[...qualified].sort((a,b)=>a.time-b.time)[0];
  const cheapest=[...qualified].filter(stat=>Number.isFinite(stat.cost)).sort((a,b)=>a.cost-b.cost)[0];
  const callout=(label,stat,value)=>'<div class="winner"><span>'+label+'</span><b>'+esc(shortModel(stat?.model??"—"))+'</b><small>'+value+'</small></div>';
  const highlights='<div class="summary-highlights">'+callout("highest score",best,best?best.score.toFixed(3):"—")+callout("fastest passing",fastest,fastest?ms(fastest.time):"—")+callout("cheapest passing",cheapest,cheapest?usd(cheapest.cost):"—")+'</div>';
  const leaderboard=stats.map((stat,index)=>{
    const open=expandedModel===stat.model;
    const rollouts=stat.rows.map((row,taskIndex)=>'<button class="nested-rollout rollout" data-id="'+esc(row.id)+'"><b>Task '+(taskIndex+1)+' <span class="'+(row.strict_pass?"green":"red")+'">'+row.partial_credit.toFixed(2)+'</span></b><span class="sub">'+esc(row.prompt)+' · '+ms(row.latency_ms)+' · '+usd(row.cost_usd)+'</span></button>').join("");
    const baseline=stat.model===D.incumbent_model?'<span class="delta">production incumbent</span>':"";
    return '<tr><td class="rank">'+(index+1)+'</td><td><button class="model-toggle '+(open?"open":"")+'" data-model="'+esc(stat.model)+'"><b>'+esc(shortModel(stat.model))+'</b></button>'+statusPill(stat)+baseline+'</td><td>'+stat.score.toFixed(3)+(incumbent&&stat!==incumbent?delta(stat.score,incumbent.score):"")+'</td><td>'+Math.round(stat.pass*stat.rows.length)+'/'+stat.rows.length+(incumbent&&stat!==incumbent?delta(stat.pass,incumbent.pass):"")+'</td><td>'+ms(stat.time)+(incumbent&&stat!==incumbent?delta(stat.time,incumbent.time,true):"")+'</td><td>'+usd(stat.cost)+(incumbent&&stat!==incumbent?delta(stat.cost,incumbent.cost,true):"")+'</td><td>'+stat.calls.toFixed(1)+(incumbent&&stat!==incumbent?delta(stat.calls,incumbent.calls,true):"")+'</td></tr>'+(open?'<tr class="rollout-detail"><td colspan="7"><div class="nested-rollouts">'+rollouts+'</div></td></tr>':"");
  }).join("");
  const taskCards=tasks.map((task,index)=>{const rows=stats.map(stat=>D.rollouts.find(row=>row.model===stat.model&&row.task_id===task.task_id)).filter(Boolean);const incumbentRow=rows.find(row=>row.model===D.incumbent_model);return '<section class="task-card"><div class="task-card-head"><div><span>Task '+(index+1)+'</span><b>'+esc(task.prompt)+'</b></div><span>'+rows.filter(row=>row.strict_pass).length+'/'+rows.length+' pass</span></div><table class="matrix-table"><thead><tr><th>Model</th><th>Score</th><th>Time</th><th>Cost</th><th>Calls</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+esc(shortModel(row.model))+(row.model===D.incumbent_model?'<span class="delta">incumbent</span>':"")+'</td><td class="'+(row.strict_pass?"green":"red")+'">'+row.partial_credit.toFixed(2)+(incumbentRow&&row!==incumbentRow?delta(row.partial_credit,incumbentRow.partial_credit):"")+'</td><td>'+ms(row.latency_ms)+(incumbentRow&&row!==incumbentRow?delta(row.latency_ms,incumbentRow.latency_ms,true):"")+'</td><td>'+usd(row.cost_usd)+(incumbentRow&&row!==incumbentRow?delta(row.cost_usd,incumbentRow.cost_usd,true):"")+'</td><td>'+row.turns+(incumbentRow&&row!==incumbentRow?delta(row.turns,incumbentRow.turns,true):"")+'</td></tr>').join("")+'</tbody></table></section>'}).join("");
  return '<div class="summary-stack">'+highlights+'<section class="summary-card"><h2>Verifier score vs cost per task</h2>'+paretoPlot(stats)+'</section><section class="summary-card"><h2>Model leaderboard</h2><div class="table-scroll"><table class="leaderboard-table"><thead><tr><th>#</th>'+sortHead("model","Model")+sortHead("score","Score")+sortHead("pass","Pass")+sortHead("time","Time / task")+sortHead("cost","Cost / task")+sortHead("calls","Calls")+'</tr></thead><tbody>'+leaderboard+'</tbody></table></div></section><section class="summary-card"><h2>Production task comparison</h2><div class="task-grid">'+taskCards+'</div></section></div>';
}
function summaryOverview(models){
  const stats=modelStats(models),qualified=stats.filter(stat=>stat.pass===1),priced=stats.filter(stat=>Number.isFinite(stat.cost));
  const fastest=[...qualified].sort((a,b)=>a.time-b.time)[0];
  const cheapest=[...qualified].filter(stat=>Number.isFinite(stat.cost)).sort((a,b)=>a.cost-b.cost)[0];
  const best=stats[0];
  const callout=(label,stat,value)=>'<div class="winner"><span>'+label+'</span><b>'+esc(shortModel(stat?.model??"—"))+'</b><small>'+value+'</small></div>';
  return '<div class="big green">MODEL MATRIX</div><div class="label">Prime Verifiers '+esc(D.verifier_version)+' only</div>'+callout("highest score",best,best?best.score.toFixed(3):"—")+callout("fastest passing",fastest,fastest?ms(fastest.time):"—")+callout("cheapest passing",cheapest,cheapest?usd(cheapest.cost):"—")+'<div class="label">Coverage</div><div class="metric">models <b>'+stats.length+'</b></div><div class="metric">rollouts <b>'+D.rollouts.length+'</b></div><div class="metric">strict passes <b>'+D.rollouts.filter(row=>row.strict_pass).length+'/'+D.rollouts.length+'</b></div><div class="metric">priced models <b>'+priced.length+'/'+stats.length+'</b></div><div class="sub summary-note">Models are rows, so new candidates add vertically without clipping. Missing cost stays unavailable instead of using an unreviewed estimate.</div>';
}
function render(){
  document.querySelector(".layout").classList.toggle("summary-mode",viewMode==="summary");
  document.querySelector("#count").textContent=D.rollouts.length;
  const models=[...new Set(D.rollouts.map(r=>r.model))];
  document.querySelector("#list").innerHTML='<button class="summary-button '+(viewMode==="summary"?"on":"")+'" id="view-summary">View summary <span>→</span></button>'+models.map((model,modelIndex)=>{const rows=D.rollouts.filter(r=>r.model===model);return '<details class="model-group" '+(modelIndex<3?"open":"")+'><summary class="model-group-title">'+esc(model.replace("claude-",""))+'<span>'+rows.filter(row=>row.strict_pass).length+'/'+rows.length+' pass</span></summary>'+rows.map((r,i)=>'<button class="rollout '+(viewMode==="trace"&&r.id===selected.id?"on":"")+'" data-id="'+esc(r.id)+'"><div class="rowtop"><span>Task '+(i+1)+'</span><b class="reward '+(r.strict_pass?"green":"red")+'">'+r.partial_credit.toFixed(2)+'</b></div><div class="prompt">'+esc(r.prompt)+'</div></button>').join("")+'</details>'}).join("");
  if(viewMode==="summary"){
    document.querySelector("#center-title").textContent="Summary";
    document.querySelector("#history").innerHTML=summaryView(models);
    document.querySelector("#reward").className="reward green";
    document.querySelector("#reward").textContent=D.rollouts.length+" rollouts";
    document.querySelector("#overview").innerHTML="";
  }else{
  document.querySelector("#center-title").textContent="Conversation history";
  const taskSummary='<section class="task-summary"><div class="task-summary-title">Task summary</div><ul>'+selected.task_summary.map(item=>'<li>'+esc(item)+'</li>').join("")+'</ul></section>';
  const conversation=selected.trace.map(m=>'<details class="message"><summary><span class="role '+esc(m.role)+'">'+esc(m.role)+'</span><span class="preview">'+esc(preview(m))+'</span></summary><div class="message-body">'+blocks(m)+'</div></details>').join("");
  const verifier='<section class="verifier-card"><div class="verifier-title">Verifier result</div><div class="verifier-result '+(selected.strict_pass?"green":"red")+'">'+(selected.strict_pass?"PASS":"FAIL")+'</div><div class="verifier-row"><span>Production target</span><span>'+esc(selected.expected_tool_path.join(" → "))+'</span></div><div class="verifier-row"><span>Observed</span><span>'+esc(selected.tool_path.join(" → ")||"none")+'</span></div><div class="verifier-row"><span>Grading method</span><span>'+esc(selected.grading_method)+'</span></div><div class="verifier-row"><span>Terminal behavior</span><span>'+esc(selected.terminal_reason)+'</span></div></section>';
  document.querySelector("#history").innerHTML=taskSummary+conversation+verifier;
  document.querySelector("#reward").className="reward "+(selected.strict_pass?"green":"red");
  document.querySelector("#reward").textContent=selected.partial_credit.toFixed(3);
  document.querySelector("#overview").innerHTML='<div class="big '+(selected.strict_pass?"green":"red")+'">'+(selected.strict_pass?"PASS":"FAIL")+'</div><div class="label">Prime metrics</div><div class="metric">reward <b>'+selected.reward.toFixed(3)+'</b></div><div class="metric">partial_credit <b>'+selected.partial_credit.toFixed(3)+'</b></div><div class="metric">cost_per_task <b title="'+esc(selected.cost_note)+'">'+usd(selected.cost_usd)+'</b></div><div class="metric">model calls <b>'+selected.turns+'</b></div><div class="metric">latency <b>'+ms(selected.latency_ms)+'</b></div><div class="metric">tokens <b>'+tok(selected.tokens)+'</b></div><div class="label">Native run</div><div class="metric">model <b>'+esc(selected.model)+'</b></div><div class="metric">verifiers <b>'+esc(selected.verifier_version)+'</b></div><div class="metric">harness <b>'+esc(selected.harness)+'</b></div><div class="metric">task <b>'+esc(selected.task_id.slice(-8))+'</b></div><div class="metric">run <b>'+esc(selected.run_id.slice(0,8))+'</b></div><div class="label">Tool path</div><div class="path">'+esc(selected.tool_path.join(" → ")||"none")+'</div>'+selected.misses.map(x=>'<div class="failure">'+esc(x)+'</div>').join("");
  }
  document.querySelector("#view-summary").addEventListener("click",()=>{viewMode="summary";render()});
  document.querySelectorAll(".sort-button").forEach(button=>button.addEventListener("click",()=>{
    const key=button.dataset.sort;
    const defaultDirection=["score","pass"].includes(key)?"desc":"asc";
    leaderSort=leaderSort.key===key?{key,dir:leaderSort.dir==="asc"?"desc":"asc"}:{key,dir:defaultDirection};
    render();
  }));
  document.querySelectorAll(".model-toggle").forEach(button=>button.addEventListener("click",()=>{expandedModel=expandedModel===button.dataset.model?null:button.dataset.model;render()}));
  document.querySelectorAll(".rollout").forEach(button=>button.addEventListener("click",()=>{selected=D.rollouts.find(r=>r.id===button.dataset.id);viewMode="trace";render()}));
}
render();
</script></body></html>`;
const output = `${benchmark}/viewer/index.html`;
mkdirSync(`${benchmark}/viewer`, { recursive: true, mode: 0o700 });
writeFileSync(output, html, { mode: 0o600 });
chmodSync(output, 0o600);
process.stdout.write(`${JSON.stringify({ output, rollouts: rollouts.length })}\n`);
