/**
 * automationbench-v2 — the HARD half of the offline AutomationBench fixture.
 *
 * Why this exists: the v1 fixture (12 families x 6 instances, `src/automationbench-offline.ts`)
 * saturates. A strong base model reaches 1.000 zero-shot on it, so it can no
 * longer rank models or show a training lift. v2 keeps every v1 task (ids,
 * assertions, and splits unchanged, so v1 receipts stay comparable) and adds
 * eight NEW families whose difficulty comes from structure rather than from
 * more instances of the same skill:
 *
 *   - cross-record dependency: the value to write lives on a DIFFERENT record
 *     than the one being written (ticket assignee := the requester's contact
 *     owner), so a policy must join two listings before its first write;
 *   - multi-hop discovery: the prompt names a ticket subject or a sent
 *     message, and the target contact is only reachable through
 *     ticket.requester / message.to -> contact.email -> contact id;
 *   - discovery + disambiguation + multi-write combined: duplicate contacts
 *     sharing one email, decoy tickets with near-identical subjects, and
 *     drafts that must be left alone next to drafts that must be sent;
 *   - long chains: up to seven writes across three collections in one episode,
 *     where a single missed write costs partial credit and a single write
 *     outside the allowed set zeroes the episode.
 *
 * The extended `support` tool surface (`/support/tickets`) is read-only
 * discoverable and writable only through the same one-call-per-step `api_fetch`
 * mutator, so nothing about the reward, the anti-free-credit rule, the
 * forbidden-effect rule, or the frozen-holdout refusal changes: this module
 * authors tasks and registers them with the v1 environment rather than forking
 * it. Same gates apply and are tested: oracle == 1.0, sentinel == 0.0, no label
 * leakage, reachability, determinism.
 *
 * Split policy for the new families: 12 instances each, positionally split
 * 6 train / 2 dev / 4 holdout, so v2 holdout is 44 tasks (12 v1 + 32 hard) and
 * is dominated by the hard bands.
 */

import {
  AUTOMATIONBENCH_SUBSET,
  GUARD_CONTACT,
  LIST_CONTACTS,
  LIST_DRAFTS,
  LIST_MESSAGES,
  LIST_TICKETS,
  PERSONAS,
  RESET_SEED,
  TASKS,
  canonicalJson,
  createDraft,
  patchContact,
  patchDraft,
  patchTicket,
  registerTasks,
  sendDraft,
  sha256,
  supportWorld,
  taskBands,
} from "./automationbench-offline.js";
import type { Assertion, ContactSeed, DraftSeed, MessageSeed, Split, Task, TicketSeed, ToolCall } from "./automationbench-offline.js";

export const AUTOMATIONBENCH_V2 = {
  fixture_id: "automationbench-simple-api-offline-hard-v2",
  benchmark_id: "automationbench-simple-api-offline-hard-v2",
  /** v2 keeps the v1 subset pin, seed, and verifiers pin; only the task pool grows. */
  base_fixture_id: AUTOMATIONBENCH_SUBSET.fixture_id,
  split_seed: AUTOMATIONBENCH_SUBSET.split_seed,
} as const;

/** Every hard task gets the same wider budget: enough for discovery plus a seven-write chain. */
const HARD_MAX_STEPS = 20;

const INSTANCES = 12;

/** 6 train / 2 dev / 4 holdout, positional like v1 so every family is in every split. */
const SPLIT_BY_INSTANCE: Split[] = ["train", "train", "train", "train", "train", "train", "dev", "dev", "holdout", "holdout", "holdout", "holdout"];

// ---------------------------------------------------------------------------
// Instance parameter tables (12 wide — no RNG, no wall clock)
// ---------------------------------------------------------------------------

const TICKET_SUBJECTS = [
  "SSO login loop",
  "Invoice PDF missing",
  "Webhook retries exhausted",
  "Export stuck at 90 percent",
  "API key rotation failed",
  "Seat count mismatch",
  "Timezone off by one hour",
  "Bulk import rejected",
  "Report totals disagree",
  "Sandbox data not resetting",
  "Notification digest empty",
  "Audit log gap",
];

const DECOY_TICKET_SUBJECTS = [
  "SSO login loop (duplicate)",
  "Invoice PDF missing on mobile",
  "Webhook retries exhausted last month",
  "Export stuck at 10 percent",
  "API key rotation scheduled",
  "Seat count mismatch (resolved earlier)",
  "Timezone off by one day",
  "Bulk import rejected in sandbox",
  "Report totals disagree in preview",
  "Sandbox data not loading",
  "Notification digest duplicated",
  "Audit log noise",
];

