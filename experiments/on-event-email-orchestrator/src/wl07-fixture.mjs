import {
  LIST_CONTACTS,
  LIST_DRAFTS,
  LIST_TICKETS,
  PERSONAS,
  RESET_SEED,
  auditObservationLeakage,
  canonicalJson,
  contactSeeds,
  createDraft,
  getTask,
  patchContact,
  patchDraft,
  patchTicket,
  partialCredit,
  registerTasks,
  reset,
  sha256,
  step,
  supportWorld,
} from "../../../dist/automationbench-offline.js";

export const WL07 = {
  fixture_id: "wl07-email-orchestration-offline-v1",
  code: "WL-07",
  split_seed: RESET_SEED,
};

const INSTANCE_COUNT = 12;
const SPLITS = ["train", "train", "train", "train", "train", "train", "dev", "dev", "holdout", "holdout", "holdout", "holdout"];
const OWNERS = ["u-1", "u-2", "u-3", "u-4", "u-5", "u-6"];
const SUBJECTS = [
  "Calendar sync failed",
  "Invoice reminder",
  "Access request",
  "Renewal question",
  "Delivery update",
  "Seat change",
  "Export notice",
  "Security review",
  "Usage report",
  "Trial ending",
  "Webhook alert",
  "Meeting follow-up",
];
const DECOYS = SUBJECTS.map((subject) => `${subject} — duplicate`);
const REPLIES = SUBJECTS.map((subject) => `Re: ${subject}`);
const EVENT_WORDING = [
  "Inbound message received",
  "Meeting invite declined",
  "Ticket reply received",
  "Inbound message received",
  "Meeting invite declined",
  "Ticket reply received",
];

function ticket(id, subject, requester, assignee = "unassigned", status = "open") {
  return { id, subject, requester, status, assignee, priority: "normal" };
}

function contacts(offset, owners = OWNERS) {
  return contactSeeds(offset, owners);
}

function paddedContacts(seeds) {
  const padding = contactSeeds((seeds.length + 7) % PERSONAS.length, ["u-7", "u-8"]).map((seed, index) => ({
    ...seed,
    id: `c-${seeds.length + index + 1}`,
  }));
  return [...seeds, ...padding];
}

function draft(to, subject) {
  return { to, subject };
}

