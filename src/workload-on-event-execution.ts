/**
 * Deterministic synthetic fixture for event-triggered execution.
 *
 * Each task presents an event envelope plus a standing execution policy. The
 * policy must apply exactly the addressed writes and leave near-miss records
 * untouched. Tasks register with the shared offline environment so the v1
 * reward, leakage, and frozen-holdout gates remain unchanged.
 *
 * The authored mix is 60 bounded / 24 extended / 12 variable tasks (62.5% /
 * 25% / 12.5%), an approximate mirror of the aggregate traffic shape. The
 * variable tail is deliberately overweighted relative to traffic so it remains
 * measurable in a 96-task fixture.
 */

import {
  AUTOMATIONBENCH_SUBSET,
  GUARD_CONTACT,
  LIST_CONTACTS,
  LIST_DRAFTS,
  LIST_TICKETS,
  canonicalJson,
  createDraft,
  patchContact,
  patchDraft,
  patchTicket,
  registerTasks,
  sendDraft,
  sha256,
  supportWorld,
} from "./automationbench-offline.js";
import type { Assertion, ContactSeed, DraftSeed, Split, Task, TicketSeed, ToolCall } from "./automationbench-offline.js";

export const WORKLOAD_OEE = {
  fixture_id: "on-event-execution-offline-v1",
  benchmark_id: "on-event-execution-offline-v1",
  base_fixture_id: AUTOMATIONBENCH_SUBSET.fixture_id,
  split_seed: AUTOMATIONBENCH_SUBSET.split_seed,
} as const;

const SPLIT_BY_INSTANCE: Split[] = [
  "train",
  "train",
  "train",
  "train",
  "train",
  "train",
  "train",
  "dev",
  "dev",
  "holdout",
  "holdout",
  "holdout",
];

const FAMILY_SPECS = [
  { slug: "oee-bounded-ack", band: "bounded", count: 30, label: "single event acknowledgement with one or two direct writes" },
  { slug: "oee-bounded-route", band: "bounded", count: 30, label: "event routing through a ticket-requester contact join" },
  { slug: "oee-extended-chain", band: "extended", count: 24, label: "ticket resolution with create-then-act mail delivery" },
  { slug: "oee-variable-fanout", band: "variable", count: 12, label: "disambiguated fanout across CRM, mail, and support" },
] as const;

type OeeBand = (typeof FAMILY_SPECS)[number]["band"];
type CaseDraft = {
  prompt: string;
  state: ReturnType<typeof supportWorld>;
  assertions: Assertion[];
  allowedWrites: string[];
  oracle: ToolCall[];
  surface: "core" | "support";
};

