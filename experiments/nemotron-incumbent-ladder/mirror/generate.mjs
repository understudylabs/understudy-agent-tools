#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const outputArg = process.argv.find((value) => value.startsWith("--out="));
const ROOT = outputArg ? outputArg.slice("--out=".length) : "./mirror-output";
mkdirSync(ROOT, { recursive: true });
const N = 480;
const seed = 178561;
let state = seed;
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0x100000000;
};
const pick = (values) => values[Math.floor(rand() * values.length)];
const repeat = (value, count) => Array.from({ length: count }, () => value).join(" ");

const tools = [
  ["run-subagent", { subagentPath: { type: ["string", "null"] }, documentId: { type: ["string", "null"] }, reasoning: { type: "string" }, additionalContext: { type: ["string", "null"] } }],
  ["run-post-event-executor", { instructions: { type: "string" }, reasoning: { type: "string" } }],
  ["get-conversation", { conversationId: { type: "string" } }],
  ["save-execution-summary", { summary: { type: "string" }, reasoning: { type: "string" } }],
  ["mark-execution-as-failed", { errorMessage: { type: "string" } }],
  ["assign-ai-inbox", { inboxId: { type: "string" } }],
  ["update-conversation-fields", { fields: { type: "object" }, propose: { type: "boolean" }, targetDealId: { type: ["string", "null"] } }],
  ["update-next-steps-and-tasks", { triggerSource: { type: "string" } }],
];
const toolObject = (name, properties) => ({
  type: "function",
  function: {
    name,
    description: `Synthetic operation ${name}. Use only when the scenario requires it.`,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  },
});
const dominantSets = [
  ["run-subagent", "run-post-event-executor", "get-conversation", "save-execution-summary", "mark-execution-as-failed", "assign-ai-inbox"],
  ["run-subagent", "run-post-event-executor", "get-conversation", "update-conversation-fields", "save-execution-summary", "assign-ai-inbox"],
];
const stages = ["qualification", "renewal", "implementation", "security-review", "launch-planning", "account-review"];
const agents = ["@subagents/qualification-guide", "@subagents/renewal-planner", "@subagents/implementation-coordinator", "@subagents/security-reviewer", "@subagents/launch-planner", "@subagents/account-reviewer"];
const distractors = ["@subagents/archivist", "@subagents/meeting-notetaker", "@subagents/data-cleaner", "@subagents/duplicate-checker"];
const companies = ["Northstar Freight", "Juniper Ledger", "Blue Lantern", "Marble Kite", "Orchid Works", "Silver Meadow"];
const people = ["Avery Chen", "Morgan Ellis", "Riley Park", "Jordan Blake", "Taylor Quinn", "Casey Rowan"];
const eventTypes = ["inbound message", "outbound message", "calendar update", "billing notice", "meeting recap", "support escalation"];
const blocks = [
  "The customer asked for a clear next step and included a concrete deadline.",
  "A teammate summarized the prior exchange and requested careful routing.",
  "The latest note contains a plausible distraction that does not change ownership.",
  "Use the event details and the stage instructions; do not invent missing facts.",
  "The account context is fictional and exists only for this local benchmark.",
];

function scenario(index) {
  const r = index / N;
  if (r < 0.25) return "shortcut";
  if (r < 0.65) return "playbook";
  return "judgment";
}

function makeSpec(index) {
  const category = scenario(index);
  const stage = pick(stages);
  const agent = agents[stages.indexOf(stage)];
  const distractor = pick(distractors.filter((item) => item !== agent));
  const significant = category !== "shortcut" || rand() > 0.55;
  const existingDraft = category === "judgment" && rand() < 0.25;
  const missingContext = category === "judgment" && rand() < 0.25;
  const rule = category === "shortcut" ? "routine-event" : pick(["marketing-prohibition", "outbound-draft-rule", "draft-exists", "missing-context", "explicit-stage"]);
  const multiCall = index % 5 === 0;
  const actions = category !== "shortcut" && multiCall ? 2 : 1;
  const calls = [];
  if (category === "shortcut" || rule === "marketing-prohibition" || (rule === "draft-exists" && existingDraft)) {
    calls.push({ tool: "save-execution-summary", arguments: {} });
  } else {
    if (missingContext && multiCall) calls.push({ tool: "get-conversation", arguments: {} });
    for (let action = 0; action < actions; action += 1) {
      calls.push({ tool: "run-subagent", arguments: { subagentPath: action === 0 ? agent : agents[(index + 1) % agents.length] } });
    }
  }
  return { category, stage, agent, distractor, significant, existingDraft, missingContext, rule, actions, multiCall, calls };
}