function caseFor(family, instance) {
  const offset = (family * 11 + instance * 5) % PERSONAS.length;
  const wording = EVENT_WORDING[family];
  const subject = SUBJECTS[instance];
  const decoySubject = DECOYS[instance];

  if (family === 0) {
    const seeds = contacts(offset);
    const target = seeds[(instance + 1) % seeds.length];
    const decoy = seeds[(instance + 4) % seeds.length];
    return {
      prompt: `${wording}: "${subject}" from ${target.email}. Route the matching ticket to the CRM owner of its sender and move it to in_progress. Leave the near-match ticket untouched.`,
      state: supportWorld(paddedContacts(seeds), [], [], [
        ticket("t-1", decoySubject, decoy.email, "u-8"),
        ticket("t-2", subject, target.email),
      ]),
      assertions: [
        { kind: "equals", path: "support.tickets.t-2.assignee", equals: target.owner },
        { kind: "equals", path: "support.tickets.t-2.status", equals: "in_progress" },
      ],
      allowedWrites: ["support.tickets.t-2"],
      oracle: [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-2", { assignee: target.owner, status: "in_progress" })],
      surface: "support",
    };
  }

  if (family === 1) {
    const seeds = contacts(offset);
    const target = seeds[(instance + 2) % seeds.length];
    const decoy = seeds[(instance + 4) % seeds.length];
    const drafts = [draft(decoy.email, decoySubject)];
    const createdId = "d-2";
    return {
      prompt: `${wording}: "${subject}" was sent by ${target.email}. Prepare a short reply draft titled "${REPLIES[instance]}" addressed to that sender. Do not send it and do not change the existing draft.`,
      state: supportWorld(paddedContacts(seeds), drafts, [], [
        ticket("t-1", subject, target.email),
        ticket("t-2", decoySubject, decoy.email),
      ]),
      assertions: [{ kind: "exists", collection: "mail.drafts", match: { to: target.email, subject: REPLIES[instance], status: "draft" } }],
      allowedWrites: [`mail.drafts.${createdId}`, "mail.sequence"],
      oracle: [LIST_TICKETS, createDraft({ to: target.email, subject: REPLIES[instance] })],
      surface: "support",
    };
  }

  if (family === 2) {
    const seeds = contacts(offset);
    const target = seeds[(instance + 3) % seeds.length];
    const decoy = seeds[(instance + 5) % seeds.length];
    const newStatus = instance % 2 === 0 ? "won" : "lost";
    return {
      prompt: `${wording}: the event for "${subject}" came from ${target.email}. Record the event outcome as ${newStatus} on that sender's contact only. The similar event from ${decoy.email} is unrelated.`,
      state: supportWorld(paddedContacts(seeds), [], [], [
        ticket("t-1", subject, target.email),
        ticket("t-2", subject, decoy.email),
      ]),
      assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.status`, equals: newStatus }],
      allowedWrites: [`crm.contacts.${target.id}`],
      oracle: [LIST_TICKETS, LIST_CONTACTS, patchContact(target.id, { status: newStatus })],
      surface: "support",
    };
  }

  if (family === 3) {
    const seeds = contacts(offset);
    const target = seeds[(instance + 4) % seeds.length];
    const decoy = seeds[(instance + 1) % seeds.length];
    return {
      prompt: `${wording}: only the ticket titled "${subject}" from ${target.email} requires assignment to ${target.owner}. The near-identical ticket "${decoySubject}" is informational and must not change.`,
      state: supportWorld(paddedContacts(seeds), [], [], [
        ticket("t-1", subject, target.email),
        ticket("t-2", decoySubject, decoy.email, "u-8"),
      ]),
      assertions: [{ kind: "equals", path: "support.tickets.t-1.assignee", equals: target.owner }],
      allowedWrites: ["support.tickets.t-1"],
      oracle: [LIST_TICKETS, patchTicket("t-1", { assignee: target.owner })],
      surface: "support",
    };
  }

  if (family === 4) {
    const base = contacts(offset);
    const target = base[(instance + 5) % base.length];
    const duplicate = { ...base[(instance + 2) % base.length], id: "c-7", name: `Initial ${base[(instance + 2) % base.length].name}`, email: target.email };
    const seeds = [...base.slice(0, 6), duplicate];
    const newStatus = instance % 2 === 0 ? "won" : "lost";
    return {
      prompt: `${wording}: the event titled "${subject}" identifies the full contact name "${target.name}" and sender address ${target.email}. Join the event to the sender address, select the exact full-name contact, and mark only that contact ${newStatus}.`,
      state: supportWorld(seeds, [], [], [ticket("t-1", subject, target.email)]),
      assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.status`, equals: newStatus }],
      allowedWrites: [`crm.contacts.${target.id}`],
      oracle: [LIST_TICKETS, LIST_CONTACTS, patchContact(target.id, { status: newStatus })],
      surface: "support",
    };
  }

  const seeds = contacts(offset);
  const target = seeds[(instance + 1) % seeds.length];
  const other = seeds[(instance + 4) % seeds.length];
  const drafts = [draft(target.email, SUBJECTS[(instance + 3) % SUBJECTS.length]), draft(target.email, DECOYS[(instance + 2) % SUBJECTS.length]), draft(other.email, SUBJECTS[instance])];
  return {
    prompt: `${wording}: "${subject}" confirms that ${target.name} has left the program. Mark that contact lost, set both drafts addressed to them to status discarded, and set the ticket they opened to status closed. Leave ${other.email}'s draft and ticket unchanged.`,
    state: supportWorld(paddedContacts(seeds), drafts, [], [
      ticket("t-1", subject, target.email, "u-2"),
      ticket("t-2", DECOYS[(instance + 4) % SUBJECTS.length], other.email, "u-3"),
    ]),
    assertions: [
      { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "lost" },
      { kind: "equals", path: "mail.drafts.d-1.status", equals: "discarded" },
      { kind: "equals", path: "mail.drafts.d-2.status", equals: "discarded" },
      { kind: "equals", path: "support.tickets.t-1.status", equals: "closed" },
    ],
    allowedWrites: [`crm.contacts.${target.id}`, "mail.drafts.d-1", "mail.drafts.d-2", "support.tickets.t-1"],
    oracle: [
      LIST_CONTACTS,
      LIST_DRAFTS,
      LIST_TICKETS,
      patchContact(target.id, { status: "lost" }),
      patchDraft("d-1", { status: "discarded" }),
      patchDraft("d-2", { status: "discarded" }),
      patchTicket("t-1", { status: "closed" }),
    ],
    surface: "support",
  };
}

