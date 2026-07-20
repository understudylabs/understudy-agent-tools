// Stage 4→5: run a candidate model against a personal-benchmark draft
// (dev split ONLY — holdout stays sealed) and write
// data/evals/<slug>__<candidate-slug>.json.
//
// This is a PLAN-QUALITY eval: the candidate cannot execute tools here, so it
// is asked to describe concretely how it would accomplish the task, and a
// judge model (default: a frontier model via the Understudy gateway) scores
// whether that plan would plausibly produce the reference outcome.
//
// Candidate/judge ids:
//   local:gemma-4-e2b-qat-understudy   → local server at 127.0.0.1:8877
//   <anything else>                    → Understudy gateway model id
//
// Usage: bun scripts/evalrun.ts --benchmark <slug> [--max 8]
//          [--candidate <id>] [--judge <id>] [--force]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCAL_URL = "http://127.0.0.1:8877/v1/chat/completions";
const GATEWAY_URL = "https://api.understudylabs.com/v1/chat/completions";
const KIND = "plan-quality-v1";
const TIMEOUT_MS = 30_000;
const RETRIES = 2;

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

function slugifyId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Gateway key is read at runtime and never printed or written anywhere.
let gatewayKey: string | null = null;
function getGatewayKey(): string {
  if (gatewayKey) return gatewayKey;
  const credFile = path.join(process.env.HOME ?? "", ".understudy", "credentials.json");
  const creds = JSON.parse(readFileSync(credFile, "utf8")) as { api_key?: string };
  if (!creds.api_key) throw new Error("no api_key in ~/.understudy/credentials.json");
  gatewayKey = creds.api_key;
  return gatewayKey;
}

type Endpoint = { url: string; model: string; headers: Record<string, string> };

function resolveEndpoint(id: string): Endpoint {
  if (id.startsWith("local:")) {
    return { url: LOCAL_URL, model: "default_model", headers: {} };
  }
  return {
    url: GATEWAY_URL,
    model: id,
    headers: { Authorization: `Bearer ${getGatewayKey()}` },
  };
}

async function chatOnce(
  ep: Endpoint,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ep.headers },
    body: JSON.stringify({ model: ep.model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${ep.model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  // message.reasoning (thinking channel) is intentionally ignored.
  return data.choices[0]?.message?.content ?? "";
}

async function chat(
  ep: Endpoint,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const content = await chatOnce(ep, messages, maxTokens, temperature);
      if (content.trim()) return content;
      // Empty content usually means reasoning ate the token budget — one
      // retry with a generous cap.
      const retry = await chatOnce(ep, messages, Math.max(maxTokens, 4000), temperature);
      if (retry.trim()) return retry;
      throw new Error(`${ep.model}: empty content after max_tokens retry`);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
    console.error(
      "usage: bun scripts/evalrun.ts --benchmark <slug> [--max 8] [--candidate <id>] [--judge <id>] [--force]",
    );
    process.exit(1);
  }
  const max = Number(arg("max") ?? 8);
  const candidate = arg("candidate") ?? "local:gemma-4-e2b-qat-understudy";
  const judge = arg("judge") ?? "claude-opus-4-8";
  const force = process.argv.includes("--force");

  const benchFile = path.join(process.cwd(), "data", "benchmarks", `${slug}.json`);
  if (!existsSync(benchFile)) {
    console.error(`no benchmark draft at ${benchFile}`);
    process.exit(1);
  }
  const outDir = path.join(process.cwd(), "data", "evals");
  const outFile = path.join(outDir, `${slug}__${slugifyId(candidate)}.json`);
  if (existsSync(outFile) && !force) {
    const existing = JSON.parse(readFileSync(outFile, "utf8"));
    console.log(
      `eval exists for (${slug}, ${candidate}) — mean ${existing.mean}, n=${existing.n}. Use --force to redo.`,
    );
    return;
  }

  const candidateEp = resolveEndpoint(candidate);
  const judgeEp = resolveEndpoint(judge);

  const draft = JSON.parse(readFileSync(benchFile, "utf8")) as {
    benchmark: string;
    instances: Instance[];
  };
  // HOLDOUT STAYS SEALED: dev split only, highest quality first, capped at --max.
  const dev = draft.instances
    .filter((i) => i.split === "dev")
    .sort((a, b) => b.quality - a.quality)
    .slice(0, max);
  console.log(
    `${slug}: ${dev.length} dev instances (candidate=${candidate}, judge=${judge}, kind=${KIND})`,
  );

  const results: Array<{
    instance_id: string;
    score: number;
    reason: string;
    candidate_chars: number;
  }> = [];
  for (const [idx, inst] of dev.entries()) {
    const tag = `[${idx + 1}/${dev.length}] ${inst.instance_id}`;
    try {
      // (a) candidate pass — plan-quality: the model cannot execute tools here.
      const answer = await chat(
        candidateEp,
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

      // (b) judge pass.
      const judgeText = await chat(
        judgeEp,
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
        judge,
        kind: KIND,
        createdAt: new Date().toISOString(),
        results,
        mean,
        n: results.length,
      },
      null,
      2,
    ),
  );
  console.log(`\n${slug}: candidate=${candidate} mean ${mean} over n=${results.length} → ${outFile}`);
}

main();
