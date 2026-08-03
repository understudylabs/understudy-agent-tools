/* Shared substrate for the /cedar/flows explorations.
 *
 * Every direction renders the SAME real evidence — the archived 57-task
 * domain-identification benchmark (incumbent gpt-4o vs candidate glm-5.2)
 * — so the only variable between pages is the interaction metaphor.
 *
 * Color carries meaning everywhere: mint = incumbent, violet = candidate,
 * green/red = pass/fail, amber = needs training. Words are a last resort.
 */

import { useEffect, useState } from "react";

export const INC_C = "#9edbd3"; // incumbent · mint
export const CAND_C = "#a78bfa"; // candidate · violet
export const GOOD = "#6ee7a0";
export const BAD = "#e5534b";
export const AMBER = "#f2b34c";
export const INK = "#f2f2f0";
export const DIM = "rgba(242,242,240,0.45)";

// fallback when no archived run qualifies; useDuel prefers the LATEST
// big benchmark (>=50 tasks, >=2 models) from the index so new runs —
// including evolved-prompt 3-ways — become the default evidence
export const RUN_URL =
  "/env-runs/domain-identification/history/20260703T043718+0000.json";

async function resolveRunUrl(wl: string): Promise<string> {
  try {
    const idx = await fetch(`/env-runs/${wl}/index.json`).then((r) =>
      r.ok ? r.json() : []
    );
    const entry = (idx as { file: string; tasks: number; models: unknown[] }[]).find(
      (e) => e.tasks >= 50 && e.models.length >= 2
    );
    if (entry) return `/env-runs/${wl}/${entry.file}`;
  } catch {
    /* fall back */
  }
  return RUN_URL;
}

export type Ex = {
  exampleId: string;
  reward: number;
  metrics: Record<string, number>;
  finalAnswer: Record<string, unknown> | null;
  consistency?: number;
  rewardSpread?: [number, number];
};

export type RunModel = {
  model: string;
  wallSeconds?: number;
  aggregate: Record<string, number>;
  examples: Ex[];
};

export type Run = {
  workload: string;
  ranAt: string;
  rubric: { name: string; weight: number }[];
  tasks: {
    exampleId: string;
    currentUser?: string;
    goldDomainHint?: string;
    crmDomains?: string[];
    incumbentModel?: string;
  }[];
  models: RunModel[];
};

export type Pair = {
  i: number;
  eid: string;
  user: string;
  gold: string;
  crm: number; // how many CRM candidates matched (ambiguity)
  inc: Ex;
  cand: Ex;
  flip: boolean; // meaningful reward gap
  solveFlip: boolean; // one solved it, the other didn't
};

export type Duel = {
  run: Run;
  inc: RunModel;
  cand: RunModel;
  pairs: Pair[];
};

export const solvedEx = (e?: Ex | null) =>
  ((e?.metrics ?? {})["task_solved"] ?? 0) >= 0.5;

export const pct = (x: number | undefined | null) =>
  `${Math.round((x ?? 0) * 100)}%`;

export function answerLabel(ex?: Ex | null): string {
  const fa = (ex?.finalAnswer ?? {}) as Record<string, unknown>;
  if (fa.primaryDomain) return String(fa.primaryDomain);
  if (fa.conversationId) return "existing thread";
  return "no match";
}

export function reasonText(ex?: Ex | null): string {
  const fa = (ex?.finalAnswer ?? {}) as Record<string, unknown>;
  return typeof fa.reasoning === "string" ? fa.reasoning : "";
}