const CLOSE_CONTEXTS = [
  "signed the contract",
  "countersigned the order form",
  "cleared procurement review",
  "returned the signed quote",
  "approved the renewal terms",
  "committed after the security review",
  "signed the multi-year agreement",
  "accepted the pilot conversion",
  "confirmed the purchase order",
  "closed the expansion deal",
  "signed after the legal redlines",
  "approved the platform upgrade",
];

const LOST_CONTEXTS = [
  "chose a competitor",
  "ended the pilot without buying",
  "froze the budget for the year",
  "consolidated vendors after an acquisition",
  "cancelled the evaluation",
  "declined the renewal",
  "shut down the project",
  "lost the internal sponsor",
  "moved the spend to next year",
  "failed to clear procurement",
  "went with an in-house build",
  "paused all vendor onboarding",
];

const SUBJECTS = [
  "Welcome packet",
  "Onboarding plan",
  "Renewal options",
  "Pricing update",
  "Kickoff agenda",
  "Security review",
  "Migration timeline",
  "Support tiers",
  "Rollout checklist",
  "Training sessions",
  "Integration scope",
  "Success criteria",
];

const STALE_SUBJECTS = [
  "Old pricing sheet",
  "Superseded agenda",
  "Legacy renewal note",
  "Duplicate quote",
  "Outdated onboarding",
  "Archived kickoff",
  "Retired migration draft",
  "Previous support matrix",
  "Stale rollout memo",
  "Cancelled training invite",
  "Withdrawn scope note",
  "Obsolete criteria list",
];

const REPS = ["u-2", "u-4", "u-5", "u-6", "u-7", "u-8", "u-2", "u-4", "u-5", "u-6", "u-7", "u-8"];

function persona(offset: number, index: number): { name: string; email: string } {
  return PERSONAS[(offset + index) % PERSONAS.length];
}

/** Contacts with explicit owners; ids stay index-derived so worlds remain pure functions of their seeds. */
function contacts(offset: number, owners: string[], statuses?: string[]): ContactSeed[] {
  return owners.map((owner, index) => {
    const who = persona(offset, index);
    return { id: `c-${index + 1}`, name: who.name, email: who.email, status: statuses?.[index] ?? "open", owner };
  });
}

function ticket(id: string, subject: string, requester: string, assignee: string, status = "open", priority = "normal"): TicketSeed {
  return { id, subject, requester, status, assignee, priority };
}

/**
 * Distractor contacts appended AFTER the addressed records, so target ids stay
 * stable while the listing a policy must read through grows to a dozen rows.
 * Their owners are drawn from reps no family filters on.
 */
function padContacts(seeds: ContactSeed[], offset: number, extra: number): ContactSeed[] {
  const owners = ["u-6", "u-7", "u-8", "u-6", "u-7"];
  const padded = [...seeds];
  for (let index = 0; index < extra; index += 1) {
    const who = persona(offset + 11, seeds.length + index);
    padded.push({ id: `c-${padded.length + 1}`, name: who.name, email: who.email, status: index % 3 === 0 ? "won" : "open", owner: owners[index % owners.length] });
  }
  return padded;
}

/** Near-miss drafts appended after the addressed drafts: same shape, wrong record. */
function padDrafts(drafts: DraftSeed[], pool: ContactSeed[], instance: number, extra: number): DraftSeed[] {
  const padded = [...drafts];
  for (let index = 0; index < extra; index += 1) {
    const who = pool[(pool.length - 1 - index + pool.length) % pool.length];
    padded.push({ to: who.email, subject: STALE_SUBJECTS[(instance + index + 7) % INSTANCES] });
  }
  return padded;
}

/** Extra tickets appended after the addressed tickets, requested by padding contacts only. */
function padTickets(tickets: TicketSeed[], pool: ContactSeed[], instance: number, extra: number): TicketSeed[] {
  const padded = [...tickets];
  const statuses = ["open", "in_progress", "resolved"];
  for (let index = 0; index < extra; index += 1) {
    const who = pool[pool.length - 1 - (index % Math.max(pool.length, 1))];
    padded.push(ticket(`t-${padded.length + 1}`, DECOY_TICKET_SUBJECTS[(instance + index + 4) % INSTANCES], who.email, "u-7", statuses[index % statuses.length], index % 2 === 0 ? "normal" : "high"));
  }
  return padded;
}

// ---------------------------------------------------------------------------
// Hard families
// ---------------------------------------------------------------------------

type CaseDraft = { prompt: string; state: ReturnType<typeof supportWorld>; assertions: Assertion[]; allowedWrites: string[]; oracle: ToolCall[]; surface: "core" | "support" };

