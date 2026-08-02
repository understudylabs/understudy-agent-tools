import {
  GUARD_CONTACT,
  RESET_SEED as AUTOMATION_RESET_SEED,
  TASKS as AUTOMATION_TASKS,
  getTask as getAutomationTask,
  reset as resetAutomation,
  step as stepAutomation,
  finish as finishAutomation,
  parseToolCalls as parseAutomationToolCalls,
  splitSha256 as automationSplitSha256,
  taskBands as automationTaskBands,
  type Task as AutomationTask,
  type ToolCall as AutomationCall,
  type WorldState as AutomationState,
} from "./automationbench-offline.js";
import {
  FROZEN_HOLDOUT_SHA256 as SYNTHETIC_HOLDOUT_SHA256,
  RESET_SEED as SYNTHETIC_RESET_SEED,
  TASKS as SYNTHETIC_TASKS,
  getTask as getSyntheticTask,
  reset as resetSynthetic,
  step as stepSynthetic,
  finish as finishSynthetic,
  parseToolCalls as parseSyntheticToolCalls,
  splitSha256 as syntheticSplitSha256,
  type SyntheticTask,
  type WorkflowState as SyntheticState,
} from "./synthetic-workflow-offline.js";
import type { ToolCall as SyntheticCall } from "./automationbench-offline.js";
import {
  HARD_TASKS,
  V2_TASKS,
  v2SplitSha256,
  v2TaskBands,
} from "./automationbench-v2.js";
import { createHash } from "node:crypto";
import type { AuditTask, AdapterProbeFamily, VerifierAuditAdapter } from "./verifier-audit.js";

const splitHash = (fn: (split: "train" | "dev" | "holdout") => string, split: string): string => {
  if (split !== "train" && split !== "dev" && split !== "holdout") throw new Error(`unknown split: ${split}`);
  return fn(split);
};
const fixtureHash = (fn: (split: "train" | "dev" | "holdout") => string): string =>
  createHash("sha256").update(["train", "dev", "holdout"].map((split) => `${split}:${fn(split as "train" | "dev" | "holdout")}`).join("|")).digest("hex");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const key = (value: unknown): string => JSON.stringify(value);
const stable = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]),
    ) as T;
  }
  return value;
};
const isFetch = (action: { name: string; arguments: Record<string, unknown> }): boolean =>
  action.name === "api_fetch";
const isMutating = (action: { name: string; arguments: Record<string, unknown> }): boolean =>
  isFetch(action) && String(action.arguments.method ?? "GET").toUpperCase() !== "GET";
const urlParts = (action: { name: string; arguments: Record<string, unknown> }): { collection: string; id: string | null } | null => {
  if (!isFetch(action)) return null;
  const parts = String(action.arguments.url ?? "").split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return null;
  if (parts.length === 1) return { collection: parts[0], id: null };
  if (parts.length === 2 && ["crm/contacts", "mail/drafts", "mail/messages", "support/tickets"].includes(parts.join("/"))) {
    return { collection: `${parts[0]}.${parts[1]}`, id: null };
  }
  if (parts.length === 2) return { collection: parts[0], id: parts[1] };
  return { collection: `${parts[0]}.${parts[1]}`, id: parts[2] };
};
const pathValue = (value: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (node, part) => node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
    value,
  );
const bodyOf = (action: { arguments: Record<string, unknown> }): Record<string, unknown> =>
  action.arguments.body && typeof action.arguments.body === "object"
    ? clone(action.arguments.body as Record<string, unknown>)
    : {};
const withBody = <T extends { arguments: Record<string, unknown> }>(action: T, body: Record<string, unknown>): T =>
  ({ ...clone(action), arguments: { ...clone(action.arguments), body } }) as T;

function canonicalCollections(
  state: Record<string, unknown>,
  multiset: string[],
): Record<string, unknown> {
  const out = clone(state);
  for (const name of multiset) {
    const value = out[name];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[name] = Object.values(value as Record<string, unknown>)
        .map(clone)
        .map(stable)
        .sort((a, b) => key(a).localeCompare(key(b)));
    }
  }
  return stable(out);
}

