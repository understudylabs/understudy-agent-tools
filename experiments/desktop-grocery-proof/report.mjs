import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PACKAGE_SCHEMA = "understudy.desktop_grocery_report_package.v1";
const DEFAULT_REPORT_ROOT = join(homedir(), ".understudy", "reports", "grocery-marketplace");

const modeLabels = {
  small: "Small local",
  main: "Main local",
  supervised: "Small + supervisor",
  hosted: "Hosted incumbent",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percent(value, digits = 0) {
  return value == null ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
}

function signedPercent(value) {
  if (value == null) return "—";
  const scaled = Number(value) * 100;
  return `${scaled >= 0 ? "+" : ""}${scaled.toFixed(0)}%`;
}

function integer(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

function dollars(value) {
  if (value == null) return null;
  return `$${Number(value).toFixed(Number(value) < 0.01 ? 4 : 2)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertOwnerOnly(path) {
  if (process.platform === "win32") return;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`derived buyer report permissions are broader than owner-only: ${path}`);
  }
}

function validateProofSource(summary, rows, tasks, tasksBytes) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(summary?.proof_id ?? "")) {
    throw new Error("source proof_id must be a safe path segment");
  }
  if (!/^[a-f0-9]{64}$/.test(summary?.suite_sha256 ?? "")) {
    throw new Error("source suite_sha256 must be a lowercase SHA-256 digest");
  }
  if (sha256(tasksBytes) !== summary.suite_sha256) {
    throw new Error("source tasks.json does not match suite_sha256");
  }
  if (!Array.isArray(tasks) || summary.task_count !== tasks.length) {
    throw new Error("source task_count does not match tasks.json");
  }
  if (!Array.isArray(rows) || summary.run_count !== rows.length) {
    throw new Error("source run_count does not match results.jsonl");
  }
  const taskIds = new Set(tasks.map((task) => task?.id));
  if (taskIds.size !== tasks.length || taskIds.has(undefined)) {
    throw new Error("source tasks.json has missing or duplicate task ids");
  }
  for (const row of rows) {
    if (
      row?.proof_id !== summary.proof_id
      || row?.suite_sha256 !== summary.suite_sha256
      || !taskIds.has(row?.task_id)
    ) {
      throw new Error("source results.jsonl does not match proof, suite, or task identity");
    }
  }
}

export function verdictProbabilityEvidence(verdict) {
  const raw = verdict?.probabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      chosen_probability: null,
      probabilities: null,
      probability_kind: null,
      source_probability_kind: verdict?.probability_kind ?? null,
      inferred_source_kind: false,
    };
  }
  const entries = Object.entries(raw)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  if (!entries.length) {
    return {
      chosen_probability: null,
      probabilities: null,
      probability_kind: null,
      source_probability_kind: verdict?.probability_kind ?? null,
      inferred_source_kind: false,
    };
  }
  const explicitKind = verdict?.probability_kind ?? null;
  const legacyLogprob = explicitKind == null
    && entries.some(([, value]) => value < 0)
    && entries.every(([, value]) => value <= 0);
  const isLogprob = explicitKind === "logprob" || legacyLogprob;
  const probabilities = Object.fromEntries(entries.map(([name, value]) => [
    name,
    isLogprob ? Math.exp(value) : value,
  ]));
  if (Object.values(probabilities).some(
    (value) => !Number.isFinite(value) || value < 0 || value > 1,
  )) {
    return {
      chosen_probability: null,
      probabilities: null,
      probability_kind: null,
      source_probability_kind: explicitKind,
      inferred_source_kind: legacyLogprob,
    };
  }
  return {
    chosen_probability: probabilities[verdict?.verdict] ?? null,
    probabilities,
    probability_kind: isLogprob ? "first_token_probability_from_logprob" : explicitKind,
    source_probability_kind: explicitKind ?? (legacyLogprob ? "logprob" : null),
    inferred_source_kind: legacyLogprob,
  };
}

function judgmentOutcome(row, verdict) {
  if (row.supervisor_correct_intervention) return "correct intervention";
  if (row.supervisor_missed_error) return "missed error";
  if (row.supervisor_false_positive) return "false positive";
  if (verdict.verdict === "continue" && row.student_score?.exact) return "correct continue";
  return "review";
}

function decisionForTask(task, rows) {
  const small = rows.find((row) => row.mode === "small");
  const main = rows.find((row) => row.mode === "main");
  const supervised = rows.find((row) => row.mode === "supervised");
  const hosted = rows.find((row) => row.mode === "hosted");
  const baseline = hosted ?? main;
  const baselineName = hosted ? "hosted incumbent" : "main model";
  if (!baseline?.score?.exact) {
    return {
      task_id: task.id,
      task_title: task.title,
      state: "expand",
      decision: "Expand the baseline",
      reason: `The ${baselineName} missed this task, so the slice cannot support a routing decision yet.`,
      baseline: hosted ? "hosted" : "main",
    };
  }
  if (small?.score?.exact) {
    return {
      task_id: task.id,
      task_title: task.title,
      state: "pilot",
      decision: "Pilot the smaller model",
      reason: "The smaller route matched every required field; supervision also allowed it to continue.",
      baseline: hosted ? "hosted" : "main",
    };
  }
  if (supervised?.supervisor_correct_intervention && supervised?.score?.exact) {
    return {
      task_id: task.id,
      task_title: task.title,
      state: "supervise",
      decision: "Pilot with supervision",
      reason: "The smaller route missed, the supervisor interrupted correctly, and the teacher recovered the exact answer.",
      baseline: hosted ? "hosted" : "main",
    };
  }
  if (supervised?.supervisor_missed_error) {
    return {
      task_id: task.id,
      task_title: task.title,
      state: "hold",
      decision: hosted ? "Keep on the hosted incumbent" : "Keep on the main model",
      reason: `The smaller route missed and the supervisor allowed the error to pass; retain the ${baselineName}.`,
      baseline: hosted ? "hosted" : "main",
    };
  }
  return {
    task_id: task.id,
    task_title: task.title,
    state: "hold",
    decision: hosted ? "Keep on the hosted incumbent" : "Keep on the main model",
    reason: "This slice does not yet show a safe smaller or supervised route.",
    baseline: hosted ? "hosted" : "main",
  };
}

function recommendation(decisions) {
  const groups = Object.groupBy(decisions, (decision) => decision.state);
  const clauses = [];
  if (groups.pilot?.length) clauses.push(`pilot the smaller model on ${groups.pilot.map((row) => row.task_title).join(", ")}`);
  if (groups.supervise?.length) clauses.push(`pilot supervision on ${groups.supervise.map((row) => row.task_title).join(", ")}`);
  if (groups.hold?.length) {
    const baseline = groups.hold.some((row) => row.baseline === "hosted")
      ? "hosted incumbent"
      : "main model";
    clauses.push(`keep ${groups.hold.map((row) => row.task_title).join(", ")} on the ${baseline}`);
  }
  if (groups.expand?.length) clauses.push(`expand the baseline for ${groups.expand.map((row) => row.task_title).join(", ")}`);
  if (!clauses.length) return "Collect a larger frozen slice before choosing a route.";
  const sentence = clauses.join("; ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

export function buildReportModel(summary, rows, tasks) {
  if (!summary?.proof_id || !summary?.suite_sha256 || !summary?.by_mode) {
    throw new Error("proof summary is missing identity or route metrics");
  }
  if (!Array.isArray(rows) || rows.length !== summary.run_count) {
    throw new Error("proof results do not match the recorded run count");
  }
  if (!Array.isArray(tasks) || tasks.length !== summary.task_count) {
    throw new Error("proof tasks do not match the recorded task count");
  }
  if (rows.some((row) => row.proof_id !== summary.proof_id || row.suite_sha256 !== summary.suite_sha256)) {
    throw new Error("proof result identity does not match the summary");
  }

  const decisions = tasks.map((task) => decisionForTask(
    task,
    rows.filter((row) => row.task_id === task.id),
  ));
  const modeIds = ["small", "main", "supervised"];
  if (summary.by_mode.hosted) modeIds.push("hosted");
  const modes = modeIds.map((id) => ({
    id,
    label: modeLabels[id],
    ...summary.by_mode[id],
  }));
  const main = summary.by_mode.main;
  const small = summary.by_mode.small;
  const supervised = summary.by_mode.supervised;
  const hosted = summary.by_mode.hosted ?? null;
  const smallLatency = Number(small.latency_reduction_vs_main ?? 0);
  const supervisedLatency = Number(supervised.latency_reduction_vs_main ?? 0);
  const judgments = rows
    .filter((row) => row.mode === "supervised")
    .flatMap((row) => (row.verdicts ?? []).map((verdict, ordinal) => ({
      task_id: row.task_id,
      task_title: row.task_title,
      marker_id: verdict.marker_id ?? null,
      ordinal,
      verdict: verdict.verdict,
      reason: verdict.reason ?? null,
      reason_recorded: typeof verdict.reason === "string" && verdict.reason.trim().length > 0,
      outcome: judgmentOutcome(row, verdict),
      ...verdictProbabilityEvidence(verdict),
    })));

  const executiveSummary = [
    hosted
      ? `The hosted incumbent passed ${hosted.exact_passes}/${hosted.task_count} tasks; the main local route passed ${main.exact_passes}/${main.task_count} on the identical slice.`
      : `The main local route passed ${main.exact_passes}/${main.task_count} tasks and is the only clean baseline on this slice.`,
    `The smaller route passed ${small.exact_passes}/${small.task_count} tasks at ${Math.abs(smallLatency * 100).toFixed(0)}% ${smallLatency >= 0 ? "lower" : "higher"} mean latency than main.`,
    `Supervision corrected ${supervised.supervisor_correct_interventions} error, missed ${supervised.supervisor_missed_errors}, and ran at ${Math.abs(supervisedLatency * 100).toFixed(0)}% ${supervisedLatency >= 0 ? "lower" : "higher"} mean latency than main.`,
  ];
  if (hosted) {
    executiveSummary.push(
      `The hosted lane used ${hosted.total_tokens} provider-reported tokens${hosted.cost_usd == null ? "" : ` at ${dollars(hosted.cost_usd)} using the supplied price basis`}.`,
    );
  }
  executiveSummary.push(
    "This is integration evidence, not a production promotion claim; the next gate is a larger frozen slice from each real workflow cluster.",
  );

  return {
    schema_version: "understudy.desktop_grocery_buyer_report.v3",
    title: "Grocery AI routing decision",
    proof_id: summary.proof_id,
    suite_sha256: summary.suite_sha256,
    generated_at: summary.completed_at,
    scope: `${summary.task_count} frozen synthetic tasks × ${modes.length} routes; ${summary.run_count} exact runs`,
    recommendation: recommendation(decisions),
    executive_summary: executiveSummary,
    modes,
    decisions,
    supervision: {
      verdicts: supervised.supervisor_verdicts,
      interventions: supervised.interventions,
      correct_interventions: supervised.supervisor_correct_interventions,
      missed_errors: supervised.supervisor_missed_errors,
      false_positives: supervised.supervisor_false_positives,
      small_model_output_share: supervised.mean_small_model_output_share,
      supervisor_token_overhead: supervised.mean_supervisor_token_overhead,
      judgments,
    },
    next_steps: [
      "Freeze 30–50 representative examples for each workflow cluster before changing traffic.",
      "Require zero missed critical errors and report intervention precision, recall, latency, and token overhead.",
      hosted
        ? "Replace the synthetic slice with consented workflow examples and retain the same incumbent price basis."
        : "Add the incumbent hosted route on the identical slice so cost and quality deltas become buyer-decision evidence.",
    ],
    further_questions: [
      "Does the smaller route remain exact on long-tail substitutions and policy exceptions?",
      "Which failure clusters can prompt changes fix before any fine-tuning or RL work?",
      "What fallback rate and added latency are acceptable for the production workflow?",
    ],
    caveats: [
      hosted
        ? "Synthetic tasks only; the explicitly approved hosted lane sent those synthetic prompts to the configured incumbent."
        : "Synthetic local tasks only; no customer prompts, production traffic, or remote judge were used.",
      "Three examples expose integration and failure modes but are too small for a replacement claim.",
      "Token counts are provider-reported by model role; dollar cost requires an explicit incumbent cost basis.",
      "Verdict confidence is the provider's first-token probability derived from logprobs; it is not a calibrated probability that the judgment is correct.",
    ],
    sources: ["summary.json", "results.jsonl", "tasks.json", "*.events.jsonl"],
    chart_map: [
      {
        section: "Route comparison",
        question: `How do exact quality and latency compare across the ${modes.length} routes?`,
        family: "comparison",
        type: "horizontal bar",
        fields: ["mode", "mean_field_accuracy", "mean_latency_ms"],
        takeaway: hosted
          ? "The hosted incumbent and open-weight routes share one frozen slice and evidence contract."
          : "Main is the clean baseline; supervision improves quality but adds latency.",
      },
    ],
  };
}

function routeCard(mode, maxLatency) {
  const quality = Math.max(0, Math.min(100, Number(mode.mean_field_accuracy) * 100));
  const latency = Math.max(0, Math.min(100, (Number(mode.mean_latency_ms) / maxLatency) * 100));
  const routeNote = mode.id === "supervised"
    ? `${mode.supervisor_correct_interventions} corrected · ${mode.supervisor_missed_errors} missed`
    : `${mode.exact_passes}/${mode.task_count} exact`;
  const cost = dollars(mode.cost_usd);
  return `<article class="route-card" data-source="summary.json">
    <header><h3>${escapeHtml(mode.label)}</h3><span>${escapeHtml(routeNote)}</span></header>
    <div class="measure"><div><span>Field accuracy</span><strong>${percent(mode.mean_field_accuracy)}</strong></div><div class="bar"><i style="width:${quality}%"></i></div></div>
    <div class="measure"><div><span>Mean latency</span><strong>${integer(mode.mean_latency_ms)} ms</strong></div><div class="bar latency"><i style="width:${latency}%"></i></div></div>
    <footer>${integer(mode.total_tokens)} total tokens${cost ? ` · ${escapeHtml(cost)}` : ""}</footer>
  </article>`;
}

function decisionCard(decision, rows) {
  const byMode = Object.fromEntries(rows.map((row) => [row.mode, row]));
  const result = (id) => byMode[id]?.score?.exact ? "Exact" : "Miss";
  const hosted = byMode.hosted
    ? `<span>Hosted <b>${result("hosted")}</b></span>`
    : "";
  return `<article class="decision ${escapeHtml(decision.state)}" data-source="results.jsonl">
    <div class="decision-top"><div><span class="eyebrow">${escapeHtml(decision.task_id)}</span><h3>${escapeHtml(decision.task_title)}</h3></div><span class="pill">${escapeHtml(decision.decision)}</span></div>
    <p>${escapeHtml(decision.reason)}</p>
    <div class="route-results"><span>Small <b>${result("small")}</b></span><span>Main <b>${result("main")}</b></span><span>Supervised <b>${result("supervised")}</b></span>${hosted}</div>
  </article>`;
}

function judgmentCard(judgment) {
  const confidence = judgment.chosen_probability == null
    ? "Not available"
    : percent(judgment.chosen_probability, 1);
  const reason = judgment.reason_recorded
    ? judgment.reason
    : judgment.verdict === "continue"
      ? "No reason required for a continue verdict."
      : "No reason was recorded.";
  const sourceNote = judgment.inferred_source_kind
    ? "Legacy evidence: probability kind inferred from negative logprobs."
    : judgment.probability_kind === "first_token_probability_from_logprob"
      ? "Derived from the provider's first-token logprob."
      : "Provider confidence was not available.";
  return `<article class="judgment ${escapeHtml(judgment.outcome.replaceAll(" ", "-"))}" data-source="results.jsonl">
    <div class="judgment-top"><div><span class="eyebrow">${escapeHtml(judgment.task_id)}</span><h3>${escapeHtml(judgment.verdict)}</h3></div><span class="pill">${escapeHtml(judgment.outcome)}</span></div>
    <p>${escapeHtml(reason)}</p>
    <footer><strong>${escapeHtml(confidence)}</strong> chosen-verdict first-token probability · ${escapeHtml(sourceNote)}</footer>
  </article>`;
}

export function buildBuyerReport(summary, rows, tasks) {
  const model = buildReportModel(summary, rows, tasks);
  const maxLatency = Math.max(...model.modes.map((mode) => Number(mode.mean_latency_ms)));
  const decisionCards = model.decisions.map((decision) => decisionCard(
    decision,
    rows.filter((row) => row.task_id === decision.task_id),
  )).join("\n");
  const summaryItems = model.executive_summary
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("\n");
  const nextSteps = model.next_steps.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
  const questions = model.further_questions.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
  const caveats = model.caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
  const judgmentCards = model.supervision.judgments.map(judgmentCard).join("\n");
  const shortHash = model.suite_sha256.slice(0, 16);
  const main = summary.by_mode.main;
  const small = summary.by_mode.small;
  const supervised = summary.by_mode.supervised;
  const hosted = summary.by_mode.hosted ?? null;
  const baseline = hosted ?? main;
  const routeHeading = baseline.exact_passes === baseline.task_count
    ? hosted ? "The hosted incumbent is a clean baseline" : "The main model is the clean baseline"
    : "No route clears the frozen slice";
  const routeIntro = `Exact field scoring shows the quality/latency tradeoff directly. The smaller model passes ${small.exact_passes}/${small.task_count}; supervision passes ${supervised.exact_passes}/${supervised.task_count} with ${supervised.supervisor_correct_interventions} correct intervention${supervised.supervisor_correct_interventions === 1 ? "" : "s"} and ${supervised.supervisor_missed_errors} missed error${supervised.supervisor_missed_errors === 1 ? "" : "s"}.${hosted ? ` The hosted incumbent passes ${hosted.exact_passes}/${hosted.task_count}.` : ""}`;
  const supervisionHeading = supervised.supervisor_correct_interventions > 0 && supervised.supervisor_missed_errors > 0
    ? `The supervisor helped ${supervised.supervisor_correct_interventions === 1 ? "once" : `${supervised.supervisor_correct_interventions} times`} and missed ${supervised.supervisor_missed_errors === 1 ? "once" : supervised.supervisor_missed_errors}`
    : supervised.supervisor_correct_interventions > 0
      ? `The supervisor corrected ${supervised.supervisor_correct_interventions} error${supervised.supervisor_correct_interventions === 1 ? "" : "s"}`
      : supervised.supervisor_missed_errors > 0
        ? `The supervisor missed ${supervised.supervisor_missed_errors} error${supervised.supervisor_missed_errors === 1 ? "" : "s"}`
        : "The supervisor stayed quiet on this slice";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(model.title)}</title>
  <style>
    :root { color-scheme: light dark; --bg:#f4f1e9; --paper:#fffdf8; --ink:#171713; --muted:#6a685f; --line:#d8d2c4; --accent:#c85a32; --gold:#c9972d; --olive:#6d7755; --blue:#3d6f89; --open:#ece5d7; }
    @media (prefers-color-scheme: dark) { :root { --bg:#11110f; --paper:#191916; --ink:#f4f0e6; --muted:#a9a59a; --line:#3a3933; --accent:#e2764f; --gold:#ddb34e; --olive:#9aaa78; --blue:#6e9eb5; --open:#292823; } }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; }
    main { width:min(1040px,calc(100% - 32px)); margin:0 auto; padding:56px 0 80px; } h1,h2,h3,p { margin-top:0; } h1 { max-width:720px; font-size:clamp(42px,7vw,76px); line-height:.95; letter-spacing:-.055em; margin-bottom:24px; } h2 { font-size:clamp(27px,4vw,38px); line-height:1.1; letter-spacing:-.035em; margin-bottom:14px; } h3 { font-size:18px; line-height:1.25; margin-bottom:0; } section { margin-top:64px; } .kicker,.eyebrow { text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:750; color:var(--accent); }
    .scope { color:var(--muted); max-width:720px; } .recommendation { font-size:clamp(22px,3vw,32px); line-height:1.25; max-width:880px; margin:22px 0 0; }
    .summary { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:28px 0; } .summary ul { margin:0; padding-left:22px; display:grid; gap:10px; }
    .section-intro { color:var(--muted); max-width:760px; margin-bottom:24px; } .route-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }
    .route-card,.decision,.audit,.judgment { background:var(--paper); border:1px solid var(--line); border-radius:16px; padding:20px; } .route-card header { display:flex; justify-content:space-between; gap:16px; align-items:baseline; margin-bottom:22px; } .route-card header span,.route-card footer { color:var(--muted); font-size:13px; }
    .measure { margin-top:14px; } .measure>div:first-child { display:flex; justify-content:space-between; gap:12px; font-size:13px; } .bar { height:10px; background:var(--open); border-radius:999px; overflow:hidden; margin-top:7px; } .bar i { display:block; height:100%; background:var(--olive); border-radius:inherit; } .bar.latency i { background:var(--blue); } .route-card footer { margin-top:20px; border-top:1px solid var(--line); padding-top:12px; }
    .decision-list { display:grid; gap:12px; } .decision-top { display:flex; justify-content:space-between; gap:18px; align-items:flex-start; } .decision p { color:var(--muted); margin:14px 0; } .pill { border:1px solid var(--line); border-radius:999px; padding:6px 10px; font-size:12px; font-weight:700; white-space:nowrap; } .decision.pilot .pill { color:var(--olive); } .decision.supervise .pill { color:var(--gold); } .decision.hold .pill { color:var(--accent); } .route-results { display:flex; gap:8px; flex-wrap:wrap; } .route-results span { background:var(--open); border-radius:8px; padding:6px 9px; font-size:12px; } .route-results b { margin-left:5px; }
    .audit { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; } .audit div { min-width:0; } .audit strong { display:block; font-size:24px; letter-spacing:-.03em; } .audit span { color:var(--muted); font-size:12px; }
    .judgment-list { display:grid; gap:12px; margin-top:14px; } .judgment-top { display:flex; justify-content:space-between; gap:18px; align-items:flex-start; } .judgment h3 { text-transform:capitalize; } .judgment p { color:var(--muted); margin:14px 0; } .judgment footer { color:var(--muted); font-size:12px; } .judgment footer strong { color:var(--ink); font-size:15px; }
    .two-col { display:grid; grid-template-columns:1.2fr .8fr; gap:44px; } ol,ul { padding-left:22px; } li+li { margin-top:8px; } .caveat { color:var(--muted); font-size:14px; }
    .provenance { margin-top:64px; border-top:1px solid var(--line); padding-top:18px; display:flex; flex-wrap:wrap; gap:12px 24px; color:var(--muted); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
    @media (max-width:760px) { main { padding-top:36px; } section { margin-top:48px; } .route-grid,.two-col { grid-template-columns:1fr; } .audit { grid-template-columns:repeat(2,minmax(0,1fr)); } .decision-top { flex-direction:column; } }
    @media print { :root { --bg:#fff; --paper:#fff; --ink:#111; --muted:#555; --line:#ccc; } main { width:100%; padding:0; } .route-card,.decision,.audit { break-inside:avoid; } }
  </style>
</head>
<body>
<main data-proof-id="${escapeHtml(model.proof_id)}">
  <header>
    <div class="kicker">Understudy · frozen comparison proof</div>
    <h1>${escapeHtml(model.title)}</h1>
    <p class="scope">${escapeHtml(model.scope)}</p>
    <p class="recommendation">${escapeHtml(model.recommendation)}</p>
  </header>

  <section class="summary" aria-labelledby="executive-summary"><h2 id="executive-summary">Executive Summary</h2><ul>${summaryItems}</ul></section>

  <section aria-labelledby="route-comparison">
    <h2 id="route-comparison">${escapeHtml(routeHeading)}</h2>
    <p class="section-intro">${escapeHtml(routeIntro)}</p>
    <div class="route-grid" role="group" aria-label="Quality and latency by route">${model.modes.map((mode) => routeCard(mode, maxLatency)).join("\n")}</div>
  </section>

  <section aria-labelledby="task-routing">
    <h2 id="task-routing">Route by failure cluster, not model reputation</h2>
    <p class="section-intro">Each recommendation is bounded to one frozen task. The useful decision is where to pilot next—not whether one model is universally good or bad.</p>
    <div class="decision-list">${decisionCards}</div>
  </section>

  <section aria-labelledby="supervision-audit">
    <h2 id="supervision-audit">${escapeHtml(supervisionHeading)}</h2>
    <p class="section-intro">That miss is decision-useful evidence. It prevents an unsafe broad rollout and becomes a labeled correction target for prompt work, GEPA, SFT, or later RL.</p>
    <div class="audit" data-source="summary.json">
      <div><strong>${integer(model.supervision.verdicts)}</strong><span>verdicts</span></div>
      <div><strong>${integer(model.supervision.interventions)}</strong><span>interventions</span></div>
      <div><strong>${integer(model.supervision.correct_interventions)}</strong><span>correct</span></div>
      <div><strong>${integer(model.supervision.missed_errors)}</strong><span>missed errors</span></div>
      <div><strong>${percent(model.supervision.small_model_output_share)}</strong><span>small-model output</span></div>
      <div><strong>${percent(model.supervision.supervisor_token_overhead)}</strong><span>supervisor overhead</span></div>
    </div>
    <div class="judgment-list" aria-label="Supervisor judgments with reasons and confidence">${judgmentCards}</div>
  </section>

  <section class="two-col" aria-label="Next steps and open questions">
    <div><h2>Turn this into a pilot decision</h2><ol>${nextSteps}</ol></div>
    <div><h2>Questions to answer next</h2><ul>${questions}</ul></div>
  </section>

  <section class="caveat" aria-labelledby="caveats"><h2 id="caveats">Caveats and assumptions</h2><ul>${caveats}</ul></section>
  <footer class="provenance"><span>proof ${escapeHtml(model.proof_id)}</span><span>suite ${escapeHtml(shortHash)}…</span><span>events ${escapeHtml(model.sources.join(" · "))}</span></footer>
</main>
</body>
</html>`;
}

export function writeBuyerReport(outputDir, summary, rows, tasks) {
  const modelPath = join(outputDir, "report.json");
  const reportPath = join(outputDir, "report.html");
  if (existsSync(modelPath) || existsSync(reportPath)) {
    throw new Error(`buyer report already exists in immutable proof directory: ${outputDir}`);
  }
  const model = buildReportModel(summary, rows, tasks);
  const html = buildBuyerReport(summary, rows, tasks);
  writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(reportPath, html, { flag: "wx", mode: 0o600 });
  return { modelPath, reportPath, model };
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function validateReportPackage(outputDir, expectedManifest) {
  const manifestPath = join(outputDir, "manifest.json");
  const modelPath = join(outputDir, "report.json");
  const reportPath = join(outputDir, "report.html");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schema_version !== expectedManifest.schema_version
    || JSON.stringify(manifest.source) !== JSON.stringify(expectedManifest.source)
    || JSON.stringify(manifest.renderer) !== JSON.stringify(expectedManifest.renderer)
  ) {
    throw new Error(`derived buyer report identity mismatch: ${outputDir}`);
  }
  const modelBytes = readFileSync(modelPath);
  const reportBytes = readFileSync(reportPath);
  if (
    sha256(modelBytes) !== manifest.files.report_json_sha256
    || sha256(reportBytes) !== manifest.files.report_html_sha256
  ) {
    throw new Error(`derived buyer report content hash mismatch: ${outputDir}`);
  }
  for (const path of [outputDir, manifestPath, modelPath, reportPath]) assertOwnerOnly(path);
  return {
    outputDir,
    manifestPath,
    modelPath,
    reportPath,
    manifest,
    model: JSON.parse(modelBytes.toString("utf8")),
  };
}

export function renderExistingProof(path, { outputRoot = DEFAULT_REPORT_ROOT } = {}) {
  const sourceDir = resolve(path);
  const summaryBytes = readFileSync(join(sourceDir, "summary.json"));
  const resultsBytes = readFileSync(join(sourceDir, "results.jsonl"));
  const tasksBytes = readFileSync(join(sourceDir, "tasks.json"));
  const summary = JSON.parse(summaryBytes.toString("utf8"));
  const rows = readJsonl(join(sourceDir, "results.jsonl"));
  const tasks = JSON.parse(tasksBytes.toString("utf8"));
  validateProofSource(summary, rows, tasks, tasksBytes);
  const model = buildReportModel(summary, rows, tasks);
  const modelBytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const reportBytes = Buffer.from(buildBuyerReport(summary, rows, tasks));
  const rendererHash = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const source = {
    proof_id: summary.proof_id,
    suite_sha256: summary.suite_sha256,
    summary_sha256: sha256(summaryBytes),
    results_sha256: sha256(resultsBytes),
    tasks_sha256: sha256(tasksBytes),
  };
  const sourceBundleHash = sha256(Object.values(source).join("\n"));
  const renderer = {
    report_schema_version: model.schema_version,
    renderer_sha256: rendererHash,
  };
  const manifest = {
    schema_version: REPORT_PACKAGE_SCHEMA,
    source,
    renderer,
    files: {
      report_json_sha256: sha256(modelBytes),
      report_html_sha256: sha256(reportBytes),
    },
  };
  const packageId = [
    summary.proof_id,
    model.schema_version.replaceAll(/[^a-zA-Z0-9.-]/g, "-"),
    sourceBundleHash.slice(0, 12),
    rendererHash.slice(0, 12),
  ].join("-");
  const reportRoot = resolve(outputRoot);
  const outputDir = join(reportRoot, packageId);
  mkdirSync(reportRoot, { recursive: true, mode: 0o700 });
  assertOwnerOnly(reportRoot);
  const expectedManifest = { schema_version: REPORT_PACKAGE_SCHEMA, source, renderer };
  if (existsSync(outputDir)) {
    return {
      sourceDir,
      reused: true,
      ...validateReportPackage(outputDir, expectedManifest),
    };
  }

  const temporaryDir = mkdtempSync(join(reportRoot, `.${packageId}.tmp-`));
  try {
    writeFileSync(join(temporaryDir, "report.json"), modelBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(join(temporaryDir, "report.html"), reportBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(
      join(temporaryDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryDir, outputDir);
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    if (existsSync(outputDir)) {
      return {
        sourceDir,
        reused: true,
        ...validateReportPackage(outputDir, expectedManifest),
      };
    }
    throw error;
  }
  return {
    sourceDir,
    reused: false,
    ...validateReportPackage(outputDir, expectedManifest),
  };
}
