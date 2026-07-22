// Embed interactive session labels+summaries for cluster refinement and future
// semantic search. Run after scan.ts:
//   bun scripts/embed.ts [--force]
// Writes: session_embeddings(session_id, vec, dim, model),
//         cluster_embeddings(cluster_id, vec, dim).
// Exports embedTexts() for reuse by cluster.ts (on-the-fly label embedding).

import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

const PY = `
import json, sys
from sentence_transformers import SentenceTransformer
inp, outp = sys.argv[1], sys.argv[2]
texts = json.load(open(inp))
model = SentenceTransformer(${JSON.stringify(EMBED_MODEL)})
vecs = model.encode(texts, normalize_embeddings=True, batch_size=64, show_progress_bar=False)
json.dump([[float(x) for x in v] for v in vecs], open(outp, "w"))
`;

// One-shot python child: texts in via temp JSON, vectors out via temp JSON.
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "moraine-embed-"));
  const inp = join(dir, "in.json");
  const outp = join(dir, "out.json");
  try {
    writeFileSync(inp, JSON.stringify(texts));
    const proc = Bun.spawn(
      ["uv", "run", "--with", "sentence-transformers", "python", "-c", PY, inp, outp],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) throw new Error("embedding child process failed");
    const vecs = JSON.parse(readFileSync(outp, "utf8")) as number[][];
    return vecs.map((v) => Float32Array.from(v));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const vecToBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const blobToVec = (b: Uint8Array) =>
  new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

if (import.meta.main) {
  const force = process.argv.includes("--force");
  const db = new Database(new URL("../data/scan.sqlite", import.meta.url).pathname);
  db.run(`CREATE TABLE IF NOT EXISTS session_embeddings (
    session_id TEXT PRIMARY KEY, vec BLOB, dim INTEGER, model TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS cluster_embeddings (
    cluster_id INTEGER PRIMARY KEY, vec BLOB, dim INTEGER)`);

  const rows = db
    .query(
      `SELECT s.session_id, s.label, s.summary FROM session_scan s
       ${force ? "" : "LEFT JOIN session_embeddings e ON e.session_id = s.session_id"}
       WHERE s.interactive = 1 ${force ? "" : "AND e.session_id IS NULL"}`,
    )
    .all() as { session_id: string; label: string; summary: string }[];
  console.log(`${rows.length} interactive sessions to embed${force ? " (--force)" : ""}`);

  const t0 = Date.now();
  if (rows.length) {
    const vecs = await embedTexts(rows.map((r) => `${r.label ?? ""}: ${r.summary ?? ""}`));
    const ins = db.prepare(
      "INSERT OR REPLACE INTO session_embeddings (session_id, vec, dim, model) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      rows.forEach((r, i) => ins.run(r.session_id, vecToBlob(vecs[i]), vecs[i].length, EMBED_MODEL));
    })();
    console.log(`embedded ${rows.length} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // cluster embeddings: name + concatenated member labels (always refreshed —
  // cheap, and cluster_map may have changed since last run)
  const clusters = db
    .query(
      `SELECT c.id, c.name, GROUP_CONCAT(m.label, '; ') labels
       FROM clusters c LEFT JOIN cluster_map m ON m.cluster_id = c.id
       GROUP BY c.id`,
    )
    .all() as { id: number; name: string; labels: string | null }[];
  if (clusters.length) {
    const vecs = await embedTexts(
      clusters.map((c) => `${c.name}: ${c.labels ?? ""}`.slice(0, 4000)),
    );
    const ins = db.prepare(
      "INSERT OR REPLACE INTO cluster_embeddings (cluster_id, vec, dim) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      clusters.forEach((c, i) => ins.run(c.id, vecToBlob(vecs[i]), vecs[i].length));
    })();
    console.log(`embedded ${clusters.length} clusters`);
  }
  const total = (db.query("SELECT COUNT(*) c FROM session_embeddings").get() as { c: number }).c;
  console.log(`session_embeddings total: ${total}`);
}