function automationCanonical(state: AutomationState): unknown {
  const out = clone(state) as AutomationState;
  delete (out.mail as Record<string, unknown>).sequence;
  const mail = canonicalCollections(out.mail as unknown as Record<string, unknown>, ["drafts", "messages"]);
  out.mail = mail as unknown as AutomationState["mail"];
  return stable(out);
}

function syntheticCanonical(state: SyntheticState): unknown {
  const out = clone(state) as unknown as Record<string, unknown>;
  delete out.sequence;
  return stable(canonicalCollections(out, ["drafts", "meetings", "summaries", "analysis"]));
}

function auditTask<T extends { taskId: string; split: string; initialState: unknown; oracle: unknown[]; allowedWrites: string[] }>(
  task: T,
  band: string,
): AuditTask<T["initialState"], T["oracle"][number]> {
  return {
    taskId: task.taskId,
    split: task.split,
    band,
    initialState: clone(task.initialState),
    oracle: clone(task.oracle) as T["oracle"][number][],
    allowedWrites: [...task.allowedWrites],
  };
}

function restoreFor(
  task: AuditTask<AutomationState | SyntheticState, AutomationCall | SyntheticCall>,
  initial: Record<string, unknown>,
  fields: (collection: string, record: Record<string, unknown>) => Record<string, unknown>,
): AutomationCall[] | SyntheticCall[] | null {
  const actions = task.oracle as Array<AutomationCall | SyntheticCall>;
  const restores: Array<AutomationCall | SyntheticCall> = [];
  for (const action of actions.filter((candidate) => isMutating(candidate))) {
    const parts = urlParts(action);
    if (!parts?.id) return null;
    const collection = pathValue(initial, parts.collection);
    if (!collection || typeof collection !== "object" || !(parts.id in (collection as Record<string, unknown>))) return null;
    restores.push({
      name: "api_fetch",
      arguments: {
        method: "PATCH",
        url: `/${parts.collection.replace(".", "/")}/${parts.id}`,
        body: fields(parts.collection, (collection as Record<string, Record<string, unknown>>)[parts.id]),
      },
    });
  }
  return restores as AutomationCall[] | SyntheticCall[];
}

function wrongValue<Action extends { name: string; arguments: Record<string, unknown> }>(task: AuditTask<unknown, Action>): Action[] | null {
  const actions = task.oracle.map(clone);
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (!isMutating(actions[i])) continue;
    const body = bodyOf(actions[i]);
    const keyName = Object.keys(body).find((name) => typeof body[name] === "string");
    if (!keyName) continue;
    actions[i] = withBody(actions[i], { ...body, [keyName]: "__audit_wrong_value__" });
    return actions;
  }
  return null;
}

function wrongTarget<Action extends { name: string; arguments: Record<string, unknown> }>(
  task: AuditTask<Record<string, unknown>, Action>,
): Action[] | null {
  const actions = task.oracle.map(clone);
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (!isMutating(actions[i])) continue;
    const parts = urlParts(actions[i]);
    if (!parts?.id) continue;
    const collection = pathValue(task.initialState, parts.collection);
    if (!collection || typeof collection !== "object") continue;
    const goldIds = task.oracle
      .filter(isMutating)
      .map(urlParts)
      .filter((value): value is { collection: string; id: string } => value?.collection === parts.collection && value.id !== null)
      .map((value) => value.id);
    const allowedIds = task.allowedWrites
      .filter((prefix) => prefix.startsWith(`${parts.collection}.`))
      .map((prefix) => prefix.split(".").at(-1))
      .filter((value): value is string => Boolean(value));
    const ids = Object.keys(collection as Record<string, unknown>)
      .filter((id) => id !== parts.id && !goldIds.includes(id) && !allowedIds.includes(id));
    if (ids.length === 0) continue;
    actions[i] = {
      ...clone(actions[i]),
      arguments: { ...clone(actions[i].arguments), url: `/${parts.collection}/${ids[0]}` },
    } as Action;
    return actions;
  }
  return null;
}

