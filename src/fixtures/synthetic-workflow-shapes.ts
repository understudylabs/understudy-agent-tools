import type { Assertion, ToolCall } from "../automationbench-offline.js";
import type {
  SyntheticCaseDraft,
  SyntheticFamily,
  WorkflowState,
} from "../synthetic-workflow-offline.js";

const call = (method: string, url: string, body?: Record<string, unknown>): ToolCall => ({
  name: "api_fetch",
  arguments: body === undefined ? { method, url } : { method, url, body },
});

const conversation = (
  id: string,
  summary: string,
  events: { type: string; note: string }[],
  configured = true,
) => ({ id, summary, events, agentStateConfigured: configured });

const guard = {
  rec_guard: {
    id: "rec_guard",
    name: "Guard account",
    stage: "open",
    observations: ["leave unchanged"],
  },
};

const baseState = (
  conversations: WorkflowState["conversations"],
  extras: Partial<WorkflowState> = {},
): WorkflowState => ({
  conversations,
  documents: {},
  records: guard,
  drafts: {},
  meetings: {},
  agentState: {},
  summaries: {},
  analysis: {},
  sequence: 0,
  ...extras,
});

const task = (
  taskId: string,
  prompt: string,
  initialState: WorkflowState,
  assertions: Assertion[],
  allowedWrites: string[],
  oracle: ToolCall[],
): SyntheticCaseDraft => ({
  taskId,
  prompt,
  initialState,
  assertions,
  allowedWrites,
  oracle,
});

const routeData = [
  ["billing", "queue-blue", "handler-invoice"],
  ["shipping", "queue-green", "handler-delivery"],
  ["returns", "queue-red", "handler-refund"],
  ["access", "queue-yellow", "handler-permission"],
  ["renewals", "queue-purple", "handler-contract"],
  ["onboarding", "queue-orange", "handler-welcome"],
] as const;

const eventRouting: SyntheticFamily = {
  slug: "event-routing",
  band: "discovery",
  label: "route inbound events to the indicated handler and queue",
  instances: 6,
  build: (instance) => {
    const [kind, queue, handler] = routeData[instance];
    const id = `conv_route_${instance + 1}`;
    const decoy = `conv_route_decoy_${instance + 1}`;
    const state = baseState({
      [id]: conversation(id, "inbound event", [
        { type: "inbound", note: `event ${kind}; route to ${handler} on ${queue}; persist status routed with operation route_event` },
      ]),
      [decoy]: conversation(decoy, "unrelated event", [
        { type: "inbound", note: "event archive; route to handler-archive on queue-archive" },
      ]),
    });
    return task(
      `workflow-route-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${id} and route the inbound event according to its payload. Do not route the unrelated event.`,
      state,
      [{ kind: "exists", collection: "summaries", match: { status: "routed", summary: `${handler} on ${queue}` } }],
      ["summaries"],
      [
        call("GET", `/conversations/${id}`),
        call("POST", "/summaries", { status: "routed", summary: `${handler} on ${queue}`, toolsCalled: ["route_event", handler, queue] }),
      ],
    );
  },
};

const meetingData = [
  ["person-a@example.com", "2031-02-03 09:00 UTC", 25],
  ["person-b@example.org", "2031-03-04 10:30 UTC", 40],
  ["person-c@example.com", "2031-04-05 11:15 UTC", 20],
  ["person-d@example.org", "2031-05-06 13:45 UTC", 50],
  ["person-e@example.com", "2031-06-07 14:00 UTC", 30],
  ["person-f@example.org", "2031-07-08 16:30 UTC", 45],
] as const;

const meetingEvent: SyntheticFamily = {
  slug: "meeting-event-orchestration",
  band: "discovery",
  label: "discover meeting event details and schedule the correct attendee",
  instances: 6,
  build: (instance) => {
    const [attendee, slot, durationMin] = meetingData[instance];
    const id = `conv_meeting_${instance + 1}`;
    const meetingId = `meeting_existing_${instance + 1}`;
    const state = baseState({
      [id]: conversation(id, "calendar event", [
        { type: "meeting-request", note: `schedule ${attendee} at ${slot} for ${durationMin} minutes` },
      ]),
    }, {
      meetings: {
        [meetingId]: { attendee: "decoy@example.com", slot: "2031-01-01 08:00 UTC", durationMin: 15 },
      },
    });
    return task(
      `workflow-meeting-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${id}, read the current meeting list, and schedule the requested meeting without changing the existing meeting.`,
      state,
      [{ kind: "exists", collection: "meetings", match: { attendee, slot, durationMin } }],
      ["meetings"],
      [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("POST", "/meetings", { attendee, slot, durationMin }),
      ],
    );
  },
};