type HardFamily = {
  slug: string;
  /** Reporting-only difficulty band; scoring never reads it. */
  band: "cross-record" | "multi-hop" | "cascade" | "long-chain" | "conditional" | "aggregation";
  label: string;
  build: (instance: number, offset: number) => CaseDraft;
};

const HARD_FAMILIES: HardFamily[] = [
  {
    slug: "ticket-owner-route",
    band: "cross-record",
    label: "route a ticket to the rep who owns the requester's contact",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4", "u-5"]);
      const requester = seeds[instance % seeds.length];
      const other = seeds[(instance + 2) % seeds.length];
      const subject = TICKET_SUBJECTS[instance];
      const tickets = [
        ticket("t-1", DECOY_TICKET_SUBJECTS[instance], other.email, "u-1"),
        ticket("t-2", subject, requester.email, "unassigned"),
        ticket("t-3", DECOY_TICKET_SUBJECTS[(instance + 1) % INSTANCES], other.email, "u-2"),
      ];
      return {
        prompt: `The support ticket titled "${subject}" is unrouted. Assign it to the rep who owns the requester's CRM contact, and move that ticket to in_progress. Every other ticket stays exactly as it is.`,
        state: supportWorld(padContacts(seeds, offset, 5), [], [], padTickets(tickets, padContacts(seeds, offset, 5).slice(5), instance, 3)),
        assertions: [
          { kind: "equals", path: "support.tickets.t-2.assignee", equals: requester.owner },
          { kind: "equals", path: "support.tickets.t-2.status", equals: "in_progress" },
        ],
        allowedWrites: ["support.tickets.t-2"],
        oracle: [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-2", { assignee: requester.owner, status: "in_progress" })],
        surface: "support",
      };
    },
  },
  {
    slug: "ticket-resolve-notify",
    band: "multi-hop",
    label: "resolve a ticket and deliver the reply to its requester",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const requester = seeds[(instance + 1) % seeds.length];
      const other = seeds[(instance + 3) % seeds.length];
      const subject = TICKET_SUBJECTS[(instance + 4) % INSTANCES];
      const reply = `Re: ${subject}`;
      const pool = padContacts(seeds, offset, 5);
      const drafts = padDrafts([{ to: other.email, subject: STALE_SUBJECTS[instance] }], pool.slice(4), instance, 2);
      const messages: MessageSeed[] = [{ to: other.email, subject: SUBJECTS[instance] }];
      const tickets = padTickets(
        [ticket("t-1", DECOY_TICKET_SUBJECTS[(instance + 2) % INSTANCES], other.email, "u-2"), ticket("t-2", subject, requester.email, "u-3", "in_progress")],
        pool.slice(4),
        instance,
        3,
      );
      // The env mints draft ids from the seeded record count, so the created draft is deterministic.
      const createdDraftId = `d-${drafts.length + messages.length + 1}`;
      return {
        prompt: `The support ticket titled "${subject}" is fixed. Email the person who opened it a note titled "${reply}", actually deliver that email rather than leaving it unsent, and mark the ticket resolved. Do not touch any other draft or ticket.`,
        state: supportWorld(pool, drafts, messages, tickets),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: requester.email, subject: reply, sent: true } },
          { kind: "absent", collection: "mail.drafts", match: { subject: reply } },
          { kind: "equals", path: "support.tickets.t-2.status", equals: "resolved" },
        ],
        allowedWrites: [`mail.drafts.${createdDraftId}`, "mail.messages", "mail.sequence", "support.tickets.t-2"],
        oracle: [LIST_TICKETS, createDraft({ to: requester.email, subject: reply }), sendDraft(createdDraftId), patchTicket("t-2", { status: "resolved" })],
        surface: "support",
      };
    },
  },
  {
    slug: "churn-cascade",
    band: "cascade",
    label: "record a churn and clean up every record that belongs to them",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const target = seeds[(instance + 2) % seeds.length];
      const other = seeds[instance % seeds.length];
      const drafts: DraftSeed[] = [
        { to: target.email, subject: SUBJECTS[instance] },
        { to: other.email, subject: SUBJECTS[(instance + 5) % INSTANCES] },
        { to: target.email, subject: STALE_SUBJECTS[instance] },
      ];
      const pool = padContacts(seeds, offset, 5);
      const paddedDrafts = padDrafts(drafts, pool.slice(4), instance, 2);
      const tickets = padTickets(
        [ticket("t-1", TICKET_SUBJECTS[(instance + 3) % INSTANCES], target.email, "u-2"), ticket("t-2", TICKET_SUBJECTS[(instance + 6) % INSTANCES], other.email, "u-3")],
        pool.slice(4),
        instance,
        3,
      );
      return {
        prompt: `${target.name} ${LOST_CONTEXTS[instance]}. Record the deal as lost on their CRM contact, mark every unsent draft addressed to them discarded, and mark every support ticket they opened closed. Records belonging to anyone else must be left untouched.`,
        state: supportWorld(pool, paddedDrafts, [], tickets),
        assertions: [
          { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "lost" },
          { kind: "equals", path: "mail.drafts.d-1.status", equals: "discarded" },
          { kind: "equals", path: "mail.drafts.d-3.status", equals: "discarded" },
          { kind: "equals", path: "support.tickets.t-1.status", equals: "closed" },
        ],
        allowedWrites: [`crm.contacts.${target.id}`, "mail.drafts.d-1", "mail.drafts.d-3", "support.tickets.t-1"],
        oracle: [
          LIST_CONTACTS,
          LIST_DRAFTS,
          LIST_TICKETS,
          patchContact(target.id, { status: "lost" }),
          patchDraft("d-1", { status: "discarded" }),
          patchDraft("d-3", { status: "discarded" }),
          patchTicket("t-1", { status: "closed" }),
        ],
        surface: "support",
      };
    },
  },
  {
    slug: "rep-departure-cascade",
    band: "cascade",
    label: "hand a departing rep's book over across CRM and support",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-3", "u-2", "u-3", "u-1"]);
      const newRep = REPS[instance];
      const targets = seeds.filter((seed) => seed.owner === "u-3");
      const keep = seeds[0];
      const pool = padContacts(seeds, offset, 5);
      const tickets = padTickets(
        [
          ticket("t-1", TICKET_SUBJECTS[instance], seeds[2].email, "u-3"),
          ticket("t-2", TICKET_SUBJECTS[(instance + 7) % INSTANCES], keep.email, "u-1"),
          ticket("t-3", DECOY_TICKET_SUBJECTS[instance], seeds[4].email, "u-3", "open", "high"),
        ],
        pool.slice(5),
        instance,
        3,
      );
      return {
        prompt: `Rep u-3 is leaving today. Move every CRM contact owned by u-3 and every support ticket assigned to u-3 over to rep ${newRep}. Anything belonging to another rep must not change, and no other field may change.`,
        state: supportWorld(pool, [], [], tickets),
        assertions: [
          ...targets.map((target) => ({ kind: "equals", path: `crm.contacts.${target.id}.owner`, equals: newRep }) as Assertion),
          { kind: "equals", path: "support.tickets.t-1.assignee", equals: newRep },
          { kind: "equals", path: "support.tickets.t-3.assignee", equals: newRep },
        ],
        allowedWrites: [...targets.map((target) => `crm.contacts.${target.id}`), "support.tickets.t-1", "support.tickets.t-3"],
        oracle: [
          LIST_CONTACTS,
          LIST_TICKETS,
          ...targets.map((target) => patchContact(target.id, { owner: newRep })),
          patchTicket("t-1", { assignee: newRep }),
          patchTicket("t-3", { assignee: newRep }),
        ],
        surface: "support",
      };
    },
  },
  {
    slug: "duplicate-merge",
    band: "cross-record",
    label: "merge duplicate contacts and carry the owner across",
    build: (instance, offset) => {
      const who = persona(offset, 0);
      const filler = [persona(offset, 1), persona(offset, 2), persona(offset, 3)];
      const shortName = `${who.name.split(" ")[0][0]}. ${who.name.split(" ").slice(1).join(" ")}`;
      const survivorFirst = instance % 2 === 0;
      const duplicateOwner = REPS[(instance + 3) % INSTANCES];
      const seeds: ContactSeed[] = survivorFirst
        ? [
            { id: "c-1", name: who.name, email: who.email, status: "open", owner: "u-1" },
            { id: "c-2", name: filler[0].name, email: filler[0].email, status: "open", owner: "u-2" },
            { id: "c-3", name: shortName, email: who.email, status: "open", owner: duplicateOwner },
            { id: "c-4", name: filler[1].name, email: filler[1].email, status: "open", owner: "u-3" },
          ]
        : [
            { id: "c-1", name: shortName, email: who.email, status: "open", owner: duplicateOwner },
            { id: "c-2", name: filler[2].name, email: filler[2].email, status: "open", owner: "u-2" },
            { id: "c-3", name: filler[0].name, email: filler[0].email, status: "open", owner: "u-3" },
            { id: "c-4", name: who.name, email: who.email, status: "open", owner: "u-1" },
          ];
      const survivorId = survivorFirst ? "c-1" : "c-4";
      const duplicateId = survivorFirst ? "c-3" : "c-1";
      return {
        prompt: `Two CRM contacts describe the same person at ${who.email}. The record whose name reads exactly "${who.name}" is the survivor. Mark the other one merged, and give the survivor the owner that the merged record had. No other contact may change.`,
        state: supportWorld(padContacts(seeds, offset, 6), [], [], []),
        assertions: [
          { kind: "equals", path: `crm.contacts.${duplicateId}.status`, equals: "merged" },
          { kind: "equals", path: `crm.contacts.${survivorId}.owner`, equals: duplicateOwner },
        ],
        allowedWrites: [`crm.contacts.${duplicateId}`, `crm.contacts.${survivorId}`],
        oracle: [LIST_CONTACTS, patchContact(duplicateId, { status: "merged" }), patchContact(survivorId, { owner: duplicateOwner })],
        surface: "core",
      };
    },
  },
  {
    slug: "reply-thread-close",
    band: "multi-hop",
    label: "follow up on a sent thread and close the deal behind it",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const target = seeds[(instance + 3) % seeds.length];
      const other = seeds[(instance + 1) % seeds.length];
      const thread = SUBJECTS[(instance + 2) % INSTANCES];
      const followUp = `${thread} — next steps`;
      const pool = padContacts(seeds, offset, 5);
      const drafts = padDrafts([{ to: other.email, subject: STALE_SUBJECTS[(instance + 4) % INSTANCES] }], pool.slice(4), instance, 2);
      const messages: MessageSeed[] = [
        { to: other.email, subject: SUBJECTS[(instance + 8) % INSTANCES] },
        { to: target.email, subject: thread },
        { to: pool[pool.length - 1].email, subject: STALE_SUBJECTS[(instance + 1) % INSTANCES] },
      ];
      // The env mints draft ids from the seeded record count, so the created draft is deterministic.
      const createdDraftId = `d-${drafts.length + messages.length + 1}`;
      return {
        prompt: `We already sent the message titled "${thread}". Its recipient ${CLOSE_CONTEXTS[instance]}. Send them a follow-up titled "${followUp}" — it must actually go out, not sit as a draft — and record the deal as won on their CRM contact. Leave the unrelated draft alone.`,
        state: supportWorld(pool, drafts, messages, []),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: target.email, subject: followUp, sent: true } },
          { kind: "absent", collection: "mail.drafts", match: { subject: followUp } },
          { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "won" },
        ],
        allowedWrites: [`mail.drafts.${createdDraftId}`, "mail.messages", "mail.sequence", `crm.contacts.${target.id}`],
        oracle: [LIST_MESSAGES, createDraft({ to: target.email, subject: followUp }), sendDraft(createdDraftId), LIST_CONTACTS, patchContact(target.id, { status: "won" })],
        surface: "core",
      };
    },
  },
  {
    slug: "priority-escalation-filter",
    band: "cross-record",
    label: "escalate only the open tickets whose requester belongs to one rep",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-2", "u-1", "u-2", "u-3"]);
      const [first, second, third, fourth] = seeds;
      const tickets = [
        ticket("t-1", TICKET_SUBJECTS[instance], first.email, "u-1"),
        ticket("t-2", TICKET_SUBJECTS[(instance + 5) % INSTANCES], second.email, "u-1"),
        // Same rep's contact, but already closed: the filter is on open tickets only.
        ticket("t-3", DECOY_TICKET_SUBJECTS[(instance + 3) % INSTANCES], third.email, "u-4", "closed"),
        ticket("t-4", TICKET_SUBJECTS[(instance + 9) % INSTANCES], third.email, "u-4"),
        ticket("t-5", DECOY_TICKET_SUBJECTS[(instance + 6) % INSTANCES], fourth.email, "u-3"),
      ];
      const pool = padContacts(seeds, offset, 5);
      return {
        prompt: `Escalate support: every ticket that is still open AND whose requester is a CRM contact owned by rep u-2 must get priority urgent and be assigned to u-2. Tickets that are already closed, or whose requester belongs to another rep, must not change in any way.`,
        state: supportWorld(pool, [], [], padTickets(tickets, pool.slice(4), instance, 3)),
        assertions: [
          { kind: "equals", path: "support.tickets.t-1.priority", equals: "urgent" },
          { kind: "equals", path: "support.tickets.t-1.assignee", equals: "u-2" },
          { kind: "equals", path: "support.tickets.t-4.priority", equals: "urgent" },
          { kind: "equals", path: "support.tickets.t-4.assignee", equals: "u-2" },
        ],
        allowedWrites: ["support.tickets.t-1", "support.tickets.t-4"],
        oracle: [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-1", { priority: "urgent", assignee: "u-2" }), patchTicket("t-4", { priority: "urgent", assignee: "u-2" })],
        surface: "support",
      };
    },
  },
  {
    slug: "dual-close-cleanup",
    band: "long-chain",
    label: "deliver two approved quotes, bin the stale one, close both deals",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const first = seeds[instance % seeds.length];
      const second = seeds[(instance + 2) % seeds.length];
      const firstSubject = SUBJECTS[instance];
      const secondSubject = SUBJECTS[(instance + 6) % INSTANCES];
      const stale = STALE_SUBJECTS[(instance + 2) % INSTANCES];
      const drafts: DraftSeed[] =
        instance % 2 === 0
          ? [{ to: first.email, subject: firstSubject }, { to: first.email, subject: stale }, { to: second.email, subject: secondSubject }]
          : [{ to: second.email, subject: secondSubject }, { to: first.email, subject: stale }, { to: first.email, subject: firstSubject }];
      const firstDraftId = instance % 2 === 0 ? "d-1" : "d-3";
      const secondDraftId = instance % 2 === 0 ? "d-3" : "d-1";
      return {
        prompt: `${first.name} and ${second.name} both ${CLOSE_CONTEXTS[instance]}. Deliver the drafts titled "${firstSubject}" and "${secondSubject}", mark the draft titled "${stale}" discarded, and record both deals as won on their CRM contacts.`,
        state: supportWorld(padContacts(seeds, offset, 5), padDrafts(drafts, padContacts(seeds, offset, 5).slice(4), instance, 2), [], []),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: first.email, subject: firstSubject, sent: true } },
          { kind: "exists", collection: "mail.messages", match: { to: second.email, subject: secondSubject, sent: true } },
          { kind: "absent", collection: "mail.drafts", match: { subject: firstSubject } },
          { kind: "absent", collection: "mail.drafts", match: { subject: secondSubject } },
          { kind: "equals", path: "mail.drafts.d-2.status", equals: "discarded" },
          { kind: "equals", path: `crm.contacts.${first.id}.status`, equals: "won" },
          { kind: "equals", path: `crm.contacts.${second.id}.status`, equals: "won" },
        ],
        allowedWrites: [
          "mail.messages",
          "mail.sequence",
          `mail.drafts.${firstDraftId}`,
          `mail.drafts.${secondDraftId}`,
          "mail.drafts.d-2",
          `crm.contacts.${first.id}`,
          `crm.contacts.${second.id}`,
        ],
        oracle: [
          LIST_DRAFTS,
          sendDraft(firstDraftId),
          sendDraft(secondDraftId),
          patchDraft("d-2", { status: "discarded" }),
          LIST_CONTACTS,
          patchContact(first.id, { status: "won" }),
          patchContact(second.id, { status: "won" }),
        ],
        surface: "core",
      };
    },
  },
  {
    slug: "conditional-route",
    band: "conditional",
    label: "branch on whether the requester exists in the CRM at all",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const known = seeds[(instance + 1) % seeds.length];
      const stranger = persona(offset + 13, 0);
      const requesterIsKnown = instance % 2 === 0;
      // Half the instances have a CRM record for the requester and half do not,
      // so the branch cannot be guessed from the prompt.
      const requester = requesterIsKnown ? known.email : stranger.email;
      const subject = TICKET_SUBJECTS[(instance + 2) % INSTANCES];
      const pool = padContacts(seeds, offset, 5);
      const tickets = padTickets([ticket("t-1", subject, requester, "unassigned")], pool.slice(4), instance, 4);
      const drafts = padDrafts([], pool.slice(4), instance, 2);
      const intake = `Intake: ${subject}`;
      const createdDraftId = `d-${drafts.length + 1}`;
      return {
        prompt: `Ticket "${subject}" needs handling. If the person who opened it already has a CRM contact, assign the ticket to that contact's owner and set the ticket to in_progress. If they have no CRM contact at all, leave the ticket unassigned, set its priority to urgent, and prepare (do not send) an email to the requester titled "${intake}". Do exactly one of these two, and change nothing else.`,
        state: supportWorld(pool, drafts, [], tickets),
        assertions: requesterIsKnown
          ? [
              { kind: "equals", path: "support.tickets.t-1.assignee", equals: known.owner },
              { kind: "equals", path: "support.tickets.t-1.status", equals: "in_progress" },
            ]
          : [
              { kind: "equals", path: "support.tickets.t-1.priority", equals: "urgent" },
              { kind: "exists", collection: "mail.drafts", match: { to: stranger.email, subject: intake, status: "draft" } },
            ],
        allowedWrites: requesterIsKnown ? ["support.tickets.t-1"] : ["support.tickets.t-1", `mail.drafts.${createdDraftId}`, "mail.sequence"],
        oracle: requesterIsKnown
          ? [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-1", { assignee: known.owner, status: "in_progress" })]
          : [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-1", { priority: "urgent" }), createDraft({ to: stranger.email, subject: intake })],
        surface: "support",
      };
    },
  },
  {
    slug: "load-balance-assign",
    band: "aggregation",
    label: "assign to the rep carrying the fewest accounts",
    build: (instance, offset) => {
      // Owner counts are unequal by construction; the winner is only knowable by
      // counting the contact listing, never from the prompt.
      const winner = ["u-4", "u-5", "u-2", "u-3"][instance % 4];
      const others = ["u-1", "u-2", "u-3", "u-4", "u-5"].filter((rep) => rep !== winner);
      const owners = [others[0], others[1], others[0], others[2], winner, others[1], others[3], others[0], others[2], others[3]];
      const seeds = contacts(offset, owners);
      const subject = TICKET_SUBJECTS[(instance + 8) % INSTANCES];
      const tickets = [
        ticket("t-1", subject, seeds[0].email, "unassigned"),
        ticket("t-2", DECOY_TICKET_SUBJECTS[(instance + 8) % INSTANCES], seeds[1].email, "u-1", "resolved"),
        ticket("t-3", DECOY_TICKET_SUBJECTS[(instance + 2) % INSTANCES], seeds[3].email, "u-3"),
      ];
      return {
        prompt: `Ticket "${subject}" is unassigned. Give it to whichever of the reps u-1, u-2, u-3, u-4, u-5 currently owns the fewest CRM contacts, and move that ticket to in_progress. Exactly one of those five owns the fewest. No CRM record may change.`,
        state: supportWorld(seeds, [], [], tickets),
        assertions: [
          { kind: "equals", path: "support.tickets.t-1.assignee", equals: winner },
          { kind: "equals", path: "support.tickets.t-1.status", equals: "in_progress" },
        ],
        allowedWrites: ["support.tickets.t-1"],
        oracle: [LIST_CONTACTS, LIST_TICKETS, patchTicket("t-1", { assignee: winner, status: "in_progress" })],
        surface: "support",
      };
    },
  },
  {
    slug: "same-title-trap",
    band: "conditional",
    label: "two drafts share a title; only the right recipient's may change",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const target = seeds[(instance + 2) % seeds.length];
      const decoy = seeds[(instance + 3) % seeds.length];
      const shared = SUBJECTS[(instance + 4) % INSTANCES];
      const revised = `${shared} (final)`;
      const targetFirst = instance % 2 === 0;
      const drafts: DraftSeed[] = targetFirst
        ? [{ to: target.email, subject: shared }, { to: decoy.email, subject: shared }]
        : [{ to: decoy.email, subject: shared }, { to: target.email, subject: shared }];
      const targetDraftId = targetFirst ? "d-1" : "d-2";
      const pool = padContacts(seeds, offset, 5);
      return {
        prompt: `Two unsent drafts carry the title "${shared}". Retitle only the one addressed to ${target.name} to "${revised}". The other draft with that title belongs to someone else and must stay exactly as it is — the CRM holds the address that tells them apart.`,
        state: supportWorld(pool, padDrafts(drafts, pool.slice(4), instance, 2), [], []),
        assertions: [
          { kind: "equals", path: `mail.drafts.${targetDraftId}.subject`, equals: revised },
          { kind: "exists", collection: "mail.drafts", match: { to: decoy.email, subject: shared, status: "draft" } },
        ],
        allowedWrites: [`mail.drafts.${targetDraftId}`],
        oracle: [LIST_CONTACTS, LIST_DRAFTS, patchDraft(targetDraftId, { subject: revised })],
        surface: "core",
      };
    },
  },
  {
    slug: "derived-subject-close",
    band: "long-chain",
    label: "compose a subject out of another record's field, then close out",
    build: (instance, offset) => {
      const seeds = contacts(offset, ["u-1", "u-2", "u-3", "u-4"]);
      const target = seeds[(instance + 1) % seeds.length];
      const other = seeds[(instance + 2) % seeds.length];
      const label = SUBJECTS[(instance + 9) % INSTANCES];
      // The subject is not stated anywhere: it is composed from the contact's own owner id.
      const composed = `${label} — owner ${target.owner}`;
      const pool = padContacts(seeds, offset, 5);
      const drafts = padDrafts([{ to: other.email, subject: STALE_SUBJECTS[(instance + 5) % INSTANCES] }], pool.slice(4), instance, 2);
      const tickets = padTickets([ticket("t-1", TICKET_SUBJECTS[(instance + 11) % INSTANCES], target.email, "u-1", "open", "high")], pool.slice(4), instance, 3);
      const createdDraftId = `d-${drafts.length + 1}`;
      return {
        prompt: `${target.name} ${CLOSE_CONTEXTS[instance]}. Send them a handover note whose title is the words "${label}", then an em dash, then the word owner, then a space, then the id of the rep who owns their CRM contact — for example "${label} — owner u-0". It must actually be delivered. Then record the deal as won on their contact and mark their open support ticket resolved.`,
        state: supportWorld(pool, drafts, [], tickets),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: target.email, subject: composed, sent: true } },
          { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "won" },
          { kind: "equals", path: "support.tickets.t-1.status", equals: "resolved" },
        ],
        allowedWrites: [`mail.drafts.${createdDraftId}`, "mail.messages", "mail.sequence", `crm.contacts.${target.id}`, "support.tickets.t-1"],
        oracle: [
          LIST_CONTACTS,
          createDraft({ to: target.email, subject: composed }),
          sendDraft(createdDraftId),
          patchContact(target.id, { status: "won" }),
          LIST_TICKETS,
          patchTicket("t-1", { status: "resolved" }),
        ],
        surface: "support",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

