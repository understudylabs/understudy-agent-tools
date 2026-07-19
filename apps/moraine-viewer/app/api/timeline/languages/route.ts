import { readLangSessionCounts } from "../langs-db";

// GET /api/timeline/languages → { langs: [{ lang, sessions }] }
// dominant-language session counts (data/langs.sqlite; empty when absent)

export async function GET() {
  return Response.json({ langs: readLangSessionCounts() });
}
