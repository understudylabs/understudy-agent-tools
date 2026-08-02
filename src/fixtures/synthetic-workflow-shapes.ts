import type { Assertion, ToolCall } from "../automationbench-offline.js";
import type {
  SyntheticCaseDraft,
  SyntheticFamily,
  WorkflowState,
} from "../synthetic-workflow-offline.js";

const assertion = (
  value: Assertion,
): Assertion => value;

const call = (
  method: string,
  url: string,
  body?: Record<string, unknown>,
): ToolCall => ({
  name: "api_fetch",
  arguments: body === undefined ? { method, url } : { method, url, body },
});

const search = (query: string): ToolCall => ({
  name: "api_search",
  arguments: { query },
});

const conversation = (
  id: string,
  summary: string,
  configured = true,
): {
  id: string;
  summary: string;
  events: { type: string; note: string }[];
  agentStateConfigured: boolean;
} => ({
  id,
  summary,
  events: [{ type: "request", note: summary }],
  agentStateConfigured: configured,
});

const baseState = (): WorkflowState => ({
  conversations: {
    "conv_email_1": conversation("conv_email_1", "prepare a follow-up draft"),
  },
  documents: {},
  records: {
    rec_guard: {
      id: "rec_guard",
      name: "Guard account",
      stage: "open",
      observations: [],
    },
  },
  drafts: {},
  meetings: {},
  agentState: {},
  summaries: {},
  analysis: {},
  sequence: 0,
});

const emailState = (): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_email_1": conversation("conv_email_1", "prepare a follow-up draft"),
  },
});

const meetingState = (): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_meeting_1": conversation("conv_meeting_1", "schedule a planning meeting"),
  },
});

const recordState = (): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_record_1": conversation("conv_record_1", "update the target record"),
  },
  records: {
    ...baseState().records,
    "rec_save_1": {
      id: "rec_save_1",
      name: "Atlas account",
      stage: "open",
      observations: [],
    },
  },
});

const orchestrationState = (): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_orch_1": conversation("conv_orch_1", "complete the record workflow"),
  },
  records: {
    ...baseState().records,
    "rec_orch_1": {
      id: "rec_orch_1",
      name: "Beacon account",
      stage: "open",
      observations: [],
    },
  },
});

const documentState = (configured: boolean): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_doc_1": conversation(
      "conv_doc_1",
      "organize the account document",
      configured,
    ),
  },
  documents: {
    "doc_overview": {
      id: "doc_overview",
      path: "doc/inbox/overview.md",
      content: "Existing account context.",
    },
  },
});

const analysisState = (distractor: boolean): WorkflowState => ({
  ...baseState(),
  conversations: {
    "conv_analysis_1": conversation(
      "conv_analysis_1",
      "produce a read-only analysis",
    ),
  },
  records: {
    ...baseState().records,
    "rec_analysis_1": {
      id: "rec_analysis_1",
      name: "Cobalt account",
      stage: "review",
      observations: ["risk noted"],
    },
    ...(distractor
      ? {
          "rec_distractor_1": {
            id: "rec_distractor_1",
            name: "Distractor account",
            stage: "open",
            observations: ["tempting write target"],
          },
        }
      : {}),
  },
  documents: {
    "doc_analysis": {
      id: "doc_analysis",
      path: "doc/analysis/context.md",
      content: "Analysis context for the target account.",
    },
  },
});