export const FAMILIES = [
  ["event-route", "cross-record"],
  ["event-reply-draft", "discovery"],
  ["event-field-update", "single-write"],
  ["event-conditional-noop", "conditional"],
  ["event-multi-hop", "multi-hop"],
  ["event-cascade-bounded", "cascade"],
];

export const TASKS = FAMILIES.flatMap(([slug], family) =>
  Array.from({ length: INSTANCE_COUNT }, (_, instance) => {
    const authored = caseFor(family, instance);
    return {
      taskId: `wl07-email-orchestration-${slug}-${String(instance + 1).padStart(2, "0")}`,
      split: SPLITS[instance],
      prompt: authored.prompt,
      initialState: authored.state,
      assertions: authored.assertions,
      allowedWrites: authored.allowedWrites,
      oracle: authored.oracle,
      surface: authored.surface,
      maxSteps: 10,
    };
  }),
);

registerTasks(TASKS);

export const BANDS = Object.fromEntries(FAMILIES);

export function taskBand(task) {
  const slug = task.taskId.replace(/^wl07-email-orchestration-/, "").replace(/-\d{2}$/, "");
  return BANDS[slug] ?? "unknown";
}

export function splitCounts() {
  return TASKS.reduce((counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }), { train: 0, dev: 0, holdout: 0 });
}

export function fixtureSha256() {
  return sha256({ fixture: WL07, tasks: TASKS, bands: BANDS });
}

export function splitSha256(split) {
  return sha256(TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

export function taskPool({ split, frozenHoldoutSha256 } = {}) {
  if (split === "holdout") {
    const expected = splitSha256("holdout");
    if (!frozenHoldoutSha256 || frozenHoldoutSha256 !== expected) {
      throw new Error("frozen-holdout refusal: WL-07 holdout requires its exact frozen hash");
    }
  }
  return TASKS.filter((task) => task.split === split);
}

export function splitManifest() {
  return {
    fixture_id: WL07.fixture_id,
    code: WL07.code,
    seed: RESET_SEED,
    counts: splitCounts(),
    fixture_sha256: fixtureSha256(),
    train_sha256: splitSha256("train"),
    dev_sha256: splitSha256("dev"),
    holdout_sha256: splitSha256("holdout"),
    splits_sha256: sha256({ train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") }),
  };
}

export function rollout(taskId, policy) {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const leakage = auditObservationLeakage(initial, task);
  let observation = initial;
  for (let stepIndex = 0; stepIndex < (task.maxSteps ?? 10); stepIndex += 1) {
    const action = policy(observation);
    if (!action) break;
    const result = step(handle, action);
    observation = result.obs;
    if (result.done) break;
  }
  return {
    taskId,
    reward: partialCredit(handle),
    forbiddenEffects: [...handle.forbiddenEffects],
    leakage,
    handle,
  };
}

export function discoverableText(task) {
  const { handle, obs } = reset(task.taskId);
  const reads = [LIST_CONTACTS, LIST_DRAFTS, LIST_TICKETS];
  return reads.reduce((text, call) => text + step(handle, call).obs.messages.at(-1).content, canonicalJson(obs.messages));
}

export function deterministicTaskHash(task) {
  return sha256({ task, observations: discoverableText(task) });
}