const entityData = [
  ["Atlas account", "qualified", ["renewal", "priority"]],
  ["Beacon account", "review", ["usage", "follow-up"]],
  ["Cobalt account", "negotiation", ["scope", "timing"]],
  ["Delta account", "approved", ["security", "launch"]],
  ["Echo account", "paused", ["budget", "revisit"]],
  ["Fable account", "active", ["adoption", "growth"]],
] as const;

const entityIdentification: SyntheticFamily = {
  slug: "entity-identification",
  band: "discovery",
  label: "identify the correct entity among near matches before updating it",
  instances: 6,
  build: (instance) => {
    const [name, stage, observations] = entityData[instance];
    const target = `rec_entity_${instance + 1}`;
    const decoy = `rec_entity_decoy_${instance + 1}`;
    const conv = `conv_entity_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "identify the account", [
        { type: "entity-request", note: `target name ${name}; after inspection set stage ${stage} and observations ${observations.join(", ")}` },
      ]),
    }, {
      records: {
        ...guard,
        [target]: { id: target, name, stage: "open", observations: [] },
        [decoy]: { id: decoy, name: `${name} archive`, stage: "open", observations: ["do not touch"] },
      },
    });
    return task(
      `workflow-entity-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv} and the account list, identify the requested account, then update only that account.`,
      state,
      [
        { kind: "equals", path: `records.${target}.stage`, equals: stage },
        { kind: "equals", path: `records.${target}.observations`, equals: [...observations] },
        { kind: "equals", path: `records.${decoy}.stage`, equals: "open" },
      ],
      [`records.${target}`],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/records"),
        call("PATCH", `/records/${target}`, { stage, observations: [...observations] }),
      ],
    );
  },
};

const actionData = [
  ["approved", "action-alpha", "ready"],
  ["deferred", "action-beta", "pending"],
  ["escalated", "action-gamma", "review"],
  ["approved", "action-delta", "ready"],
  ["deferred", "action-epsilon", "pending"],
  ["escalated", "action-zeta", "review"],
] as const;

const actionSelection: SyntheticFamily = {
  slug: "action-option-selection",
  band: "single-write",
  label: "select one action option under ambiguity",
  instances: 6,
  build: (instance) => {
    const [decision, action, stage] = actionData[instance];
    const conv = `conv_action_${instance + 1}`;
    const target = `rec_action_${instance + 1}`;
    const decoy = `rec_action_decoy_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "choose the next action", [
        { type: "decision", note: `decision ${decision}; choose ${action}; apply stage ${stage}` },
      ]),
    }, {
      records: {
        ...guard,
        [target]: { id: target, name: "Target account", stage: "open", observations: [action] },
        [decoy]: { id: decoy, name: "Near match account", stage: "open", observations: ["other-action"] },
      },
    });
    return task(
      `workflow-action-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${conv}, resolve the action choice from its event, and apply that choice to the matching account only.`,
      state,
      [
        { kind: "equals", path: `records.${target}.stage`, equals: stage },
        { kind: "equals", path: `records.${decoy}.stage`, equals: "open" },
      ],
      [`records.${target}`],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/records"),
        call("PATCH", `/records/${target}`, { stage }),
      ],
    );
  },
};

const analysisData = [
  ["low", "capacity", "review complete"],
  ["medium", "quality", "follow-up needed"],
  ["high", "security", "escalation advised"],
  ["low", "adoption", "usage review complete"],
  ["medium", "timing", "schedule review"],
  ["high", "dependency", "dependency review complete"],
] as const;