const emailFamilies: SyntheticFamily = {
  slug: "email-drafts",
  band: "discovery",
  label: "create routed email drafts",
  instances: 2,
  build: (instance): SyntheticCaseDraft => {
    if (instance === 0) {
      return {
        taskId: "saw-email-001",
        prompt: "Read conv_email_1 and draft a Follow-up email to ops@northwind.invalid with body pricing-interest.",
        initialState: emailState(),
        assertions: [
          assertion({ kind: "exists", collection: "drafts", match: { to: "ops@northwind.invalid", subject: "Follow-up" } }),
          assertion({ kind: "exists", collection: "drafts", match: { to: "ops@northwind.invalid", subject: "Follow-up", status: "draft" } }),
        ],
        allowedWrites: ["drafts"],
        oracle: [
          search("conversations"),
          call("GET", "/conversations/conv_email_1"),
          call("POST", "/drafts", { to: "ops@northwind.invalid", subject: "Follow-up", body: "pricing-interest" }),
        ],
      };
    }
    return {
      taskId: "saw-email-002",
      prompt: "Read conv_email_1 and draft a Follow-up email to renewals@northwind.invalid; do not draft for csm@northwind.invalid.",
      initialState: emailState(),
      assertions: [
        assertion({ kind: "exists", collection: "drafts", match: { to: "renewals@northwind.invalid", subject: "Follow-up" } }),
        assertion({ kind: "exists", collection: "drafts", match: { to: "renewals@northwind.invalid", subject: "Follow-up", status: "draft" } }),
        assertion({ kind: "absent", collection: "drafts", match: { to: "csm@northwind.invalid" } }),
      ],
      allowedWrites: ["drafts"],
      oracle: [
        search("conversations"),
        call("GET", "/conversations/conv_email_1"),
        call("POST", "/drafts", { to: "renewals@northwind.invalid", subject: "Follow-up", body: "follow-up" }),
      ],
    };
  },
};

const meetingFamily: SyntheticFamily = {
  slug: "meeting-scheduling",
  band: "single-write",
  label: "schedule a meeting",
  instances: 1,
  build: (): SyntheticCaseDraft => ({
    taskId: "saw-meeting-001",
    prompt: "Read conv_meeting_1 and schedule a 30 minute meeting for ops@northwind.invalid at 2030-01-15 15:00 UTC.",
    initialState: meetingState(),
    assertions: [
      assertion({ kind: "exists", collection: "meetings", match: { attendee: "ops@northwind.invalid", slot: "2030-01-15 15:00 UTC", durationMin: 30 } }),
    ],
    allowedWrites: ["meetings"],
    oracle: [
      search("meetings"),
      call("GET", "/conversations/conv_meeting_1"),
      call("POST", "/meetings", { attendee: "ops@northwind.invalid", slot: "2030-01-15 15:00 UTC", durationMin: 30 }),
    ],
  }),
};

const recordFamily: SyntheticFamily = {
  slug: "record-update",
  band: "single-write",
  label: "update one record",
  instances: 1,
  build: (): SyntheticCaseDraft => ({
    taskId: "saw-record-001",
    prompt: "Read conv_record_1 and update rec_save_1 to stage qualified with observations renewal and positive.",
    initialState: recordState(),
    assertions: [
      assertion({ kind: "equals", path: "records.rec_save_1.stage", equals: "qualified" }),
      assertion({ kind: "equals", path: "records.rec_save_1.observations", equals: ["renewal", "positive"] }),
    ],
    allowedWrites: ["records.rec_save_1"],
    oracle: [
      call("GET", "/conversations/conv_record_1"),
      call("GET", "/records/rec_save_1"),
      call("PATCH", "/records/rec_save_1", { stage: "qualified", observations: ["renewal", "positive"] }),
    ],
  }),
};

const orchestrationFamily: SyntheticFamily = {
  slug: "record-summary",
  band: "multi-write",
  label: "update a record and persist a summary",
  instances: 1,
  build: (): SyntheticCaseDraft => ({
    taskId: "saw-orch-001",
    prompt: "Update rec_orch_1 to closed-won with observation pipeline, read its overview, and save an ok summary marked completed.",
    initialState: orchestrationState(),
    assertions: [
      assertion({ kind: "equals", path: "records.rec_orch_1.stage", equals: "closed-won" }),
      assertion({ kind: "equals", path: "records.rec_orch_1.observations", equals: ["pipeline"] }),
      assertion({ kind: "exists", collection: "summaries", match: { status: "ok", toolsCalled: ["update_record", "run_deal_overview"] } }),
    ],
    allowedWrites: ["records.rec_orch_1", "summaries"],
    oracle: [
      call("PATCH", "/records/rec_orch_1", { stage: "closed-won", observations: ["pipeline"] }),
      call("GET", "/records/rec_orch_1"),
      call("POST", "/summaries", { status: "ok", summary: "completed", toolsCalled: ["update_record", "run_deal_overview"] }),
    ],
  }),
};

