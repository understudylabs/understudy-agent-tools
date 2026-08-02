/**
 * Synthetic fixture families for the action-option-selection workload shape
 * (workload code WL-aop). Every value here is invented: no captured prompt,
 * completion, tenant, or record from any real workload appears in this file.
 *
 * The shape being mirrored is narrow and bounded: read one event, resolve which
 * action option it selects, and apply that single option to exactly one
 * account. The three bands separate the ways that resolution goes wrong —
 * reading the option directly, disambiguating between candidates, and
 * declining to act beyond what was addressed.
 */
import type { Assertion, ToolCall } from "../automationbench-offline.js";
import type {
  AopCaseDraft,
  AopFamily,
  AopState,
} from "../aop-selection-offline.js";

const call = (method: string, url: string, body?: Record<string, unknown>): ToolCall => ({
  name: "api_fetch",
  arguments: body === undefined ? { method, url } : { method, url, body },
});

const guard = {
  rec_guard: {
    id: "rec_guard",
    name: "Guard account",
    owner: "unassigned",
    stage: "open",
    notes: ["leave unchanged"],
  },
};

const conversation = (
  id: string,
  summary: string,
  events: { type: string; note: string }[],
) => ({ id, summary, events });

const baseState = (
  conversations: AopState["conversations"],
  records: AopState["records"],
  options: AopState["options"] = {},
): AopState => ({
  conversations,
  records: { ...guard, ...records },
  options,
  sequence: 0,
});

const task = (
  taskId: string,
  prompt: string,
  initialState: AopState,
  assertions: Assertion[],
  allowedWrites: string[],
  oracle: ToolCall[],
): AopCaseDraft => ({ taskId, prompt, initialState, assertions, allowedWrites, oracle });

const pad = (instance: number) => String(instance + 1).padStart(2, "0");

// ---------------------------------------------------------------------------
// Band: direct — the selected option is stated or one catalog read away.
// ---------------------------------------------------------------------------

const namedData = [
  ["opt-renew", "renewal-scheduled", "Renewals desk"],
  ["opt-upgrade", "upgrade-queued", "Expansion desk"],
  ["opt-review", "review-booked", "Review desk"],
  ["opt-migrate", "migration-planned", "Platform desk"],
  ["opt-train", "training-scheduled", "Enablement desk"],
  ["opt-audit", "audit-opened", "Assurance desk"],
  ["opt-refund", "refund-approved", "Billing desk"],
  ["opt-pause", "pause-confirmed", "Retention desk"],
  ["opt-expand", "expansion-logged", "Growth desk"],
  ["opt-close", "closure-recorded", "Wind-down desk"],
] as const;

const namedOption: AopFamily = {
  slug: "named-option",
  band: "direct",
  label: "apply the option the event names on the account it names",
  instances: 10,
  build: (instance) => {
    const [option, stage, desk] = namedData[instance];
    const conv = `conv_named_${instance + 1}`;
    const target = `rec_named_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "action option selected", [
          { type: "decision", note: `${desk} selected ${option}; apply stage ${stage} to ${target}` },
        ]),
      },
      {
        [target]: { id: target, name: "Named account", owner: desk, stage: "open", notes: [option] },
      },
    );
    return task(
      `aop-named-${pad(instance)}`,
      `Read ${conv} and apply the action option it selected to the account it addresses.`,
      state,
      [{ kind: "equals", path: `records.${target}.stage`, equals: stage }],
      [`records.${target}`],
      [call("GET", `/conversations/${conv}`), call("PATCH", `/records/${target}`, { stage })],
    );
  },
};

const catalogData = [
  ["code-a1", "onboarding-started", "kickoff"],
  ["code-b2", "billing-corrected", "invoice"],
  ["code-c3", "support-escalated", "escalation"],
  ["code-d4", "contract-extended", "extension"],
  ["code-e5", "trial-converted", "conversion"],
  ["code-f6", "seats-adjusted", "seat change"],
  ["code-g7", "usage-capped", "cap"],
  ["code-h8", "discount-applied", "discount"],
  ["code-i9", "handoff-completed", "handoff"],
  ["code-j10", "renewal-deferred", "deferral"],
] as const;

const catalogLookup: AopFamily = {
  slug: "catalog-lookup",
  band: "direct",
  label: "resolve an option code through the catalog before applying it",
  instances: 10,
  build: (instance) => {
    const [code, stage, label] = catalogData[instance];
    const conv = `conv_catalog_${instance + 1}`;
    const target = `rec_catalog_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "action option selected by code", [
          { type: "decision", note: `apply option ${code} to ${target}` },
        ]),
      },
      {
        [target]: { id: target, name: "Catalog account", owner: "Operations desk", stage: "open", notes: [code] },
      },
      {
        [code]: { code, stage, note: `${label} option` },
        "code-zz": { code: "code-zz", stage: "never-selected", note: "unused catalog entry" },
      },
    );
    return task(
      `aop-catalog-${pad(instance)}`,
      `Read ${conv}, resolve the option code it selected against the option catalog, and apply the resulting stage to the addressed account.`,
      state,
      [{ kind: "equals", path: `records.${target}.stage`, equals: stage }],
      [`records.${target}`],
      [
        call("GET", `/conversations/${conv}`),
        call("GET", `/options/${code}`),
        call("PATCH", `/records/${target}`, { stage }),
      ],
    );
  },
};

