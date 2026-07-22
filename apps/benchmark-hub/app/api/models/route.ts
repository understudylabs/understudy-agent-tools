import { NextResponse } from "next/server";
// Gateway auth is the CLI's own resolver (env first, then
// ~/.understudy/credentials.json) imported from dist — never forked, and the
// key never leaves the server: the browser only sees model ids.
import { resolveGatewayAuth } from "../../../lib/gateway-core";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; payload: { models: string[]; error: string | null } } | null = null;

/**
 * GET /api/runs' model picker source: the gateway's /v1/models, cached
 * server-side for 5 minutes so opening the Run panel never hammers the
 * gateway. Auth failures degrade to an empty list with the reason.
 */
export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache.payload, cached: true });
  }
  let payload: { models: string[]; error: string | null };
  try {
    const auth = resolveGatewayAuth();
    const response = await fetch(`${auth.baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`gateway /v1/models returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (Array.isArray(body.data) ? body.data : [])
      .map((entry) => String(entry?.id ?? ""))
      .filter(Boolean)
      .sort();
    payload = { models, error: models.length > 0 ? null : "gateway listed no models" };
  } catch (err) {
    payload = { models: [], error: err instanceof Error ? err.message : String(err) };
  }
  cache = { at: Date.now(), payload };
  return NextResponse.json({ ...payload, cached: false });
}