/** The hard tasks only: 8 families x 12 instances = 96 tasks. */
export const HARD_TASKS: Task[] = buildHardTasks();

function buildHardTasks(): Task[] {
  const tasks: Task[] = [];
  HARD_FAMILIES.forEach((family, familyIndex) => {
    for (let instance = 0; instance < INSTANCES; instance += 1) {
      const offset = (familyIndex * 5 + instance * 3) % PERSONAS.length;
      const authored = family.build(instance, offset);
      tasks.push({
        taskId: `hard-api-${family.slug}-${String(instance + 1).padStart(2, "0")}`,
        split: SPLIT_BY_INSTANCE[instance],
        prompt: authored.prompt,
        initialState: authored.state,
        assertions: authored.assertions,
        allowedWrites: authored.allowedWrites,
        oracle: authored.oracle,
        surface: authored.surface,
        maxSteps: HARD_MAX_STEPS,
      });
    }
  });
  return tasks;
}

/** v2 = every v1 task (unchanged ids, assertions, and splits) plus the hard tasks. */
export const V2_TASKS: Task[] = [...TASKS, ...HARD_TASKS];

registerTasks(HARD_TASKS);

/** Family slug -> band across both halves of v2, for the per-band breakdown of a run. */
export function v2TaskBands(): Record<string, string> {
  return { ...taskBands(), ...Object.fromEntries(HARD_FAMILIES.map((family) => [family.slug, family.band])) };
}

