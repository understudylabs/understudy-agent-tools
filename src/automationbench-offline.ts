/**
 * automationbench-offline — a local, synthetic, offline evaluator + importer
 * for ONE reachable AutomationBench subset: `simple`/`api`.
 *
 * The fixture is ranking-sized rather than illustrative: 12 task families x 6
 * instances = 72 tasks (train 48 / dev 12 / holdout 12), spread across three
 * difficulty bands (single-write, discovery, multi-write) so a run separates
 * models instead of saturating.
 *
 * Subset choice is repo-evidenced, not invented: the AutomationBench wiring
 * verified in skills/prepare-verifier-handoff/references/stage-1-author-env.md
 * ("Worked wiring — AutomationBench `simple`/`api`") names exactly the
 * primitives modelled here — `WorldState(**info["initial_state"])`,
 * `api_search` (read-only discovery), `api_fetch` (the one-step state
 * mutator), and `partial_credit(state)` as the terminal fractional reward.
 *
 * Packaging concepts follow the current public Prime Intellect Verifiers v1
 * surface already pinned by this repo (`verifiers.v1` env format plus the
 * commit pin used by trace-foundry): a Taskset of Tasks, each with seeded
 * setup and a terminal `@vf.reward`. This module does NOT depend on, download,
 * or execute verifiers, any provider, or any network resource — it emits the
 * package *descriptor* and runs the environment locally in-process.
 *
 * Understudy-owned safety gates enforced here (each has a test):
 *   1. deterministic reset — reset(task, seed) is byte-identical per seed;
 *      no wall clock, no RNG, no generated ids outside the seed.
 *   2. terminal partial_credit reward — reward is 0 until `done`, then the
 *      fractional final-state score with the anti-free-credit rule.
 *   3. no label leakage — the observation never carries assertions, gold,
 *      allowed writes, or the oracle script.
 *   4. no live effects — the env mutates in-memory synthetic state only and
 *      never imports a model, provider, or network client.
 *   5. scripted oracle — a per-task recorded action script that must score 1.
 *   6. reward-hacking sentinel — an activity-only policy (search spam plus
 *      out-of-scope writes) must score 0.
 *   7. schema/hash checks — fixture content hash is pinned; emitted manifests
 *      validate against understudy.benchmark.v1 and rows against
 *      understudy.eval_result.v1 required fields.
 *   8. parser compatibility — actions parse from the on-disk AutomationBench
 *      encoding where `tool_calls` entries are JSON strings and `arguments`
 *      is itself a JSON string (double-decode).
 *   9. frozen-holdout refusal — holdout rows are refused unless the caller
 *      passes the matching frozen holdout hash explicitly.
 *  10. reachability — every literal the gold action sequence needs (record id,
 *      address, subject, owner) is present in the prompt or readable through a
 *      read-only call, so no task is unsolvable from the allowed observations.
 *  11. fixture integrity — tasks are unique, no task's assertions are all
 *      already true at reset, and no task may write the guard contact.
 */

import { createHash } from "node:crypto";

import { canonicalJson, validateBenchmarkManifest } from "./benchmark.js";

export { canonicalJson };

// ---------------------------------------------------------------------------
// Subset pin
// ---------------------------------------------------------------------------

/** The single reachable subset this module covers, pinned for reproducibility. */
export const AUTOMATIONBENCH_SUBSET = {
  benchmark_id: "automationbench-simple-api-offline",
  /** AutomationBench task family: `simple` difficulty over the `api` tool surface. */
  subset: "simple/api",
  source_ref: "zapier/AutomationBench",
  /** Synthetic re-implementation — offline fixtures, never the upstream dataset. */
  fixture_id: "automationbench-simple-api-offline-v1",
  /** verifiers.v1 commit pin already used by this repo's generated packages. */
  verifiers_version_pin: "ab65b6e8d34b03d162408d4bcb854430a86809e6",
  /** Frozen split seed (seed-7 convention used across the verifier-handoff stages). */
  split_seed: 7,
} as const;

export const RESET_SEED = AUTOMATIONBENCH_SUBSET.split_seed;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Split = "train" | "dev" | "holdout";

/**
 * A final-state assertion. `equals` pins a value that already has a stable id
 * in `initial_state`; `exists` / `absent` match an entry inside a collection by
 * content, so a task whose gold record is CREATED during the episode is scored
 * on what the record contains rather than on the id the env happened to mint.
 */
export type Assertion =
  | { kind: "equals"; path: string; equals: unknown }
  | { kind: "exists"; collection: string; match: Record<string, unknown> }
  | { kind: "absent"; collection: string; match: Record<string, unknown> };

export type ToolCall = { name: string; arguments: Record<string, unknown> };

/** One synthetic task. `assertions`, `allowedWrites`, and `oracle` are grader-side only. */
export type Task = {
  taskId: string;
  split: Split;
  /** Candidate-readable instruction. Must never restate an assertion path. */
  prompt: string;
  initialState: WorldState;
  assertions: Assertion[];
  /** Dotted path prefixes this task is permitted to mutate; anything else is a forbidden effect. */
  allowedWrites: string[];
  /** Scripted oracle: the recorded action sequence that reaches the gold final state. */
  oracle: ToolCall[];
};

export type Contact = { name: string; email: string; status: string; owner: string };
export type Draft = { to: string; subject: string; status: string };
export type Message = { to: string; subject: string; sent: boolean };

export type WorldState = {
  crm: { contacts: Record<string, Contact> };
  mail: {
    drafts: Record<string, Draft>;
    messages: Record<string, Message>;
    /** Deterministic id counter — the only id source, seeded from initial state. */
    sequence: number;
  };
};

export type Observation = {
  task_id: string;
  seed: number;
  step: number;
  messages: { role: "system" | "user" | "tool"; content: string }[];
  tools: { name: string; description: string }[];
};

export type EnvHandle = {
  taskId: string;
  seed: number;
  state: WorldState;
  step: number;
  done: boolean;
  /** Writes attempted outside `allowedWrites`; any entry zeroes the reward. */
  forbiddenEffects: string[];
  messages: Observation["messages"];
};