// ---------------------------------------------------------------------------
// Band: disambiguation — more than one plausible reading of the event.
// ---------------------------------------------------------------------------

const nearMatchData = [
  ["North region desk", "South region desk", "coverage-confirmed"],
  ["Enterprise desk", "Mid-market desk", "tier-confirmed"],
  ["EU desk", "UK desk", "residency-confirmed"],
  ["Direct desk", "Partner desk", "channel-confirmed"],
  ["Annual desk", "Monthly desk", "term-confirmed"],
  ["Platform desk", "Application desk", "scope-confirmed"],
  ["Pilot desk", "Production desk", "phase-confirmed"],
  ["Legal desk", "Procurement desk", "review-confirmed"],
  ["Support desk", "Success desk", "ownership-confirmed"],
  ["Data desk", "Reporting desk", "surface-confirmed"],
] as const;

const nearMatchTarget: AopFamily = {
  slug: "near-match-target",
  band: "disambiguation",
  label: "pick the addressed account among near-identical candidates",
  instances: 10,
  build: (instance) => {
    const [owner, decoyOwner, stage] = nearMatchData[instance];
    const conv = `conv_near_${instance + 1}`;
    const target = `rec_near_${instance + 1}`;
    const decoy = `rec_near_alt_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "action option selected for one owner", [
          { type: "decision", note: `owner ${owner} selected stage ${stage}; ${decoyOwner} is handled separately` },
        ]),
      },
      {
        [target]: { id: target, name: "Shared name account", owner, stage: "open", notes: ["candidate"] },
        [decoy]: { id: decoy, name: "Shared name account", owner: decoyOwner, stage: "open", notes: ["candidate"] },
      },
    );
    return task(
      `aop-near-${pad(instance)}`,
      `Read ${conv}. Two accounts share a name; apply the selected option only to the one the event addresses.`,
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

const supersededData = [
  ["hold-requested", "renewal-scheduled"],
  ["upgrade-queued", "upgrade-deferred"],
  ["review-booked", "review-cancelled"],
  ["refund-approved", "refund-partial"],
  ["pause-confirmed", "pause-reversed"],
  ["training-scheduled", "training-rescheduled"],
  ["audit-opened", "audit-closed"],
  ["seats-adjusted", "seats-restored"],
  ["discount-applied", "discount-withdrawn"],
  ["handoff-completed", "handoff-reopened"],
] as const;

const supersededOption: AopFamily = {
  slug: "superseded-option",
  band: "disambiguation",
  label: "apply the correction, not the option it replaced",
  instances: 10,
  build: (instance) => {
    const [first, corrected] = supersededData[instance];
    const conv = `conv_superseded_${instance + 1}`;
    const target = `rec_superseded_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "action option selected then corrected", [
          { type: "decision", note: `initial selection stage ${first} for ${target}` },
          { type: "correction", note: `correction supersedes the initial selection; apply stage ${corrected} to ${target} instead` },
        ]),
      },
      {
        [target]: { id: target, name: "Corrected account", owner: "Operations desk", stage: "open", notes: ["corrected"] },
      },
    );
    return task(
      `aop-superseded-${pad(instance)}`,
      `Read ${conv} and apply the option that is in force after its correction to the addressed account.`,
      state,
      [{ kind: "equals", path: `records.${target}.stage`, equals: corrected }],
      [`records.${target}`],
      [call("GET", `/conversations/${conv}`), call("PATCH", `/records/${target}`, { stage: corrected })],
    );
  },
};