const PERSONAS: ContactSeed[] = [
  { id: "c-01", name: "Ada Lovelace", email: "ada.lovelace@example.test", status: "open", owner: "u-1" },
  { id: "c-02", name: "Grace Hopper", email: "grace.hopper@example.test", status: "open", owner: "u-2" },
  { id: "c-03", name: "Alan Turing", email: "alan.turing@example.test", status: "open", owner: "u-3" },
  { id: "c-04", name: "Barbara Liskov", email: "barbara.liskov@example.test", status: "open", owner: "u-4" },
  { id: "c-05", name: "Edsger Dijkstra", email: "edsger.dijkstra@example.test", status: "open", owner: "u-5" },
  { id: "c-06", name: "Frances Allen", email: "frances.allen@example.test", status: "open", owner: "u-6" },
  { id: "c-07", name: "Donald Knuth", email: "donald.knuth@example.test", status: "open", owner: "u-7" },
  { id: "c-08", name: "Radia Perlman", email: "radia.perlman@example.test", status: "open", owner: "u-8" },
  { id: "c-09", name: "Katherine Johnson", email: "katherine.johnson@example.test", status: "open", owner: "u-1" },
  { id: "c-10", name: "Linus Torvalds", email: "linus.torvalds@example.test", status: "open", owner: "u-2" },
  { id: "c-11", name: "Maya Hamilton", email: "maya.hamilton@example.test", status: "open", owner: "u-3" },
  { id: "c-12", name: "Niklaus Wirth", email: "niklaus.wirth@example.test", status: "open", owner: "u-4" },
  { id: "c-13", name: "Mary Jackson", email: "mary.jackson@example.test", status: "open", owner: "u-5" },
  { id: "c-14", name: "Ken Thompson", email: "ken.thompson@example.test", status: "open", owner: "u-6" },
  { id: "c-15", name: "Joan Clarke", email: "joan.clarke@example.test", status: "open", owner: "u-7" },
  { id: "c-16", name: "Donald Michie", email: "donald.michie@example.test", status: "open", owner: "u-8" },
  { id: "c-17", name: "Anita Borg", email: "anita.borg@example.test", status: "open", owner: "u-1" },
  { id: "c-18", name: "Evelyn Boyd", email: "evelyn.boyd@example.test", status: "open", owner: "u-2" },
  { id: "c-19", name: "Claude Shannon", email: "claude.shannon@example.test", status: "open", owner: "u-3" },
  { id: "c-20", name: "Dorothy Vaughan", email: "dorothy.vaughan@example.test", status: "open", owner: "u-4" },
  { id: "c-21", name: "Jean Sammet", email: "jean.sammet@example.test", status: "open", owner: "u-5" },
  { id: "c-22", name: "John Backus", email: "john.backus@example.test", status: "open", owner: "u-6" },
  { id: "c-23", name: "Hedy Lamarr", email: "hedy.lamarr@example.test", status: "open", owner: "u-7" },
  { id: "c-24", name: "Grace Murray", email: "grace.murray@example.test", status: "open", owner: "u-8" },
  { id: "c-25", name: "Sophie Wilson", email: "sophie.wilson@example.test", status: "open", owner: "u-1" },
  { id: "c-26", name: "Tim Berners", email: "tim.berners@example.test", status: "open", owner: "u-2" },
  { id: "c-27", name: "Frances Spence", email: "frances.spence@example.test", status: "open", owner: "u-3" },
  { id: "c-28", name: "Mary Keller", email: "mary.keller@example.test", status: "open", owner: "u-4" },
  { id: "c-29", name: "Vint Cerf", email: "vint.cerf@example.test", status: "open", owner: "u-5" },
  { id: "c-30", name: "Radia Perlman", email: "radia.perlman.30@example.test", status: "open", owner: "u-6" },
  { id: "c-31", name: "Edsger Hoare", email: "edsger.hoare@example.test", status: "open", owner: "u-7" },
  { id: "c-32", name: "Barbara Lampson", email: "barbara.lampson@example.test", status: "open", owner: "u-8" },
];

const EVENT_TYPES = [
  "ticket.created",
  "contact.verified",
  "delivery.requested",
  "workflow.escalated",
  "ticket.reopened",
  "contact.updated",
  "delivery.delayed",
  "workflow.reviewed",
  "ticket.assigned",
  "contact.merged",
  "delivery.confirmed",
  "workflow.approved",
];
const ACK_SUBJECTS = [
  "billing-review-01",
  "access-check-02",
  "export-window-03",
  "renewal-note-04",
  "account-update-05",
  "shipment-alert-06",
  "invoice-copy-07",
  "profile-change-08",
  "usage-summary-09",
  "workspace-invite-10",
  "quota-review-11",
  "delivery-window-12",
  "security-note-13",
  "receipt-copy-14",
  "plan-change-15",
  "export-status-16",
  "billing-window-17",
  "access-reset-18",
  "renewal-check-19",
  "account-note-20",
  "shipment-review-21",
  "invoice-status-22",
  "profile-check-23",
  "usage-note-24",
  "workspace-review-25",
  "quota-note-26",
  "delivery-check-27",
  "security-review-28",
  "receipt-status-29",
  "plan-review-30",
];
const ROUTE_SUBJECTS = [
  "route-billing-01",
  "route-access-02",
  "route-export-03",
  "route-renewal-04",
  "route-account-05",
  "route-shipment-06",
  "route-invoice-07",
  "route-profile-08",
  "route-usage-09",
  "route-workspace-10",
  "route-quota-11",
  "route-delivery-12",
  "route-security-13",
  "route-receipt-14",
  "route-plan-15",
  "route-status-16",
  "route-window-17",
  "route-reset-18",
  "route-check-19",
  "route-note-20",
  "route-review-21",
  "route-copy-22",
  "route-change-23",
  "route-summary-24",
  "route-invite-25",
  "route-alert-26",
  "route-confirm-27",
  "route-update-28",
  "route-request-29",
  "route-approval-30",
];
const CHAIN_SUBJECTS = [
  "resolve-billing-01",
  "resolve-access-02",
  "resolve-export-03",
  "resolve-renewal-04",
  "resolve-account-05",
  "resolve-shipment-06",
  "resolve-invoice-07",
  "resolve-profile-08",
  "resolve-usage-09",
  "resolve-workspace-10",
  "resolve-quota-11",
  "resolve-delivery-12",
  "resolve-security-13",
  "resolve-receipt-14",
  "resolve-plan-15",
  "resolve-status-16",
  "resolve-window-17",
  "resolve-reset-18",
  "resolve-check-19",
  "resolve-note-20",
  "resolve-review-21",
  "resolve-copy-22",
  "resolve-change-23",
  "resolve-summary-24",
];
const FANOUT_SUBJECTS = [
  "fanout-billing-01",
  "fanout-access-02",
  "fanout-export-03",
  "fanout-renewal-04",
  "fanout-account-05",
  "fanout-shipment-06",
  "fanout-invoice-07",
  "fanout-profile-08",
  "fanout-usage-09",
  "fanout-workspace-10",
  "fanout-quota-11",
  "fanout-delivery-12",
];
const ACK_STATUSES = ["acknowledged", "confirmed", "queued", "reviewed", "accepted", "verified"];
const ROUTE_STATES = ["in_progress", "pending", "assigned", "escalated", "triaged"];
const CHAIN_STATUSES = ["in_progress", "pending", "open", "awaiting_reply"];
const CHAIN_PRIORITIES = ["normal", "high", "urgent"];
const FANOUT_CONTACT_STATUSES = ["escalated", "review", "attention"];
const FANOUT_TICKET_STATUSES = ["closed", "resolved", "complete"];