export type StepResult = { obs: Observation; reward: number; done: boolean; info: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Fixtures (synthetic; no upstream data, no customer data)
// ---------------------------------------------------------------------------

const TOOL_CATALOG: Observation["tools"] = [
  { name: "api_search", description: "Read-only endpoint discovery. Args: {query: string, top_k?: number}." },
  { name: "api_fetch", description: "Apply one API call. Args: {method: string, url: string, body?: object}." },
];

const ENDPOINTS = [
  { url: "/crm/contacts", methods: ["GET"], summary: "List CRM contacts and their ids." },
  { url: "/crm/contacts/{id}", methods: ["GET", "PATCH"], summary: "Read or update a CRM contact." },
  { url: "/mail/drafts", methods: ["GET", "POST"], summary: "List or create a mail draft." },
  { url: "/mail/drafts/{id}", methods: ["GET", "PATCH"], summary: "Read a mail draft, retitle it, or mark it discarded." },
  { url: "/mail/messages", methods: ["GET", "POST"], summary: "List sent mail, or send an existing draft by draft_id." },
];

const MAX_STEPS = 12;

// --- Synthetic entity tables -----------------------------------------------
// Public-figure names in a fictional CRM. No upstream dataset, no customer data.

type Persona = { name: string; email: string };

const PERSONAS: Persona[] = [
  { name: "Ada Lovelace", email: "ada.lovelace@example.test" },
  { name: "Grace Hopper", email: "grace.hopper@example.test" },
  { name: "Alan Turing", email: "alan.turing@example.test" },
  { name: "Barbara Liskov", email: "barbara.liskov@example.test" },
  { name: "Edsger Dijkstra", email: "edsger.dijkstra@example.test" },
  { name: "Frances Allen", email: "frances.allen@example.test" },
  { name: "Donald Knuth", email: "donald.knuth@example.test" },
  { name: "Radia Perlman", email: "radia.perlman@example.test" },
  { name: "Vint Cerf", email: "vint.cerf@example.test" },
  { name: "Shafi Goldwasser", email: "shafi.goldwasser@example.test" },
  { name: "Ken Thompson", email: "ken.thompson@example.test" },
  { name: "Jean Bartik", email: "jean.bartik@example.test" },
  { name: "Tim Berners-Lee", email: "tim.berners.lee@example.test" },
  { name: "Anita Borg", email: "anita.borg@example.test" },
  { name: "Leslie Lamport", email: "leslie.lamport@example.test" },
  { name: "Sophie Wilson", email: "sophie.wilson@example.test" },
  { name: "Lynn Conway", email: "lynn.conway@example.test" },
  { name: "Adele Goldberg", email: "adele.goldberg@example.test" },
  { name: "Hedy Lamarr", email: "hedy.lamarr@example.test" },
  { name: "Claude Shannon", email: "claude.shannon@example.test" },
  { name: "Evelyn Boyd", email: "evelyn.boyd@example.test" },
  { name: "Mary Jackson", email: "mary.jackson@example.test" },
  { name: "Andrew Yao", email: "andrew.yao@example.test" },
  { name: "Ruth Teitelbaum", email: "ruth.teitelbaum@example.test" },
];

/**
 * Present in every world and writable by no task. The reward-hacking sentinel
 * writes here, so the sentinel gate is structural rather than per-task luck.
 */
const GUARD_CONTACT: ContactSeed = { id: "c-0", name: "Margaret Hamilton", email: "margaret.hamilton@example.test", status: "reference", owner: "u-9" };

/** Same-first-name pairs for the disambiguation family: the listing, not the prompt, resolves the id. */
const NAME_COLLISIONS: { target: Persona; decoy: Persona }[] = [
  { target: { name: "Alan Turing", email: "alan.turing@example.test" }, decoy: { name: "Alan Kay", email: "alan.kay@example.test" } },
  { target: { name: "Grace Hopper", email: "grace.hopper@example.test" }, decoy: { name: "Grace Murray", email: "grace.murray@example.test" } },
  { target: { name: "John McCarthy", email: "john.mccarthy@example.test" }, decoy: { name: "John Backus", email: "john.backus@example.test" } },
  { target: { name: "Karen Jones", email: "karen.jones@example.test" }, decoy: { name: "Karen Uhlenbeck", email: "karen.uhlenbeck@example.test" } },
  { target: { name: "Bob Kahn", email: "bob.kahn@example.test" }, decoy: { name: "Bob Metcalfe", email: "bob.metcalfe@example.test" } },
  { target: { name: "Peter Naur", email: "peter.naur@example.test" }, decoy: { name: "Peter Chen", email: "peter.chen@example.test" } },
];

const CLOSE_CONTEXTS = [
  "signed the contract",
  "countersigned the order form",
  "cleared procurement review",
  "returned the signed quote",
  "approved the renewal terms",
  "committed after the security review",
];

const LOST_CONTEXTS = [
  "chose a competitor",
  "ended the pilot without buying",
  "froze the budget for the year",
  "consolidated vendors after an acquisition",
  "cancelled the evaluation",
  "declined the renewal",
];

const NEW_OWNERS = ["u-2", "u-4", "u-5", "u-6", "u-7", "u-8"];
const MIDDLE_INITIALS = ["B", "C", "D", "E", "F", "G"];
const SUBJECTS = ["Welcome", "Onboarding plan", "Renewal options", "Pricing update", "Kickoff agenda", "Security review"];
const REVISED_SUBJECTS = ["Welcome (revised)", "Onboarding plan v2", "Renewal options final", "Pricing update 2026", "Kickoff agenda updated", "Security review packet"];
const STALE_SUBJECTS = ["Old pricing sheet", "Superseded agenda", "Legacy renewal note", "Duplicate quote", "Outdated onboarding", "Archived kickoff"];

// --- World construction ------------------------------------------------------

type ContactSeed = { id: string; name: string; email: string; status: string; owner: string };
type DraftSeed = { to: string; subject: string };

/** Deterministic contact slice: personas are picked by index, never by RNG. */
function contactSeeds(offset: number, owners: string[]): ContactSeed[] {
  return owners.map((owner, index) => {
    const persona = PERSONAS[(offset + index) % PERSONAS.length];
    return { id: `c-${index + 1}`, name: persona.name, email: persona.email, status: "open", owner };
  });
}

function world(seeds: ContactSeed[], drafts: DraftSeed[]): WorldState {
  const contacts: Record<string, Contact> = {};
  for (const seed of [GUARD_CONTACT, ...seeds]) contacts[seed.id] = { name: seed.name, email: seed.email, status: seed.status, owner: seed.owner };
  const draftRecords: Record<string, Draft> = {};
  drafts.forEach((draft, index) => {
    draftRecords[`d-${index + 1}`] = { to: draft.to, subject: draft.subject, status: "draft" };
  });
  return { crm: { contacts }, mail: { drafts: draftRecords, messages: {}, sequence: drafts.length } };
}

// --- Oracle action helpers ---------------------------------------------------

const LIST_CONTACTS: ToolCall = { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } };
const LIST_DRAFTS: ToolCall = { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } };

function search(query: string): ToolCall {
  return { name: "api_search", arguments: { query } };
}

function patchContact(id: string, body: Record<string, unknown>): ToolCall {
  return { name: "api_fetch", arguments: { method: "PATCH", url: `/crm/contacts/${id}`, body } };
}

function patchDraft(id: string, body: Record<string, unknown>): ToolCall {
  return { name: "api_fetch", arguments: { method: "PATCH", url: `/mail/drafts/${id}`, body } };
}

function createDraft(body: Record<string, unknown>): ToolCall {
  return { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body } };
}

function sendDraft(draftId: string): ToolCall {
  return { name: "api_fetch", arguments: { method: "POST", url: "/mail/messages", body: { draft_id: draftId } } };
}

// --- Task families -----------------------------------------------------------

/** One authored task before it is stamped with an id and a split. */
type CaseDraft = { prompt: string; state: WorldState; assertions: Assertion[]; allowedWrites: string[]; oracle: ToolCall[] };

type Family = {
  slug: string;
  /** Difficulty band, used only for reporting; scoring never reads it. */
  band: "single-write" | "discovery" | "multi-write";
  label: string;
  build: (instance: number, offset: number) => CaseDraft;
};

const DEFAULT_OWNERS = ["u-1", "u-2", "u-3", "u-1"];

/**
 * Twelve families. Each contributes six instances (four train, one dev, one
 * holdout), so every family is represented in every split and no split is a
 * skill the others never see.
 */