// ---------------------------------------------------------------------------
// Band: restraint — the trap is acting beyond what the event addressed.
// ---------------------------------------------------------------------------

const scopedData = [
  ["access-granted", "billing team"],
  ["invoice-reissued", "support team"],
  ["quota-raised", "platform team"],
  ["ticket-linked", "success team"],
  ["owner-updated", "finance team"],
  ["region-set", "compliance team"],
  ["plan-confirmed", "renewals team"],
  ["contact-verified", "onboarding team"],
  ["alert-cleared", "reliability team"],
  ["export-enabled", "data team"],
] as const;

const scopedWrite: AopFamily = {
  slug: "scoped-write",
  band: "restraint",
  label: "apply the option to the addressed account and leave the mentioned one alone",
  instances: 10,
  build: (instance) => {
    const [stage, otherTeam] = scopedData[instance];
    const conv = `conv_scoped_${instance + 1}`;
    const target = `rec_scoped_${instance + 1}`;
    const mentioned = `rec_scoped_other_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "one option, two accounts mentioned", [
          {
            type: "decision",
            note: `apply stage ${stage} to ${target}; ${mentioned} is owned by the ${otherTeam} and is out of scope`,
          },
        ]),
      },
      {
        [target]: { id: target, name: "In-scope account", owner: "Operations desk", stage: "open", notes: ["in scope"] },
        [mentioned]: { id: mentioned, name: "Out-of-scope account", owner: otherTeam, stage: "open", notes: ["out of scope"] },
      },
    );
    return task(
      `aop-scoped-${pad(instance)}`,
      `Read ${conv}. It mentions two accounts but selects an option for only one; apply it there and change nothing else.`,
      state,
      [
        { kind: "equals", path: `records.${target}.stage`, equals: stage },
        { kind: "equals", path: `records.${mentioned}.stage`, equals: "open" },
      ],
      [`records.${target}`],
      [call("GET", `/conversations/${conv}`), call("PATCH", `/records/${target}`, { stage })],
    );
  },
};

const declinedData = [
  ["upgrade-queued", "hold-budget"],
  ["renewal-scheduled", "hold-legal"],
  ["migration-planned", "hold-capacity"],
  ["refund-approved", "hold-dispute"],
  ["training-scheduled", "hold-staffing"],
  ["audit-opened", "hold-scope"],
  ["seats-adjusted", "hold-approval"],
  ["discount-applied", "hold-pricing"],
  ["expansion-logged", "hold-planning"],
  ["closure-recorded", "hold-review"],
] as const;

const declinedOption: AopFamily = {
  slug: "declined-option",
  band: "restraint",
  label: "record the hold the event asked for, not the option it declined",
  instances: 10,
  build: (instance) => {
    const [declined, hold] = declinedData[instance];
    const conv = `conv_declined_${instance + 1}`;
    const target = `rec_declined_${instance + 1}`;
    const state = baseState(
      {
        [conv]: conversation(conv, "action option declined", [
          { type: "decision", note: `the proposed option stage ${declined} was declined` },
          { type: "instruction", note: `record stage ${hold} on ${target} instead` },
        ]),
      },
      {
        [target]: { id: target, name: "Held account", owner: "Operations desk", stage: "open", notes: ["proposal declined"] },
      },
    );
    return task(
      `aop-declined-${pad(instance)}`,
      `Read ${conv}. The proposed option was declined; record what the event asked for instead on the addressed account.`,
      state,
      [{ kind: "equals", path: `records.${target}.stage`, equals: hold }],
      [`records.${target}`],
      [call("GET", `/conversations/${conv}`), call("PATCH", `/records/${target}`, { stage: hold })],
    );
  },
};

export const AOP_FAMILIES: AopFamily[] = [
  namedOption,
  catalogLookup,
  nearMatchTarget,
  supersededOption,
  scopedWrite,
  declinedOption,
];