function inScopeClobber<Action extends { name: string; arguments: Record<string, unknown> }>(
  task: AuditTask<unknown, Action>,
): Action[] | null {
  const actions = task.oracle.map(clone);
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (!isMutating(actions[i])) continue;
    const parts = urlParts(actions[i]);
    if (!parts?.id) continue;
    if (
      parts.collection === "agent-state" &&
      pathValue(task.initialState as Record<string, unknown>, `conversations.${parts.id}.agentStateConfigured`) === false
    ) continue;
    const body = bodyOf(actions[i]);
    const collection = parts.collection;
    const method = String(actions[i].arguments.method ?? "GET").toUpperCase();
    if (collection === "mail.messages" && method === "POST") {
      const draftAction = actions.slice(0, i).find((candidate) => {
        const candidateParts = urlParts(candidate);
        return isMutating(candidate) && candidateParts?.collection === "mail.drafts" && candidateParts.id !== null;
      });
      const draftParts = draftAction ? urlParts(draftAction) : null;
      if (draftParts?.id) {
        actions.push({
          name: "api_fetch",
          arguments: {
            method: "PATCH",
            url: `/mail/drafts/${draftParts.id}`,
            body: { subject: "__audit_junk__" },
          },
        } as unknown as Action);
        return actions;
      }
    }
    const field = collection === "crm.contacts" ? "owner"
      : collection === "support.tickets" ? "priority"
        : collection === "documents" ? (method === "POST" ? "content" : "path")
          : collection === "records" ? "name"
            : collection === "agent-state" ? "reasoning"
              : collection === "drafts" ? (method === "POST" ? "subject" : "body")
                : collection === "meetings" ? "durationMin"
                  : collection === "summaries" ? "summary"
                    : collection === "analysis" ? "finding"
                      : "subject";
    const junk = field === "durationMin" ? 999 : "__audit_junk__";
    actions.push(withBody(actions[i], { ...body, [field]: junk }));
    return actions;
  }
  return null;
}

function collectionSpam<Action extends { name: string; arguments: Record<string, unknown> }>(
  task: AuditTask<unknown, Action>,
  candidates: Array<{ prefix: string; action: Action }>,
): Action[] | null {
  for (const candidate of candidates) {
    if (task.allowedWrites.some((prefix) => prefix === candidate.prefix || prefix.startsWith(`${candidate.prefix}.`))) {
      return [...task.oracle.map(clone), candidate.action];
    }
  }
  return null;
}

function writeThenRevert<Action extends { name: string; arguments: Record<string, unknown> }>(
  task: AuditTask<Record<string, unknown>, Action>,
  collection: string,
  recordFields: (record: Record<string, unknown>) => Record<string, unknown>,
): Action[] | null {
  const state = pathValue(task.initialState, collection);
  if (!state || typeof state !== "object") return null;
  const allowedIds = task.allowedWrites
    .filter((prefix) => prefix.startsWith(`${collection}.`))
    .map((prefix) => prefix.split(".")[2])
    .filter(Boolean);
  const id = Object.keys(state as Record<string, unknown>).find((candidate) => !allowedIds.includes(candidate));
  if (!id) return null;
  const record = (state as Record<string, Record<string, unknown>>)[id];
  const junk = { ...recordFields(record) };
  const field = Object.keys(junk)[0];
  if (!field) return null;
  const bad = { ...junk, [field]: typeof junk[field] === "string" ? "__audit_temporary_junk__" : junk[field] };
  const urlCollection = collection.replace(".", "/");
  const outside = { name: "api_fetch", arguments: { method: "PATCH", url: `/${urlCollection}/${id}`, body: bad } } as unknown as Action;
  const restore = { name: "api_fetch", arguments: { method: "PATCH", url: `/${urlCollection}/${id}`, body: junk } } as unknown as Action;
  return [outside, restore, ...task.oracle.map(clone)];
}

function runAutomation(task: AuditTask<AutomationState, AutomationCall>, actions: AutomationCall[]): { reward: number; finalState: AutomationState } {
  const { handle } = resetAutomation(task.taskId, AUTOMATION_RESET_SEED);
  let reward = 0;
  for (const action of actions) {
    if (handle.done) break;
    reward = stepAutomation(handle, action).reward;
  }
  if (!handle.done) reward = finishAutomation(handle).reward;
  return { reward, finalState: clone(handle.state) };
}

