import type { Assertion, ToolCall } from "../../automationbench-offline.js";

export type Meeting = {
  attendee: string;
  slot: string;
  durationMin: number;
  status?: "scheduled" | "cancelled";
};

export type Conversation = {
  id: string;
  summary: string;
  events: { type: string; note: string }[];
};

export type Draft = {
  to: string;
  subject: string;
  body: string;
  status: "draft";
};

export type AgentState = {
  status: string;
  note: string;
};

export type Summary = {
  status: string;
  summary: string;
};

export type RecordItem = {
  id: string;
  label: string;
  value: string;
};

export type MeetingState = {
  conversations: Record<string, Conversation>;
  meetings: Record<string, Meeting>;
  drafts: Record<string, Draft>;
  agentState: Record<string, AgentState>;
  summaries: Record<string, Summary>;
  records: Record<string, RecordItem>;
  sequence: number;
};

export type CaseDraft = {
  taskId: string;
  prompt: string;
  initialState: MeetingState;
  assertions: Assertion[];
  allowedWrites: string[];
  oracle: ToolCall[];
};

export type Family = {
  slug: string;
  band: "single-write" | "discovery" | "conditional" | "multi-write" | "no-op-guard" | "long-chain";
  label: string;
  instances: number;
  build: (instance: number) => CaseDraft;
};

const attendees = [
  ["alex.rivera@example.test", "2031-02-03 09:00 UTC", 25, "planning"],
  ["briar.chen@example.test", "2031-03-14 10:30 UTC", 40, "handoff"],
  ["casey.morgan@example.test", "2031-04-25 11:15 UTC", 20, "review"],
  ["devon.patel@example.test", "2031-05-06 13:45 UTC", 50, "launch"],
  ["emery.kim@example.test", "2031-06-17 14:00 UTC", 30, "design"],
  ["finley.ross@example.test", "2031-07-08 16:30 UTC", 45, "retrospective"],
  ["gray.novak@example.test", "2031-08-19 08:15 UTC", 35, "capacity"],
  ["harper.owens@example.test", "2031-09-10 12:00 UTC", 55, "roadmap"],
  ["indigo.li@example.test", "2031-10-21 15:45 UTC", 15, "feedback"],
  ["jordan.singh@example.test", "2031-11-12 09:30 UTC", 60, "architecture"],
  ["kai.brooks@example.test", "2031-12-03 17:00 UTC", 30, "enablement"],
  ["logan.ellis@example.test", "2032-01-24 10:00 UTC", 45, "planning"],
] as const;

const fallbackSlots = [
  "2031-02-03 10:00 UTC", "2031-03-14 11:30 UTC", "2031-04-25 12:15 UTC",
  "2031-05-06 15:00 UTC", "2031-06-17 15:00 UTC", "2031-07-08 17:30 UTC",
  "2031-08-19 09:15 UTC", "2031-09-10 13:00 UTC", "2031-10-21 16:45 UTC",
  "2031-11-12 10:30 UTC", "2031-12-03 18:00 UTC", "2032-01-24 11:00 UTC",
] as const;

const baseState = (conversation: Conversation, extras: Partial<MeetingState> = {}): MeetingState => ({
  conversations: { [conversation.id]: conversation },
  meetings: {},
  drafts: {},
  agentState: {},
  summaries: {},
  records: {
    rec_guard: { id: "rec_guard", label: "Protected reference", value: "leave unchanged" },
  },
  sequence: 0,
  ...extras,
});

const call = (method: string, url: string, body?: Record<string, unknown>): ToolCall => ({
  name: "api_fetch",
  arguments: body ? { method, url, body } : { method, url },
});

const conversation = (id: string, note: string): Conversation => ({
  id,
  summary: "Inbound calendar event",
  events: [{ type: "calendar-event", note }],
});

const targetMeeting = (instance: number) => {
  const [attendee, slot, durationMin, topic] = attendees[instance];
  return { attendee, slot, durationMin, topic };
};

const meetingFor = (instance: number, status: "scheduled" | "cancelled" = "scheduled"): Meeting => {
  const target = targetMeeting(instance);
  return { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin, status };
};

