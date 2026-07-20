// Consolidate free-form scan labels into canonical task clusters with one
// Gemma call over the label histogram. Run after (or during) scan.ts:
//   bun scripts/cluster.ts
// Writes: clusters (id, name), cluster_map (label -> cluster_id).

import { Database } from "bun:sqlite";

const LLM = process.env.SCAN_LLM_URL ?? "http://127.0.0.1:8877/v1/chat/completions";
const db = new Database(new URL("../data/scan.sqlite", import.meta.url).pathname);

db.run(`CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`);
db.run(`CREATE TABLE IF NOT EXISTS cluster_map (label TEXT PRIMARY KEY, cluster_id INTEGER)`);

// deterministic plumbing labels get their own pinned cluster — never blended
// into real work clusters
const PINNED = ["cli command"];
const labels = (db
  .query("SELECT label, COUNT(*) c FROM session_scan GROUP BY label ORDER BY c DESC")
  .all() as { label: string; c: number }[]).filter((l) => !PINNED.includes(l.label));
if (!labels.length) {
  console.log("no labels yet — run scan.ts first");
  process.exit(0);
}
console.log(`${labels.length} distinct labels over ${labels.reduce((a, l) => a + l.c, 0)} sessions`);

// only repeated labels go to the model — 300+ singletons blow the token budget;
// singletons are assigned locally by word overlap afterwards
const repeated = labels.filter((l) => l.c >= 2);
const singletons = labels.filter((l) => l.c < 2);
console.log(`${repeated.length} repeated labels to the model, ${singletons.length} singletons assigned locally`);
const histogram = repeated.map((l) => `${l.label} (${l.c})`).join("\n");
const res = await fetch(LLM, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "default_model",
    temperature: 0.2,
    max_tokens: 12000, // reasoning eats most of this before the JSON appears
    messages: [
      {
        role: "system",
        content:
          "You consolidate task labels from coding-agent sessions into canonical clusters. " +
          "Given a label histogram, group ALL labels into 6-10 clusters of similar work. " +
          'Respond with ONLY JSON: {"clusters": [{"name": "<2-3 word cluster name>", "labels": ["<every input label assigned here>"]}]}. ' +
          "Every input label must appear in exactly one cluster.",
      },
      { role: "user", content: histogram },
    ],
  }),
});
if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
const j = (await res.json()) as { choices: { message: { content: string } }[] };
const raw = j.choices[0]?.message?.content ?? "";
const m = raw.match(/\{[\s\S]*\}/);
if (!m) throw new Error(`no JSON in response: ${raw.slice(0, 200)}`);
const parsed = JSON.parse(m[0]) as { clusters: { name: string; labels: string[] }[] };

db.run("DELETE FROM clusters");
db.run("DELETE FROM cluster_map");
const insCluster = db.prepare("INSERT INTO clusters (id, name) VALUES (?, ?)");
const insMap = db.prepare("INSERT OR REPLACE INTO cluster_map (label, cluster_id) VALUES (?, ?)");
const assigned = new Set<string>();
parsed.clusters.forEach((c, i) => {
  insCluster.run(i, c.name.toLowerCase().trim().slice(0, 40));
  for (const l of c.labels) {
    insMap.run(l.toLowerCase().trim(), i);
    assigned.add(l.toLowerCase().trim());
  }
});
// singletons + anything the model forgot: batched LLM assignment against the
// canonical cluster list; stemmed word overlap as fallback; last resort "other"
const STOP = new Set(["and", "the", "of", "for", "a", "an", "in", "on", "with", "to", "&"]);
const stem = (w: string) => w.replace(/(ing|ment|tion|s)$/, "");
const words = (s: string) =>
  s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
const clusterNames = parsed.clusters.map((c) => c.name.toLowerCase().trim().slice(0, 40));
const clusterVocab = parsed.clusters.map((c) => {
  const v = new Set<string>(words(c.name));
  for (const l of c.labels) for (const w of words(l)) v.add(w);
  return v;
});

async function assignBatch(batch: string[]): Promise<Map<string, number>> {
  const res = await fetch(LLM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "default_model",
      temperature: 0.1,
      max_tokens: 8000,
      messages: [
        {
          role: "system",
          content:
            `Assign each task label to the best-fitting cluster. Clusters (use the index): ` +
            clusterNames.map((n, i) => `${i}=${n}`).join(", ") +
            `. Respond ONLY with JSON: {"assignments": {"<label>": <cluster index>, ...}} covering every label.`,
        },
        { role: "user", content: batch.join("\n") },
      ],
    }),
  });
  const out = new Map<string, number>();
  if (!res.ok) return out;
  const jj = (await res.json()) as { choices: { message: { content: string } }[] };
  const mm = (jj.choices[0]?.message?.content ?? "").match(/\{[\s\S]*\}/);
  if (!mm) return out;
  try {
    const a = (JSON.parse(mm[0]) as { assignments?: Record<string, number> }).assignments ?? {};
    for (const [label, idx] of Object.entries(a)) {
      if (Number.isInteger(idx) && idx >= 0 && idx < clusterNames.length) out.set(label.toLowerCase().trim(), idx);
    }
  } catch { /* fall through to overlap */ }
  return out;
}

const otherId = parsed.clusters.length;
const missed = labels.filter((l) => !assigned.has(l.label));
let llmAssigned = 0, overlapAssigned = 0, toOther = 0;
const BATCH = 40;
for (let i = 0; i < missed.length; i += BATCH) {
  const batch = missed.slice(i, i + BATCH);
  const byLlm = await assignBatch(batch.map((l) => l.label));
  for (const l of batch) {
    const idx = byLlm.get(l.label);
    if (idx !== undefined) { insMap.run(l.label, idx); llmAssigned++; continue; }
    let best = -1, bestScore = 0;
    clusterVocab.forEach((v, ci) => {
      const score = words(l.label).filter((w) => v.has(w)).length;
      if (score > bestScore) { bestScore = score; best = ci; }
    });
    if (best >= 0) { insMap.run(l.label, best); overlapAssigned++; }
    else { insMap.run(l.label, otherId); toOther++; }
  }
  console.log(`assigned ${Math.min(i + BATCH, missed.length)}/${missed.length} stragglers`);
}
if (toOther) insCluster.run(otherId, "other");
console.log(`${llmAssigned} by LLM, ${overlapAssigned} by stemmed overlap, ${toOther} → "other"`);

// pinned plumbing cluster, after everything else
const pinnedId = otherId + 1;
insCluster.run(pinnedId, "cli plumbing");
for (const l of PINNED) insMap.run(l, pinnedId);

const report = db
  .query(`
    SELECT c.name, COUNT(s.session_id) sessions
    FROM session_scan s
    JOIN cluster_map m ON m.label = s.label
    JOIN clusters c ON c.id = m.cluster_id
    GROUP BY c.id ORDER BY sessions DESC
  `)
  .all();
console.log("clusters:", JSON.stringify(report, null, 1));
