// Consolidate free-form scan labels into canonical task clusters with one
// Gemma call over the label histogram. Run after (or during) scan.ts:
//   bun scripts/cluster.ts
// Writes: clusters (id, name), cluster_map (label -> cluster_id).

import { Database } from "bun:sqlite";
import { embedTexts, blobToVec } from "./embed";

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
let embedAssigned = 0, llmAssigned = 0, overlapAssigned = 0, toOther = 0;

// --- embedding path (preferred): cosine of label embedding vs cluster
// centroids (mean of member session embeddings from embed.ts). Falls back to
// the LLM-batch/word-overlap path when embed.ts hasn't been run.
const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
};
const hasEmbeddings =
  (db.query("SELECT name FROM sqlite_master WHERE name='session_embeddings'").get() != null) &&
  ((db.query("SELECT COUNT(*) c FROM session_embeddings").get() as { c: number }).c > 0);

// per-cluster centroids from member session embeddings (mean of vectors)
const centroids = new Map<number, Float32Array>();
if (hasEmbeddings) {
  const memberVecs = db
    .query(
      `SELECT m.cluster_id cid, e.vec vec FROM session_embeddings e
       JOIN session_scan s ON s.session_id = e.session_id
       JOIN cluster_map m ON m.label = s.label`,
    )
    .all() as { cid: number; vec: Uint8Array }[];
  const sums = new Map<number, { sum: Float64Array; n: number }>();
  for (const r of memberVecs) {
    const v = blobToVec(r.vec);
    let s = sums.get(r.cid);
    if (!s) { s = { sum: new Float64Array(v.length), n: 0 }; sums.set(r.cid, s); }
    for (let i = 0; i < v.length; i++) s.sum[i] += v[i];
    s.n++;
  }
  for (const [cid, s] of sums) {
    if (cid >= clusterNames.length) continue; // pinned/other from a prior run
    centroids.set(cid, Float32Array.from(s.sum, (x) => x / s.n));
  }
}

if (missed.length && centroids.size) {
  console.log(`assigning ${missed.length} stragglers by embedding similarity (${centroids.size} centroids)`);
  const EMBED_BATCH = 256;
  const THRESHOLD = 0.25;
  for (let i = 0; i < missed.length; i += EMBED_BATCH) {
    const batch = missed.slice(i, i + EMBED_BATCH);
    const vecs = await embedTexts(batch.map((l) => l.label));
    batch.forEach((l, bi) => {
      let best = -1, bestScore = -Infinity;
      for (const [cid, c] of centroids) {
        const s = cosine(vecs[bi], c);
        if (s > bestScore) { bestScore = s; best = cid; }
      }
      if (best >= 0 && bestScore >= THRESHOLD) { insMap.run(l.label, best); embedAssigned++; }
      else { insMap.run(l.label, otherId); toOther++; }
    });
    console.log(`assigned ${Math.min(i + EMBED_BATCH, missed.length)}/${missed.length} stragglers`);
  }
} else {
  if (missed.length) console.log("no embeddings available (run embed.ts) — falling back to LLM batch assignment");
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
}
if (toOther) insCluster.run(otherId, "other");
console.log(
  `${embedAssigned} by embedding, ${llmAssigned} by LLM, ${overlapAssigned} by stemmed overlap, ${toOther} → "other"`,
);

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

// --- quality report: 3 most-central sessions per cluster (highest cosine to
// the final centroid) — seed exemplars for Stage-4 personal benchmarks
if (hasEmbeddings) {
  const rows = db
    .query(
      `SELECT m.cluster_id cid, c.name, e.session_id sid, s.label, e.vec vec
       FROM session_embeddings e
       JOIN session_scan s ON s.session_id = e.session_id
       JOIN cluster_map m ON m.label = s.label
       JOIN clusters c ON c.id = m.cluster_id`,
    )
    .all() as { cid: number; name: string; sid: string; label: string; vec: Uint8Array }[];
  const byCluster = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!byCluster.has(r.cid)) byCluster.set(r.cid, []);
    byCluster.get(r.cid)!.push(r);
  }
  const exemplars: Record<string, { session_id: string; label: string; cosine: number }[]> = {};
  for (const [, members] of [...byCluster.entries()].sort((a, b) => a[0] - b[0])) {
    const dim = blobToVec(members[0].vec).length;
    const sum = new Float64Array(dim);
    for (const m of members) { const v = blobToVec(m.vec); for (let i = 0; i < dim; i++) sum[i] += v[i]; }
    const centroid = Float32Array.from(sum, (x) => x / members.length);
    exemplars[members[0].name] = members
      .map((m) => ({ session_id: m.sid, label: m.label, cosine: cosine(blobToVec(m.vec), centroid) }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, 3)
      .map((m) => ({ ...m, cosine: Number(m.cosine.toFixed(4)) }));
  }
  console.log("exemplars:", JSON.stringify(exemplars, null, 1));
}