const documentFamily: SyntheticFamily = {
  slug: "document-automation",
  band: "multi-write",
  label: "move, revise, and summarize a document workflow",
  instances: 2,
  build: (instance): SyntheticCaseDraft => {
    const configured = instance === 0;
    const taskId = configured ? "saw-doc-001" : "saw-doc-002";
    const status = configured ? "ok" : "partial";
    return {
      taskId,
      prompt: configured
        ? "Read conv_doc_1, move doc_overview to doc/archive/overview.md, preserve Existing account context., append BANT Scorecard, Key Risks, and Next Steps, synchronize agent state, and save an ok summary."
        : "Read conv_doc_1, move doc_overview to doc/archive/overview.md, preserve Existing account context., append BANT Scorecard, Key Risks, and Next Steps, tolerate the unavailable agent state, and save a partial summary.",
      initialState: documentState(configured),
      assertions: [
        assertion({ kind: "exists", collection: "documents", match: { path: "doc/archive/overview.md" } }),
        assertion({ kind: "absent", collection: "documents", match: { path: "doc/inbox/overview.md" } }),
        assertion({ kind: "equals", path: "documents.doc_overview.content", equals: "Existing account context.\nBANT Scorecard\nKey Risks\nNext Steps" }),
        assertion({ kind: "exists", collection: "summaries", match: { status, toolsCalled: ["move_document", "write_document", "update_agent_state"] } }),
      ],
      allowedWrites: configured
        ? ["documents.doc_overview", "agentState.conv_doc_1", "summaries"]
        : ["documents.doc_overview", "summaries"],
      oracle: [
        call("GET", "/conversations/conv_doc_1"),
        call("GET", "/documents"),
        call("PATCH", "/documents/doc_overview", { path: "doc/archive/overview.md" }),
        call("POST", "/documents/doc_overview", { content: "Existing account context.\nBANT Scorecard\nKey Risks\nNext Steps" }),
        call("PATCH", "/agent-state/conv_doc_1", { awake: true, reasoning: "synchronized" }),
        call("POST", "/summaries", { status, summary: configured ? "complete" : "state overview unavailable", toolsCalled: ["move_document", "write_document", "update_agent_state"] }),
      ],
    };
  },
};

const analysisFamily: SyntheticFamily = {
  slug: "read-only-analysis",
  band: "discovery",
  label: "read systems and persist one analysis finding",
  instances: 2,
  build: (instance): SyntheticCaseDraft => ({
    taskId: instance === 0 ? "saw-analysis-001" : "saw-analysis-002",
    prompt: "Read conv_analysis_1, inspect doc_analysis and rec_analysis_1, then save a low-priority analysis finding for rec_analysis_1; do not modify records.",
    initialState: analysisState(instance === 1),
    assertions: [
      assertion({ kind: "exists", collection: "analysis", match: { recordRef: "rec_analysis_1", category: "analysis", priority: "low" } }),
      ...(instance === 1
        ? [assertion({ kind: "absent", collection: "records", match: { id: "rec_distractor_1", stage: "changed" } })]
        : []),
    ],
    allowedWrites: ["analysis"],
    oracle: [
      call("GET", "/conversations/conv_analysis_1"),
      call("GET", "/documents/doc_analysis"),
      call("GET", "/records/rec_analysis_1"),
      call("POST", "/analysis", { recordRef: "rec_analysis_1", category: "analysis", priority: "low", finding: "Read-only review complete." }),
    ],
  }),
};

export const FAMILIES: SyntheticFamily[] = [
  emailFamilies,
  meetingFamily,
  recordFamily,
  orchestrationFamily,
  documentFamily,
  analysisFamily,
];