function persona(index: number): ContactSeed {
  return PERSONAS[index % PERSONAS.length];
}

function envelope(eventType: string, payload: Record<string, unknown>, effects: string): string {
  return [
    `EVENT ENVELOPE: type=${eventType}`,
    `payload=${canonicalJson(payload)}`,
    `standing execution policy: ${effects}`,
    "Execute only the addressed effects. Every other record is a near-miss and must remain unchanged.",
  ].join("\n");
}

function ticket(id: string, subject: string, requester: string, assignee = "unassigned", status = "open"): TicketSeed {
  return { id, subject, requester, status, assignee, priority: "normal" };
}

function contactsFor(target: ContactSeed, extras: ContactSeed[]): ContactSeed[] {
  return [target, ...extras].map((contact, index) => ({ ...contact, id: `c-${index + 1}` }));
}

function buildAck(instance: number): CaseDraft {
  const target = persona(instance);
  const decoy = persona(instance + 2);
  const status = ACK_STATUSES[instance % ACK_STATUSES.length];
  const subject = ACK_SUBJECTS[instance];
  const contacts = contactsFor(target, [{ ...decoy, status }, persona(instance + 4)]);
  return {
    prompt: envelope(
      EVENT_TYPES[instance % EVENT_TYPES.length],
      { event_id: `ack-${instance + 1}`, event_subject: subject, contact_email: target.email, requested_status: status },
      "find the contact matching contact_email and set only its status to requested_status",
    ),
    state: supportWorld(contacts, [{ to: decoy.email, subject: `near-miss-${subject}` }], [], []),
    assertions: [{ kind: "equals", path: "crm.contacts.c-1.status", equals: status }],
    allowedWrites: ["crm.contacts.c-1"],
    oracle: [LIST_CONTACTS, patchContact("c-1", { status })],
    surface: "core",
  };
}