const singleSchedule: Family = {
  slug: "meeting-single-schedule",
  band: "single-write",
  label: "read the event and schedule exactly the requested meeting",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_schedule_${instance + 1}`;
    return {
      taskId: `meeting-single-schedule-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id} and schedule the requested ${target.topic} meeting. Preserve every existing calendar entry.`,
      initialState: baseState(conversation(id, `Schedule ${target.attendee} at ${target.slot} for ${target.durationMin} minutes about ${target.topic}.`), {
        meetings: { [`meeting_decoy_${instance + 1}`]: { attendee: "decoy@example.test", slot: "2031-01-01 08:00 UTC", durationMin: 15, status: "scheduled" } },
      }),
      assertions: [{ kind: "exists", collection: "meetings", match: { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin, status: "scheduled" } }],
      allowedWrites: ["meetings"],
      oracle: [call("GET", `/conversations/${id}`), call("POST", "/meetings", { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin })],
    };
  },
};

const attendeeDiscovery: Family = {
  slug: "meeting-attendee-discovery",
  band: "discovery",
  label: "resolve the exact attendee among near-match contacts",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_discovery_${instance + 1}`;
    const near = target.attendee.replace("@", "+near@");
    return {
      taskId: `meeting-attendee-discovery-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Inspect ${id} and the attendee directory. Resolve the exact requested attendee, not the near-match address, then schedule the meeting.`,
      initialState: baseState(conversation(id, `The requester is ${target.attendee}; a near-match address is ${near}. Schedule at ${target.slot} for ${target.durationMin} minutes.`), {
        records: {
          rec_guard: { id: "rec_guard", label: "Protected reference", value: "leave unchanged" },
          [`contact_${instance + 1}`]: { id: `contact_${instance + 1}`, label: target.attendee, value: "requested attendee" },
          [`contact_near_${instance + 1}`]: { id: `contact_near_${instance + 1}`, label: near, value: "near match" },
        },
      }),
      assertions: [{ kind: "exists", collection: "meetings", match: { ...meetingFor(instance) } }],
      allowedWrites: ["meetings"],
      oracle: [call("GET", `/conversations/${id}`), call("GET", "/records"), call("POST", "/meetings", { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin })],
    };
  },
};

const slotConflict: Family = {
  slug: "meeting-slot-conflict",
  band: "conditional",
  label: "choose the event's stated fallback when the requested slot conflicts",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const fallback = fallbackSlots[instance];
    const id = `conv_conflict_${instance + 1}`;
    return {
      taskId: `meeting-slot-conflict-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id}. The preferred slot may be occupied; use the fallback slot stated in the event when needed, and do not alter the existing meeting.`,
      initialState: baseState(conversation(id, `Schedule ${target.attendee} for ${target.durationMin} minutes. Preferred slot ${target.slot}; if occupied, use fallback ${fallback}.`), {
        meetings: {
          [`meeting_conflict_${instance + 1}`]: { attendee: "other@example.test", slot: target.slot, durationMin: 30, status: "scheduled" },
        },
      }),
      assertions: [{ kind: "exists", collection: "meetings", match: { attendee: target.attendee, slot: fallback, durationMin: target.durationMin, status: "scheduled" } }],
      allowedWrites: ["meetings"],
      oracle: [call("GET", `/conversations/${id}`), call("GET", "/meetings"), call("POST", "/meetings", { attendee: target.attendee, slot: fallback, durationMin: target.durationMin })],
    };
  },
};

const reschedule: Family = {
  slug: "meeting-reschedule",
  band: "multi-write",
  label: "move an existing meeting and persist the change record",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_reschedule_${instance + 1}`;
    const meetingId = `meeting_move_${instance + 1}`;
    const newSlot = fallbackSlots[instance];
    return {
      taskId: `meeting-reschedule-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id}, move ${meetingId} to ${newSlot}, and record the change as rescheduled with summary ${meetingId} moved to ${newSlot}. Do not touch unrelated calendar entries.`,
      initialState: baseState(conversation(id, `Move ${meetingId} for ${target.attendee} from ${target.slot} to ${newSlot}; record the change as rescheduled.`), {
        meetings: {
          [meetingId]: { ...meetingFor(instance) },
          [`meeting_other_${instance + 1}`]: { attendee: "other@example.test", slot: "2031-01-01 08:00 UTC", durationMin: 15, status: "scheduled" },
        },
      }),
      assertions: [
        { kind: "equals", path: `meetings.${meetingId}.slot`, equals: newSlot },
        { kind: "exists", collection: "summaries", match: { status: "rescheduled", summary: `${meetingId} moved to ${newSlot}` } },
      ],
      allowedWrites: [`meetings.${meetingId}`, "summaries"],
      oracle: [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("PATCH", `/meetings/${meetingId}`, { slot: newSlot }),
        call("POST", "/summaries", { status: "rescheduled", summary: `${meetingId} moved to ${newSlot}` }),
      ],
    };
  },
};

const cancelNotify: Family = {
  slug: "meeting-cancel-and-notify",
  band: "multi-write",
  label: "cancel the identified meeting and create one notification draft",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_cancel_${instance + 1}`;
    const meetingId = `meeting_cancel_${instance + 1}`;
    const to = target.attendee;
    return {
      taskId: `meeting-cancel-and-notify-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id}, cancel the identified meeting, and create exactly one notification draft for the attendee. Preserve unrelated meetings and drafts.`,
      initialState: baseState(conversation(id, `Cancel ${meetingId} for ${to} at ${target.slot}; notify the attendee with subject Cancelled ${target.topic} and body The meeting was cancelled.`), {
        meetings: {
          [meetingId]: { ...meetingFor(instance) },
          [`meeting_other_${instance + 1}`]: { attendee: "other@example.test", slot: "2031-01-01 08:00 UTC", durationMin: 15, status: "scheduled" },
        },
      }),
      assertions: [
        { kind: "equals", path: `meetings.${meetingId}.status`, equals: "cancelled" },
        { kind: "exists", collection: "drafts", match: { to, subject: `Cancelled ${target.topic}`, body: "The meeting was cancelled.", status: "draft" } },
      ],
      allowedWrites: [`meetings.${meetingId}`, "drafts"],
      oracle: [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("PATCH", `/meetings/${meetingId}`, { status: "cancelled" }),
        call("POST", "/drafts", { to, subject: `Cancelled ${target.topic}`, body: "The meeting was cancelled." }),
      ],
    };
  },
};

