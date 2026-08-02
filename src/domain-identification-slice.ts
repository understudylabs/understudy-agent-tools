/**
 * domain-identification-slice — a sanitized synthetic benchmark slice shaped
 * like the "domain-identification" workload: read an inbound record, identify
 * which account is registered to exactly the requester's email domain among a
 * pool of near-matches, and emit ONE bounded write (or the explicit no-match
 * outcome when nothing matches).
 *
 * Why a scoped slice rather than more v2 tasks: the workload's repair case is
 * identification under near-miss pressure with a bounded output, not the
 * long-chain multi-write shape v2 is built to stress. Its telemetry profile
 * (see `docs/domain-identification-repair.md`) is short, tightly clustered
 * completions with one addressed effect per request, so the slice keeps each
 * episode to at most one write and grades the terminal state only.
 *
 * Every task is authored here by pure, index-driven construction — no RNG, no
 * wall clock, no I/O, no customer data. Tasks register with the v1 environment
 * (`src/automationbench-offline.ts`) exactly like the v2 hard families, so the
 * reward, the anti-free-credit rule, the forbidden-effect rule, and the
 * frozen-holdout refusal are the same code and the same gates:
 * oracle == 1.0, sentinel == 0.0, no label leakage, reachability, determinism.
 *
 * Bands (reporting only; scoring never reads them):
 *   - direct-match:  exactly one account carries the requester's domain;
 *   - near-match:    sibling, subdomain, and different-TLD lookalikes compete;
 *   - parent-join:   the matched account defers to the parent domain's owner;
 *   - abstain:       no account matches, so the only correct act is the
 *                    explicit no-match outcome — writing a guessed owner is a
 *                    scored miss rather than a rounding blip.
 */

import {
  AUTOMATIONBENCH_SUBSET,
  GUARD_CONTACT,
  LIST_CONTACTS,
  LIST_TICKETS,
  RESET_SEED,
  canonicalJson,
  patchTicket,
  registerTasks,
  sha256,
  supportWorld,
} from "./automationbench-offline.js";
import type {
  Assertion,
  ContactSeed,
  Split,
  Task,
  TicketSeed,
  ToolCall,
  WorldState,
} from "./automationbench-offline.js";

export const DOMAIN_IDENTIFICATION_SLICE = {
  fixture_id: "domain-identification-offline-v1",
  benchmark_id: "domain-identification-offline-v1",
  /** The slice reuses the v1 environment, seed, and verifiers pin; only the task pool is new. */
  base_fixture_id: AUTOMATIONBENCH_SUBSET.fixture_id,
  split_seed: AUTOMATIONBENCH_SUBSET.split_seed,
} as const;

/** One discovery read, one listing read, one bounded write — plus slack for a retry. */
const SLICE_MAX_STEPS = 10;

const INSTANCES = 12;

/** 6 train / 2 dev / 4 holdout, positional, so every family is in every split. */
const SPLIT_BY_INSTANCE: Split[] = [
  "train", "train", "train", "train", "train", "train",
  "dev", "dev",
  "holdout", "holdout", "holdout", "holdout",
];

// ---------------------------------------------------------------------------
// Instance parameter tables (12 wide — no RNG, no wall clock)
// ---------------------------------------------------------------------------

/** Invented organisation labels. Every address below stays inside the test TLDs. */
const ORGS = [
  "northwind",
  "blueharbor",
  "ironpine",
  "silverlake",
  "greenfield",
  "stonebridge",
  "whitecliff",
  "amberfield",
  "brightpath",
  "clearwater",
  "foxglove",
  "redstone",
] as const;

const REQUESTER_LOCALS = [
  "casey", "morgan", "riley", "jordan", "avery", "quinn",
  "harper", "rowan", "sasha", "devon", "noor", "kai",
] as const;

const TICKET_SUBJECTS = [
  "Inbound request unrouted",
  "Access review pending",
  "Billing contact unknown",
  "Renewal question unassigned",
  "Integration request open",
  "Onboarding question open",
  "Escalation needs an owner",
  "Data export request open",
  "Seat change request open",
  "Security questionnaire open",
  "Invoice query unassigned",
  "Migration question open",
] as const;

const DECOY_SUBJECTS = [
  "Inbound request already routed",
  "Access review completed",
  "Billing contact confirmed",
  "Renewal question answered",
  "Integration request closed",
  "Onboarding question resolved",
  "Escalation already owned",
  "Data export delivered",
  "Seat change applied",
  "Security questionnaire returned",
  "Invoice query settled",
  "Migration question answered",
] as const;

