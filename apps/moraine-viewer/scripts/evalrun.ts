// Stage 4→5: run a local candidate model against a personal-benchmark draft
// (dev split ONLY — holdout stays sealed) and write data/evals/<slug>.json.
//
// This is a PLAN-QUALITY eval: the candidate cannot execute tools here, so it
// is asked to describe concretely how it would accomplish the task, and the
// same local model judges (self-judge — treat scores as relative, not absolute)
// whether that plan would plausibly produce the reference outcome.
//
// Usage: bun scripts/evalrun.ts --benchmark <slug> [--max 8] [--candidate gemma-4-e2b-qat-understudy] [--force]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const GEMMA_URL = "http://127.0.0.1:8877/v1/chat/completions";
const KIND = "plan-quality-v0";
const JUDGE = "gemma-4-e2b-qat (self-judge — treat scores as relative, not absolute)";

type Instance = {
  instance_id: string;
  split: "train" | "dev" | "holdout";
  prompt: string;
  reference: { final_assistant: string; commits: string[]; events: number };
  quality: number;
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function chat(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(GEMMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "default_model", messages, max_tokens: maxTokens, temperature }),
  });
  if (!res.ok) throw new Error(`gemma ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  // message.reasoning (thinking channel) is intentionally ignored.
  return data.choices[0]?.message?.content ?? "";
}

function extractJson(text: string): { score: number; reason: string } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.indexOf("}", start); end >= 0; end = text.indexOf("}", end + 1)) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (typeof obj.score === "number") {
        return { score: obj.score, reason: String(obj.reason ?? "") };
      }
    } catch {
      // keep extending to the next closing brace
    }
  }
  return null;
}

async function main() {
  const slug = arg("benchmark");
  if (!slug) {
    console.error("usage: bun scripts/evalrun.ts --benchmark <slug> [--max 8] [--candidate <id>] [--force]");
    process.exit(1);
  }
  const max = Number(arg("max") ?? 8);
  const candidate = arg("candidate") ?? "gemma-4-e2b-qat-understudy";
  const force = process.argv.includes("--force");

  const benchFile = path.join(process.cwd(), "data", "benchmarks", `${slug}.json`);
  if (!existsSync(benchFile)) {
    console.error(`no benchmark draft at ${benchFile}`);
    process.exit(1);
  }
  const outDir = path.join(process.cwd(), "data", "evals");
  const outFile = path.join(outDir, `${slug}.json`);
  if (existsSync(outFile) && !force) {
    const existing = JSON.parse(readFileSync(outFile, "utf8"));
    if (existing.candidate === candidate) {
      console.log(`eval exists for (${slug}, ${candidate}) — mean ${existing.mean}, n=${existing.n}. Use --force to redo.`);
      return;
    }
  }

  const draft = JSON.parse(readFileSync(benchFile, "utf8")) as { benchmark: string; instances: Instance[] };
  // HOLDOUT STAYS SEALED: dev split only, highest quality first, capped at --max.
  const dev = draft.instances
    .filter((i) => i.split === "dev")
    .sort((a, b) => b.quality - a.quality)
    .slice(0, max);
  console.log(`${slug}: ${dev.length} dev instances (candidate=${candidate}, kind=${KIND})`);

  const results: Array<{ instance_id: string; score: number; reason: string; candidate_chars: number }> = [];
  for (const [idx, inst] of dev.entries()) {
    const tag = `[${idx + 1}/${dev.length}] ${inst.instance_id}`;
    try {
      // (a) candidate pass — plan-quality: the model cannot execute tools here.
      const answer = await chat(
        [
          {
            role: "system",
            content:
              "You are a coding agent asked to do this task. Describe concretely how you would accomplish it: the steps, tools/commands, and what the final outcome/deliverable would be.",
          },
          { role: "user", content: inst.prompt },
        ],
        2500,
        0.3,
      );

      // (b) judge pass — same local model as judge.
      const judgeText = await chat(
        [
          {
            role: "system",
            content:
              'You are a strict evaluator. Score 0-10 whether the candidate\'s plan would plausibly produce the reference outcome. Respond ONLY with JSON: {"score": n, "reason": "<1 sentence>"}',
          },
          {
            role: "user",
            content: [
              `ORIGINAL TASK PROMPT:\n${inst.prompt}`,
              `REFERENCE OUTCOME (what actually shipped):\nFinal assistant message: ${inst.reference.final_assistant || "(none)"}\nCommits shipped: ${inst.reference.commits.length ? inst.reference.commits.join("; ") : "(none)"}`,
              `CANDIDATE'S PLAN:\n${answer}`,
              'Score 0-10: would this plan plausibly produce the reference outcome? Respond ONLY JSON {"score": n, "reason": "<1 sentence>"}.',
            ].join("\n\n"),
          },
        ],
        2000,
        0.1,
      );
      const parsed = extractJson(judgeText);
      if (!parsed) {
        console.log(`${tag} — judge returned no parseable JSON, skipping. Raw: ${judgeText.slice(0, 120)}`);
        continue;
      }
      const score = Math.min(1, Math.max(0, parsed.score / 10));
      results.push({ instance_id: inst.instance_id, score, reason: parsed.reason, candidate_chars: answer.length });
      console.log(`${tag} — score ${score.toFixed(2)} (${parsed.reason})`);
    } catch (err) {
      console.log(`${tag} — error: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (results.length === 0) {
    console.error("no results — not writing an eval file");
    process.exit(1);
  }
  const mean = Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 1000) / 1000;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        benchmark: draft.benchmark,
        candidate,
        kind: KIND,
        judge: JUDGE,
        createdAt: new Date().toISOString(),
        results,
        mean,
        n: results.length,
      },
      null,
      2,
    ),
  );
  console.log(`\n${slug}: mean ${mean} over n=${results.length} → ${outFile}`);
}

main();