const analysisPersist: SyntheticFamily = {
  slug: "analysis-then-persist",
  band: "discovery",
  label: "inspect multiple systems, then persist one analysis finding",
  instances: 6,
  build: (instance) => {
    const [priority, category, finding] = analysisData[instance];
    const conv = `conv_analysis_${instance + 1}`;
    const doc = `doc_analysis_${instance + 1}`;
    const record = `rec_analysis_${instance + 1}`;
    const decoy = `rec_analysis_decoy_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "produce an account analysis", [
        { type: "analysis-request", note: `inspect ${doc} and ${record}; category ${category}; priority ${priority}; finding ${finding}` },
      ]),
    }, {
      documents: {
        [doc]: { id: doc, path: `docs/context-${instance + 1}.md`, content: `Context note ${instance + 1}.` },
      },
      records: {
        ...guard,
        [record]: { id: record, name: "Analysis target", stage: "review", observations: ["observed"] },
        [decoy]: { id: decoy, name: "Analysis decoy", stage: "review", observations: ["leave unchanged"] },
      },
    });
    return task(
      `workflow-analysis-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv}, inspect its referenced document and account, then persist the resulting finding without modifying either source.`,
      state,
      [
        { kind: "exists", collection: "analysis", match: { recordRef: record, category, priority, finding } },
        { kind: "equals", path: `records.${decoy}.stage`, equals: "review" },
      ],
      ["analysis"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", `/documents/${doc}`),
        call("GET", `/records/${record}`),
        call("POST", "/analysis", { recordRef: record, category, priority, finding }),
      ],
    );
  },
};

const documentData = [
  ["archive/a.md", "Summary A", "Risks A", "Next A"],
  ["archive/b.md", "Summary B", "Risks B", "Next B"],
  ["archive/c.md", "Summary C", "Risks C", "Next C"],
  ["archive/d.md", "Summary D", "Risks D", "Next D"],
  ["archive/e.md", "Summary E", "Risks E", "Next E"],
  ["archive/f.md", "Summary F", "Risks F", "Next F"],
] as const;

const documentPreservation: SyntheticFamily = {
  slug: "document-preservation",
  band: "multi-write",
  label: "move and append to the referenced document while preserving content",
  instances: 6,
  build: (instance) => {
    const [path, section, risks, next] = documentData[instance];
    const conv = `conv_document_${instance + 1}`;
    const doc = `doc_preserve_${instance + 1}`;
    const decoy = `doc_preserve_decoy_${instance + 1}`;
    const original = `Original context ${instance + 1}.`;
    const content = `${original}\n${section}\n${risks}\n${next}`;
    const state = baseState({
      [conv]: conversation(conv, "organize the referenced document", [
        { type: "document-request", note: `update ${doc}; move to ${path}; preserve existing context; append ${section}, ${risks}, and ${next}; final content ${content}; finish with status complete, summary document organized, using operations move_document and write_document` },
      ]),
    }, {
      documents: {
        [doc]: { id: doc, path: `inbox/${instance + 1}.md`, content: original },
        [decoy]: { id: decoy, path: `inbox/decoy-${instance + 1}.md`, content: "Decoy context." },
      },
    });
    return task(
      `workflow-document-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${conv} and the document list, then move the referenced document to its archive path, preserve its context, append the requested sections, and save a completion summary.`,
      state,
      [
        { kind: "exists", collection: "documents", match: { path } },
        { kind: "equals", path: `documents.${doc}.content`, equals: content },
        { kind: "exists", collection: "summaries", match: { status: "complete", summary: "document organized" } },
        { kind: "equals", path: `documents.${decoy}.path`, equals: `inbox/decoy-${instance + 1}.md` },
      ],
      [`documents.${doc}`, "summaries"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/documents"),
        call("PATCH", `/documents/${doc}`, { path }),
        call("POST", `/documents/${doc}`, { content }),
        call("POST", "/summaries", { status: "complete", summary: "document organized", toolsCalled: ["move_document", "write_document"] }),
      ],
    );
  },
};

const agentSync: SyntheticFamily = {
  slug: "agent-state-synchronization",
  band: "single-write",
  label: "synchronize agent state after reading the conversation",
  instances: 6,
  build: (instance) => {
    const conv = `conv_agent_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "synchronize the agent", [
        { type: "state-request", note: `set awake true and reason sync-${instance + 1}` },
      ]),
    });
    return task(
      `workflow-agent-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv}, then synchronize that conversation's agent state with the requested values.`,
      state,
      [{ kind: "equals", path: `agentState.${conv}.reasoning`, equals: `sync-${instance + 1}` }],
      [`agentState.${conv}`],
      [
        call("GET", `/conversations/${conv}`),
        call("PATCH", `/agent-state/${conv}`, { awake: true, reasoning: `sync-${instance + 1}` }),
      ],
    );
  },
};