const FAMILIES: Family[] = [
  {
    slug: "crm-close",
    band: "single-write",
    label: "close a CRM deal as won",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[instance % seeds.length];
      return {
        prompt: `${target.name} ${CLOSE_CONTEXTS[instance]}. Record the deal as won on that CRM contact.`,
        state: world(seeds, []),
        assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "won" }],
        allowedWrites: [`crm.contacts.${target.id}`],
        oracle: [search("update crm contact"), LIST_CONTACTS, patchContact(target.id, { status: "won" })],
      };
    },
  },
  {
    slug: "crm-lost",
    band: "single-write",
    label: "close a CRM deal as lost",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[(instance + 1) % seeds.length];
      return {
        prompt: `${target.name} ${LOST_CONTEXTS[instance]}. Record the deal as lost on that CRM contact.`,
        state: world(seeds, []),
        assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "lost" }],
        allowedWrites: [`crm.contacts.${target.id}`],
        oracle: [LIST_CONTACTS, patchContact(target.id, { status: "lost" })],
      };
    },
  },
  {
    slug: "crm-owner",
    band: "single-write",
    label: "reassign one CRM account",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[instance % seeds.length];
      const owner = NEW_OWNERS[instance];
      return {
        prompt: `The account for ${target.name} moves to rep ${owner}. Update the CRM owner for that contact.`,
        state: world(seeds, []),
        assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.owner`, equals: owner }],
        allowedWrites: [`crm.contacts.${target.id}`],
        oracle: [LIST_CONTACTS, patchContact(target.id, { owner })],
      };
    },
  },
  {
    slug: "crm-rename",
    band: "single-write",
    label: "correct a CRM display name",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[(instance + 2) % seeds.length];
      const [first, ...rest] = target.name.split(" ");
      const legalName = `${first} ${MIDDLE_INITIALS[instance]}. ${rest.join(" ")}`;
      return {
        prompt: `The signed contract lists the legal name ${legalName} for the contact recorded as ${target.name}. Correct that CRM contact's name to the legal name exactly.`,
        state: world(seeds, []),
        assertions: [{ kind: "equals", path: `crm.contacts.${target.id}.name`, equals: legalName }],
        allowedWrites: [`crm.contacts.${target.id}`],
        oracle: [LIST_CONTACTS, patchContact(target.id, { name: legalName })],
      };
    },
  },
  {
    slug: "mail-draft",
    band: "discovery",
    label: "draft mail to a contact found in CRM",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[(instance + 3) % seeds.length];
      const subject = SUBJECTS[instance];
      return {
        prompt: `Prepare an email to ${target.name} with the subject "${subject}". Do not send it \u2014 leave it as a draft. Their address is in the CRM record.`,
        state: world(seeds, []),
        assertions: [{ kind: "exists", collection: "mail.drafts", match: { to: target.email, subject, status: "draft" } }],
        allowedWrites: ["mail.drafts", "mail.sequence"],
        oracle: [LIST_CONTACTS, createDraft({ to: target.email, subject })],
      };
    },
  },
  {
    slug: "mail-revise",
    band: "discovery",
    label: "retitle one draft among several",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const owner = seeds[instance % seeds.length];
      const other = seeds[(instance + 1) % seeds.length];
      const oldSubject = SUBJECTS[instance];
      const newSubject = REVISED_SUBJECTS[instance];
      const targetFirst = instance % 2 === 0;
      const drafts: DraftSeed[] = targetFirst
        ? [{ to: owner.email, subject: oldSubject }, { to: other.email, subject: STALE_SUBJECTS[instance] }]
        : [{ to: other.email, subject: STALE_SUBJECTS[instance] }, { to: owner.email, subject: oldSubject }];
      const targetDraftId = targetFirst ? "d-1" : "d-2";
      return {
        prompt: `The draft titled "${oldSubject}" should be retitled "${newSubject}". Change only that draft and leave every other draft untouched.`,
        state: world(seeds, drafts),
        assertions: [{ kind: "equals", path: `mail.drafts.${targetDraftId}.subject`, equals: newSubject }],
        allowedWrites: [`mail.drafts.${targetDraftId}`],
        oracle: [LIST_DRAFTS, patchDraft(targetDraftId, { subject: newSubject })],
      };
    },
  },
  {
    slug: "mail-discard",
    band: "discovery",
    label: "discard the obsolete draft only",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const owner = seeds[(instance + 1) % seeds.length];
      const other = seeds[(instance + 2) % seeds.length];
      const staleSubject = STALE_SUBJECTS[instance];
      const targetFirst = instance % 2 === 1;
      const drafts: DraftSeed[] = targetFirst
        ? [{ to: owner.email, subject: staleSubject }, { to: other.email, subject: SUBJECTS[instance] }]
        : [{ to: other.email, subject: SUBJECTS[instance] }, { to: owner.email, subject: staleSubject }];
      const targetDraftId = targetFirst ? "d-1" : "d-2";
      return {
        prompt: `The draft titled "${staleSubject}" is obsolete. Mark that draft discarded. Do not modify or send any other draft.`,
        state: world(seeds, drafts),
        assertions: [{ kind: "equals", path: `mail.drafts.${targetDraftId}.status`, equals: "discarded" }],
        allowedWrites: [`mail.drafts.${targetDraftId}`],
        oracle: [LIST_DRAFTS, patchDraft(targetDraftId, { status: "discarded" })],
      };
    },
  },
  {
    slug: "mail-send",
    band: "discovery",
    label: "send the approved draft",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const recipient = seeds[(instance + 2) % seeds.length];
      const other = seeds[(instance + 3) % seeds.length];
      const subject = SUBJECTS[instance];
      const targetFirst = instance % 2 === 0;
      const drafts: DraftSeed[] = targetFirst
        ? [{ to: recipient.email, subject }, { to: other.email, subject: STALE_SUBJECTS[instance] }]
        : [{ to: other.email, subject: STALE_SUBJECTS[instance] }, { to: recipient.email, subject }];
      const targetDraftId = targetFirst ? "d-1" : "d-2";
      return {
        prompt: `The draft titled "${subject}" is approved. Deliver it. Leave the other draft alone.`,
        state: world(seeds, drafts),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: recipient.email, subject, sent: true } },
          { kind: "absent", collection: "mail.drafts", match: { subject } },
        ],
        allowedWrites: ["mail.messages", "mail.sequence", `mail.drafts.${targetDraftId}`],
        oracle: [LIST_DRAFTS, sendDraft(targetDraftId)],
      };
    },
  },
  {
    slug: "crm-bulk-owner",
    band: "multi-write",
    label: "reassign every account of a departing rep",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, ["u-1", "u-3", "u-2", "u-3"]);
      const owner = NEW_OWNERS[instance];
      const targets = seeds.filter((seed) => seed.owner === "u-3");
      return {
        prompt: `Rep u-3 has left. Reassign every CRM contact currently owned by u-3 to rep ${owner}. Leave contacts owned by anyone else unchanged.`,
        state: world(seeds, []),
        assertions: targets.map((target) => ({ kind: "equals", path: `crm.contacts.${target.id}.owner`, equals: owner }) as Assertion),
        allowedWrites: targets.map((target) => `crm.contacts.${target.id}`),
        oracle: [LIST_CONTACTS, ...targets.map((target) => patchContact(target.id, { owner }))],
      };
    },
  },
  {
    slug: "crm-disambiguate",
    band: "multi-write",
    label: "pick the right contact when first names collide",
    build: (instance, offset) => {
      const pair = NAME_COLLISIONS[instance];
      const filler = contactSeeds(offset, ["u-1", "u-2"]);
      const seeds: ContactSeed[] = [
        { id: "c-1", name: pair.decoy.name, email: pair.decoy.email, status: "open", owner: "u-1" },
        { id: "c-2", name: filler[0].name, email: filler[0].email, status: "open", owner: "u-2" },
        { id: "c-3", name: pair.target.name, email: pair.target.email, status: "open", owner: "u-3" },
        { id: "c-4", name: filler[1].name, email: filler[1].email, status: "open", owner: "u-1" },
      ];
      const outcome = instance % 2 === 0 ? "won" : "lost";
      return {
        prompt: `${pair.target.name} ${outcome === "won" ? CLOSE_CONTEXTS[instance] : LOST_CONTEXTS[instance]}. Record the deal as ${outcome} on that contact only \u2014 another contact shares the same first name, and touching the wrong record is a failure.`,
        state: world(seeds, []),
        assertions: [{ kind: "equals", path: "crm.contacts.c-3.status", equals: outcome }],
        allowedWrites: ["crm.contacts.c-3"],
        oracle: [LIST_CONTACTS, patchContact("c-3", { status: outcome })],
      };
    },
  },
  {
    slug: "crm-mail-churn",
    band: "multi-write",
    label: "record a loss and draft the follow-up",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[(instance + 1) % seeds.length];
      const subject = REVISED_SUBJECTS[instance];
      return {
        prompt: `${target.name} ${LOST_CONTEXTS[instance]}. Record the deal as lost on that CRM contact and prepare an email to them with the subject "${subject}". Do not send the email.`,
        state: world(seeds, []),
        assertions: [
          { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "lost" },
          { kind: "exists", collection: "mail.drafts", match: { to: target.email, subject, status: "draft" } },
        ],
        allowedWrites: [`crm.contacts.${target.id}`, "mail.drafts", "mail.sequence"],
        oracle: [LIST_CONTACTS, patchContact(target.id, { status: "lost" }), createDraft({ to: target.email, subject })],
      };
    },
  },
  {
    slug: "mail-send-and-close",
    band: "multi-write",
    label: "deliver the quote and close the deal",
    build: (instance, offset) => {
      const seeds = contactSeeds(offset, DEFAULT_OWNERS);
      const target = seeds[(instance + 3) % seeds.length];
      const other = seeds[instance % seeds.length];
      const subject = SUBJECTS[(instance + 2) % SUBJECTS.length];
      const targetFirst = instance % 2 === 1;
      const drafts: DraftSeed[] = targetFirst
        ? [{ to: target.email, subject }, { to: other.email, subject: STALE_SUBJECTS[instance] }]
        : [{ to: other.email, subject: STALE_SUBJECTS[instance] }, { to: target.email, subject }];
      const targetDraftId = targetFirst ? "d-1" : "d-2";
      return {
        prompt: `${target.name} ${CLOSE_CONTEXTS[instance]}. Deliver the draft titled "${subject}" and record the deal as won on their CRM contact.`,
        state: world(seeds, drafts),
        assertions: [
          { kind: "exists", collection: "mail.messages", match: { to: target.email, subject, sent: true } },
          { kind: "absent", collection: "mail.drafts", match: { subject } },
          { kind: "equals", path: `crm.contacts.${target.id}.status`, equals: "won" },
        ],
        allowedWrites: [`crm.contacts.${target.id}`, "mail.messages", "mail.sequence", `mail.drafts.${targetDraftId}`],
        oracle: [LIST_DRAFTS, sendDraft(targetDraftId), LIST_CONTACTS, patchContact(target.id, { status: "won" })],
      };
    },
  },
];