const REPS = ["u-1", "u-2", "u-3", "u-4", "u-5"] as const;

const org = (index: number): string => ORGS[index % ORGS.length];
const rep = (index: number): string => REPS[index % REPS.length];
const primaryDomain = (index: number): string => `${org(index)}.example.com`;
const requester = (index: number, domain: string): string =>
  `${REQUESTER_LOCALS[index % REQUESTER_LOCALS.length]}@${domain}`;

/** An account record is a CRM contact whose address is the domain's operations mailbox. */
function account(
  id: string,
  domain: string,
  owner: string,
  status = "account",
): ContactSeed {
  return { id, name: `${domain} operations`, email: `ops@${domain}`, status, owner };
}

function ticket(
  id: string,
  subject: string,
  requesterEmail: string,
  assignee: string,
  status = "open",
  priority = "normal",
): TicketSeed {
  return { id, subject, requester: requesterEmail, status, assignee, priority };
}

/**
 * Unrelated accounts appended AFTER the addressed records so the listing a
 * policy must read through stays a dozen rows wide while target ids hold still.
 */
function padAccounts(seeds: ContactSeed[], instance: number, extra: number): ContactSeed[] {
  const padded = [...seeds];
  for (let index = 0; index < extra; index += 1) {
    const domain = `${org(instance + seeds.length + index + 4)}.example.org`;
    padded.push(account(`c-${padded.length + 1}`, domain, rep(index + 3)));
  }
  return padded;
}

/** Decoy tickets appended after the addressed ticket; they are already routed. */
function padTickets(tickets: TicketSeed[], pool: ContactSeed[], instance: number, extra: number): TicketSeed[] {
  const padded = [...tickets];
  const statuses = ["in_progress", "resolved", "closed"];
  for (let index = 0; index < extra; index += 1) {
    const who = pool[(pool.length - 1 - index + pool.length) % pool.length];
    padded.push(ticket(
      `t-${padded.length + 1}`,
      DECOY_SUBJECTS[(instance + index) % INSTANCES],
      who.email,
      who.owner,
      statuses[index % statuses.length],
      index % 2 === 0 ? "normal" : "high",
    ));
  }
  return padded;
}

/** Every family routes the one addressed ticket and nothing else. */
function routeAssertions(assignee: string, status: string): Assertion[] {
  return [
    { kind: "equals", path: "support.tickets.t-2.assignee", equals: assignee },
    { kind: "equals", path: "support.tickets.t-2.status", equals: status },
  ];
}