const partialAgent: SyntheticFamily = {
  slug: "agent-state-partial-failure",
  band: "multi-write",
  label: "complete an orchestration while tolerating unavailable agent state",
  instances: 6,
  build: (instance) => {
    const conv = `conv_partial_${instance + 1}`;
    const doc = `doc_partial_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "complete workflow with unavailable state", [
        { type: "workflow-request", note: `update ${doc}; move to archive/partial-${instance + 1}.md; agent state unavailable; attempt reasoning synchronized; save status partial using operations move_document and update_agent_state` },
      ], false),
    }, {
      documents: {
        [doc]: { id: doc, path: `inbox/partial-${instance + 1}.md`, content: `Partial source ${instance + 1}.` },
      },
    });
    return task(
      `workflow-partial-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv}, update its referenced document, attempt synchronization, tolerate the 409-style unavailable state response, and save a partial summary.`,
      state,
      [
        { kind: "equals", path: `documents.${doc}.path`, equals: `archive/partial-${instance + 1}.md` },
        { kind: "exists", collection: "summaries", match: { status: "partial", summary: "agent state unavailable" } },
      ],
      [`documents.${doc}`, "summaries"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", `/documents/${doc}`),
        call("PATCH", `/documents/${doc}`, { path: `archive/partial-${instance + 1}.md` }),
        call("PATCH", `/agent-state/${conv}`, { awake: true, reasoning: "synchronized" }),
        call("POST", "/summaries", { status: "partial", summary: "agent state unavailable", toolsCalled: ["move_document", "update_agent_state"] }),
      ],
    );
  },
};

const summaryOrchestration: SyntheticFamily = {
  slug: "summary-orchestration",
  band: "multi-write",
  label: "update an entity, inspect the result, and persist a summary",
  instances: 6,
  build: (instance) => {
    const conv = `conv_summary_${instance + 1}`;
    const record = `rec_summary_${instance + 1}`;
    const stage = ["closed", "approved", "active", "paused", "qualified", "renewed"][instance];
    const state = baseState({
      [conv]: conversation(conv, "complete the account workflow", [
        { type: "summary-request", note: `update ${record} to stage ${stage} with observation summary-${instance + 1} and summarize after reading; save status ok with summary updated ${record}, using operations update_record and read_record` },
      ]),
    }, {
      records: {
        ...guard,
        [record]: { id: record, name: `Summary target ${instance + 1}`, stage: "open", observations: [] },
        [`rec_summary_decoy_${instance + 1}`]: { id: `rec_summary_decoy_${instance + 1}`, name: "Summary decoy", stage: "open", observations: [] },
      },
    });
    return task(
      `workflow-summary-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${conv}, update only the referenced account, read its resulting state, and persist the requested summary.`,
      state,
      [
        { kind: "equals", path: `records.${record}.stage`, equals: stage },
        { kind: "exists", collection: "summaries", match: { status: "ok", summary: `updated ${record}` } },
      ],
      [`records.${record}`, "summaries"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/records"),
        call("PATCH", `/records/${record}`, { stage, observations: [`summary-${instance + 1}`] }),
        call("GET", `/records/${record}`),
        call("POST", "/summaries", { status: "ok", summary: `updated ${record}`, toolsCalled: ["update_record", "read_record"] }),
      ],
    );
  },
};

const mailData = [
  ["mail-a@example.com", "Follow-up A", "context-a"],
  ["mail-b@example.org", "Follow-up B", "context-b"],
  ["mail-c@example.com", "Follow-up C", "context-c"],
  ["mail-d@example.org", "Follow-up D", "context-d"],
  ["mail-e@example.com", "Follow-up E", "context-e"],
  ["mail-f@example.org", "Follow-up F", "context-f"],
] as const;

const mailFollowup: SyntheticFamily = {
  slug: "routed-mail-followup",
  band: "discovery",
  label: "discover the routed recipient and create only the requested follow-up",
  instances: 6,
  build: (instance) => {
    const [to, subject, body] = mailData[instance];
    const conv = `conv_mail_${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "prepare a routed follow-up", [
        { type: "mail-request", note: `recipient ${to}; subject ${subject}; body ${body}` },
      ]),
    }, {
      drafts: {
        [`draft_decoy_${instance + 1}`]: { to: "decoy@example.com", subject: "Unrelated", body: "leave", status: "draft" },
      },
    });
    return task(
      `workflow-mail-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv} and the draft list, then create the one follow-up requested by the event. Do not change the existing draft.`,
      state,
      [
        { kind: "exists", collection: "drafts", match: { to, subject, status: "draft" } },
        { kind: "exists", collection: "drafts", match: { to, subject, body } },
      ],
      ["drafts"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/drafts"),
        call("POST", "/drafts", { to, subject, body }),
      ],
    );
  },
};