const INSTANCES_PER_FAMILY = 6;

/**
 * Split assignment is positional, not hashed: instances 1-4 of every family are
 * train, instance 5 is dev, instance 6 is holdout. Family-stratified rather
 * than family-held-out, so dev/holdout measure generalization to unseen
 * entities and parameters within a known skill.
 */
const SPLIT_BY_INSTANCE: Split[] = ["train", "train", "train", "train", "dev", "holdout"];

/**
 * The frozen synthetic subset: 12 families x 6 instances = 72 tasks under the
 * seed-7 split boundary (train 48 / dev 12 / holdout 12). Generated by pure,
 * index-driven construction — no RNG, no wall clock, no I/O — so the fixture
 * hash is a function of this source file alone.
 */
export const TASKS: Task[] = buildTasks();

function buildTasks(): Task[] {
  const tasks: Task[] = [];
  FAMILIES.forEach((family, familyIndex) => {
    for (let instance = 0; instance < INSTANCES_PER_FAMILY; instance += 1) {
      const offset = (familyIndex * 7 + instance * 5) % PERSONAS.length;
      const authored = family.build(instance, offset);
      tasks.push({
        taskId: `simple-api-${family.slug}-${String(instance + 1).padStart(2, "0")}`,
        split: SPLIT_BY_INSTANCE[instance],
        prompt: authored.prompt,
        initialState: authored.state,
        assertions: authored.assertions,
        allowedWrites: authored.allowedWrites,
        oracle: authored.oracle,
      });
    }
  });
  return tasks;
}

/** Family slug -> difficulty band, for reporting a per-band breakdown of a run. */
export function taskBands(): Record<string, Family["band"]> {
  return Object.fromEntries(FAMILIES.map((family) => [family.slug, family.band]));
}

/** Return the difficulty band for one task from the fixture's family metadata. */
export function taskBand(taskId: string): Family["band"] {
  const slug = taskId.replace(/^simple-api-/, "").replace(/-\d{2}$/, "");
  const band = taskBands()[slug];
  if (!band) throw new Error(`unknown task family for ${taskId}`);
  return band;
}

/** Task counts per split, computed from the fixture rather than hard-coded. */
export function splitCounts(): Record<Split, number> {
  return TASKS.reduce(
    (counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }),
    { train: 0, dev: 0, holdout: 0 } as Record<Split, number>,
  );
}

export function getTask(taskId: string): Task {
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  return task;
}

// ---------------------------------------------------------------------------
// Hashing / schema checks
// ---------------------------------------------------------------------------

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Content hash of the whole frozen fixture (tasks, tool catalog, endpoint catalog). */
export function fixtureSha256(): string {
  return sha256({ tasks: TASKS, tools: TOOL_CATALOG, endpoints: ENDPOINTS, pin: AUTOMATIONBENCH_SUBSET });
}

/** Content hash of one split's task ids + assertions — the frozen-split contract. */
export function splitSha256(split: Split): string {
  return sha256(TASKS.filter((task) => task.split === split).map((task) => ({ task_id: task.taskId, assertions: task.assertions })));
}

// ---------------------------------------------------------------------------
// Environment: reset / step / reward
// ---------------------------------------------------------------------------

/**
 * Deterministic reset. `seed` must equal RESET_SEED: this subset's seed IS the
 * pinned `initial_state` (upstream has no RNG seed either), so accepting an
 * arbitrary seed would silently produce an unpinned world. No wall-clock
 * timestamp or generated id is stamped here — the verified upstream
 * nondeterminism (a construction-time `gmail.internal_date`) is designed out.
 */
export function reset(taskId: string, seed: number = RESET_SEED): { handle: EnvHandle; obs: Observation } {
  if (seed !== RESET_SEED) throw new Error(`reset refused: seed ${seed} is not the pinned seed ${RESET_SEED}`);
  const task = getTask(taskId);
  const handle: EnvHandle = {
    taskId,
    seed,
    state: JSON.parse(JSON.stringify(task.initialState)) as WorldState,
    step: 0,
    done: false,
    forbiddenEffects: [],
    messages: [
      { role: "system", content: "You operate business apps through api_search and api_fetch. Make the smallest change that satisfies the request." },
      { role: "user", content: task.prompt },
    ],
  };
  return { handle, obs: observe(handle) };
}

function observe(handle: EnvHandle): Observation {
  return {
    task_id: handle.taskId,
    seed: handle.seed,
    step: handle.step,
    messages: handle.messages.map((message) => ({ ...message })),
    tools: TOOL_CATALOG.map((tool) => ({ ...tool })),
  };
}

function readPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), state);
}

function recordWrite(handle: EnvHandle, path: string): void {
  const task = getTask(handle.taskId);
  if (!task.allowedWrites.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) handle.forbiddenEffects.push(path);
}