const noOpGuard: Family = {
  slug: "meeting-no-op-guard",
  band: "no-op-guard",
  label: "read a non-meeting event and record the no-meeting outcome",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_noop_${instance + 1}`;
    return {
      taskId: `meeting-no-op-guard-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id}. This event is informational only and does not request a meeting. Record status no-meeting-requested with note ${target.topic}-no-meeting, and do not change the calendar.`,
      initialState: baseState(conversation(id, `Share an update about ${target.topic}; no meeting is requested.`)),
      assertions: [
        { kind: "absent", collection: "meetings", match: { attendee: target.attendee, slot: target.slot } },
        { kind: "equals", path: `agentState.${id}.status`, equals: "no-meeting-requested" },
        { kind: "equals", path: `agentState.${id}.note`, equals: `${target.topic}-no-meeting` },
      ],
      allowedWrites: [`agentState.${id}`],
      oracle: [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("PATCH", `/agent-state/${id}`, { status: "no-meeting-requested", note: `${target.topic}-no-meeting` }),
      ],
    };
  },
};

const summaryChain: Family = {
  slug: "meeting-summary-chain",
  band: "long-chain",
  label: "read the event, schedule the meeting, and persist one completion summary",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_summary_${instance + 1}`;
    return {
      taskId: `meeting-summary-chain-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id} and the current calendar, schedule the requested meeting, then persist one completion summary with status scheduled and summary ${target.topic} meeting scheduled.`,
      initialState: baseState(conversation(id, `Schedule ${target.attendee} at ${target.slot} for ${target.durationMin} minutes about ${target.topic}; completion status scheduled.`), {
        meetings: { [`meeting_decoy_${instance + 1}`]: { attendee: "other@example.test", slot: "2031-01-01 08:00 UTC", durationMin: 15, status: "scheduled" } },
      }),
      assertions: [
        { kind: "exists", collection: "meetings", match: { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin, status: "scheduled" } },
        { kind: "exists", collection: "summaries", match: { status: "scheduled", summary: `${target.topic} meeting scheduled` } },
      ],
      allowedWrites: ["meetings", "summaries"],
      oracle: [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("POST", "/meetings", { attendee: target.attendee, slot: target.slot, durationMin: target.durationMin }),
        call("POST", "/summaries", { status: "scheduled", summary: `${target.topic} meeting scheduled` }),
      ],
    };
  },
};

const duplicateSuppression: Family = {
  slug: "meeting-duplicate-suppression",
  band: "conditional",
  label: "avoid a duplicate and synchronize the orchestration state",
  instances: 12,
  build: (instance) => {
    const target = targetMeeting(instance);
    const id = `conv_duplicate_${instance + 1}`;
    const existingId = `meeting_existing_${instance + 1}`;
    return {
      taskId: `meeting-duplicate-suppression-${String(instance + 1).padStart(2, "0")}`,
      prompt: `Read ${id} and the calendar. The requested meeting already exists; do not create a duplicate. Synchronize the event state to duplicate-suppressed.`,
      initialState: baseState(conversation(id, `The requested ${target.attendee} meeting at ${target.slot} already exists as ${existingId}; mark the event duplicate-suppressed without creating another meeting.`), {
        meetings: { [existingId]: { ...meetingFor(instance) } },
      }),
      assertions: [
        { kind: "equals", path: `agentState.${id}.status`, equals: "duplicate-suppressed" },
        { kind: "equals", path: `agentState.${id}.note`, equals: existingId },
      ],
      allowedWrites: [`agentState.${id}`],
      oracle: [
        call("GET", `/conversations/${id}`),
        call("GET", "/meetings"),
        call("PATCH", `/agent-state/${id}`, { status: "duplicate-suppressed", note: existingId }),
      ],
    };
  },
};

export const FAMILIES: Family[] = [
  singleSchedule,
  attendeeDiscovery,
  slotConflict,
  reschedule,
  cancelNotify,
  noOpGuard,
  summaryChain,
  duplicateSuppression,
];