const chainData = [
  ["closed", "archive/chain-a.md", "chain-a"],
  ["approved", "archive/chain-b.md", "chain-b"],
  ["active", "archive/chain-c.md", "chain-c"],
  ["paused", "archive/chain-d.md", "chain-d"],
  ["qualified", "archive/chain-e.md", "chain-e"],
  ["renewed", "archive/chain-f.md", "chain-f"],
] as const;

const multiStepChain: SyntheticFamily = {
  slug: "multi-step-orchestrator-chain",
  band: "multi-write",
  label: "chain conversation, entity, document, and summary operations",
  instances: 6,
  build: (instance) => {
    const [stage, path, marker] = chainData[instance];
    const conv = `conv_chain_${instance + 1}`;
    const record = `rec_chain_${instance + 1}`;
    const doc = `doc_chain_${instance + 1}`;
    const original = `Chain context ${instance + 1}.`;
    const state = baseState({
      [conv]: conversation(conv, "run the complete orchestrator chain", [
        { type: "chain-request", note: `entity ${record}; set stage ${stage}; document ${doc}; archive path ${path}; marker ${marker}; final content ${original}\n${marker}; save status complete with summary chain ${marker}, using operations update_record, archive_document, and write_document` },
      ]),
    }, {
      records: {
        ...guard,
        [record]: { id: record, name: "Chain target", stage: "open", observations: [] },
      },
      documents: {
        [doc]: { id: doc, path: `inbox/chain-${instance + 1}.md`, content: original },
      },
    });
    return task(
      `workflow-chain-${String(instance + 1).padStart(2, "0")}`,
      `Inspect ${conv}, follow its references, update the entity, preserve and archive the document, then persist the completion summary.`,
      state,
      [
        { kind: "equals", path: `records.${record}.stage`, equals: stage },
        { kind: "equals", path: `documents.${doc}.path`, equals: path },
        { kind: "equals", path: `documents.${doc}.content`, equals: `${original}\n${marker}` },
        { kind: "exists", collection: "summaries", match: { status: "complete", summary: `chain ${marker}` } },
      ],
      [`records.${record}`, `documents.${doc}`, "summaries"],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", `/records/${record}`),
        call("PATCH", `/records/${record}`, { stage, observations: [marker] }),
        call("GET", `/documents/${doc}`),
        call("PATCH", `/documents/${doc}`, { path }),
        call("POST", `/documents/${doc}`, { content: `${original}\n${marker}` }),
        call("POST", "/summaries", { status: "complete", summary: `chain ${marker}`, toolsCalled: ["update_record", "archive_document", "write_document"] }),
      ],
    );
  },
};

const recordObservation: SyntheticFamily = {
  slug: "record-observation",
  band: "single-write",
  label: "read an entity and append a routed observation",
  instances: 6,
  build: (instance) => {
    const conv = `conv_observation_${instance + 1}`;
    const record = `rec_observation_${instance + 1}`;
    const note = `note-${instance + 1}`;
    const state = baseState({
      [conv]: conversation(conv, "append one observation", [
        { type: "observation-request", note: `append ${note} to ${record}` },
      ]),
    }, {
      records: {
        ...guard,
        [record]: { id: record, name: "Observation target", stage: "open", observations: ["existing"] },
      },
    });
    return task(
      `workflow-observation-${String(instance + 1).padStart(2, "0")}`,
      `Read ${conv} and the account list, then append the requested observation to the referenced account only.`,
      state,
      [{ kind: "equals", path: `records.${record}.observations`, equals: ["existing", note] }],
      [`records.${record}`],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", "/records"),
        call("PATCH", `/records/${record}`, { observations: ["existing", note] }),
      ],
    );
  },
};

export const FAMILIES: SyntheticFamily[] = [
  eventRouting,
  meetingEvent,
  entityIdentification,
  actionSelection,
  analysisPersist,
  documentPreservation,
  agentSync,
  partialAgent,
  summaryOrchestration,
  mailFollowup,
  multiStepChain,
  recordObservation,
];