function buildRoute(instance: number): CaseDraft {
  const target = persona(instance + 1);
  const decoy = persona(instance + 4);
  const contacts = contactsFor(target, [decoy, persona(instance + 5)]);
  const subject = ROUTE_SUBJECTS[instance % ROUTE_SUBJECTS.length];
  const requestedState = ROUTE_STATES[instance % ROUTE_STATES.length];
  const requestedPriority = instance % 3 === 0 ? "high" : instance % 3 === 1 ? "normal" : "urgent";
  const tickets = [
    { ...ticket("t-1", `${subject}-near-miss`, decoy.email, "u-8", requestedState), priority: requestedPriority },
    { ...ticket("t-2", subject, target.email), priority: requestedPriority === "normal" ? "high" : "normal" },
    { ...ticket("t-3", `${subject}-archived`, decoy.email, "u-7", "resolved"), priority: "normal" },
  ];
  return {
    prompt: envelope(
      EVENT_TYPES[(instance + 1) % EVENT_TYPES.length],
      { event_id: `route-${instance + 1}`, ticket_subject: subject, requested_state: requestedState, requested_priority: requestedPriority },
      "find the addressed ticket, join its requester email to the CRM contact, then set only that ticket's assignee to the contact owner and its status to requested_state",
    ),
    state: supportWorld(contacts, [], [], tickets),
    assertions: [
      { kind: "equals", path: "support.tickets.t-2.assignee", equals: target.owner },
      { kind: "equals", path: "support.tickets.t-2.status", equals: requestedState },
      { kind: "equals", path: "support.tickets.t-2.priority", equals: requestedPriority },
    ],
    allowedWrites: ["support.tickets.t-2"],
    oracle: [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-2", { assignee: target.owner, status: requestedState, priority: requestedPriority })],
    surface: "support",
  };
}

function buildChain(instance: number): CaseDraft {
  const target = persona(instance + 2);
  const decoy = persona(instance + 5);
  const contacts = contactsFor(target, [decoy, persona(instance + 6)]);
  const subject = CHAIN_SUBJECTS[instance % CHAIN_SUBJECTS.length];
  const reply = `event receipt: ${subject}`;
  const initialStatus = CHAIN_STATUSES[instance % CHAIN_STATUSES.length];
  const initialPriority = CHAIN_PRIORITIES[instance % CHAIN_PRIORITIES.length];
  const tickets = [
    { ...ticket("t-1", `${subject}-near-miss`, decoy.email, "u-4", "resolved"), priority: "normal" },
    { ...ticket("t-2", subject, target.email, "u-3", initialStatus), priority: initialPriority },
  ];
  const drafts: DraftSeed[] = [{ to: decoy.email, subject: "leave-this-draft-alone" }];
  const createdDraftId = "d-2";
  return {
    prompt: envelope(
      EVENT_TYPES[(instance + 2) % EVENT_TYPES.length],
      { event_id: `chain-${instance + 1}`, ticket_subject: subject, reply_subject: reply, target_status: "resolved" },
      "find the ticket with ticket_subject, mark it target_status, create one draft addressed to that ticket's requester with reply_subject, and send that new draft",
    ),
    state: supportWorld(contacts, drafts, [], tickets),
    assertions: [
      { kind: "equals", path: "support.tickets.t-2.status", equals: "resolved" },
      { kind: "exists", collection: "mail.messages", match: { to: target.email, subject: reply, sent: true } },
      { kind: "absent", collection: "mail.drafts", match: { subject: reply } },
    ],
    allowedWrites: ["support.tickets.t-2", "mail.drafts.d-2", "mail.messages", "mail.sequence"],
    oracle: [
      LIST_TICKETS,
      createDraft({ to: target.email, subject: reply }),
      sendDraft(createdDraftId),
      patchTicket("t-2", { status: "resolved" }),
    ],
    surface: "support",
  };
}

function buildFanout(instance: number): CaseDraft {
  const target = persona(instance + 3);
  const decoy = { ...target, id: "c-2", name: `${target.name} (near-miss)`, status: "open", owner: "u-8" };
  const subject = FANOUT_SUBJECTS[instance % FANOUT_SUBJECTS.length];
  const contactStatus = FANOUT_CONTACT_STATUSES[instance % FANOUT_CONTACT_STATUSES.length];
  const ticketStatus = FANOUT_TICKET_STATUSES[instance % FANOUT_TICKET_STATUSES.length];
  const contacts = [{ ...target, id: "c-1" }, decoy, { ...persona(instance + 6), status: contactStatus }].map((contact, index) => ({ ...contact, id: `c-${index + 1}` }));
  const primaryDraft = `${subject}-primary`;
  const followupDraft = `${subject}-followup`;
  const nearMissDraft = `${subject}-near-miss`;
  const primaryTicket = `${subject}-primary`;
  const followupTicket = `${subject}-followup`;
  const nearMissTicket = `${subject}-near-miss`;
  const drafts = [
    { to: target.email, subject: primaryDraft },
    { to: target.email, subject: followupDraft },
    { to: decoy.email, subject: nearMissDraft },
  ];
  const tickets = [
    ticket("t-1", primaryTicket, target.email, "u-2"),
    ticket("t-2", followupTicket, target.email, "u-3"),
    { ...ticket("t-3", nearMissTicket, decoy.email, "u-4", ticketStatus), priority: "normal" },
  ];
  return {
    prompt: envelope(
      EVENT_TYPES[(instance + 3) % EVENT_TYPES.length],
      {
        event_id: `fanout-${instance + 1}`,
        contact_name: target.name,
        contact_email: target.email,
        draft_subjects: [primaryDraft, followupDraft],
        ticket_subjects: [primaryTicket, followupTicket],
        target_contact_status: contactStatus,
        target_ticket_status: ticketStatus,
      },
      "find the contact matching both contact_name and contact_email, set its status to target_contact_status, discard only drafts whose subjects are in draft_subjects, and set only tickets whose subjects are in ticket_subjects to target_ticket_status",
    ),
    state: supportWorld(contacts, drafts, [], tickets),
    assertions: [
      { kind: "equals", path: "crm.contacts.c-1.status", equals: contactStatus },
      { kind: "equals", path: "mail.drafts.d-1.status", equals: "discarded" },
      { kind: "equals", path: "mail.drafts.d-2.status", equals: "discarded" },
      { kind: "equals", path: "support.tickets.t-1.status", equals: ticketStatus },
      { kind: "equals", path: "support.tickets.t-2.status", equals: ticketStatus },
    ],
    allowedWrites: ["crm.contacts.c-1", "mail.drafts.d-1", "mail.drafts.d-2", "support.tickets.t-1", "support.tickets.t-2"],
    oracle: [
      LIST_CONTACTS,
      LIST_DRAFTS,
      LIST_TICKETS,
      patchContact("c-1", { status: contactStatus }),
      patchDraft("d-1", { status: "discarded" }),
      patchDraft("d-2", { status: "discarded" }),
      patchTicket("t-1", { status: ticketStatus }),
      patchTicket("t-2", { status: ticketStatus }),
    ],
    surface: "support",
  };
}

function buildFamily(slug: string, instance: number): CaseDraft {
  if (slug === "oee-bounded-ack") return buildAck(instance);
  if (slug === "oee-bounded-route") return buildRoute(instance);
  if (slug === "oee-extended-chain") return buildChain(instance);
  return buildFanout(instance);
}

function buildTasks(): Task[] {
  const tasks: Task[] = [];
  for (const [familyIndex, family] of FAMILY_SPECS.entries()) {
    for (let instance = 0; instance < family.count; instance += 1) {
      const authored = buildFamily(family.slug, instance + familyIndex * 3);
      const split = SPLIT_BY_INSTANCE[tasks.length % SPLIT_BY_INSTANCE.length];
      tasks.push({
        taskId: `oee-${family.slug}-${String(instance + 1).padStart(2, "0")}`,
        split,
        prompt: authored.prompt,
        initialState: authored.state,
        assertions: authored.assertions,
        allowedWrites: authored.allowedWrites,
        oracle: authored.oracle,
        surface: authored.surface,
        maxSteps: 16,
      });
    }
  }
  return tasks;
}

export const OEE_TASKS = buildTasks();

registerTasks(OEE_TASKS);

export function oeeScenarioSha256(task: Task): string {
  const promptLines = task.prompt.split("\n");
  const payloadLine = promptLines.findIndex((line) => line.startsWith("payload="));
  if (payloadLine !== -1) {
    const payload = JSON.parse(promptLines[payloadLine].slice("payload=".length)) as Record<string, unknown>;
    delete payload.event_id;
    promptLines[payloadLine] = `payload=${canonicalJson(payload)}`;
  }
  return sha256({
    prompt: promptLines.join("\n"),
    initialState: task.initialState,
    assertions: task.assertions,
    allowedWrites: task.allowedWrites,
  });
}

export function oeeTaskBands(): Record<string, OeeBand> {
  return Object.fromEntries(FAMILY_SPECS.map((family) => [family.slug, family.band]));
}

export function oeeSplitCounts(): Record<Split, number> {
  return OEE_TASKS.reduce(
    (counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }),
    { train: 0, dev: 0, holdout: 0 } as Record<Split, number>,
  );
}