function render(spec, index, inputBand) {
  const company = companies[index % companies.length];
  const person = people[(index * 3) % people.length];
  const eventType = eventTypes[index % eventTypes.length];
  const targetTokens = inputBand === "small" ? 1200 : inputBand === "medium" ? 5200 : 10500;
  const base = `<role>
You are the workflow coordinator for ${company}. Follow the synthetic playbook exactly.
</role>
<what_you_receive>
You receive a fictional ${eventType}, account context, and the current stage.
</what_you_receive>
<cross_cutting_rules>
Routine events marked NOT SIGNIFICANT require save-execution-summary and no other action.
Never draft a response for automated notices or bulk messages.
Outbound messages do not receive an immediate draft unless the playbook explicitly says DRAFT NOW.
</cross_cutting_rules>
<always_loaded_context>
The contact is ${person}. This synthetic account uses invented records and no external systems.
</always_loaded_context>
<stage_instructions>
Current stage: ${spec.stage}.
If the event is significant and the stage requires specialist work, call ${spec.agent}.
Do not call distractors such as ${spec.distractor}; they are present to test resolution.
${spec.actions > 1 ? `After the first specialist, call ${agents[(index + 1) % agents.length]}.` : ""}
</stage_instructions>
<condition_evaluation_rules>
Existing draft: ${spec.existingDraft ? "yes" : "no"}.
Required context available: ${spec.missingContext ? "no; fetch the conversation first" : "yes"}.
Event significance: ${spec.significant ? "significant" : "NOT SIGNIFICANT"}.
</condition_evaluation_rules>
<output_policy>
This is a single-turn policy benchmark. Emit only the next outcome-bearing action
or actions required by the scenario. ABSOLUTELY DO NOT emit
save-execution-summary after an action in this response; terminal summaries occur
in the later tool-result turn. For significant events, save-execution-summary is
forbidden in this response.
For routine or suppressed events, save-execution-summary is the immediate action.
When two actions are explicitly named in <stage_instructions>, emit both in order.
Free-text arguments are not scored.
</output_policy>`;
  const event = `<task>
The ${eventType} for ${company} concerns ${person}. It says: ${pick(blocks)}
Scenario marker: ${spec.rule}. Resolve the instructions above rather than guessing.
</task>`;
  const filler = repeat(`${pick(blocks)} Synthetic context remains relevant only when it changes the routing decision.`, Math.max(0, Math.floor((targetTokens - base.length / 4 - event.length / 4) / 100)));
  return [
    { role: "system", content: `${base}\n${filler}` },
    { role: "user", content: `${event}\n<event_details>\n${filler.slice(0, Math.floor(filler.length / 2))}\n</event_details>` },
  ];
}

const rows = [];
for (let index = 0; index < N; index += 1) {
  const spec = makeSpec(index);
  const inputBand = index % 4 === 0 ? "small" : index % 4 === 1 ? "large" : "medium";
  const toolNames = dominantSets[index % 2];
  const toolMap = new Map(tools.map(([name, properties]) => [name, toolObject(name, properties)]));
  rows.push({
    task_id: `mirror-${String(index + 1).padStart(4, "0")}`,
    band: spec.category,
    fixture: "hardened-synthetic-mirror",
    split: "pending",
    input_band: inputBand,
    request: { messages: render(spec, index, inputBand), tools: toolNames.map((name) => toolMap.get(name)), tool_choice: "required", temperature: 0 },
    label: { calls: spec.calls, rationale: `By construction: ${spec.category}; rule=${spec.rule}; stage=${spec.stage}; significant=${spec.significant}; existingDraft=${spec.existingDraft}; missingContext=${spec.missingContext}.` },
    scenario_spec: spec,
    input_tokens_est: inputBand === "small" ? 1200 : inputBand === "medium" ? 5200 : 10500,
  });
}

for (const category of ["shortcut", "playbook", "judgment"]) {
  const categoryRows = rows.filter((row) => row.band === category);
  categoryRows.forEach((row, index) => {
    row.split = index < categoryRows.length / 2 ? "train" : index < categoryRows.length * 3 / 4 ? "dev" : "holdout";
  });
}
const all = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
writeFileSync(join(ROOT, "tasks.jsonl"), all);
for (const split of ["train", "dev", "holdout"]) {
  writeFileSync(join(ROOT, `${split}.jsonl`), rows.filter((row) => row.split === split).map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const digest = (file) => createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex");
writeFileSync(join(ROOT, "FREEZE.md"), `# Hardened synthetic mirror freeze\n\n- Total tasks: ${rows.length}\n- Split sizes: train 240, dev 120, holdout 120\n- Category mix: shortcut 120, playbook 192, judgment 168\n- Multi-call labels: ${rows.filter((row) => row.label.calls.length > 1).length}\n- Estimated input-token mean: ${Math.round(rows.reduce((sum, row) => sum + row.input_tokens_est, 0) / rows.length)}\n\n| file | sha256 |\n|---|---|\n| tasks.jsonl | ${digest("tasks.jsonl")} |\n| train.jsonl | ${digest("train.jsonl")} |\n| dev.jsonl | ${digest("dev.jsonl")} |\n| holdout.jsonl | ${digest("holdout.jsonl")} |\n`);