/** plain-english rubric axes — [label, why it matters] */
export const AXIS_LABEL: Record<string, [string, string]> = {
  resolution_match: ["right answer", "routed exactly where production routed"],
  domain_identified: ["right company", "found the correct company"],
  final_json_valid: ["valid format", "answered in the shape the caller parses"],
  lookup_discipline: ["honest tools", "no guessing, no carpet-bombing the CRM"],
  task_solved: ["solved", "the whole task, strictly"],
};
export const axisLabel = (n: string) =>
  AXIS_LABEL[n]?.[0] ?? n.replaceAll("_", " ");

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(arr: T[], seed: number): T[] {
  const r = mulberry(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function useDuel(): Duel | null {
  const [duel, setDuel] = useState<Duel | null>(null);
  useEffect(() => {
    let live = true;
    resolveRunUrl("domain-identification")
      .then((url) => fetch(url))
      .then((r) => r.json())
      .then((run: Run) => {
        if (!live) return;
        const incName = run.tasks[0]?.incumbentModel ?? "gpt-4o";
        const inc =
          run.models.find((m) => m.model === incName) ?? run.models[0];
        const cand = run.models
          .filter((m) => m !== inc)
          .sort((a, b) => (b.aggregate.reward ?? 0) - (a.aggregate.reward ?? 0))[0];
        const byInc = new Map(inc.examples.map((e) => [e.exampleId, e]));
        const byCand = new Map(cand.examples.map((e) => [e.exampleId, e]));
        const pairs: Pair[] = run.tasks
          .filter((t) => byInc.has(t.exampleId) && byCand.has(t.exampleId))
          .map((t, i) => {
            const a = byInc.get(t.exampleId)!;
            const b = byCand.get(t.exampleId)!;
            return {
              i,
              eid: t.exampleId,
              user: t.currentUser ?? "",
              gold: t.goldDomainHint ?? "",
              crm: (t.crmDomains ?? []).length,
              inc: a,
              cand: b,
              flip: Math.abs(a.reward - b.reward) > 0.15,
              solveFlip: solvedEx(a) !== solvedEx(b),
            };
          });
        setDuel({ run, inc, cand, pairs });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return duel;
}

/* ---- the generated rubric — what the user accepted in environment
 * generation. race/gradient score with THIS, not the env defaults. ---- */

export type GenRule = { rule: string; quote?: string | null; weight: number };
export type GenRubric = { rules: GenRule[]; version: number | null };

export function useGeneratedRubric(wl: string): GenRubric | null {
  const [rubric, setRubric] = useState<GenRubric | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/env-analysis/${wl}-rubric.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d && Array.isArray(d.rules) && d.rules.length)
          setRubric({ rules: d.rules, version: d.version ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wl]);
  return rubric;
}

/** which measurable axis grades a rule — heuristic until each rule is
 * individually instrumented in the env */
export function ruleAxis(rule: string): string {
  const t = rule.toLowerCase();
  if (/tool|lookup|call/.test(t)) return "lookup_discipline";
  if (/invent|guess|make up|fabricat/.test(t)) return "lookup_discipline";
  if (/format|json|structure/.test(t)) return "final_json_valid";
  return "resolution_match";
}

/** generated rules → normalized per-axis weights */
export function axisWeightsFromRules(rules: GenRule[]): Record<string, number> {
  const w: Record<string, number> = {};
  for (const r of rules) w[ruleAxis(r.rule)] = (w[ruleAxis(r.rule)] ?? 0) + r.weight;
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(w)) w[k] /= sum;
  return w;
}

/** rescore an aggregate (or per-example metrics) with the user's rubric */
export function rescore(
  metrics: Record<string, number>,
  weights: Record<string, number>
): number {
  let n = 0;
  for (const [ax, w] of Object.entries(weights)) n += (metrics[ax] ?? 0) * w;
  return n;
}

export const WORKLOADS = [
  { id: "domain-identification", tasks: 57 },
  { id: "zapier-automationbench", tasks: 25 },
  { id: "harvey-lab", tasks: 10 },
  { id: "analyzer", tasks: 18 },
  { id: "on-event-email-orchestrator", tasks: 16 },
  { id: "on-event-execution", tasks: 64 },
  { id: "on-event-meeting-orchestrator", tasks: 187 },
  { id: "automation", tasks: 52 },
  { id: "chat", tasks: 131 },
];

export type WlRuns = { reward: Record<string, number>; tasks: number } | null;

/** most recent archived result per model, per workload (null = no runs yet) */
export function useWorkloadRuns(): Record<string, WlRuns> {
  const [runs, setRuns] = useState<Record<string, WlRuns>>({});
  useEffect(() => {
    let live = true;
    Promise.all(
      WORKLOADS.map(async (w) => {
        try {
          const idx = await fetch(`/env-runs/${w.id}/index.json`).then((r) =>
            r.ok ? r.json() : null
          );
          if (!Array.isArray(idx) || !idx.length) return [w.id, null] as const;
          const reward: Record<string, number> = {};
          let tasks = 0;
          for (const entry of idx) {
            tasks = Math.max(tasks, entry.tasks ?? 0);
            for (const m of entry.models ?? [])
              if (!(m.model in reward)) reward[m.model] = m.reward;
          }
          return [w.id, { reward, tasks }] as const;
        } catch {
          return [w.id, null] as const;
        }
      })
    ).then((entries) => {
      if (live) setRuns(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, []);
  return runs;
}