export function oeeFixtureSha256(): string {
  return sha256({ tasks: OEE_TASKS, pin: WORKLOAD_OEE, guard_contact: GUARD_CONTACT });
}

export function oeeSplitSha256(split: Split): string {
  return sha256(OEE_TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

export function oeeTaskPool(options: { split: Split; frozenHoldoutSha256?: string }): Task[] {
  if (options.split === "holdout") {
    const expected = oeeSplitSha256("holdout");
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the OEE holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: OEE holdout hash mismatch (expected ${expected})`);
  }
  return OEE_TASKS.filter((task) => task.split === options.split);
}

export function oeeSplitManifest(): Record<string, unknown> {
  const counts = oeeSplitCounts();
  return {
    fixture_id: WORKLOAD_OEE.fixture_id,
    seed: WORKLOAD_OEE.split_seed,
    counts,
    fixture_sha256: oeeFixtureSha256(),
    train_sha256: oeeSplitSha256("train"),
    dev_sha256: oeeSplitSha256("dev"),
    holdout_sha256: oeeSplitSha256("holdout"),
    splits_sha256: sha256({ train: oeeSplitSha256("train"), dev: oeeSplitSha256("dev"), holdout: oeeSplitSha256("holdout") }),
    families: FAMILY_SPECS,
  };
}