function runSynthetic(task: AuditTask<SyntheticState, SyntheticCall>, actions: SyntheticCall[]): { reward: number; finalState: SyntheticState } {
  const { handle } = resetSynthetic(task.taskId, SYNTHETIC_RESET_SEED);
  let reward = 0;
  for (const action of actions) {
    if (handle.done) break;
    reward = stepSynthetic(handle, action).reward;
  }
  if (!handle.done) reward = finishSynthetic(handle).reward;
  return { reward, finalState: clone(handle.state) };
}

function automationAdapterProbe(family: AdapterProbeFamily, task: AuditTask<AutomationState, AutomationCall>): AutomationCall[] | null {
  const guard = { name: "api_fetch", arguments: { method: "PATCH", url: `/crm/contacts/${GUARD_CONTACT.id}`, body: { name: "__audit_sentinel__" } } };
  if (family === "search-spam") return Array.from({ length: Math.min(3, 12) }, () => ({ name: "api_search", arguments: { query: "crm contacts mail drafts messages support tickets" } }));
  if (family === "sentinel-clobber") return [
    { name: "api_search", arguments: { query: "crm contacts mail drafts messages support tickets" } },
    { name: "api_search", arguments: { query: "crm contacts mail drafts messages support tickets" } },
    guard,
  ];
  if (family === "wrong-value") return wrongValue(task);
  if (family === "wrong-target") return wrongTarget(task);
  if (family === "in-scope-clobber") return inScopeClobber(task);
  if (family === "collection-spam") return collectionSpam(task, [
    { prefix: "mail.drafts", action: { name: "api_fetch", arguments: { method: "POST", url: "/mail/drafts", body: { to: "audit@example.test", subject: "__audit_spam__" } } } },
  ]);
  return writeThenRevert(task, "crm.contacts", (record) => ({ name: record.name, email: record.email, status: record.status, owner: record.owner }));
}

function syntheticAdapterProbe(family: AdapterProbeFamily, task: AuditTask<SyntheticState, SyntheticCall>): SyntheticCall[] | null {
  if (family === "search-spam") return Array.from({ length: 3 }, () => ({ name: "api_search", arguments: { query: "workflow records documents events" } }));
  if (family === "sentinel-clobber") return [
    { name: "api_search", arguments: { query: "workflow records documents events" } },
    { name: "api_search", arguments: { query: "workflow records documents events" } },
    { name: "api_fetch", arguments: { method: "PATCH", url: "/records/rec_guard", body: { stage: "sentinel-mutated" } } },
  ];
  if (family === "wrong-value") return wrongValue(task);
  if (family === "wrong-target") return wrongTarget(task);
  if (family === "in-scope-clobber") return inScopeClobber(task);
  if (family === "collection-spam") return collectionSpam(task, [
    { prefix: "drafts", action: { name: "api_fetch", arguments: { method: "POST", url: "/drafts", body: { to: "audit@example.test", subject: "__audit_spam__", body: "__audit_spam__" } } } },
    { prefix: "meetings", action: { name: "api_fetch", arguments: { method: "POST", url: "/meetings", body: { attendee: "audit", slot: "__audit_spam__", durationMin: 1 } } } },
    { prefix: "summaries", action: { name: "api_fetch", arguments: { method: "POST", url: "/summaries", body: { status: "audit", summary: "__audit_spam__", toolsCalled: [] } } } },
    { prefix: "analysis", action: { name: "api_fetch", arguments: { method: "POST", url: "/analysis", body: { recordRef: "audit", category: "audit", priority: "audit", finding: "__audit_spam__" } } } },
  ]);
  return writeThenRevert(task, "records", (record) => ({ name: record.name, stage: record.stage, observations: record.observations }));
}

const automationTask = (task: AutomationTask): AuditTask<AutomationState, AutomationCall> =>
  auditTask(task, v2TaskBands()[task.taskId.replace(/^hard-api-/, "").replace(/^simple-api-/, "").replace(/-\d+$/, "")] ?? automationTaskBands()[task.taskId.replace(/^simple-api-/, "").replace(/-\d+$/, "")] ?? "unknown") as AuditTask<AutomationState, AutomationCall>;