export function v2SplitCounts(): Record<Split, number> {
  return V2_TASKS.reduce((counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }), { train: 0, dev: 0, holdout: 0 } as Record<Split, number>);
}

/** Content hash of the whole v2 fixture. */
export function v2FixtureSha256(): string {
  return sha256({ tasks: V2_TASKS, pin: AUTOMATIONBENCH_V2, guard_contact: GUARD_CONTACT, seed: RESET_SEED });
}

/** Content hash of one v2 split's task ids + assertions — the frozen-split contract. */
export function v2SplitSha256(split: Split): string {
  return sha256(V2_TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

export type V2PoolOptions = { split: Split; frozenHoldoutSha256?: string };

/** v2 task pool. The frozen holdout fails closed exactly like v1: no hash, no read. */
export function v2TaskPool(options: V2PoolOptions): Task[] {
  if (options.split === "holdout") {
    const expected = v2SplitSha256("holdout");
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the v2 holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: v2 holdout hash mismatch (expected ${expected})`);
  }
  return V2_TASKS.filter((task) => task.split === options.split);
}

/** The frozen v2 split contract, ready to paste into a lab note or a runner flag. */
export function v2SplitManifest(): Record<string, unknown> {
  const counts = v2SplitCounts();
  return {
    fixture_id: AUTOMATIONBENCH_V2.fixture_id,
    seed: RESET_SEED,
    counts,
    fixture_sha256: v2FixtureSha256(),
    train_sha256: v2SplitSha256("train"),
    dev_sha256: v2SplitSha256("dev"),
    holdout_sha256: v2SplitSha256("holdout"),
    splits_sha256: sha256({ train: v2SplitSha256("train"), dev: v2SplitSha256("dev"), holdout: v2SplitSha256("holdout") }),
    hard_families: HARD_FAMILIES.map((family) => ({ slug: family.slug, band: family.band, label: family.label })),
    canonical: canonicalJson({ counts }),
  };
}