/**
 * Apply ONE tool call. In-memory synthetic state only — there is no network
 * client, no provider client, and no filesystem write on this path.
 * Reward is terminal: every non-final step returns 0.
 */
export function step(handle: EnvHandle, action: ToolCall): StepResult {
  if (handle.done) throw new Error("step called after the episode terminated");
  handle.step += 1;

  let content: string;
  if (action.name === "api_search") {
    const query = String(action.arguments.query ?? "").toLowerCase();
    const matches = ENDPOINTS.filter((endpoint) => query.split(/\s+/).some((token) => token.length > 2 && (endpoint.url.includes(token) || endpoint.summary.toLowerCase().includes(token))));
    content = canonicalJson({ results: matches.length > 0 ? matches : ENDPOINTS });
  } else if (action.name === "api_fetch") {
    content = canonicalJson(apiFetch(handle, action.arguments));
  } else {
    content = canonicalJson({ error: `unknown tool: ${action.name}` });
  }
  handle.messages.push({ role: "tool", content });

  const done = handle.step >= MAX_STEPS;
  if (done) handle.done = true;
  return { obs: observe(handle), reward: done ? partialCredit(handle) : 0, done, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

function apiFetch(handle: EnvHandle, args: Record<string, unknown>): Record<string, unknown> {
  const method = String(args.method ?? "GET").toUpperCase();
  const url = String(args.url ?? "");
  const body = (args.body && typeof args.body === "object" ? (args.body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const state = handle.state;

  if (url === "/crm/contacts" && method === "GET") {
    return { status: 200, contacts: { ...state.crm.contacts } };
  }

  const contactMatch = /^\/crm\/contacts\/([\w-]+)$/.exec(url);
  if (contactMatch) {
    const id = contactMatch[1];
    const contact = state.crm.contacts[id];
    if (!contact) return { status: 404, error: "contact not found" };
    if (method === "GET") return { status: 200, contact: { ...contact } };
    if (method === "PATCH") {
      for (const key of ["status", "owner", "name"] as const) {
        if (typeof body[key] === "string") {
          recordWrite(handle, `crm.contacts.${id}`);
          contact[key] = body[key] as string;
        }
      }
      return { status: 200, contact: { ...contact } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/mail/drafts") {
    if (method === "GET") return { status: 200, drafts: { ...state.mail.drafts } };
    if (method === "POST") {
      state.mail.sequence += 1;
      const id = `d-${state.mail.sequence}`;
      recordWrite(handle, "mail.sequence");
      recordWrite(handle, `mail.drafts.${id}`);
      state.mail.drafts[id] = { to: String(body.to ?? ""), subject: String(body.subject ?? ""), status: "draft" };
      return { status: 201, draft_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  const draftMatch = /^\/mail\/drafts\/([\w-]+)$/.exec(url);
  if (draftMatch) {
    const id = draftMatch[1];
    const draft = state.mail.drafts[id];
    if (!draft) return { status: 404, error: "draft not found" };
    if (method === "GET") return { status: 200, draft: { ...draft } };
    if (method === "PATCH") {
      for (const key of ["to", "subject", "status"] as const) {
        if (typeof body[key] === "string") {
          recordWrite(handle, `mail.drafts.${id}`);
          draft[key] = body[key] as string;
        }
      }
      return { status: 200, draft: { ...draft } };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  if (url === "/mail/messages") {
    if (method === "GET") return { status: 200, messages: { ...state.mail.messages } };
    if (method === "POST") {
      const draftId = String(body.draft_id ?? "");
      const draft = state.mail.drafts[draftId];
      if (!draft) return { status: 404, error: "draft not found" };
      state.mail.sequence += 1;
      const id = `m-${state.mail.sequence}`;
      recordWrite(handle, "mail.sequence");
      recordWrite(handle, `mail.messages.${id}`);
      recordWrite(handle, `mail.drafts.${draftId}`);
      state.mail.messages[id] = { to: draft.to, subject: draft.subject, sent: true };
      delete state.mail.drafts[draftId];
      return { status: 201, message_id: id };
    }
    return { status: 405, error: `method not allowed: ${method}` };
  }

  return { status: 404, error: `unknown endpoint: ${url}` };
}

/** End the episode early (the policy declares it is finished) and take the terminal reward. */
export function finish(handle: EnvHandle): StepResult {
  handle.done = true;
  return { obs: observe(handle), reward: partialCredit(handle), done: true, info: { forbidden_effects: [...handle.forbiddenEffects] } };
}

/**
 * Terminal fractional final-state reward.
 *
 * Anti-free-credit: assertions already satisfied by `initial_state` are
 * excluded from both numerator and denominator, so a do-nothing policy cannot
 * bank pre-satisfied state. Preservation: any write outside the task's allowed
 * paths zeroes the reward — the reward-hacking sentinel rides on this rule.
 */
export function partialCredit(handle: EnvHandle): number {
  const task = getTask(handle.taskId);
  if (handle.forbiddenEffects.length > 0) return 0;
  const earned = task.assertions.filter((assertion) => !assertionSatisfied(task.initialState, assertion));
  if (earned.length === 0) return 0;
  const satisfied = earned.filter((assertion) => assertionSatisfied(handle.state, assertion));
  return satisfied.length / earned.length;
}

function matchesEntry(entry: unknown, match: Record<string, unknown>): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return Object.entries(match).every(([key, value]) => canonicalJson(record[key]) === canonicalJson(value));
}

/** Evaluate one final-state assertion against a world. Pure and total: it never throws. */
export function assertionSatisfied(state: WorldState, assertion: Assertion): boolean {
  if (assertion.kind === "equals") return canonicalJson(readPath(state, assertion.path)) === canonicalJson(assertion.equals);
  const collection = readPath(state, assertion.collection);
  const entries = collection && typeof collection === "object" ? Object.values(collection as Record<string, unknown>) : [];
  const present = entries.some((entry) => matchesEntry(entry, assertion.match));
  return assertion.kind === "exists" ? present : !present;
}

/** The dotted state path an assertion reads — the string that must never surface in an observation. */
export function assertionPath(assertion: Assertion): string {
  return assertion.kind === "equals" ? assertion.path : assertion.collection;
}

// ---------------------------------------------------------------------------
// Parser compatibility
// ---------------------------------------------------------------------------

/**
 * Parse actions out of a recorded assistant message. Real AutomationBench
 * exports store each `tool_calls` entry as a JSON-encoded STRING whose
 * `arguments` is itself a JSON string, so both encodings must double-decode;
 * plain object entries (OpenAI-style or flat) are accepted unchanged.
 */
export function parseToolCalls(message: unknown): ToolCall[] {
  const raw = (message && typeof message === "object" ? (message as Record<string, unknown>).tool_calls : undefined) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (!decoded || typeof decoded !== "object") throw new Error("tool call must decode to an object");
    const record = decoded as Record<string, unknown>;
    const fn = (record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record) as Record<string, unknown>;
    const name = String(fn.name ?? record.name ?? "");
    if (!name) throw new Error("tool call is missing a name");
    const rawArgs = fn.arguments ?? record.arguments ?? {};
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`tool call ${name} has non-object arguments`);
    return { name, arguments: args as Record<string, unknown> };
  });
}

// ---------------------------------------------------------------------------
// Label-leakage audit
// ---------------------------------------------------------------------------

const LEAK_KEYS = ["assertions", "gold", "allowed_writes", "allowedWrites", "oracle", "initial_state", "reward", "score", "collection", "equals"];

/**
 * Audit one observation for label leakage: no grader-side key may appear, and
 * no assertion path or expected value may be readable from the observation.
 * Returns human-readable findings; empty means clean.
 */
export function auditObservationLeakage(obs: Observation, task: Task): string[] {
  const serialized = canonicalJson(obs);
  const findings: string[] = [];
  for (const key of LEAK_KEYS) {
    if (serialized.includes(`"${key}"`)) findings.push(`observation exposes grader key: ${key}`);
  }
  for (const assertion of task.assertions) {
    const path = assertionPath(assertion);
    if (serialized.includes(path)) findings.push(`observation exposes assertion path: ${path}`);
  }
  for (const write of task.allowedWrites) {
    if (serialized.includes(write)) findings.push(`observation exposes allowed-write path: ${write}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Policies: scripted oracle + reward-hacking sentinel
// ---------------------------------------------------------------------------

export type Policy = (obs: Observation) => ToolCall | null;

/** Scripted oracle: replays the task's recorded gold action sequence, then finishes. */
export function oraclePolicy(taskId: string): Policy {
  const script = getTask(taskId).oracle;
  return (obs) => script[obs.step] ?? null;
}

/**
 * Reward-hacking sentinel: maximal activity, zero real progress — search spam
 * plus a write to an out-of-scope record. It must score 0. If a change ever
 * lets this policy score above 0, the reward is hackable and the gate fails.
 */
export function sentinelPolicy(): Policy {
  return (obs) => {
    if (obs.step < 3) return { name: "api_search", arguments: { query: "crm mail endpoints" } };
    // The guard contact exists in every world and is writable by no task, so
    // this write is a forbidden effect regardless of which task is running.
    if (obs.step === 3) return { name: "api_fetch", arguments: { method: "PATCH", url: `/crm/contacts/${GUARD_CONTACT.id}`, body: { name: "sentinel" } } };
    return null;
  };
}

export type Rollout = { taskId: string; split: Split; reward: number; steps: number; forbiddenEffects: string[]; leakage: string[] };

/** Drive one episode with a scripted (never model-backed) policy and take the terminal reward. */
export function rollout(taskId: string, policy: Policy): Rollout {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const leakage = auditObservationLeakage(initial, task);
  let obs = initial;
  for (let i = 0; i < MAX_STEPS; i += 1) {
    const action = policy(obs);
    if (!action) break;
    const result = step(handle, action);
    obs = result.obs;
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: partialCredit(handle) } : finish(handle);
  return { taskId, split: task.split, reward: terminal.reward, steps: handle.step, forbiddenEffects: [...handle.forbiddenEffects], leakage };
}

// ---------------------------------------------------------------------------
// Frozen-holdout refusal
// ---------------------------------------------------------------------------

export type PoolOptions = {
  split: Split;
  /** Required to read the frozen holdout: must equal splitSha256("holdout"). */
  frozenHoldoutSha256?: string;
};

/**
 * Build a task pool for a split. The frozen holdout is refused unless the
 * caller passes its exact hash — an accidental holdout read, or a holdout
 * whose contents drifted from the frozen contract, both fail closed.
 */
export function taskPool(options: PoolOptions): Task[] {
  if (options.split === "holdout") {
    const expected = splitSha256("holdout");
    if (!options.frozenHoldoutSha256) throw new Error("frozen-holdout refusal: reading the holdout requires frozenHoldoutSha256");
    if (options.frozenHoldoutSha256 !== expected) throw new Error(`frozen-holdout refusal: holdout hash mismatch (expected ${expected})`);
  }
  return TASKS.filter((task) => task.split === options.split);
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export type EvalRow = Record<string, unknown>;

export type EvaluateOptions = PoolOptions & { runId: string; policy: (taskId: string) => Policy; model?: string | null };

/** Run every task in a split with a scripted policy and emit understudy.eval_result.v1 rows. */
export function evaluateSplit(options: EvaluateOptions): EvalRow[] {
  const pool = taskPool(options);
  const harnessSha = fixtureSha256();
  const splitSha = splitSha256(options.split);
  return pool.map((task) => {
    const result = rollout(task.taskId, options.policy(task.taskId));
    return {
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: task.taskId,
      split: task.split,
      score: result.reward,
      status: "ok",
      model: options.model ?? null,
      route: "local-offline-sim",
      cost: { usd: 0, basis: "local-zero-marginal-cost" },
      benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
      subscores: { forbidden_effects: result.forbiddenEffects.length, steps: result.steps },
      provenance: { harness_sha256: harnessSha, split_sha256: splitSha, artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`] },
    };
  });
}

const REQUIRED_ROW_FIELDS = ["schema_version", "run_id", "task_id", "status"];

/** Structural check of eval_result.v1 required fields + score range (same no-dependency style as the rest of the repo). */
export function validateEvalRows(rows: EvalRow[]): string[] {
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    for (const field of REQUIRED_ROW_FIELDS) {
      if (typeof row[field] !== "string" || (row[field] as string).length === 0) errors.push(`rows[${index}].${field} is required`);
    }
    if (row.schema_version !== "understudy.eval_result.v1") errors.push(`rows[${index}].schema_version must be understudy.eval_result.v1`);
    const score = row.score;
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) errors.push(`rows[${index}].score must be null or within 0..1`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Importer (benchmark.v1 manifest + verifiers.v1 package descriptor)
// ---------------------------------------------------------------------------

/** Native AutomationBench export shape: `{meta: {model, ...}, tasks: [{name, passed, score}]}`. */
export type NativeExport = { meta?: Record<string, unknown>; tasks?: unknown[] };

/**
 * The verifiers.v1 packaging descriptor. Concepts only — a Taskset of Tasks
 * with seeded setup and one terminal `@vf.reward` pinned to the LOCAL scorer,
 * so remote_reward == local_reward by construction. Emitting the descriptor is
 * deliberately not the same as shipping a runnable partner package: nothing
 * here imports, installs, or executes verifiers.
 */
export function verifiersPackageDescriptor(): Record<string, unknown> {
  return {
    format: "verifiers.v1",
    verifiers_version_pin: AUTOMATIONBENCH_SUBSET.verifiers_version_pin,
    taskset: { id: AUTOMATIONBENCH_SUBSET.benchmark_id, task_ids: TASKS.filter((task) => task.split !== "holdout").map((task) => task.taskId) },
    task: { setup: "reset(task_id, seed=7) — pinned initial_state, no wall clock, no RNG", tools: TOOL_CATALOG.map((tool) => tool.name) },
    reward: { kind: "terminal", fn: "partial_credit", shaping: null, scorer_ref: "src/automationbench-offline.ts#partialCredit" },
    executable: false,
    executable_reason: "descriptor only — this repo does not install, upload to, or run a hosted trainer",
  };
}

export type ImportOptions = {
  runId: string;
  /** Optional native AutomationBench export to project onto eval rows. */
  nativeExport?: NativeExport;
  model?: string | null;
  /** Required to import holdout rows; frozen-holdout refusal otherwise. */
  frozenHoldoutSha256?: string;
};

export type ImportResult = { manifest: Record<string, unknown>; rows: EvalRow[]; manifestErrors: string[]; rowErrors: string[] };

/**
 * Build the understudy.benchmark.v1 manifest for the pinned subset and, when a
 * native export is supplied, project its task results onto eval_result.v1 rows.
 * Rows for holdout tasks are refused unless the frozen holdout hash is passed.
 */
export function importSubset(options: ImportOptions): ImportResult {
  const counts = splitCounts();
  const manifest: Record<string, unknown> = {
    schema_version: "understudy.benchmark.v1",
    benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
    name: "AutomationBench simple/api (offline synthetic subset)",
    description: "Local, synthetic, offline re-implementation of the AutomationBench simple/api subset: 12 task families x 6 instances across three difficulty bands. No upstream dataset, no provider calls.",
    provenance: {
      origin: "imported",
      source_refs: [],
      imported_from: { format: "automationbench", ref: AUTOMATIONBENCH_SUBSET.source_ref, version: AUTOMATIONBENCH_SUBSET.subset, license: null },
    },
    taxonomy: [{ category_id: "simple-api", name: "simple difficulty / api tool surface", difficulty: "simple", derived_from: null }],
    tasks: TASKS.map((task) => ({
      task_id: task.taskId,
      category_id: "simple-api",
      seed: RESET_SEED,
      genesis: "synthesized",
      generator_ref: `fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`,
      split: task.split,
      gold: { kind: "final-state", ref: `env://${AUTOMATIONBENCH_SUBSET.benchmark_id}/gold/${task.taskId}` },
    })),
    environment: {
      format: "verifiers.v1",
      package_ref: `descriptor://${AUTOMATIONBENCH_SUBSET.benchmark_id}`,
      package_sha256: fixtureSha256(),
      tool_surface: TOOL_CATALOG.map((tool) => tool.name),
      runtime: "in-process",
      verifiers_version_pin: AUTOMATIONBENCH_SUBSET.verifiers_version_pin,
      package_descriptor: verifiersPackageDescriptor(),
    },
    verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "partial_credit", replayable: true },
    splits: {
      boundary: `seed-${RESET_SEED}: train ${counts.train} / dev ${counts.dev} / holdout ${counts.holdout} (synthetic sample — do not read as an upstream AutomationBench result)`,
      splits_sha256: sha256({ train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") }),
      contamination: "none",
    },
    linked_eval: null,
    results_contract: { row_schema: "understudy.eval_result.v1", trace_artifact: null, branch_projection: "one row per task" },
  };

  const rows: EvalRow[] = [];
  for (const entry of options.nativeExport?.tasks ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    // The stable task id lives in `name`; `id` is only a 1-based enumeration index.
    const taskId = String(record.name ?? record.task_id ?? "");
    const task = TASKS.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`import refused: export row references unknown task_id ${taskId || "(missing)"}`);
    if (task.split === "holdout") {
      const expected = splitSha256("holdout");
      if (options.frozenHoldoutSha256 !== expected) throw new Error("frozen-holdout refusal: importing holdout rows requires the matching frozenHoldoutSha256");
    }
    const score = typeof record.score === "number" ? record.score : record.passed === true ? 1 : 0;
    rows.push({
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: taskId,
      split: task.split,
      score: Math.min(Math.max(score, 0), 1),
      status: "ok",
      model: options.model ?? (typeof options.nativeExport?.meta?.model === "string" ? (options.nativeExport?.meta?.model as string) : null),
      route: "imported",
      benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
      provenance: { harness_sha256: fixtureSha256(), split_sha256: splitSha256(task.split), artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`] },
    });
  }

  return { manifest, rows, manifestErrors: validateBenchmarkManifest(manifest), rowErrors: validateEvalRows(rows) };
}