const syntheticTask = (task: SyntheticTask): AuditTask<SyntheticState, SyntheticCall> =>
  auditTask(task, task.band) as AuditTask<SyntheticState, SyntheticCall>;

export const automationBenchV2Adapter: VerifierAuditAdapter<AutomationState, AutomationCall> = {
  name: "automationbench-v2",
  fixtureSha256: fixtureHash(v2SplitSha256),
  splitSha256: (split) => splitHash(v2SplitSha256, split),
  tasks: (split, frozen) => {
    if (split === "holdout") {
      const expected = v2SplitSha256("holdout");
      if (frozen !== expected) throw new Error("frozen-holdout refusal: AutomationBench v2 hash missing or mismatched");
    }
    return V2_TASKS.filter((task) => task.split === split).map(automationTask);
  },
  run: runAutomation,
  canonicalize: automationCanonical,
  actionKey: key,
  isMutating,
  readActions: (task) => task.oracle.filter((action) => !isMutating(action)),
  maxSteps: (task) => (getAutomationTask(task.taskId).maxSteps ?? 12),
  adapterProbe: automationAdapterProbe,
  restoreActions: (task) => restoreFor(task, task.initialState as unknown as Record<string, unknown>, (collection, record) => collection === "crm.contacts" ? ({ name: record.name, email: record.email, status: record.status, owner: record.owner }) : record),
};

export const syntheticWorkflowAdapter: VerifierAuditAdapter<SyntheticState, SyntheticCall> = {
  name: "synthetic-workflow-offline",
  fixtureSha256: fixtureHash(syntheticSplitSha256),
  splitSha256: (split) => splitHash(syntheticSplitSha256, split),
  tasks: (split, frozen) => {
    if (split === "holdout" && frozen !== syntheticSplitSha256("holdout")) throw new Error("frozen-holdout refusal: synthetic workflow hash missing or mismatched");
    return SYNTHETIC_TASKS.filter((task) => task.split === split).map(syntheticTask);
  },
  run: runSynthetic,
  canonicalize: syntheticCanonical,
  actionKey: key,
  isMutating,
  readActions: (task) => task.oracle.filter((action) => !isMutating(action)),
  maxSteps: () => 12,
  adapterProbe: syntheticAdapterProbe,
  restoreActions: (task) => restoreFor(task, task.initialState as unknown as Record<string, unknown>, (collection, record) => {
    if (collection === "records") return { name: record.name, stage: record.stage, observations: record.observations };
    if (collection === "documents") return { path: record.path };
    return record;
  }),
};

export const AUDIT_ADAPTERS = {
  automationBenchV2: automationBenchV2Adapter,
  syntheticWorkflow: syntheticWorkflowAdapter,
} as const;

export const FROZEN_HOLDOUT_HASHES = {
  automationBenchV2: v2SplitSha256("holdout"),
  syntheticWorkflow: SYNTHETIC_HOLDOUT_SHA256,
  automationBenchV1: automationSplitSha256("holdout"),
} as const;

export type TranscriptRow = {
  task_id?: unknown;
  score?: unknown;
  transcript?: unknown;
};

function parseTranscriptRows(
  rows: TranscriptRow[],
  parser: (message: unknown) => AutomationCall[],
): Array<{ taskId: string; recordedScore: number; actions: AutomationCall[] }> {
  return rows.flatMap((row) => {
    if (typeof row.task_id !== "string" || typeof row.score !== "number" || !Array.isArray(row.transcript)) return [];
    const actions = row.transcript.flatMap((message) => parser(message));
    return [{ taskId: row.task_id, recordedScore: row.score, actions }];
  });
}

export const parseAutomationTranscripts = (rows: TranscriptRow[]) =>
  parseTranscriptRows(rows, parseAutomationToolCalls);

export const parseSyntheticTranscripts = (rows: TranscriptRow[]) =>
  parseTranscriptRows(rows, parseSyntheticToolCalls);
