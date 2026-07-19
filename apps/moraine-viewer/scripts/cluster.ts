// Consolidate free-form scan labels into canonical task clusters with one
// Gemma call over the label histogram. Run after (or during) scan.ts:
//   bun scripts/cluster.ts
// Writes: clusters (id, name), cluster_map (label -> cluster_id).

import { Database } from "bun:sqlite";

const LLM = process.env.SCAN_LLM_URL ?? "http://127.0.0.1:8877/v1/chat/completions";
const db = new Database(new URL("../data/scan.sqlite", import.meta.url).pathname);

db.run(`CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`);
db.run(`CREATE TABLE IF NOT EXISTS cluster_map (label TEXT PRIMARY KEY, cluster_id INTEGER)`);

const labels = db
  .query("SELECT label, COUNT(*) c FROM session_scan GROUP BY label ORDER BY c DESC")
  .all() as { label: string; c: number }[];
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
// singletons + anything the model forgot: assign by word overlap with cluster
// names and member labels; no match → "other"
const STOP = new Set(["and", "the", "of", "for", "a", "an", "in", "on", "with", "to", "&"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
const clusterVocab = parsed.clusters.map((c) => {
  const v = new Set<string>(words(c.name));
  for (const l of c.labels) for (const w of words(l)) v.add(w);
  return v;
});
const otherId = parsed.clusters.length;
let overlapAssigned = 0, toOther = 0;
const missed = labels.filter((l) => !assigned.has(l.label));
for (const l of missed) {
  let best = -1, bestScore = 0;
  clusterVocab.forEach((v, i) => {
    const score = words(l.label).filter((w) => v.has(w)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) { insMap.run(l.label, best); overlapAssigned++; }
  else { insMap.run(l.label, otherId); toOther++; }
}
if (toOther) insCluster.run(otherId, "other");
console.log(`${overlapAssigned} labels assigned by word overlap, ${toOther} → "other"`);

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