function routeOracle(assignee: string, status: string): ToolCall[] {
  return [LIST_TICKETS, LIST_CONTACTS, patchTicket("t-2", { assignee, status })];
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

type SliceCase = {
  prompt: string;
  state: WorldState;
  assertions: Assertion[];
  allowedWrites: string[];
  oracle: ToolCall[];
};

type SliceFamily = {
  slug: string;
  /** Reporting-only band; scoring never reads it. */
  band: "direct-match" | "near-match" | "parent-join" | "abstain";
  label: string;
  build: (instance: number) => SliceCase;
};

const ROUTE_INSTRUCTION =
  "Read the address that opened it, take the domain of that address, and find the account registered to exactly that domain.";

const FAMILIES: SliceFamily[] = [
  {
    slug: "direct-route",
    band: "direct-match",
    label: "route an inbound ticket to the owner of the account holding its exact requester domain",
    build: (instance) => {
      const target = primaryDomain(instance);
      const owner = rep(instance);
      const seeds = padAccounts([
        account("c-1", `${org(instance + 1)}.example.com`, rep(instance + 1)),
        account("c-2", target, owner),
        account("c-3", `${org(instance + 2)}.example.com`, rep(instance + 2)),
      ], instance, 5);
      const tickets = padTickets([
        ticket("t-1", DECOY_SUBJECTS[(instance + 5) % INSTANCES], `ops@${org(instance + 1)}.example.com`, rep(instance + 1), "in_progress"),
        ticket("t-2", TICKET_SUBJECTS[instance], requester(instance, target), "unassigned"),
      ], seeds.slice(3), instance, 3);
      return {
        prompt: `The support ticket titled "${TICKET_SUBJECTS[instance]}" has no owner. ${ROUTE_INSTRUCTION} Assign the ticket to the rep who owns that account and move the ticket to in_progress. Every other ticket and every account stays exactly as it is.`,
        state: supportWorld(seeds, [], [], tickets),
        assertions: routeAssertions(owner, "in_progress"),
        allowedWrites: ["support.tickets.t-2"],
        oracle: routeOracle(owner, "in_progress"),
      };
    },
  },
  {
    slug: "lookalike-route",
    band: "near-match",
    label: "reject sibling, subdomain, and different-TLD lookalikes of the requester domain",
    build: (instance) => {
      const label = org(instance + 3);
      const target = `${label}.example.com`;
      const owner = rep(instance + 1);
      const seeds = padAccounts([
        account("c-1", `${label}-labs.example.com`, rep(instance + 2)),
        account("c-2", target, owner),
        account("c-3", `mail.${label}.example.com`, rep(instance + 3)),
        account("c-4", `${label}.example.org`, rep(instance + 4)),
      ], instance, 4);
      const tickets = padTickets([
        ticket("t-1", DECOY_SUBJECTS[(instance + 2) % INSTANCES], `ops@${label}-labs.example.com`, rep(instance + 2), "resolved"),
        ticket("t-2", TICKET_SUBJECTS[(instance + 3) % INSTANCES], requester(instance + 3, target), "unassigned"),
      ], seeds.slice(4), instance, 3);
      return {
        prompt: `The support ticket titled "${TICKET_SUBJECTS[(instance + 3) % INSTANCES]}" has no owner. ${ROUTE_INSTRUCTION} Several accounts have similar-looking domains; only the one whose domain is character-for-character identical counts. Assign the ticket to the rep who owns that account and move the ticket to in_progress. Nothing else changes.`,
        state: supportWorld(seeds, [], [], tickets),
        assertions: routeAssertions(owner, "in_progress"),
        allowedWrites: ["support.tickets.t-2"],
        oracle: routeOracle(owner, "in_progress"),
      };
    },
  },
  {
    slug: "parent-route",
    band: "parent-join",
    label: "follow a matched subsidiary account to the rep who owns its parent domain",
    build: (instance) => {
      const child = `${org(instance + 6)}.example.com`;
      const parent = `${org(instance + 7)}.example.com`;
      const parentOwner = rep(instance + 2);
      const seeds = padAccounts([
        account("c-1", parent, parentOwner),
        account("c-2", child, rep(instance + 4), `subsidiary of ${parent}`),
        account("c-3", `${org(instance + 8)}.example.com`, rep(instance + 3)),
      ], instance, 5);
      const tickets = padTickets([
        ticket("t-1", DECOY_SUBJECTS[(instance + 7) % INSTANCES], `ops@${org(instance + 8)}.example.com`, rep(instance + 3), "closed"),
        ticket("t-2", TICKET_SUBJECTS[(instance + 6) % INSTANCES], requester(instance + 6, child), "unassigned"),
      ], seeds.slice(3), instance, 3);
      return {
        prompt: `The support ticket titled "${TICKET_SUBJECTS[(instance + 6) % INSTANCES]}" has no owner. ${ROUTE_INSTRUCTION} If that account records a parent company, the ticket belongs to the rep who owns the parent's account instead. Assign the ticket to the correct rep and move the ticket to in_progress. Nothing else changes.`,
        state: supportWorld(seeds, [], [], tickets),
        assertions: routeAssertions(parentOwner, "in_progress"),
        allowedWrites: ["support.tickets.t-2"],
        oracle: routeOracle(parentOwner, "in_progress"),
      };
    },
  },
  {
    slug: "unmatched-abstain",
    band: "abstain",
    label: "record the no-match outcome instead of guessing an owner for an unregistered domain",
    build: (instance) => {
      const label = org(instance + 9);
      // The requester's domain is registered nowhere: only its lookalikes are.
      const unregistered = `${label}.example.org`;
      const seeds = padAccounts([
        account("c-1", `${label}.example.com`, rep(instance + 1)),
        account("c-2", `${label}-group.example.com`, rep(instance + 2)),
        account("c-3", `mail.${label}.example.com`, rep(instance + 3)),
      ], instance, 4);
      const tickets = padTickets([
        ticket("t-1", DECOY_SUBJECTS[(instance + 9) % INSTANCES], `ops@${label}.example.com`, rep(instance + 1), "in_progress"),
        ticket("t-2", TICKET_SUBJECTS[(instance + 9) % INSTANCES], requester(instance + 9, unregistered), "pending"),
      ], seeds.slice(3), instance, 3);
      return {
        prompt: `The support ticket titled "${TICKET_SUBJECTS[(instance + 9) % INSTANCES]}" has no owner. ${ROUTE_INSTRUCTION} A domain that merely looks similar is not a match. If no account is registered to that exact domain, set the ticket's assignee to none and its status to unmatched instead of guessing an owner. Change nothing else.`,
        state: supportWorld(seeds, [], [], tickets),
        assertions: routeAssertions("none", "unmatched"),
        allowedWrites: ["support.tickets.t-2"],
        oracle: routeOracle("none", "unmatched"),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

/** 4 families x 12 instances = 48 tasks. */
export const DOMAIN_ID_TASKS: Task[] = buildTasks();

function buildTasks(): Task[] {
  const tasks: Task[] = [];
  for (const family of FAMILIES) {
    for (let instance = 0; instance < INSTANCES; instance += 1) {
      const authored = family.build(instance);
      tasks.push({
        taskId: `domain-id-${family.slug}-${String(instance + 1).padStart(2, "0")}`,
        split: SPLIT_BY_INSTANCE[instance],
        prompt: authored.prompt,
        initialState: authored.state,
        assertions: authored.assertions,
        allowedWrites: authored.allowedWrites,
        oracle: authored.oracle,
        surface: "support",
        maxSteps: SLICE_MAX_STEPS,
      });
    }
  }
  return tasks;
}

registerTasks(DOMAIN_ID_TASKS);

/** Family slug -> band, for the per-band breakdown of a run. */
export function domainIdTaskBands(): Record<string, string> {
  return Object.fromEntries(FAMILIES.map((family) => [family.slug, family.band]));
}

export function domainIdSplitCounts(): Record<Split, number> {
  return DOMAIN_ID_TASKS.reduce(
    (counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }),
    { train: 0, dev: 0, holdout: 0 } as Record<Split, number>,
  );
}

/** Content hash of the whole slice. */
export function domainIdFixtureSha256(): string {
  return sha256({
    tasks: DOMAIN_ID_TASKS,
    pin: DOMAIN_IDENTIFICATION_SLICE,
    guard_contact: GUARD_CONTACT,
    seed: RESET_SEED,
  });
}

/** Content hash of one split's task ids + assertions — the frozen-split contract. */
export function domainIdSplitSha256(split: Split): string {
  return sha256(
    DOMAIN_ID_TASKS
      .filter((task) => task.split === split)
      .map((task) => ({ task_id: task.taskId, assertions: task.assertions })),
  );
}

export type DomainIdPoolOptions = { split: Split; frozenHoldoutSha256?: string };

/** Slice task pool. The frozen holdout fails closed: no hash, no read. */
export function domainIdTaskPool(options: DomainIdPoolOptions): Task[] {
  if (options.split === "holdout") {
    const expected = domainIdSplitSha256("holdout");
    if (!options.frozenHoldoutSha256) {
      throw new Error("frozen-holdout refusal: reading the domain-identification holdout requires frozenHoldoutSha256");
    }
    if (options.frozenHoldoutSha256 !== expected) {
      throw new Error(`frozen-holdout refusal: domain-identification holdout hash mismatch (expected ${expected})`);
    }
  }
  return DOMAIN_ID_TASKS.filter((task) => task.split === options.split);
}

/** The frozen split contract, ready to paste into a lab note or a runner flag. */
export function domainIdSplitManifest(): Record<string, unknown> {
  const counts = domainIdSplitCounts();
  return {
    fixture_id: DOMAIN_IDENTIFICATION_SLICE.fixture_id,
    seed: RESET_SEED,
    counts,
    fixture_sha256: domainIdFixtureSha256(),
    train_sha256: domainIdSplitSha256("train"),
    dev_sha256: domainIdSplitSha256("dev"),
    holdout_sha256: domainIdSplitSha256("holdout"),
    splits_sha256: sha256({
      train: domainIdSplitSha256("train"),
      dev: domainIdSplitSha256("dev"),
      holdout: domainIdSplitSha256("holdout"),
    }),
    families: FAMILIES.map((family) => ({ slug: family.slug, band: family.band, label: family.label })),
    canonical: canonicalJson({ counts }),
  };
}
